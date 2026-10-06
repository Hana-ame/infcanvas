/**
 * fortify 包 —— 防御建筑种子（围墙/哨塔/陷阱）+ 自主建造卡 + 陷阱触发系统。
 *
 * ---- 三条红线怎么落 ----
 * ① 一切皆抽卡：三种建筑一律是 SER_BUILD 卡（build_wall 3 / build_tower 4 / build_trap 2），
 *    谁抽到谁造。造价够不够与"身边找得到空地"是 condition 硬闸，抽不中自然不建；
 *    没有建造队列、没有蓝图、没有指令式 AI。
 * ② 数值全进 tuning.fortify（陷阱伤害/踩中半径/引爆时长/墙间距偏好）与
 *    registerBuilding 的建筑表（造价/hp/tags/passable/w/h）——本文件零玩法魔法数字。
 * ③ 跨 tick 状态走 ctx.scratch：陷阱"被踩了多久"按建筑 id 存键
 *    `fortify.trapHit.<buildingId>`，随档，不是闭包。
 *
 * ---- 哨塔 = 航点（用户 2026-10-07「标志位扩展到哨塔/地标」）----
 * 哨塔挂 K_TAG_WAYPOINT 即自动进入 Sim.fireAnchorsList 的航点桶，长距（>24 格）寻路
 * 以它为中转锚点分段 A*——**零内核改动**。
 * 但刻意**不挂** K_TAG_FIRE：否则哨塔会混进 cooking/sleep 的
 * `nearestBuildingByTag('fire')` 查询（在哨塔旁开火、按"火旁恢复"结算睡觉），
 * 那是语义污染而不是复用。两个标签各司其职，见 contracts.ts K_TAG_WAYPOINT 注释。
 *
 * ---- 卸载语义 ----
 * 不挂本包 → 无三张建造卡、无陷阱系统、无 fortify 数值消费；已建的墙/塔/陷阱留存为
 * 普通建筑实体（passable/hp 由表读，表外按"不阻挡"处理），核心照跑。
 *
 * ---- 与 building 包的两个差异（都是刻意的改进，不是忘了抄）----
 * 1. `buildHere` 检查 addBuilding 的返回值：内核拒放（同类间距/占位冲突）时**不扣料**，
 *    直接收工重抽。building.ts 是先扣料再落子并忽略返回值——间距拒放会白白漏料。
 * 2. `findSpot` 的候选坐标做了 Math.round：building.ts 直接把鼠的连续坐标 + 整数偏移
 *    传下去，建筑 pos 会带小数（不影响内核，但会让"占地重叠判定"变模糊）。
 */
import type { ModPack } from '../pack';
import {
  K_STOCK_WOOD,
  K_TAG_SHELTER,
  K_TAG_TRAP,
  K_TAG_TOWER,
  K_TAG_WALL,
  K_TAG_WAYPOINT,
  SER_BUILD,
} from '../contracts';
import type { SimContext } from '../../sim/context';
import type { BuildingState, PawnState, Pos } from '../../sim/types';

const WALL_ID = 'wall';
const TOWER_ID = 'tower';
const TRAP_ID = 'trap';

/** 陷阱累积接触时长的 scratch 键前缀：完整键 = `fortify.trapHit.<建筑id>`。
 *  键用建筑 id（唯一、随删随走），不用坐标——建筑引爆后键立即 delete，不残留。 */
const TRAP_HIT_PREFIX = 'fortify.trapHit.';

