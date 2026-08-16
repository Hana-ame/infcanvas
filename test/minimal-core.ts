/**
 * test/minimal-core.ts
 *
 * 用途：验证 docs/REIMPLEMENT_PROMPT.md 的“最小核心”可行性。
 * 范围：只做两件事——
 *   1. 一切皆抽卡：小人每个 tick 的行为从“卡池”按权重抽取，不存在行为树/任务队列。
 *   2. 自主生存循环：4 只鼠鼠出生后自动采集/进食/睡觉/社交/建造篝火。
 * 刻意不实现：寻路 A*、WSS 同步、无限地图、存档、渲染。
 * 刻意隔离：本目录不修改主代码；运行入口见 README.md。
 */

export type CardId =
  | 'idle'
  | 'gatherFood'
  | 'eat'
  | 'gatherWood'
  | 'buildCampfire'
  | 'rest'
  | 'socialize';

export interface Pawn {
  id: number;
  name: string;
  x: number;
  y: number;
  hp: number;
  food: number;
  rest: number;
  mood: number;
  san: number;
  /** 熟练度：卡被触发上升、长期不用下降（卡=习惯的建模） */
  mastery: Partial<Record<CardId, number>>;
  /** 统计每张卡触发次数，用于验证“抽卡驱动”与“习惯演化” */
  uses: Partial<Record<CardId, number>>;
  /** 当前正在执行的卡（调试/日志用） */
  currentCard: CardId | null;
}

export interface Card {
  id: CardId;
  label: string;
  baseWeight: number;
  /** 谓词：卡是否可被抽（不构成行为树，只是数据表过滤） */
  condition: (pawn: Pawn, sim: TinySim) => boolean;
  /** 卡被执行时的效果 */
  effect: (pawn: Pawn, sim: TinySim) => void;
}

export interface Stockpile {
  food: number;
  wood: number;
}

export interface SimOptions {
  seed?: number;
  pawnCount?: number;
  /** 神谕目标：给某个工作系列权重乘数。例如 { gatherFood: 3 } = 采集令 */
  oracleGoal?: Partial<Record<CardId, number>>;
  mapW?: number;
  mapH?: number;
  log?: boolean;
}

/** 极简世界：只放生存闭环需要的资源点与篝火 */
export interface TinyWorld {
  w: number;
  h: number;
  berries: { x: number; y: number; amount: number }[];
  trees: { x: number; y: number; hp: number }[];
  campfires: { x: number; y: number }[];
}

export class TinySim {
  readonly world: TinyWorld;
  readonly stockpile: Stockpile = { food: 0, wood: 0 };
  readonly pawns: Pawn[] = [];
  readonly events: string[] = [];
  readonly oracleGoal: Partial<Record<CardId, number>>;
  readonly cards: Card[];
  tick = 0;
  private rng: () => number;
  private logEnabled: boolean;

  constructor(opts: SimOptions = {}) {
    const seed = opts.seed ?? 20260816;
    this.rng = mulberry32(seed);
    this.oracleGoal = opts.oracleGoal ?? {};
    this.logEnabled = opts.log ?? false;
    this.world = makeWorld(opts.mapW ?? 24, opts.mapH ?? 24, this.rng);
    this.cards = makeCards();

    const count = opts.pawnCount ?? 4;
    const cx = Math.floor(this.world.w / 2);
    const cy = Math.floor(this.world.h / 2);
    for (let i = 0; i < count; i++) {
      const x = cx + (i % 2 === 0 ? -1 : 1) + Math.floor(this.rng() * 3 - 1);
      const y = cy + (i < 2 ? -1 : 1) + Math.floor(this.rng() * 3 - 1);
      this.pawns.push({
        id: i + 1,
        name: `鼠${i + 1}`,
        x: clamp(x, 1, this.world.w - 2),
        y: clamp(y, 1, this.world.h - 2),
        hp: 100,
        food: 80 + Math.floor(this.rng() * 20),
        rest: 80 + Math.floor(this.rng() * 20),
        mood: 80 + Math.floor(this.rng() * 20),
        san: 100,
        mastery: {},
        uses: {},
        currentCard: null,
      });
    }
    this.logEvent('🏕 4 只鼠鼠出生，试验“一切皆抽卡”最小核心');
  }

  step(seconds = 1): void {
    this.tick += seconds;
    for (const pawn of this.pawns) {
      decayNeeds(pawn, seconds);
      const card = this.drawCard(pawn);
      pawn.currentCard = card.id;
      if (this.logEnabled) {
        this.logEvent(`[${this.tick}s] ${pawn.name} 抽到「${card.label}」(${this.shortState(pawn)})`);
      }
      card.effect(pawn, this);
      this.recordUse(pawn, card.id);
      this.decayUnusedMastery(pawn, card.id);
      // 死亡/失去意识的最简处理：食物/休息归零不会立刻死，但会强制 idle/rest 类卡权重拉高
      pawn.san = Math.max(0, Math.min(100, pawn.san));
      pawn.mood = Math.max(0, Math.min(100, pawn.mood));
    }
    this.logEvent(`[${this.tick}s] 库存: 🍎${this.stockpile.food} 🪵${this.stockpile.wood} 🔥${this.world.campfires.length}`);
  }

