// LLM 慢决策层 dummy（用户指定：先不调真 API，用随机/反馈方式模拟 LLM 印卡）
// 真 LLM 版将实现同一 CardPlanner 接口（生成策略卡 def → sim.printCard），
// 这里用确定性规则/随机生成同样的输出，把「LLM 只印卡」链路先跑通。
// 用法（server/index.ts）：LLM_DUMMY=1 启用（无 API key、零成本、可离线）
import type { BehaviorCardDef } from '../sim/ai/pawn';
import type { SimContext } from '../sim/systems/context';

// 印卡接口（未来 LLM 版同签名）：
// planner 输入当前局面，输出一张策略卡 def（null = 本次不印）
export type CardPlanner = (ctx: SimContext) => BehaviorCardDef | null;

export interface DummyPlannerOpts {
  mode?: 'feedback' | 'random'; // feedback: 按当前最缺的生产需求印卡；random: 随机策略卡
  interval?: number;            // 印卡间隔（秒，默认 90）
  seed?: number;                // 确定性种子（测试/可复现）
}

// 策略卡模板池（系列：work 进决策；label 显示）
const WORK_CARDS = [
  { workType: 'chop', label: '伐木令', series: 'work' },
  { workType: 'mine', label: '采矿令', series: 'work' },
  { workType: 'caveMine', label: '矿洞令', series: 'work' },
  { workType: 'build', label: '建造令', series: 'work' },
] as const;
const LIFE_CARDS = [
  { action: 'rest', label: '休整令', series: 'physio' },
  { action: 'eat', label: '觅食令', series: 'physio' },
  { action: 'pray', label: '祈祷令', series: 'religion' },
  { action: 'idle', label: '放空令', series: 'leisure' },
] as const;

// 反馈式印卡：读库存/队列/时段，印"当下最需要"的生产/休整卡
export function feedbackPlanner(ctx: SimContext): BehaviorCardDef | null {
  const t = ctx.tuning;
  const s = ctx.stockpile;
  const wood = s.wood ?? 0;
  const ore = s.ore ?? 0;
  const food = s.food ?? 0;
  const queue = ctx.buildQueue?.length ?? 0;
  const thr = t.population.foodThreshold; // 共用库存门槛（数据驱动铁律：阈值读 tuning）
  if (wood < thr) return workDef('chop', '缺木');
  if (ore < thr / 2) return workDef('mine', '缺矿');
  if (queue > 0) return workDef('build', '有建造队列');
  if (food < thr) return workDef('chop', '缺粮');
  if (ctx.isNight()) return lifeDef('rest', '入夜休整');
  return null; // 局面健康 → 不干预（保持小人自主）
}

export function randomPlanner(ctx: SimContext): BehaviorCardDef | null {
  const rng = Math.random;
  if (rng() < 0.6) {
    const w = WORK_CARDS[Math.floor(rng() * WORK_CARDS.length)];
    return workDef(w.workType, '随机策略');
  }
  const l = LIFE_CARDS[Math.floor(rng() * LIFE_CARDS.length)];
  return lifeDef(l.action, '随机策略');
}

// 神谕策略卡效用 = 基础卡基准 + 神谕溢价（策略卡在对应需求存在时必须能赢过基础卡）
// 基础工作卡 utilityFixed：伐木 30 / 采矿 25 / 建造 28；基础休息卡 utilityBase 50（需 rest<40）
const WORK_UTILITY: Record<string, number> = { chop: 34, mine: 31, caveMine: 34, build: 32 };
const LIFE_UTILITY: Record<string, number> = { rest: 25, eat: 25, pray: 12, idle: 12 };

function workDef(workType: string, note: string): BehaviorCardDef {
  const tpl = WORK_CARDS.find((w) => w.workType === workType) ?? WORK_CARDS[0];
  return {
    id: `dummy:${workType}`, name: tpl.label, series: tpl.series, weight: 9,
    utilityFixed: WORK_UTILITY[workType] ?? 30,
    action: 'walkAndWork', workType, label: tpl.label,
    satisfies: [{ desire: 'greed', amount: 2 }],
  } as BehaviorCardDef;
}

function lifeDef(action: 'rest' | 'eat' | 'pray' | 'idle', note: string): BehaviorCardDef {
  const tpl = LIFE_CARDS.find((l) => l.action === action) ?? LIFE_CARDS[0];
  return {
    id: `dummy:${action}`, name: tpl.label, series: tpl.series, weight: 6,
    utilityFixed: LIFE_UTILITY[action] ?? 12,
    action, label: tpl.label,
    satisfies: [{ desire: 'sloth', amount: 1 }],
  } as BehaviorCardDef;
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
      acc += dt;
      if (acc < interval) return;
      acc = 0;
      const def = planner(sim);
      if (def) {
        // SimContext 不含 printCard（印卡是 Sim 的 LLM 专属 API）——运行时经由 sim 本体
        const s = sim as unknown as { printCard(d: BehaviorCardDef): number | null };
        if (s.printCard?.(def) !== null) count++;
      }
    },
  };
}