export const fortifyPack: ModPack = {
  id: 'fortify',
  requires: ['building'], // 复用 building 的造价口径/落子生态与 SER_BUILD 木料权重钩子
  apply(m) {
    // ---- 建筑数据表（纯种子；行为参数在 tuning.fortify）----
    // 造价 2 木：墙是**迟滞**不是封锁——便宜到能随手铺一圈拖时间，
    // 靠数量而不是靠单体硬度（hp 40）。真正的密度下限由内核同类间距
    // （build.minSpacing=5）决定，见 tuning.fortify.wallMinGap 注释。
    m.registerBuilding({
      id: WALL_ID,
      name: '围墙',
      cost: { [K_STOCK_WOOD]: 2 },
      hp: 40,
      tags: [K_TAG_WALL],
      passable: false, // 纯迟滞：canStep 自然挡住通行，不需要额外代码
      w: 1,
      h: 1,
    });
    // 哨塔：2×2、可站立（据守/庇护的前提）。三重身份 = 航点 + 庇护 + 据点。
    m.registerBuilding({
      id: TOWER_ID,
      name: '哨塔',
      cost: { [K_STOCK_WOOD]: 15 },
      hp: 120,
      tags: [K_TAG_TOWER, K_TAG_WAYPOINT, K_TAG_SHELTER],
      passable: true,
      w: 2,
      h: 2,
    });
    // 陷阱：1×1、可通行但踩中扣血。一次性消耗品（trapDurabilitySec 后引爆）。
    m.registerBuilding({
      id: TRAP_ID,
      name: '陷阱',
      cost: { [K_STOCK_WOOD]: 4 },
      hp: 30,
      tags: [K_TAG_TRAP],
      passable: true,
    });

    // ---- 系统：陷阱触发（raid 类：只在有敌时才有后果）----
    // 伤害对**敌人**结算（ctx.hostiles()），鼠踩陷阱不扣血。
    // 累积接触时长 ≥ trapDurabilitySec → 引爆（removeBuilding），一次性消耗品。
    m.registerSystemDef({
      id: 'fortify-traps',
      category: 'raid',
      ctor: (ctx: SimContext) => ({
        id: 'fortify-traps',
        update(dt) {
          const t = ctx.tuning.fortify;
          if (ctx.hostiles().length === 0) return;
          const traps: BuildingState[] = [];
          for (const b of ctx.buildingsAll()) {
            if (b.defId === TRAP_ID) traps.push(b);
          }
          if (traps.length === 0) return;

          // 快照敌人群：damageHostile 会把死敌从 hostilesList splice 掉，
          // 边遍历边删会跳帧（raid 系统里踩过的同一个坑）。
          const list = [...ctx.hostiles()];
          const dead: string[] = [];
          for (const h of list) {
            for (const b of traps) {
              if (dead.includes(b.id)) continue;
              if (Math.hypot(b.pos.x - h.pos.x, b.pos.y - h.pos.y) > t.trapHitRadius) continue;
              // 踩中：按秒连续磨敌血（不是一次性跳变）
              ctx.damageHostile(h.id, t.trapDmgPerSec * dt);
              const key = TRAP_HIT_PREFIX + b.id;
              const acc = (ctx.scratch[key] ?? 0) + dt;
              if (acc >= t.trapDurabilitySec) {
                delete ctx.scratch[key]; // 引爆后不留残留状态
                dead.push(b.id);
                ctx.log('💥 陷阱炸了');
              } else {
                ctx.scratch[key] = acc;
              }
            }
          }
          for (const id of dead) ctx.removeBuilding(id);
        },
      }),
    });

    // ---- 卡：修围墙（SER_BUILD，weight 3）----
    m.registerCard({
      id: 'build_wall',
      label: '修围墙',
      series: SER_BUILD,
      weight: 3,
      condition: (p, ctx) => wantWall(p, ctx),
      action(p, ctx) {
        buildHere(p, ctx, WALL_ID);
      },
    });

    // ---- 卡：建哨塔（SER_BUILD，weight 4）----
    // 权重最高（见 tuning.fortify 的 towerBuildWeightNote）：15 木换航点+庇护+据点，
    // 是本系列唯一值得反复抽的主项。
    m.registerCard({
      id: 'build_tower',
      label: '建哨塔',
      series: SER_BUILD,
      weight: 4,
      condition: (_p, ctx) => wantTower(ctx),
      action(p, ctx) {
        buildHere(p, ctx, TOWER_ID);
      },
    });

    // ---- 卡：埋陷阱（SER_BUILD，weight 2）----
    m.registerCard({
      id: 'build_trap',
      label: '埋陷阱',
      series: SER_BUILD,
      weight: 2,
      condition: (p, ctx) => wantTrap(p, ctx),
      action(p, ctx) {
        buildHere(p, ctx, TRAP_ID);
      },
    });
  },
};

