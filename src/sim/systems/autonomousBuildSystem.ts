// 自主建造系统（用户 Q1/Q8：观察模拟器 + 营地自主扩张）
// AI 评估资源与营地状态，自动规划扩建（篝火/墙/农田/工作台/矿洞），让营地自己长起来
// 不玩家指挥 → buildQueue 由系统注入，小人照常执行
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

const countBuilding = (ctx: SimContext, defId: string): number => {
  let n = 0;
  for (const [, b] of ctx.world.buildings) {
    if (b.def.id === defId) n++;
  }
  return n;
};

// 营地平均信仰（评估是否到建教堂门槛）
const avgFaith = (ctx: SimContext): number => {
  if (ctx.pawnList.length === 0) return 0;
  let sum = 0;
  for (const eid of ctx.pawnList) sum += ctx.pawnStates.get(eid)?.faith ?? 0;
  return sum / ctx.pawnList.length;
};

// 扩建计划（按优先级）
const EXPANSION_PLAN: { defId: string; minWood: number; need: (ctx: SimContext) => boolean }[] = [
  // 营地无篝火 → 先起篝火（社会锚点）
  { defId: 'campfire', minWood: 6, need: (c) => !c.world.hasBuilding('campfire') },
  // 人多且篝火少 → 加篝火
  { defId: 'campfire', minWood: 10, need: (c) => c.pawnList.length >= 4 && countBuilding(c, 'campfire') < 2 },
  // 食物常短缺 → 扩农田
  { defId: 'farm', minWood: 12, need: (c) => (c.stockpile.food ?? 0) < 80 && countBuilding(c, 'farm') < 3 },
  // 工具缺 → 建工作台
  { defId: 'workbench', minWood: 20, need: (c) => (c.stockpile.tools ?? 0) < 2 && countBuilding(c, 'workbench') < 2 },
  // 矿少 → 建矿洞（持续产矿）
  { defId: 'cave', minWood: 15, need: (c) => (c.stockpile.ore ?? 0) < 20 && countBuilding(c, 'cave') < 2 },
  // 信仰高 → 把营地篝火升级为教堂（Q9 即时指令：教堂=篝火升级）
  { defId: 'church', minWood: 25, need: (c) => avgFaith(c) >= 35 && countBuilding(c, 'church') < 1 },
  // 资源富余 → 围营地墙
  { defId: 'wall', minWood: 30, need: (c) => c.stockpile.wood > 60 && countBuilding(c, 'wall') < 6 },
];

export class AutonomousBuildSystem implements GameSystem {
  id = 'autobuild';
  private timer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 20 + Math.floor(this.ctx.rng.next() * 10); // 20-30s 评估一次
    this.evaluate();
  }

  private evaluate(): void {
    const w = this.ctx.world;
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    let pushed = 0;
    for (const plan of EXPANSION_PLAN) {
      if (pushed >= 2) break; // 每次评估最多规划 2 个，防资源失控
      if (this.ctx.buildQueue.some((b) => b.defId === plan.defId)) continue; // 已有排队蓝图
      if (this.ctx.stockpile.wood < plan.minWood) continue;
      if (!plan.need(this.ctx)) continue;
      // 教堂 = 篝火升级：在原篝火位置重建为教堂（Q9 即时指令）
      let spot: { x: number; y: number } | null = null;
      if (plan.defId === 'church') {
        const fire = this.findCampfire();
        if (fire) spot = fire;
      } else {
        spot = this.findBuildSpot(cx, cy);
      }
      if (spot) {
        this.ctx.buildQueue.push({
          x: spot.x, y: spot.y, defId: plan.defId, progress: 0, faction: 'auto',
          cost: { wood: 1, ore: 0 },
        });
        this.ctx.logEvent(`🏗 AI 规划：${plan.defId === 'church' ? '把篝火升级为教堂' : `建造【${plan.defId}】`}`);
        pushed++;
      }
    }
  }

  // 找一个篝火单位的位置（用于升级为教堂）
  private findCampfire(): { x: number; y: number } | null {
    const w = this.ctx.world;
    for (const [key, b] of w.buildings) {
      if (b.def.id === 'campfire') {
        return { x: key % w.width, y: Math.floor(key / w.width) };
      }
    }
    return null;
  }

  private findBuildSpot(cx: number, cy: number): { x: number; y: number } | null {
    const w = this.ctx.world;
    for (let r = 2; r <= 6; r++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const a = this.ctx.rng.next() * Math.PI * 2;
        const x = cx + Math.round(Math.cos(a) * r);
        const y = cy + Math.round(Math.sin(a) * r);
        if (!w.inBounds(x, y) || !w.canBuildAt(x, y)) continue;
        return { x, y };
      }
    }
    return null;
  }
}
