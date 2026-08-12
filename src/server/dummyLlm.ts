// 神谕慢决策层（策略卡全数据化——用户 2026-08-13 定案："真的全部数据化"）
// 策略卡表 = defs/strategyCards.ts（条件/蓝图副作用/权重全声明式，mod 可 registerStrategyCard / defs.strategyCards）
// 引擎只做两件事：feedback = 条件过滤后按 weight 加权采样；random = 全表加权随机采样
// 印卡 → setOracleGoal（目标层）+ blueprint 副作用（数据驱动落点）
import type { BehaviorCardDef } from '../sim/ai/pawn';
import type { SimContext } from '../sim/systems/context';
import { STRATEGY_CARDS, evalStrategyCondition } from '../sim/defs/strategyCards';
import type { StrategyCardDef } from '../sim/defs/strategyCards';

// 印卡接口（未来 LLM 版同签名）：
// planner 输入当前局面，输出一张策略卡 def（null = 本次不印）
export type CardPlanner = (ctx: SimContext) => BehaviorCardDef | null;

export interface DummyPlannerOpts {
  mode?: 'feedback' | 'random'; // feedback: 按当前最缺的生产需求印卡；random: 随机策略卡
  interval?: number;            // 印卡间隔（秒，默认 90）
  seed?: number;                // 确定性种子（测试/可复现）
  onPrint?: (def: BehaviorCardDef) => void; // 印卡回调（UI 通知等）
}

// 通用采样引擎：策略卡表 → 候选池 → 按 weight 加权采样
// feedback：条件满足的卡进候选（健康局面空池 → 不干预）；random：全表
function sampleStrategy(ctx: SimContext, cards: StrategyCardDef[], feedback: boolean): BehaviorCardDef | null {
  // feedback：条件满足的卡进池（always 卡是 random 专用，不参与反馈判定）；
  // random：全表（含无条件生活卡）
  const pool = feedback ? cards.filter((c) => c.condition.kind !== 'always' && evalStrategyCondition(ctx, c.condition)) : cards;
  if (pool.length === 0) return null;
  const weights = pool.map((c) => c.weight);
  const picked = ctx.rng.weightedPick(pool, weights);
  if (!picked) return null;
  return strategyToDef(picked);
}

// 策略卡 def → 神谕目标 def（BehaviorCardDef 形式：横幅/测试兼容）
function strategyToDef(c: StrategyCardDef): BehaviorCardDef {
  return {
    id: c.id, name: c.label, series: c.series ?? 'work', weight: c.weight,
    utilityFixed: 20,
    action: c.action, workType: c.workType, label: c.label, reason: c.reason,
    satisfies: [{ desire: 'greed', amount: 1 }],
  } as BehaviorCardDef;
}

// feedback 模式：条件过滤 + 加权采样（垦田 weight 10 > 缺粮伐木 7 → 农田不足时优先垦田）
export function feedbackPlanner(ctx: SimContext): BehaviorCardDef | null {
  return sampleStrategy(ctx, ctx.mods.strategyCards, true);
}

// random 模式：全表加权随机采样（含无条件卡：觅食/祈祷/放空）
export function randomPlanner(ctx: SimContext): BehaviorCardDef | null {
  return sampleStrategy(ctx, ctx.mods.strategyCards, false);
}



// 定时印卡器：挂到 sim 每 tick 检查（interval 秒印一张，目标随机）
export function makeDummyCardPlanner(sim: SimContext, opts: DummyPlannerOpts = {}): {
  readonly printed: number;
  planner: CardPlanner;
  tick(dt: number): void;
} {
  const mode = opts.mode ?? 'feedback';
  const interval = opts.interval ?? 90;
  let acc = 0;
  let count = 0;
  const planner: CardPlanner = mode === 'random' ? randomPlanner : feedbackPlanner;

  return {
    get printed(): number { return count; },
    planner,
    tick(dt: number): void {
      // 神谕只降目标（策略卡）；科技是另外的池子（用户 2026-08-13 定案：神谕不降科技，
      // 科技机制另行独立，与神谕慢决策层解耦——见 docs 核对清单）
      acc += dt;
      if (acc < interval) return;
      acc = 0;
      const def = planner(sim);
      if (def) {
        // 神谕影响目标层（不碰选择链）：降旨设定目标（对应工作系列抽卡权重 ×oracleGoalMul），
        // 小人仍自主抽卡择优/违抗；蓝图副作用（垦田令→农田、拓荒令→营地）照旧
        // duration 120s：目标影响周期魔数（与 oracleGoal 权重加成的持续时间一致）
        const s = sim as unknown as {
          setOracleGoal(d: { workType?: string; label: string; duration: number }): void;
          logEvent(t: string): void;
        };
        applyBlueprint(sim, def.id);
        s.setOracleGoal?.({ workType: def.workType, label: def.label, duration: 120 });
        count++;
        opts.onPrint?.(def);
      }
    },
  };
}

// 蓝图副作用（数据驱动）：查策略卡表 blueprint 声明（defId/spot），按 spot 规则找落点
//  - nearCamp：营地（首个 campfire）旁环扫 → 种植闭环（垦田令→farm）
//  - far：营地外环远处 → 迁徙闭环（拓荒令→campfire，建成自动形成新派系）
function applyBlueprint(sim: SimContext, cardId: string): void {
  const card = sim.mods.strategyCards.find((c) => c.id === cardId);
  const bp = card?.blueprint;
  if (!bp) return;
  const blueprint = bp.defId;
  const cmd = sim as unknown as {
    issueCommand(c: { type: 'build'; x: number; y: number; buildingId?: string }): void;
    world: {
      buildings: Map<number, { def: { id: string } }>;
      width: number;
      canBuildFootprint(x: number, y: number, def: unknown): boolean;
    };
  };
  const def = sim.mods.buildings[blueprint];
  if (!def) return;
  // 蓝图已在队列 → 跳过（不重复垦田/拓荒）
  if (sim.buildQueue.some((b) => b.defId === blueprint)) return;
  // 营地位置（首个 campfire）
  let camp: { x: number; y: number } | null = null;
  for (const [key, b] of cmd.world.buildings) {
    if (b.def.id === 'campfire') {
      camp = { x: key % cmd.world.width, y: Math.floor(key / cmd.world.width) };
      break;
    }
  }
  // 扫描环形（切比雪夫距离 == radius）找合法落点（canBuildFootprint 校验 footprint，farm 2×2 安全）
  const findEmpty = (radius: number): { x: number; y: number } | null => {
    const w = cmd.world;
    if (!camp) return null;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = camp.x + dx;
        const y = camp.y + dy;
        if (w.canBuildFootprint(x, y, def)) return { x, y };
      }
    }
    return null;
  };
  // 半径由近及远回退（营地旁挤满 → 稍远，保证垦田/拓荒不因落点失效而白印）
  const chain = bp.spot === 'nearCamp' ? [3, 4, 5] : [12, 10, 8];
  for (const r of chain) {
    const spot = findEmpty(r);
    if (spot) {
      cmd.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: blueprint });
      return;
    }
  }
}
