/**
 * farming 包 —— 农耕种子（ROADMAP R3-2）：耕地建筑 + 播种/收割卡 + 生长=地块冷却。
 *
 * 一切皆抽卡（原则①）：农耕没有"农夫 AI"。开垦/播种/收割都是**卡**，进同一个卡池
 * 参与抽签；小人为什么忽然想去种地？不是 if-else 行为树，而是**饥饿把 farm 系列的
 * 权重抬起来**（下方"权重钩子"），饿了 → farm 卡更容易被抽中 → 去种地。
 * "没人播种就饿肚子"这个涌现点因此是**权重管线的副产品**：没有任何一行代码写
 * "food < X 就必须去种地"。抽不到 farming 卡就继续饿，与抽不到 eat 卡完全同构。
 *
 * 生长 = 地块冷却的变体（ROADMAP 明写）：
 *  - 与 world.harvestCd 同构（世界自转的东西都是冷却，不是 tick 循环），
 *    但**不走 world.takeOne/featureAt**：田是建筑，作物状态属于"建筑级"事实，
 *    用包私有表表达——卸载 farming 包时田留在世界里，无人读它 → 不产出也不报错。
 *  - 状态存 ctx.scratch（键 "farming.<建筑id>"），**不进闭包**（存档纪律，见 context.ts）：
 *    键值 < 0 = 已播种且成熟时刻 = -值；键不存在或 ≥ 0 = 空地。
 *
 * 卸载语义（原则④）：不挂本包 → 无 farm 卡、无生长系统、scratch 永不被读；
 *  tuning.farming 仍在出厂表里但无人消费；已存在的田建筑留存、静止不产出，核心照跑。
 *
 * 数值：全部读 tuning.farming / tuning.buildings[FIELD_ID]（原则③），本文件零魔法数。
 */
import type { ModPack } from '../pack';
import { K_STOCK_FOOD, K_STOCK_WOOD, K_TAG_FIELD } from '../contracts';
import { SER_BUILD, SER_FARM } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { BuildingState, PawnState } from '../../sim/types';

/** 农田建筑定义 id（单包自洽键；与 contracts 的资源/标签键不同层） */
const FIELD_ID = 'field';

/** 作物状态 scratch 键前缀：键 "farming.<建筑id>" */
const STATE_PREFIX = 'farming.';

/** 成熟播报去重键前缀（与作物状态键分开的命名空间，共用 scratch 这一张表） */
const RIPE_LOGGED_KEY = 'farming.logged:';

/**
 * scratch 里"成熟时刻"的编码：负值 = 成熟时刻 = -value。
 * 为什么不直接存正数秒数：键不存在与"值 = 0"会撞义（0 既是"未种"又像"第 0 秒成熟"），
 * 用符号位把"空地"和"已种"彻底分开，判空只需 v === undefined || v >= 0，零歧义。
 */
function readyAtOf(ctx: SimContext, b: BuildingState): number | undefined {
  const v = ctx.scratch[STATE_PREFIX + b.id];
  return v !== undefined && v < 0 ? -v : undefined;
}

/** 该田此刻是否已成熟（成熟后一直可收，直到有人收走——冷却到点即"可收"） */
function isRipe(ctx: SimContext, b: BuildingState): boolean {
  const r = readyAtOf(ctx, b);
  return r !== undefined && ctx.time >= r;
}

function markSown(ctx: SimContext, b: BuildingState): void {
  ctx.scratch[STATE_PREFIX + b.id] = -(ctx.time + ctx.tuning.farming.growSec);
}

function markReaped(ctx: SimContext, b: BuildingState): void {
  delete ctx.scratch[STATE_PREFIX + b.id];
}

/**
 * 找一块处于目标阶段的田，取最近的一块：stage 'empty' 待播种 / 'ripe' 待收割。
 * 线性扫建筑表——与 world.nearestBuildingByTag 同量级，本阶段几十座可接受。
 */
function findFieldInStage(
  ctx: SimContext,
  p: PawnState,
  stage: 'empty' | 'ripe',
  maxR: number,
): BuildingState | undefined {
  let best: BuildingState | undefined;
  let bestD = maxR;
  for (const b of ctx.buildingsAll()) {
    if (b.defId !== FIELD_ID) continue;
    const ripe = isRipe(ctx, b);
    if (stage === 'ripe' ? !ripe : ripe) continue;
    const d = Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y);
    if (d > bestD) continue;
    best = b;
    bestD = d;
  }
  return best;
}

