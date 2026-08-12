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

// 扩建计划（数据驱动：阈值来自 tuning.autobuild，mod 可注册额外计划）
export interface ExpansionPlan {
  id: string;
  defId: string;
  minWood: number;
  need: (ctx: SimContext) => boolean;
  onExisting?: boolean;  // 为 true 时在"可升级为此建筑"的现有建筑（def.upgradesTo === defId）上原地升级，而非找空地新建
}

// 内置计划构造：所有阈值读 tuning.autobuild（docs/DATA_DRIVEN.md §4）
const buildBasePlans = (ctx: SimContext): ExpansionPlan[] => {
  const t = ctx.tuning.autobuild;
  return [
    // 营地无篝火 → 先起篝火（社会锚点）
    { id: 'campfire', defId: 'campfire', minWood: t.campfireWood, need: (c) => !c.world.hasBuilding('campfire') },
    // 人多且篝火少 → 加篝火
    { id: 'campfire2', defId: 'campfire', minWood: t.campfireWoodExtra, need: (c) => c.pawnList.length >= t.pawnsPerCampfire && countBuilding(c, 'campfire') < t.campfireTarget },
    // 食物常短缺 → 扩农田
    { id: 'farm', defId: 'farm', minWood: t.farmWood, need: (c) => (c.stockpile.food ?? 0) < t.foodThreshold && countBuilding(c, 'farm') < t.farmTarget },
    // 工具缺 → 建工作台
    { id: 'workbench', defId: 'workbench', minWood: t.workbenchWood, need: (c) => (c.stockpile.tools ?? 0) < t.toolsThreshold && countBuilding(c, 'workbench') < t.workbenchTarget },
    // 矿少 → 建矿洞（持续产矿）
    { id: 'cave', defId: 'cave', minWood: t.caveWood, need: (c) => (c.stockpile.ore ?? 0) < t.oreThreshold && countBuilding(c, 'cave') < t.caveTarget },
    // 信仰高 → 把营地篝火升级为教堂（数据驱动：campfire.def.upgradesTo==='church'）
    { id: 'church', defId: 'church', minWood: t.churchWood, onExisting: true, need: (c) => avgFaith(c) >= t.faithThreshold && countBuilding(c, 'church') < 1 },
    // 资源富余 → 围营地墙
    { id: 'wall', defId: 'wall', minWood: t.wallWood, need: (c) => c.stockpile.wood > t.wallWood && countBuilding(c, 'wall') < t.wallTarget },
  ];
};

export class AutonomousBuildSystem implements GameSystem {
  id = 'autobuild';
  private timer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    const t = this.ctx.tuning.autobuild;
    this.timer = t.evaluateMin + Math.floor(this.ctx.rng.next() * (t.evaluateMax - t.evaluateMin)); // 每轮评估间隔
    this.evaluate(t.maxPerEval);
  }

  private evaluate(maxPerEval: number): void {
    const w = this.ctx.world;
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    // 内置计划 + mod 注册计划（mod 优先，可覆盖/追加）
    const plans = [...buildBasePlans(this.ctx), ...this.ctx.mods.expansionPlans];
    let pushed = 0;
    for (const plan of plans) {
      if (pushed >= maxPerEval) break; // 每次评估最多规划 N 个，防资源失控
      if (this.ctx.buildQueue.some((b) => b.defId === plan.defId)) continue; // 已有排队蓝图
      if (this.ctx.buildingDef(plan.defId)?.tech && !this.ctx.techs.has(this.ctx.buildingDef(plan.defId)!.tech!)) continue; // 科技锁
      if (this.ctx.stockpile.wood < plan.minWood) continue;
      if (!plan.need(this.ctx)) continue;
      // 升级计划：在可升级源（def.upgradesTo === plan.defId）上原地升级；否则找空地新建
      let spot: { x: number; y: number } | null = null;
      if (plan.onExisting) {
        spot = this.findUpgradeSource(plan.defId);
      } else {
        spot = this.findBuildSpot(cx, cy, plan.defId);
      }
      if (spot) {
        // 成本与手动队列一致（def.costWood/costOre；缺省 size²×2 木 / 0 矿）
        const def = this.ctx.buildingDef(plan.defId);
        const t = this.ctx.tuning.autobuild;
        this.ctx.buildQueue.push({
          x: spot.x, y: spot.y, defId: plan.defId, progress: 0, faction: 'auto',
          cost: { wood: def?.costWood ?? def ? def.size.x * def.size.y * t.costWoodPerCell : t.costWoodFallback, ore: def?.costOre ?? t.costOreFallback },
        });
        this.ctx.logEvent(`🏗 AI 规划：${plan.onExisting ? '升级' : '建造'}【${plan.defId}】`);
        pushed++;
      }
    }
  }

  // 找一个可升级源建筑（def.upgradesTo === targetDefId），用于原地升级
  private findUpgradeSource(targetDefId: string): { x: number; y: number } | null {
    const w = this.ctx.world;
    for (const [key, b] of w.buildings) {
      if (b.def.upgradesTo === targetDefId) {
        return { x: key % w.width, y: Math.floor(key / w.width) };
      }
    }
    return null;
  }

  // 找空地：用 footprint 校验（farm 2×2 / church 2×2 落点必须整块合法，
  // 此前单格 canBuildAt 会让大建筑蓝图落到重叠格 → 建成时被 buildSystem 放弃）
  private findBuildSpot(cx: number, cy: number, defId: string): { x: number; y: number } | null {
    const w = this.ctx.world;
    const t = this.ctx.tuning.autobuild;
    const def = this.ctx.buildingDef(defId);
    for (let r = t.spotRingMin; r <= t.spotRingMax; r++) {
      for (let attempt = 0; attempt < t.spotAttempts; attempt++) {
        const a = this.ctx.rng.next() * Math.PI * 2;
        const x = cx + Math.round(Math.cos(a) * r);
        const y = cy + Math.round(Math.sin(a) * r);
        // 有 def → footprint 校验；无 def（mod 计划只注蓝图）→ 单格兼容
        if (def ? w.canBuildFootprint(x, y, def) : (w.inBounds(x, y) && w.canBuildAt(x, y))) return { x, y };
      }
    }
    return null;
  }
}
