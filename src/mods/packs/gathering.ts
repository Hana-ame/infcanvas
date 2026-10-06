/**
 * gathering 包 —— 采集种子卡：采野果（→食物）/ 砍树（→木材）。
 *
 * 设计：工作 = 走到目标旁 + 每 tick 收割一份，采空进入再生冷却（world.takeOne）。
 * 没有任务队列：谁抽到卡谁来干；两鼠同时盯一丛浆果就一起采——拥挤与竞争是涌现，
 * 不是要消灭的 bug。
 *
 * 寻路联动（2026-08-21 补，此前补丁因脚本中断未落盘——测试空转通过被 review 揪出）：
 *  - 多格特征（2×2 大树）：邻接按"到占地矩形距离"判定；寻路落点 = 矩形周边最近可走格。
 *  - 单槽避让：寻路失败的目标格登记 avoidFeat 30s，条件过滤跳过，
 *    防"看得见够不着"的条件恒真抽卡死循环（鼠站水边反复抽卡一步不动）。
 */
import type { ModPack } from '../pack';
import { K_STOCK_FOOD, K_STOCK_WOOD, K_TAG_FIRE } from '../contracts';
import { SER_GATHER, SER_WOOD } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState, FeatureHit } from '../../sim/types';

/** 避让时长秒数：远大于一次重抽周期、小于再生冷却——够绕开又不永久拉黑 */
const AVOID_SEC = 30;

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** 最近且未被本鼠避让、且在营地射程内的特征 */
function nearestReachable(p: PawnState, ctx: SimContext, kind: FeatureHit['kind'], senseR: number): FeatureHit | null {
  const f = ctx.nearestFeature(kind, p.pos.x, p.pos.y, senseR);
  if (!f) return null;
  const av = p.avoidFeat;
  if (av && av.until > ctx.time && av.x === f.x && av.y === f.y) return null;
  // 营地射程：离最近火堆太远的目标不去（防鼠群无限扩散）
  const anyFire = ctx.nearestBuildingByTag(K_TAG_FIRE, f.x, f.y);
  if (anyFire) {
    const d = Math.hypot(f.x - anyFire.pos.x, f.y - anyFire.pos.y);
    if (d > ctx.tuning.build.maxForageDist) return null;
  }
  return f;
}

export const gatheringPack: ModPack = {
  id: 'gathering',
  requires: [],
  apply(m) {
    // 感知半径进 tuning.gathering.senseRadius（原则③：数值不硬编码）
    m.registerCard({
      id: 'gather_berry',
      label: '采野果',
      series: SER_GATHER,
      weight: 10,
      duration: 8,
      condition: (p, ctx) => nearestReachable(p, ctx, 'berry', ctx.tuning.gathering.senseRadius) !== null,
      action(p, ctx) {
        workFeature(p, ctx, 'berry', K_STOCK_FOOD);
      },
    });
    m.registerCard({
      id: 'chop_tree',
      label: '砍树',
      series: SER_WOOD,
      weight: 9,
      duration: 6,
      condition: (p, ctx) => nearestReachable(p, ctx, 'tree', ctx.tuning.gathering.senseRadius) !== null,
      action(p, ctx) {
        workFeature(p, ctx, 'tree', K_STOCK_WOOD);
      },
    });
  },
};

/** 工作循环体（两张采集卡共享）：不在目标旁 → 走到周边最近可走格（仅在无路时规划）；
 *  在旁 → 每 tick 收 1 份入库（takeOne 维护余量/再生），采空 → 收工重抽。 */
function workFeature(p: PawnState, ctx: SimContext, kind: FeatureHit['kind'], stockKey: string): void {
  const f = nearestReachable(p, ctx, kind, ctx.tuning.gathering.senseRadius);
  if (!f) {
    ctx.finishCard(p); // 目标没了（被别的鼠采光）/处于避让期：收工
    return;
  }
  const rect: Rect = ctx.featureRect(f);
  // 多格特征邻接：点到占地矩形距离 ≤1.5 即算"在旁边"（大树贴边即可开工）
  if (ctx.distToFeatureRect(p.pos.x, p.pos.y, rect) > 1.5) {
    if (p.path.length === 0) {
      const goal = ctx.nearestFreeAdjacent(rect, p.pos.x, p.pos.y);
      // 不可达（水/岩围住）就登记避让再收工——否则条件恒真、原地空转
      if (!goal || !ctx.setPath(p, goal.x, goal.y)) {
        p.avoidFeat = { x: f.x, y: f.y, until: ctx.time + AVOID_SEC };
        ctx.finishCard(p);
      }
    }
    return; // 路上——引擎 moveStep 推进
  }
  p.path = []; // 贴边停走
  const left = ctx.takeOne(f.x, f.y);
  if (left < 0) {
    ctx.finishCard(p); // 特征恰好失效（竞态/冷却）：下轮重抽
    return;
  }
  ctx.stockpile[stockKey] = (ctx.stockpile[stockKey] ?? 0) + 1;
  if (left === 0) ctx.finishCard(p); // 采空：收工
}