/** 修墙意愿：木料够 + （还没有墙 或 身边真有敌人）。
 *  第一堵不设门槛（开局就能铺出迟滞带）；之后必须有威胁——墙是迟滞工事不是装饰，
 *  无威胁时 2 木/堵的墙会把木料吃光（与 build_hut 的"按人口刚需才盖"同一条纪律）。
 *  不挂 raid 时 ctx.hostiles() 恒为空 ⇒ 只能修第一堵，卸载不破坏核心。 */
function wantWall(p: PawnState, ctx: SimContext): boolean {
  if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < costOf(ctx, WALL_ID)) return false;
  let walls = 0;
  for (const b of ctx.buildingsAll()) {
    if (b.defId === WALL_ID) walls++;
  }
  return walls === 0 || hostileNear(p, ctx);
}

/** 建塔意愿：木料够 + 哨塔数 < 每 4 只鼠 1 座。
 *  上限复用 build.storeRatio（重型设施/人口比例）——不另造一个"塔/人口"数值，
 *  避免 tuning 里出现同义的第二个旋钮。 */
function wantTower(ctx: SimContext): boolean {
  if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < costOf(ctx, TOWER_ID)) return false;
  let towers = 0;
  let pawns = 0;
  for (const b of ctx.buildingsAll()) {
    if (b.defId === TOWER_ID) towers++;
  }
  for (const _ of ctx.pawns()) pawns++;
  return towers < Math.max(1, Math.ceil(pawns * ctx.tuning.build.storeRatio));
}

/** 埋陷阱意愿：木料够 + （还没有陷阱 或 身边真有敌人）。
 *  陷阱是一次性伏击消耗品：没人踩就纯属浪费木料。第一个不设门槛保证开局能埋出伏击线。 */
function wantTrap(p: PawnState, ctx: SimContext): boolean {
  if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < costOf(ctx, TRAP_ID)) return false;
  let traps = 0;
  for (const b of ctx.buildingsAll()) {
    if (b.defId === TRAP_ID) traps++;
  }
  return traps === 0 || hostileNear(p, ctx);
}

/** 身边有敌：复用 raid 的感知半径当"有威胁"判据。
 *  这是 fortify 对 raid 的**软依赖**——只读 tuning.raid.senseRadius（出厂表恒有），
 *  不 requires raid，所以不挂 raid 时也能挂 fortify（只是永远判定"无威胁"）。 */
function hostileNear(p: PawnState, ctx: SimContext): boolean {
  const R = ctx.tuning.raid.senseRadius;
  for (const h of ctx.hostiles()) {
    if (Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y) <= R) return true;
  }
  return false;
}

function costOf(ctx: SimContext, defId: string): number {
  return ctx.tuning.buildings[defId]?.cost[K_STOCK_WOOD] ?? Infinity;
}

/** 落子：找位 → 内核判定 → 成功才扣料。
 *  与 building.ts 的差异见文件头第 1 条：内核拒放时不扣料，直接收工（重抽再试）。 */
function buildHere(p: PawnState, ctx: SimContext, defId: string): void {
  const def = ctx.tuning.buildings[defId];
  const spot = findSpot(ctx, p.pos, defId, ctx.tuning.build.searchRadius);
  if (!spot) {
    ctx.finishCard(p); // 找得到空地是 condition 的隐性前提：找不到说明这里真盖不下
    return;
  }
  const built = ctx.addBuilding(defId, spot.x, spot.y);
  if (!built) {
    ctx.finishCard(p); // 内核拒放（同类间距/占位冲突）：不扣料，硬重试是机制链味道
    return;
  }
  for (const [k, v] of Object.entries(def?.cost ?? {})) {
    ctx.stockpile[k] = (ctx.stockpile[k] ?? 0) - v;
  }
  ctx.log(`🏗 ${def?.name ?? defId}建好了`);
  ctx.finishCard(p);
}

