// 策略卡数据表（神谕降旨全数据化——用户 2026-08-13 定案："真的要全部数据化"）
// 加一张策略卡 = 表里加一行（条件/蓝图副作用/权重全声明式），mod 可 registerStrategyCard / defs.strategyCards
// 引擎（dummyLlm）只做两件事：按条件过滤（feedback）或不过滤（random）→ 按 weight 加权采样
import type { SimContext } from '../systems/context';

// 触发条件（声明式；数值可引用 tuning 键：below { tuning: 'population.foodThreshold', div: 2 }）
export type StrategyCondition =
  // 资源低于阈值（可选：某建筑数量 < lessThan 才触发）
  | { kind: 'stockLow'; item: string; below: number | { tuning: string; div?: number }; countBuilding?: { defId: string; lessThan: number } }
  // 人口 ≥ n（可选：木 > stockWoodGt、篝火数 < campsLessThan）
  | { kind: 'populationAtLeast'; n: number; stockWoodGt?: number | { tuning: string }; campsLessThan?: number }
  // 有建造队列
  | { kind: 'queue' }
  // 入夜
  | { kind: 'night' }
  // 无条件（random 采样池用）
  | { kind: 'always' };

export interface StrategyBlueprint {
  defId: string;              // 蓝图建筑（垦田令→farm、拓荒令→campfire）
  spot: 'nearCamp' | 'far';   // 落点：营地旁环扫 / 远处环扫
}

export interface StrategyCardDef {
  id: string;
  label: string;              // 降旨文本（垦田令/拓荒令…）
  action: 'walkAndWork' | 'rest' | 'eat' | 'pray' | 'idle';
  workType?: string;          // walkAndWork 目标工作（oracleGoal 权重调制对象）
  series?: string;            // 缺省 'work'
  duration?: number;          // 目标持续秒数（缺省 120）
  weight: number;             // 采样权重（同条件多卡时高权重更可能）
  condition: StrategyCondition;
  blueprint?: StrategyBlueprint;
  reason?: string;            // 降旨原因（横幅显示）
}

// 求值：tuning 引用 → 数值（支持点路径 'population.foodThreshold'；数据驱动铁律：阈值读 tuning，mod 可覆盖）
function num(v: number | { tuning: string; div?: number }, ctx: SimContext): number {
  if (typeof v === 'number') return v;
  let raw: unknown = ctx.tuning;
  for (const k of v.tuning.split('.')) raw = (raw as Record<string, unknown>)[k];
  const n = Number(raw);
  return (v.div ?? 1) > 1 ? n / (v.div ?? 1) : n;
}

export function evalStrategyCondition(ctx: SimContext, cond: StrategyCondition): boolean {
  const s = ctx.stockpile;
  switch (cond.kind) {
    case 'stockLow': {
      if ((s[cond.item] ?? 0) >= num(cond.below, ctx)) return false;
      if (cond.countBuilding) {
        let n = 0;
        for (const [, b] of ctx.world.buildings) if (b.def.id === cond.countBuilding.defId) n++;
        if (n >= cond.countBuilding.lessThan) return false;
      }
      return true;
    }
    case 'populationAtLeast': {
      if (ctx.pawnList.length < cond.n) return false;
      if (cond.stockWoodGt !== undefined && (s.wood ?? 0) <= num(cond.stockWoodGt, ctx)) return false;
      if (cond.campsLessThan !== undefined) {
        let camps = 0;
        for (const [, b] of ctx.world.buildings) if (b.def.id === 'campfire') camps++;
        if (camps >= cond.campsLessThan) return false;
      }
      return true;
    }
    case 'queue': return (ctx.buildQueue?.length ?? 0) > 0;
    case 'night': return ctx.isNight();
    case 'always': return true;
  }
}

// 内置策略卡表（全部声明化）：
// 经济调节不靠"伐木令"——收益/支出账本自动调工作概率（factionPriority flowAt）
//（用户 2026-08-13 定案：伐木令退位为"单次不永久提升收益行为概率"的可选神谕目标，
//  不再承担经济平衡；故表中只有结构性/行为类策略卡）
export const STRATEGY_CARDS: StrategyCardDef[] = [
  { id: 'oracle:build', label: '建造令', action: 'walkAndWork', workType: 'build', weight: 8, condition: { kind: 'queue' }, reason: '有建造队列' },
  { id: 'oracle:till', label: '垦田令', action: 'walkAndWork', workType: 'build', weight: 10, condition: { kind: 'stockLow', item: 'food', below: { tuning: 'population.foodThreshold' }, countBuilding: { defId: 'farm', lessThan: 3 } }, blueprint: { defId: 'farm', spot: 'nearCamp' }, reason: '缺粮垦田' },
  { id: 'oracle:migrate', label: '拓荒令', action: 'walkAndWork', workType: 'build', weight: 9, condition: { kind: 'populationAtLeast', n: 4, stockWoodGt: { tuning: 'population.foodThreshold' }, campsLessThan: 2 }, blueprint: { defId: 'campfire', spot: 'far' }, reason: '人丁兴旺拓荒' },
  { id: 'oracle:rest', label: '休整令', action: 'rest', series: 'physio', weight: 6, condition: { kind: 'night' }, reason: '入夜休整' },
  { id: 'oracle:eat', label: '觅食令', action: 'eat', series: 'physio', weight: 5, condition: { kind: 'always' }, reason: '补充体力' },
  { id: 'oracle:pray', label: '祈祷令', action: 'pray', series: 'religion', weight: 4, condition: { kind: 'always' }, reason: '安神' },
  { id: 'oracle:idle', label: '放空令', action: 'idle', series: 'leisure', weight: 3, condition: { kind: 'always' }, reason: '休整' },
];
