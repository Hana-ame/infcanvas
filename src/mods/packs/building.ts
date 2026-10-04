/**
 * building 包 —— 建筑种子（篝火/棚屋）+ 自主建造卡。
 *
 * 设计：建筑定义 = 纯数据（registerBuilding 进 tuning 表）；建造 = 一张卡
 * （材料够 + 附近没有同类 → 找格落子）。没有"建造队列/蓝图系统"——谁抽到卡谁来干，
 * 材料不够这卡自然抽不中。木料富余时"大兴土木"的倾向也只是权重钩子，不是规则。
 */
import type { ModPack } from '../pack';
import { K_STOCK_WOOD, K_TAG_FIRE, K_TAG_SHELTER, K_TAG_STORAGE } from '../contracts';
import { SER_BUILD } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState, Pos } from '../../sim/types';
import type { BuildingState } from '../../sim/types';

export const buildingPack: ModPack = {
  id: 'building',
  requires: [],
  apply(m) {
    // ---- 建筑数据表（纯种子；hp/造价/标签/燃料全在表上）----
    // 造价 4→10、fuelSec 12：篝火是与寻路组合的营地核心（航点网络节点），
    // 低价随手造会泛滥（用户反馈）；维护耗木让"砍树-囤柴-燃火"成为持续经济闭环。
    m.registerBuilding({
      id: 'campfire',
      name: '篝火',
      cost: { wood: 10 },
      hp: 80,
      tags: [K_TAG_FIRE],
      passable: true,
      fuelSec: 12,
    });
    m.registerBuilding({
      id: 'hut',
      name: '棚屋',
      cost: { wood: 12 },
      hp: 200,
      tags: [K_TAG_SHELTER],
      passable: false,
      w: 2,
      h: 2,
      // 刻意**不加科技门控**（2026-08-21 平衡复采修正）：
      // 门控同时压在棚屋与仓库上时，一局 900s 内两项都解锁不完 → 鼠群唯一的建筑出口
      // 只剩篝火，木料全砸进篝火（实测 4 seed 全是"篝火×N"，棚屋/仓库一座不出），
      // 世界退化成"多堆火"。棚屋是刚需（人口比例门 + 睡旁边回心情），门控它等于
      // 拿掉一个刚需维度。门控留给"锦上添花"的建筑才不伤核心循环。
      tech: undefined,
    });
    // 仓库：2×2，木料经济锚点
    m.registerBuilding({
      id: 'store',
      name: '仓库',
      cost: { wood: 8 },
      hp: 150,
      tags: [K_TAG_STORAGE],
      passable: false,
      w: 2,
      h: 2,
      tech: ['storage:store'], // 科技门控（R2-1）：解锁仓储术才建仓库
    });

    // ---- 系统：燃料维护（production 组）。数据驱动：
    //      累积 scratch['build.fuelAcc']；每整份扣 1 wood；断薪按 id 序熄灭一座。
    //      累积器随档（存档纪律：跨 tick 状态不进闭包）。
    const FUEL_ACC_KEY = 'build.fuelAcc';
    m.registerSystemDef({
      id: 'buildings-upkeep',
      category: 'production',
      ctor: (ctx: SimContext) => ({
        id: 'buildings-upkeep',
        update(dt) {
          let burning = 0;
          for (const b of ctx.buildingsAll()) {
            if (ctx.tuning.buildings[b.defId]?.fuelSec !== undefined) burning++;
          }
          if (burning === 0) return;
          let acc = (ctx.scratch[FUEL_ACC_KEY] ?? 0) + (burning * dt) / 12;
          const take = Math.floor(acc);
          if (take <= 0) {
            ctx.scratch[FUEL_ACC_KEY] = acc;
            return;
          }
          ctx.scratch[FUEL_ACC_KEY] = acc - take;
          for (let i = 0; i < take; i++) {
            if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) > 0) {
              ctx.stockpile[K_STOCK_WOOD] -= 1;
            } else {
              const victim = [...ctx.buildingsAll()]
                .filter((b) => ctx.tuning.buildings[b.defId]?.fuelSec !== undefined)
                .sort((a, b) => a.id.localeCompare(b.id))[0];
              if (!victim) break;
              ctx.removeBuilding(victim.id);
              ctx.log(`💨 ${ctx.tuning.buildings[victim.defId]?.name ?? '篝火'}断了燃料，熄灭了`);
            }
          }
        },
      }),
    });

    // ---- 权重钩子：木料富余则更想盖房；心情低时更想有个家 ----
    m.registerHook('cardWeight', (p, card, ctx) => {
      if (card.series !== SER_BUILD) return 1;
      const wood = ctx.stockpile[K_STOCK_WOOD] ?? 0;
      let mul = wood >= 20 ? 1.8 : wood >= 12 ? 1.3 : 1;
      // 心情低 → 更想盖棚屋（家的安全感是真实需求驱动，不是木料富余就乱盖）
      if (card.id === 'build_hut' && p.needs.mood < 40) mul *= 2;
      return mul;
    });

    // ---- 卡：搭篝火（三重门槛见 tuning.build.newFire* 注释）----
    m.registerCard({
      id: 'build_campfire',
      label: '搭篝火',
      series: SER_BUILD,
      weight: 5,
      condition: (p, ctx) => wantNewFire(p, ctx),
      action(p, ctx) {
        buildHere(p, ctx, 'campfire');
      },
    });

    // ---- 卡：盖棚屋（材料够 + 按人口比例的刚需：不够住才盖）----
    m.registerCard({
      id: 'build_hut',
      label: '盖棚屋',
      series: SER_BUILD,
      weight: 4,
      condition: (p, ctx) => wantHut(p, ctx),
      action(p, ctx) {
        buildHere(p, ctx, 'hut');
      },
    });

    // ---- 卡：建仓库（木料够 + 数量低于人口比例）----
    m.registerCard({
      id: 'build_store',
      label: '建仓库',
      series: SER_BUILD,
      weight: 3,
      condition: (p, ctx) => {
        // 科技门控前置（R2-1）：同 wantHut 语义
        if (!ctx.techSatisfied(ctx.tuning.buildings['store']?.tech)) return false;
        if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < costOf(ctx, 'store')) return false;
        let stores = 0;
        for (const b of ctx.buildingsAll()) {
          if (b.defId === 'store') stores++;
        }
        let pawns = 0;
        for (const _ of ctx.pawns()) pawns++;
        return stores < Math.max(1, Math.ceil(pawns * ctx.tuning.build.storeRatio));
      },
      action(p, ctx) {
        buildHere(p, ctx, 'store');
      },
    });
  },
};