/** 环形外扩找可容纳整个 w×h 占地的左上角：脚下一格优先，到 searchRadius 为止。
 *
 *  为什么要自己写一份而不是复用 building.ts 的 findSpot：
 *  building.ts 只查 `ctx.passable`，而 passable 只看**阻挡建筑**的占位表——
 *  可通行建筑（篝火/农田/哨塔/陷阱）不在表里，只查 passable 会把陷阱铺到篝火正上方。
 *  这里额外做一道**占地矩形重叠**判定，对所有建筑（含可通行的）生效。 */
function findSpot(ctx: SimContext, center: Pos, defId: string, maxR: number): Pos | null {
  const w = ctx.tuning.buildings[defId]?.w ?? 1;
  const h = ctx.tuning.buildings[defId]?.h ?? 1;
  const wallGap = Math.max(ctx.tuning.fortify.wallMinGap, ctx.tuning.build.minSpacing);
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        // 取整：鼠坐标是连续的，直接 +偏移 会得到小数建筑坐标（building.ts 的既有行为），
        // 而占地重叠判定是整数格语义，取整才不会"同一格里放两座塔"。
        const x = Math.round(center.x + dx);
        const y = Math.round(center.y + dy);
        if (!footprintFree(ctx, x, y, w, h)) continue;
        if (defId === WALL_ID && !wallGapOk(ctx, x, y, w, h, wallGap)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

/** 占地判定：每一格地形可站 且 不与任何已有建筑（含可通行建筑）的矩形重叠。 */
function footprintFree(ctx: SimContext, x: number, y: number, w: number, h: number): boolean {
  for (let fy = 0; fy < h; fy++) {
    for (let fx = 0; fx < w; fx++) {
      if (!ctx.passable(x + fx, y + fy)) return false;
    }
  }
  for (const b of ctx.buildingsAll()) {
    const f = ctx.tuning.buildings[b.defId];
    const bw = f?.w ?? 1;
    const bh = f?.h ?? 1;
    // 半开区间相交判定：[x, x+w) × [bx, bx+bw)
    if (x < b.pos.x + bw && b.pos.x < x + w && y < b.pos.y + bh && b.pos.y < y + h) return false;
  }
  return true;
}

/** 墙与墙的间距预筛：边到边距离 < wallGap 的候选跳过。
 *  注意这不是冗余检查——内核 world.addBuilding 的同类间距规则**只会拒绝并返回 null**，
 *  而 findSpot 想的是"换个格子"；提前跳过能让墙自然延伸成带而不是原地打转漏掉整卡。
 *  取 max(wallMinGap, build.minSpacing) 保证本阈值永远 ≥ 内核阈值，
 *  即包内预筛**不会**放过内核会拒的候选（想铺更稀疏的墙带就上调 wallMinGap）。 */
function wallGapOk(
  ctx: SimContext,
  x: number,
  y: number,
  w: number,
  h: number,
  gap: number,
): boolean {
  for (const b of ctx.buildingsAll()) {
    if (b.defId !== WALL_ID) continue;
    const f = ctx.tuning.buildings[b.defId];
    const bw = f?.w ?? 1;
    const bh = f?.h ?? 1;
    // 两个轴上分别取"边到边的净距"，负数（重叠）钳到 0
    const dx = Math.max(b.pos.x - (x + w - 1), 0, x - (b.pos.x + bw - 1));
    const dy = Math.max(b.pos.y - (y + h - 1), 0, y - (b.pos.y + bh - 1));
    if (Math.hypot(dx, dy) < gap) return false;
  }
  return true;
}
