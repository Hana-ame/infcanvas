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
  onPrint?: (def: BehaviorCardDef) => void; // 印卡回调（UI 通知等）
}

// 策略卡模板池（系列：work 进决策；label 显示）
// 垦田令/拓荒令 = 种植/迁徙行为：印卡时 tick 侧把对应蓝图放入建造队列
// （垦田令 → farm 蓝图 → 小人建造 → farm 被动产粮 = 种植；
//  拓荒令 → 远处 campfire 蓝图 → 建成 → socialUnit 自动形成新派系 = 迁徙）
const WORK_CARDS = [
  { workType: 'chop', label: '伐木令', series: 'work' },
  { workType: 'mine', label: '采矿令', series: 'work' },
  { workType: 'caveMine', label: '矿洞令', series: 'work' },
  { workType: 'build', label: '建造令', series: 'work' },
  { workType: 'build', label: '垦田令', series: 'work', blueprint: 'farm' },
  { workType: 'build', label: '拓荒令', series: 'work', blueprint: 'campfire' },
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
  if (wood < thr) return workDef('chop', { note: '缺木' });
  if (ore < thr / 2) return workDef('mine', { note: '缺矿' });
  if (queue > 0) return workDef('build', { note: '有建造队列' });
  // 种植：缺粮且农田不足 → 垦田令（建造农田，被动产粮闭环）；农田够 → 仍伐木换粮
  if (food < thr) {
    const farms = [...ctx.world.buildings.values()].filter((b) => b.def.tags?.includes('farm')).length;
    if (farms < 3) return workDef('build', { note: '缺粮垦田', label: '垦田令' });
    return workDef('chop', { note: '缺粮' });
  }
  // 迁徙：人丁兴旺 + 木足 + 尚无第二营地 → 拓荒令（远处建新营地，形成新派系）
  const memberCount = [...ctx.socialUnits.units.values()].reduce((n, u) => n + u.members.length, 0);
  const camps = [...ctx.world.buildings.values()].filter((b) => b.def.id === 'campfire').length;
  if (wood > thr * 4 && memberCount >= 4 && camps < 2) return workDef('build', { note: '人丁兴旺拓荒', label: '拓荒令' });
  if (ctx.isNight()) return lifeDef('rest', '入夜休整');
  return null; // 局面健康 → 不干预（保持小人自主）
}

export function randomPlanner(ctx: SimContext): BehaviorCardDef | null {
  const rng = Math.random;
  if (rng() < 0.6) {
    const w = WORK_CARDS[Math.floor(rng() * WORK_CARDS.length)];
    return workDef(w.workType, { note: '随机策略', label: 'blueprint' in w ? w.label : undefined });
  }
  const l = LIFE_CARDS[Math.floor(rng() * LIFE_CARDS.length)];
  return lifeDef(l.action, '随机策略');
}

// 神谕策略卡效用 = 基础卡基准 + 神谕溢价（策略卡在对应需求存在时必须能赢过基础卡）
// 基础工作卡 utilityFixed：伐木 30 / 采矿 25 / 建造 28；基础休息卡 utilityBase 50（需 rest<40）
const WORK_UTILITY: Record<string, number> = { chop: 34, mine: 31, caveMine: 34, build: 32, till: 34, migrate: 34 };
const LIFE_UTILITY: Record<string, number> = { rest: 25, eat: 25, pray: 12, idle: 12 };

// workDef(workType, opts)：opts.label 覆盖默认（垦田令/拓荒令），id 由 label 派生
function workDef(workType: string, opts: { note: string; label?: string }): BehaviorCardDef {
  const tpl = WORK_CARDS.find((w) => w.workType === workType) ?? WORK_CARDS[0];
  const label = opts.label ?? tpl.label;
  const baseId = label === '垦田令' ? 'till' : label === '拓荒令' ? 'migrate' : workType;
  return {
    id: `dummy:${baseId}`, name: label, series: tpl.series, weight: 9,
    utilityFixed: WORK_UTILITY[baseId] ?? WORK_UTILITY[workType] ?? 30,
    action: 'walkAndWork', workType, label, reason: opts.note,
    satisfies: [{ desire: 'greed', amount: 2 }],
  } as BehaviorCardDef;
}

function lifeDef(action: 'rest' | 'eat' | 'pray' | 'idle', note: string): BehaviorCardDef {
  const tpl = LIFE_CARDS.find((l) => l.action === action) ?? LIFE_CARDS[0];
  return {
    id: `dummy:${action}`, name: tpl.label, series: tpl.series, weight: 6,
    utilityFixed: LIFE_UTILITY[action] ?? 12,
    action, label: tpl.label, reason: note,
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

// 蓝图副作用：按策略卡 id 决定模板与落点
//  - dummy:till：营地（首个 campfire）附近空地放农田蓝图 → 种植闭环（farm 被动产粮）
//  - dummy:migrate：营地外环远处空地放 campfire 蓝图 → 迁徙闭环（建成自动形成新派系）
function applyBlueprint(sim: SimContext, cardId: string): void {
  const blueprint: 'farm' | 'campfire' | null =
    cardId === 'dummy:till' ? 'farm' : cardId === 'dummy:migrate' ? 'campfire' : null;
  if (!blueprint) return;
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
  const chain = blueprint === 'farm' ? [3, 4, 5] : [12, 10, 8];
  for (const r of chain) {
    const spot = findEmpty(r);
    if (spot) {
      cmd.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: blueprint });
      return;
    }
  }
}