export const farmingPack: ModPack = {
  id: 'farming',
  requires: ['building'], // 田是建筑，沿用 building 包的建筑/造价/间距生态
  apply(m) {
    // ---- 建筑数据表：农田 1×1、可通行、造价木料。数值全在表上（原则③）。----
    // 为什么 passable=true：hut/store 阻挡通行因为它们是"占地的实体"，
    // 农田是"地面的改良"——阻挡通行会把营地切成碎片，鼠群自己的田自己都进不去。
    m.registerBuilding({
      id: FIELD_ID,
      name: '农田',
      cost: { [K_STOCK_WOOD]: 6 },
      hp: 60,
      tags: [K_TAG_FIELD],
      passable: true,
    });

    // ---- 系统：作物成熟播报（world 类，慢时钟）。
    //      它**不推进**生长——生长是纯冷却，读时判定（见 isRipe）天然无状态，
    //      所以"世界自转"不靠逐 tick 减数，只靠"当前时刻 vs 成熟时刻"的比较。
    //      本系统只做一件有实际后果的事：田成熟那一刻播一条叙事事件，
    //      让"世界在自己长"对玩家可见（否则 growSec 的静默期里玩家无从判断田死没死）。
    //      去重靠"上一趟播报时刻"，键随档 → 读档后既不重播也不漏播。----
    m.registerSystemDef({
      id: 'farming-growth',
      category: 'world',
      ctor: (ctx: SimContext) => ({
        id: 'farming-growth',
        update() {
          for (const b of ctx.buildingsAll()) {
            if (b.defId !== FIELD_ID || !isRipe(ctx, b)) continue;
            const key = RIPE_LOGGED_KEY + b.id; // 播报去重键（与作物状态键分开命名空间）
            const last = ctx.scratch[key];
            // 同一块田"同一茬"只播一次：去重窗口取 growSec，收走后重新播种已跨过一整轮生长
            if (last !== undefined && ctx.time - last < ctx.tuning.farming.growSec) continue;
            ctx.scratch[key] = ctx.time;
            ctx.log(`🌾 田里的庄稼熟了`);
          }
        },
      }),
    });

    // ---- 权重钩子：饥饿把整个 farm 系列顶上来（涌现点的物理实现）。
    //      这是**唯一**让"饿"通向"种地"的地方——一行权重乘法，不是行为规则。----
    m.registerHook('cardWeight', (p, card, ctx) => {
      if (card.series !== SER_FARM) return 1;
      const f = ctx.tuning.farming;
      return p.needs.food < f.hungryBelow ? f.hungryWeightMul : 1;
    });

    // ---- 卡：开垦农田（造一块新田。木料够 + 田数未超人口比例 + 找得到空地）----
    m.registerCard({
      id: 'build_field',
      label: '开垦农田',
      series: SER_BUILD,
      weight: 3,
      condition: (p, ctx) => wantNewField(p, ctx),
      action(p, ctx) {
        tillHere(p, ctx);
      },
    });

    // ---- 卡：播种（走到空田旁 → 翻土 → 标记成熟时刻 + 收工）----
    m.registerCard({
      id: 'sow_field',
      label: '播种',
      series: SER_FARM,
      weight: 6,
      duration: 5,
      condition: (p, ctx) => findFieldInStage(ctx, p, 'empty', ctx.tuning.farming.senseRadius) !== undefined,
      action(p, ctx) {
        sow(p, ctx);
      },
    });

    // ---- 卡：收割（走到熟田旁 → 拔 → 收成入 food → 田回空地）----
    m.registerCard({
      id: 'harvest_field',
      label: '收割',
      series: SER_FARM,
      weight: 6,
      duration: 3,
      condition: (p, ctx) => findFieldInStage(ctx, p, 'ripe', ctx.tuning.farming.senseRadius) !== undefined,
      action(p, ctx) {
        harvest(p, ctx);
      },
    });
  },
};

/** 开垦意愿：木料够 + 田数低于人口比例（不够种才开；不是有木就种）。
 *  与 building.wantHut 同构的"刚需比例门"——4 只鼠 × fieldRatio 2 = 2 块田封顶。 */