  run(totalTicks: number): void {
    for (let t = 0; t < totalTicks; t++) this.step(1);
  }

  /** 抽卡核心：候选 + 权重 = 基础权重 × 需求调制 × 熟练度 × 神谕 */
  drawCard(pawn: Pawn): Card {
    const candidates = this.cards.filter((c) => c.condition(pawn, this));
    const weights = candidates.map((c) => this.cardWeight(pawn, c));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      // 理论兜底：没有任何卡可抽时发呆
      return this.cards.find((c) => c.id === 'idle')!;
    }
    let r = this.rng() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  cardWeight(pawn: Pawn, card: Card): number {
    const base = card.baseWeight;
    const need = needModifier(pawn, card.id);
    const mastery = pawn.mastery[card.id] ?? 0;
    const habit = 0.5 + mastery / 100;
    const oracle = this.oracleGoal[card.id] ?? 1;
    const w = base * need * habit * oracle;
    // 熟练度长期不用的衰减在 step 中处理；这里只返回当前权重
    return Math.max(0, w);
  }

  private recordUse(pawn: Pawn, id: CardId): void {
    pawn.uses[id] = (pawn.uses[id] ?? 0) + 1;
    pawn.mastery[id] = Math.min(100, (pawn.mastery[id] ?? 0) + 2);
  }

  private decayUnusedMastery(pawn: Pawn, used: CardId): void {
    for (const id of ALL_CARD_IDS) {
      if (id === used) continue;
      const v = pawn.mastery[id] ?? 0;
      if (v > 0) pawn.mastery[id] = Math.max(0, v - 0.02);
    }
  }

  logEvent(msg: string): void {
    if (this.logEnabled) this.events.push(msg);
  }

  private shortState(pawn: Pawn): string {
    return `🍗${Math.round(pawn.food)} 😴${Math.round(pawn.rest)} 😊${Math.round(pawn.mood)}`;
  }

  // ---- 世界查询/操作（供卡的 condition/effect 使用） ----
  nearestBerry(pawn: Pawn): { x: number; y: number; amount: number } | null {
    return nearest(this.world.berries, pawn.x, pawn.y);
  }

  nearestTree(pawn: Pawn): { x: number; y: number; hp: number } | null {
    return nearest(this.world.trees, pawn.x, pawn.y);
  }

  nearbyPawn(pawn: Pawn, radius = 2): Pawn | null {
    let best: Pawn | null = null;
    let bestD = radius;
    for (const other of this.pawns) {
      if (other.id === pawn.id) continue;
      const d = Math.hypot(other.x - pawn.x, other.y - pawn.y);
      if (d <= bestD) {
        best = other;
        bestD = d;
      }
    }
    return best;
  }

  nearCampfire(pawn: Pawn): boolean {
    return this.world.campfires.some((c) => Math.hypot(c.x - pawn.x, c.y - pawn.y) <= 2);
  }

  moveToward(pawn: Pawn, tx: number, ty: number): void {
    const dx = Math.sign(tx - pawn.x);
    const dy = Math.sign(ty - pawn.y);
    if (dx !== 0) pawn.x += dx;
    else if (dy !== 0) pawn.y += dy;
    pawn.x = clamp(pawn.x, 0, this.world.w - 1);
    pawn.y = clamp(pawn.y, 0, this.world.h - 1);
  }
}