/** 新火堆意愿：材料够 + 身边足够远 + 鼠群确实已扩散（≥spreadMice 只远离所有火）。
 *  单鼠游荡不再触发——否则每只带木料的鼠都变成行走的火种（真实踩坑）。 */
function wantNewFire(p: PawnState, ctx: SimContext): boolean {
  const cfg = ctx.tuning.build;
  if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < costOf(ctx, 'campfire')) return false;
  const near = ctx.nearestBuildingByTag(K_TAG_FIRE, p.pos.x, p.pos.y, cfg.newFireRadius);
  if (near !== undefined) return false;
  // 群体扩散判定：统计离所有火都超过 spreadRadius 的鼠数
  let far = 0;
  const fireAt = (o: PawnState): BuildingState | undefined =>
    ctx.nearestBuildingByTag(K_TAG_FIRE, o.pos.x, o.pos.y);
  for (const o of ctx.pawns()) {
    const f = fireAt(o);
    if (!f || Math.hypot(o.pos.x - f.pos.x, o.pos.y - f.pos.y) > cfg.spreadRadius) far++;
  }
  return far >= cfg.spreadMice;
}

/** 棚屋刚需：材料够 + 棚屋数 < 按人口比例的上限。
 *  4 只鼠 × 0.5 = 2 座就够——此前只查木料，900s 狂盖 28~43 座（用户反馈）。 */
function wantHut(p: PawnState, ctx: SimContext): boolean {
  // 科技门控（R2-1）：无条件生效——wantHut 是唯一读取 hut.tech 的地方，
  // 保留这一行是为了"门控规则只有一处实现"的纪律（techSatisfied 的"表外放行"
  // 语义也要在这里被真实消费一次）。hut 本身不带 tech（见注册处注释）。
  if (!ctx.techSatisfied(ctx.tuning.buildings['hut']?.tech)) return false;
  if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < costOf(ctx, 'hut')) return false;
  let shelters = 0;
  let pawns = 0;
  for (const b of ctx.buildingsAll()) {
    if (ctx.tuning.buildings[b.defId]?.tags?.includes('shelter')) shelters++;
  }
  for (const _ of ctx.pawns()) pawns++;
  const need = Math.ceil(pawns * (ctx.tuning.build.hutRatio ?? 0.5));
  return shelters < need;
}

function costOf(ctx: SimContext, defId: string): number {
  return ctx.tuning.buildings[defId]?.cost[K_STOCK_WOOD] ?? Infinity;
}

/** 在身边找格落子：脚下一格优先，环形外扩到 searchRadius。成功扣料+落子+记事，
 *  失败也收工（重抽再试——找不到格说明这里真盖不下，硬重试是机制链味道）。 */
function buildHere(p: PawnState, ctx: SimContext, defId: string): void {
  const def = ctx.tuning.buildings[defId];
  const spot = findSpot(ctx, p.pos, defId, ctx.tuning.build.searchRadius);
  if (!spot) {
    ctx.finishCard(p);
    return;
  }
  for (const [k, v] of Object.entries(def.cost)) {
    ctx.stockpile[k] = (ctx.stockpile[k] ?? 0) - v;
  }
  ctx.addBuilding(defId, spot.x, spot.y);
  ctx.log(`🏠 ${def.name}建好了`);
  ctx.finishCard(p);
}

/** 找可容纳整个 w×h 占地的左上角：每格 passable（地形/树冠/占位一并排除；
 *  world.addBuilding 再统一裁决定同类间距） */
function findSpot(ctx: SimContext, center: Pos, defId: string, maxR: number): Pos | null {
  const w = ctx.tuning.buildings[defId]?.w ?? 1;
  const h = ctx.tuning.buildings[defId]?.h ?? 1;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = center.x + dx;
        const y = center.y + dy;
        let fit = true;
        for (let fy = 0; fy < h && fit; fy++) {
          for (let fx = 0; fx < w && fit; fx++) {
            if (!ctx.passable(x + fx, y + fy)) fit = false;
          }
        }
        if (fit) return { x, y };
      }
    }
  }
  return null;
}