function wantNewField(_p: PawnState, ctx: SimContext): boolean {
  const f = ctx.tuning.farming;
  const cost = ctx.tuning.buildings[FIELD_ID]?.cost[K_STOCK_WOOD] ?? Infinity;
  if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < cost) return false;
  let fields = 0;
  let pawns = 0;
  for (const b of ctx.buildingsAll()) if (b.defId === FIELD_ID) fields++;
  for (const _ of ctx.pawns()) pawns++;
  return fields < Math.max(1, Math.ceil(pawns * f.fieldRatio));
}

/**
 * 开垦动作：在身边按"越来越远"的顺序试若干候选格，用 addBuilding 本身做合法性判定。
 *
 * 为什么不用"先 findSpot 再 addBuilding"（building 包的做法）：内核 world.addBuilding
 * 对**同类**建筑套 build.minSpacing=5 的间距判定（田 = 1×1 → 已有田的 5 格邻域内一律拒），
 * 所以"脚下第一块可站格"几乎必然被间距拒掉。与其在包里复刻一份间距判定（会与内核漂移），
 * 不如直接逐个候选喂给 addBuilding——它就是唯一权威判定，拒了就试下一个。
 * 代价是最坏 O(半径²) 次廉价判定，本阶段可接受。
 */
function tillHere(p: PawnState, ctx: SimContext): void {
  const def = ctx.tuning.buildings[FIELD_ID];
  const maxR = ctx.tuning.farming.searchRadius;
  let ok = false;
  for (let r = 0; r <= maxR && !ok; r++) {
    for (let dy = -r; dy <= r && !ok; dy++) {
      for (let dx = -r; dx <= r && !ok; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        ok = ctx.addBuilding(FIELD_ID, Math.round(p.pos.x + dx), Math.round(p.pos.y + dy)) !== null;
      }
    }
  }
  if (!ok) {
    ctx.finishCard(p); // 半径内真的放不下（营地挤满/被水岩卡死）：收工，重抽再试
    return;
  }
  for (const [k, v] of Object.entries(def.cost)) {
    ctx.stockpile[k] = (ctx.stockpile[k] ?? 0) - v; // 只在真落子后才扣料
  }
  ctx.log(`🪏 开垦了一块农田`);
  ctx.finishCard(p);
}

/** 播种动作：不在田旁 → 走到田心；在旁 → 标记成熟 → 收工。
 *  一次性工序（不是 gather 那种每 tick 收一份的持续劳作）：
 *  翻土是一个"开始即完成"的事件，中途被抽新卡打断就重来，符合直觉。 */
function sow(p: PawnState, ctx: SimContext): void {
  const field = findFieldInStage(ctx, p, 'empty', ctx.tuning.farming.senseRadius);
  if (!field) {
    ctx.finishCard(p);
    return;
  }
  if (Math.hypot(p.pos.x - field.pos.x, p.pos.y - field.pos.y) > 1.5) {
    if (p.path.length === 0) ctx.setPath(p, field.pos.x, field.pos.y); // 路上，引擎 moveStep 推进
    return;
  }
  p.path = [];
  markSown(ctx, field);
  ctx.log(`🌱 播下种子（约 ${ctx.tuning.farming.growSec}s 后成熟）`);
  ctx.finishCard(p);
}

/** 收割动作：不在田旁 → 走到田心；在旁 → 收成入 food、田回空地（可再种）。 */
function harvest(p: PawnState, ctx: SimContext): void {
  const field = findFieldInStage(ctx, p, 'ripe', ctx.tuning.farming.senseRadius);
  if (!field) {
    ctx.finishCard(p);
    return;
  }
  if (Math.hypot(p.pos.x - field.pos.x, p.pos.y - field.pos.y) > 1.5) {
    if (p.path.length === 0) ctx.setPath(p, field.pos.x, field.pos.y);
    return;
  }
  p.path = [];
  const food = ctx.tuning.farming.yieldFood;
  ctx.stockpile[K_STOCK_FOOD] = (ctx.stockpile[K_STOCK_FOOD] ?? 0) + food;
  markReaped(ctx, field);
  ctx.log(`🌾 收获农田（+${food} 食物）`);
  ctx.finishCard(p);
}