// ---------------------------------------------------------------------------
// 卡表：这是“一切皆抽卡”的数据面。权重/谓词/效果都在这里。
// 禁止在 Sim 里写“if 食物低就吃”这种行为树——需求只通过权重调制抽卡。
// ---------------------------------------------------------------------------
function makeCards(): Card[] {
  return [
    {
      id: 'gatherFood',
      label: '采集野果',
      baseWeight: 10,
      condition: () => true,
      effect(pawn, sim) {
        const b = sim.nearestBerry(pawn);
        if (!b) return;
        if (Math.hypot(b.x - pawn.x, b.y - pawn.y) <= 1.5) {
          const take = Math.min(b.amount, 2);
          b.amount -= take;
          sim.stockpile.food += take;
          if (b.amount <= 0) sim.world.berries.splice(sim.world.berries.indexOf(b), 1);
        } else {
          sim.moveToward(pawn, b.x, b.y);
        }
      },
    },
    {
      id: 'eat',
      label: '吃东西',
      baseWeight: 8,
      condition: (pawn, sim) => sim.stockpile.food > 0 && pawn.food < 70,
      effect(pawn, sim) {
        sim.stockpile.food -= 1;
        pawn.food = Math.min(100, pawn.food + 35);
        pawn.mood = Math.min(100, pawn.mood + 2);
      },
    },
    {
      id: 'gatherWood',
      label: '砍柴',
      baseWeight: 7,
      condition: () => true,
      effect(pawn, sim) {
        const t = sim.nearestTree(pawn);
        if (!t) return;
        if (Math.hypot(t.x - pawn.x, t.y - pawn.y) <= 1.5) {
          t.hp -= 1;
          if (t.hp <= 0) {
            sim.world.trees.splice(sim.world.trees.indexOf(t), 1);
            sim.stockpile.wood += 1;
          }
        } else {
          sim.moveToward(pawn, t.x, t.y);
        }
      },
    },
    {
      id: 'buildCampfire',
      label: '建造篝火',
      baseWeight: 4,
      condition: (pawn, sim) => sim.stockpile.wood >= 3 && sim.world.campfires.length < 2,
      effect(pawn, sim) {
        sim.stockpile.wood -= 3;
        sim.world.campfires.push({ x: pawn.x, y: pawn.y });
        sim.logEvent('🔥 篝火建成！');
      },
    },
    {
      id: 'rest',
      label: '睡觉休息',
      baseWeight: 6,
      condition: (pawn) => pawn.rest < 60,
      effect(pawn, sim) {
        pawn.rest = Math.min(100, pawn.rest + 30);
        // 在篝火旁休息会额外回 san（神谕文档中的“火旁恢复”）
        if (sim.nearCampfire(pawn)) pawn.san = Math.min(100, pawn.san + 5);
      },
    },
    {
      id: 'socialize',
      label: '社交闲聊',
      baseWeight: 5,
      condition: (pawn, sim) => sim.nearbyPawn(pawn) !== null,
      effect(pawn, sim) {
        const other = sim.nearbyPawn(pawn);
        pawn.mood = Math.min(100, pawn.mood + 8);
        if (other) other.mood = Math.min(100, other.mood + 4);
      },
    },
    {
      id: 'idle',
      label: '发呆',
      baseWeight: 3,
      condition: () => true,
      effect(pawn) {
        pawn.mood = Math.min(100, pawn.mood + 1);
      },
    },
  ];
}

function needModifier(pawn: Pawn, id: CardId): number {
  // 需求调制权重：饿的时候“采集/吃”权重高；困的时候“休息”权重高。
  // 这不是行为树；需求只是权重输入。
  switch (id) {
    case 'gatherFood':
    case 'eat':
      return pawn.food < 30 ? 4 : pawn.food < 55 ? 2 : 1;
    case 'rest':
      return pawn.rest < 25 ? 5 : pawn.rest < 55 ? 2 : 1;
    case 'socialize':
      return pawn.mood < 40 ? 2.5 : 1;
    case 'idle':
      return pawn.mood > 85 ? 1.5 : 1;
    default:
      return 1;
  }
}

function decayNeeds(pawn: Pawn, dt: number): void {
  // 最小的真实性：需求随时间衰减（数值从 prompt 里的“模拟真实性”而来）
  pawn.food = Math.max(0, pawn.food - 0.18 * dt);
  pawn.rest = Math.max(0, pawn.rest - 0.14 * dt);
  pawn.mood = Math.max(0, pawn.mood - 0.05 * dt);
  pawn.san = Math.max(0, pawn.san - 0.02 * dt);
}

function makeWorld(w: number, h: number, rng: () => number): TinyWorld {
  const berries: TinyWorld['berries'] = [];
  const trees: TinyWorld['trees'] = [];
  // 资源随机撒点：数量少而确定，保证生存闭环可复现
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  for (let i = 0; i < 6; i++) {
    berries.push({
      x: clamp(cx + Math.floor(rng() * 12 - 6), 1, w - 2),
      y: clamp(cy + Math.floor(rng() * 12 - 6), 1, h - 2),
      amount: 3 + Math.floor(rng() * 4),
    });
  }
  for (let i = 0; i < 8; i++) {
    trees.push({
      x: clamp(cx + Math.floor(rng() * 14 - 7), 1, w - 2),
      y: clamp(cy + Math.floor(rng() * 14 - 7), 1, h - 2),
      hp: 1,
    });
  }
  return { w, h, berries, trees, campfires: [] };
}

function nearest<T extends { x: number; y: number }>(items: T[], x: number, y: number): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const it of items) {
    const d = Math.hypot(it.x - x, it.y - y);
    if (d < bestD) {
      best = it;
      bestD = d;
    }
  }
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 确定性随机：给试验可复现输出 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ALL_CARD_IDS: CardId[] = [
  'idle',
  'gatherFood',
  'eat',
  'gatherWood',
  'buildCampfire',
  'rest',
  'socialize',
];
