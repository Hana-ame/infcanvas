/**
 * medicine 包 —— 医疗种子（R3 瘟疫/饥荒）：病榻建筑 + 照料卡 + 自然恢复。
 *
 * 一切皆抽卡（原则①）：本包**没有**「医护 AI」，也没有「血低于 X 必须有人去治疗」
 *  的规则。heal 是一张**卡**，进同一个卡池参与抽签；它为什么被抽中？靠权重（见下方
 *  两个 hook）——有人重伤时 SER_HEAL 权重 ×healWeightWounded，自己重伤时 SER_REST
 *  ×restWeightWounded。抽不到就忍着，与抽不到 eat 卡完全同构。
 *
 * ---------------------------------------------------------------------------------
 * ---- 磁铁范式（本项目已踩坑 5 次，本包是第 6 个实例）----
 * ---------------------------------------------------------------------------------
 * 「需要先靠近才能做」的行为必须拆**两个半径**：
 *   - condition 用 healMagnetRadius（24，「看得见值得走过去」）= 进候选池的硬闸；
 *   - action 里若不在 healWorkRadius（2.5，「伸手可及」）就 setPath + return 等 moveStep；
 *   - 不可达（水/岩隔断）就 finishCard 收工，防恒真空转。
 * 二者若复用同一个数，就是「伤员看得见却永远照顾不到」= 死代码（chat/sow/harvest/
 * sleep/cook 五个实例的共同根因）。
 *
 * ---------------------------------------------------------------------------------
 * ---- 跨 tick 状态走 ctx.scratch（纪律：不进闭包）----
 * ---------------------------------------------------------------------------------
 * 键 "medicine.target.<鼠eid>" = 这只鼠当前正在照料的伤员 eid（number）。
 * 为什么 persist 目标而不是每 tick 重找最近伤员：鼠在照料中途换目标会让「这一卡到底
 * 在照顾谁」变成浮动的——两只伤员都重伤时，重找会让其中一只永远轮不到。随档（scratch）。
 *
 * ---------------------------------------------------------------------------------
 * ---- 卸载语义（原则④卸载不破坏核心）----
 * ---------------------------------------------------------------------------------
 * 不挂本包 → 无 heal 卡、无 build_bed 卡、无 medicine-tick 系统、tuning.buildings
 * 里没有 bed 定义。已存在的 bed 建筑**留存**（世界事实，不是行为），无任何系统读它
 * → 不产出也不报错；tuning.medicine 仍在出厂表里但无人消费。
 *
 * ---------------------------------------------------------------------------------
 * ---- 材料链说明（本包只消费，不生产草药）----
 * ---------------------------------------------------------------------------------
 * 草药（K_STOCK_HERB）的**来源不是本包**：hunting 包让 deer 掉 herb
 * （tuning.enemies 的 drops { meat: 2, herb: 1 }）。本包只**消费** herb。
 * 若 hunting 包未挂载，herb 恒 0 ⇒ heal 卡 action 里「没草药就 return 等下一 tick」
 * 自然成立、不报错。这是「卸载不破坏核心」的活例证：**缺料不是崩溃，是卡住等料**
 * （与 cooking 缺生食时 wantCook 返回 false 同构，只是那边写在 condition、这边写在 action）。
 *
 * 数值：全部读 tuning.medicine（原则③），本文件零魔法数字。
 */
import type { ModPack } from '../pack';
import {
  K_STOCK_HERB,
  K_STOCK_WOOD,
  K_TAG_BED,
  SER_BUILD,
  SER_HEAL,
  SER_REST,
} from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState } from '../../sim/types';

/** 病榻建筑定义 id（单包自洽键；与 contracts 的跨包资源/标签键不同层） */
const BED_ID = 'bed';

/** 照料目标 scratch 键前缀：键 "medicine.target.<鼠eid>"，值 = 伤员 eid（number）。
 *  值存 eid 而非坐标——伤员会走，坐标会过期，eid 才是稳定标识。 */
const TARGET_PREFIX = 'medicine.target.';

export const medicinePack: ModPack = {
  id: 'medicine',
  requires: ['building'], // 病榻是建筑，沿用 building 包的造价/间距生态（farming 包同先例）
  apply(m) {
    // ---- 建筑数据表：病榻 2×2、可通行、造价木 8 ----
    // 为什么 passable=true：病人要能站/躺在病榻边，照料者要能走到旁边；阻挡通行会把
    // 营地切成碎片（与 farming 农田同一条理由——「占地的实体」才阻挡，床不是墙）。
    m.registerBuilding({
      id: BED_ID,
      name: '病榻',
      cost: { [K_STOCK_WOOD]: 8 },
      hp: 100,
      tags: [K_TAG_BED],
      passable: true,
      w: 2,
      h: 2,
    });

    // ---- 系统：自然恢复（category 'needs' ⇒ 早于 behavior 的 'ai' 类）----
    // 遍历所有 hp 未满的鼠按 naturalHealPerSec*dt 回血，封顶 maxHp，不消耗任何资源。
    //
    // 为什么必须早于 behavior：类别序 CATEGORY_ORDER = [needs, ai, ...] 保证了这一点。
    // 若晚于 behavior，同一 tick 里「heal 卡把伤员抬过重伤线」与「自然恢复」的先后
    // 会影响下一拍的 condition 判定，时序漂移会让涌现点（"谁去照料"）变得不稳定。
    //
    // 【为什么直接写 p.hp 而不是 ctx.damagePawn】damagePawn 是**扣血**接口（负数语义），
    // 用它回血语义错位，且 hp<=0 时会误触发 killPawn。回血就是回血，直接改 p.hp
    // 并用 Math.min 封顶 maxHp（不越界）。
    m.registerSystemDef({
      id: 'medicine-tick',
      category: 'needs',
      ctor: (ctx: SimContext) => ({
        id: 'medicine-tick',
        update(dt) {
          const rate = ctx.tuning.medicine.naturalHealPerSec;
          if (rate <= 0) return;
          for (const p of ctx.pawns()) {
            if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + rate * dt);
          }
        },
      }),
    });

    // ---- 权重钩子 1：磁铁半径内有重伤同伴 → SER_HEAL 抬高 ----
    // 这是「为什么去照料」的**唯一实现处**，与 cooking 的 cookWeightNearFire 同构：
    // 抬高集中在「真的有人需要」的世界状态上，而不是靠一个永远生效的大基数
    // （后者会让鼠在无伤时也反复抽 heal、每次都卡在"找伤员"的路上 = 变相降智）。
    // 方向性可单测：重伤同伴在磁铁半径内 → 权重更高；无伤员 → 不抬。
    m.registerHook('cardWeight', (p, card, ctx) => {
      if (card.series !== SER_HEAL) return 1;
      const m = ctx.tuning.medicine;
      return hasWoundedNearby(p, ctx, m.healMagnetRadius) ? m.healWeightWounded : 1;
    });

    // ---- 权重钩子 2：自己重伤 → SER_REST 抬高（想躺下歇着）----
    // 与 needs 包的「饿了抬 eat/gather」同构：需求只是权重输入，不是行为规则（原则①）。
    // 数值进 tuning（restWeightWounded），不写死包内（原则②⑦）。
    m.registerHook('cardWeight', (p, card, ctx) => {
      if (card.series !== SER_REST) return 1;
      const m = ctx.tuning.medicine;
      return p.hp < m.woundedBelow * p.maxHp ? m.restWeightWounded : 1;
    });

    // ---- 卡：搭病榻（木料够 + 有伤员才值得搭）----
    // 为什么有「有伤员」这道门：build_campfire/build_hut 都已经因为「木料富余就狂盖」
    // 踩过坑（实测 4 只鼠狂盖 28~43 座棚屋，用户反馈）。病榻同样需要刚需门——
    // 但它的刚需不是人口比例，而是「真的有伤员」。没有伤员时这张卡抽不到，
    // 这正是抽卡硬闸而非行为树（原则①）：抽不到就忍着。
    // weight 3：与 build_store 同级（次要建筑），低于 build_campfire(5)/build_hut(4)。
    m.registerCard({
      id: 'build_bed',
      label: '搭病榻',
      series: SER_BUILD,
      weight: 3,
      condition: (_p, ctx) => wantNewBed(ctx),
      action(p, ctx) {
        buildBedHere(p, ctx);
      },
    });

    // ---- 卡：照料（有人重伤 → 抽上 → 走到身旁 → 消耗草药逐 tick 回血）----
    // duration 8：与 gather_berry(8)/chop_tree(6) 同量纲的**持续劳作**，不是"秒完成"。
    // 若瞬时完成，heal 会在有伤员的世界里自锁霸池（同 cooking 第一版 30.7% 霸池的教训）。
    // weight 4：低于生存卡，且由 healWeightWounded(3.0) 在「真有人需要」时抬起。
    m.registerCard({
      id: 'heal',
      label: '照料',
      series: SER_HEAL,
      weight: 4,
      duration: 8,
      condition: (p, ctx) => hasWoundedNearby(p, ctx, ctx.tuning.medicine.healMagnetRadius),
      action(p, ctx, dt) {
        heal(p, ctx, dt);
      },
    });
  },
};

/**
 * 磁铁半径内有没有值得照料的伤员（heal 卡的 condition 硬闸 + SER_HEAL 权重钩子共用）。
 *
 * 重伤判据是**比例**（hp < woundedBelow × o.maxHp）而非固定血量：maxHp 可被 mod 改，
 * 比例判据不会跟着失真。
 * o !== p：不能照顾自己（那要单独的「自疗」卡，本包不做——避免"重伤鼠自抽 heal
 * 自消耗草药"的自锁机器）。
 */
function hasWoundedNearby(p: PawnState, ctx: SimContext, maxR: number): boolean {
  const m = ctx.tuning.medicine;
  for (const o of ctx.pawns()) {
    if (o.eid === p.eid) continue;
    if (o.hp <= 0) continue; // 已死（killPawn 已移除，双保险）
    if (o.hp >= m.woundedBelow * o.maxHp) continue; // 不算重伤
    if (Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y) > maxR) continue;
    return true;
  }
  return false;
}

/** 磁铁半径内最近的伤员（给这只鼠选定照料对象，结果写进 scratch）。
 *  线性扫 pawns——与 hasWoundedNearby 同量级，几十只鼠可接受（不做空间索引）。 */
function nearestWounded(p: PawnState, ctx: SimContext, maxR: number): PawnState | undefined {
  const m = ctx.tuning.medicine;
  let best: PawnState | undefined;
  let bestD = maxR;
  for (const o of ctx.pawns()) {
    if (o.eid === p.eid) continue;
    if (o.hp <= 0) continue;
    if (o.hp >= m.woundedBelow * o.maxHp) continue;
    const d = Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y);
    if (d > bestD) continue;
    best = o;
    bestD = d;
  }
  return best;
}

/** 照料目标 scratch 键（跨 tick 状态走 scratch，不进闭包——纪律 4） */
function targetKey(p: PawnState): string {
  return TARGET_PREFIX + p.eid;
}

/**
 * 解析这只鼠当前的照料对象：scratch 优先；没有就找磁铁半径内最近的伤员并记下。
 *
 * 为什么 persist 而不是每 tick 重找：见文件头「跨 tick 状态」段的理由。
 * scratch 里的目标若已死（killPawn 移除）或已康复（hp >= maxHp），就当作失效
 * → 重新找一个新的伤员（不直接 finishCard：也许还有别的伤员值得照顾）。
 */
function resolveTarget(ctx: SimContext, p: PawnState): PawnState | undefined {
  const k = targetKey(p);
  const eid = ctx.scratch[k];
  if (eid !== undefined) {
    const t = ctx.pawn(eid);
    if (t && t.hp > 0 && t.hp < t.maxHp) return t;
    delete ctx.scratch[k]; // 目标已死（killPawn 移除）或已康复：清掉陈旧键
  }
  const fresh = nearestWounded(p, ctx, ctx.tuning.medicine.healMagnetRadius);
  if (fresh) ctx.scratch[k] = fresh.eid;
  return fresh;
}

/** 清掉这只鼠的照料目标（finishCard 时调用，下一卡重新选） */
function clearTarget(ctx: SimContext, p: PawnState): void {
  delete ctx.scratch[targetKey(p)];
}

/**
 * 照料动作（磁铁范式 + 持续工作量）：
 *   1. 解析照料对象（scratch 优先；已死/已康复的旧目标键会被清掉）——没有就 finishCard；
 *   2. 对象离开磁铁圈 → 清目标 + finishCard（防「人跑了还在原地追」的恒真空转）；
 *   3. 不在 healWorkRadius 内 → setPath 走过去 + return 等 moveStep；不可达即收工；
 *   4. 到身旁：没草药就 return 等下一 tick（**不** finishCard——也许草药快到了）；
 *      有草药就扣 herbCost、按 healPerSec*dt（病榻旁 ×bedBonus）回血。
 *
 * 【为什么"没草药"（第 4 步）不 finishCard】草药可能是**在路上的**（另一只鼠正砍树
 * 攒木料、或 hunting 包掉落的 herb 还没被捡回仓库）。finishCard 会让这只鼠立刻重抽
 * 别的卡，等草药到了它又得重新走过去——白走一趟。留着这张卡在原地等，代价只是
 * 占着一整个卡期，收益是不丢失"已经走到伤员身旁"的位置优势。
 */
function heal(p: PawnState, ctx: SimContext, dt: number): void {
  const m = ctx.tuning.medicine;
  const target = resolveTarget(ctx, p);
  if (!target) {
    ctx.finishCard(p); // 没有可照料的伤员（含"旧目标已康复"）：这张卡空转没意义
    return;
  }
  const d = Math.hypot(p.pos.x - target.pos.x, p.pos.y - target.pos.y);
  if (d > m.healMagnetRadius) {
    clearTarget(ctx, p);
    ctx.finishCard(p); // 伤员走出磁铁圈：收工重抽，防恒真空转
    return;
  }
  if (!ctx.adjacent(p, target.pos.x, target.pos.y, m.healWorkRadius)) {
    // 还不够近——**走过去**（这一步是本包全部的「磁铁」含义）。路上不推进照料。
    if (p.path.length === 0 && !ctx.setPath(p, target.pos.x, target.pos.y)) {
      clearTarget(ctx, p);
      ctx.finishCard(p); // 不可达（水/岩隔断）：收工重抽，防恒真空转
    }
    return; // 路上，引擎 moveStep 推进
  }
  p.path = []; // 停到伤员身旁别乱走
  // ---- 到身旁了：有草药才动手 ----
  const herbs = ctx.stockpile[K_STOCK_HERB] ?? 0;
  if (herbs < m.herbCost) return; // 没草药：等下一 tick（不 finishCard，见上方注释）
  ctx.stockpile[K_STOCK_HERB] = herbs - m.herbCost;
  // 病榻旁：以**病人**位置判「在床旁」（床位是给病人的，语义锚点是病人，不是照料者）
  const bed = ctx.nearestBuildingByTag(K_TAG_BED, target.pos.x, target.pos.y, m.bedWorkRadius);
  const mult = bed ? m.bedBonus : 1;
  target.hp = Math.min(target.maxHp, target.hp + m.healPerSec * dt * mult);
  if (target.hp >= target.maxHp) {
    clearTarget(ctx, p);
    ctx.finishCard(p); // 刚被这一手抬到满血：收工
  }
}

/**
 * 搭床意愿：木料够 + 世界里有伤员。
 *
 * 这道门是**抽卡硬闸**（原则①），不是行为树——它决定「这张卡能不能被抽上」，
 * 不决定「鼠该不该搭床」。木料富余 + 无伤员时这张卡自然抽不到，
 * 就不会出现 build_campfire 式的「4 只鼠狂搭 40 张空床」泛滥。
 * 遍历全部鼠（不只 p 附近）：病榻是营地的战略设施，不是"就近照顾"的临时物，
 * 谁抽到卡谁搭，但触发条件是"营地里有人受伤了"。
 */
function wantNewBed(ctx: SimContext): boolean {
  const cost = ctx.tuning.buildings[BED_ID]?.cost[K_STOCK_WOOD] ?? Infinity;
  if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < cost) return false;
  const m = ctx.tuning.medicine;
  for (const o of ctx.pawns()) {
    if (o.hp <= 0) continue;
    if (o.hp < m.woundedBelow * o.maxHp) return true;
  }
  return false;
}

/**
 * 搭床动作：在身边按「越来越远」的环形顺序试候选格，用 addBuilding 本身做合法性判定。
 *
 * 为什么不用「先 findSpot 再 addBuilding」（building 包的做法）：内核 world.addBuilding
 * 对**同类**建筑套 build.minSpacing=5 的间距判定。病榻 2×2 + minSpacing 5 意味着
 * 第二张床必须落在第一张的 5 格外（"脚下第一块可站格"几乎必然被拒）。与其在包里
 * 复刻一份间距判定（会与内核漂移），不如直接逐个候选喂给 addBuilding——它就是唯一
 * 权威判定，拒了就试下一个。代价：最坏 O(半径²) 次廉价判定，本阶段可接受
 * （与 farming.tillHere 同一取舍）。
 */
function buildBedHere(p: PawnState, ctx: SimContext): void {
  const def = ctx.tuning.buildings[BED_ID];
  const cost = def?.cost[K_STOCK_WOOD] ?? Infinity;
  if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < cost) {
    ctx.finishCard(p); // 木料不够（condition 通过后被别的鼠扣走了）：收工重抽
    return;
  }
  const maxR = ctx.tuning.medicine.bedSearchRadius;
  let ok = false;
  for (let r = 0; r <= maxR && !ok; r++) {
    for (let dy = -r; dy <= r && !ok; dy++) {
      for (let dx = -r; dx <= r && !ok; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        ok = ctx.addBuilding(BED_ID, Math.round(p.pos.x + dx), Math.round(p.pos.y + dy)) !== null;
      }
    }
  }
  if (!ok) {
    ctx.finishCard(p); // 半径内真的放不下（营地挤满/被水岩卡死）：收工重抽再试
    return;
  }
  ctx.stockpile[K_STOCK_WOOD] = (ctx.stockpile[K_STOCK_WOOD] ?? 0) - cost; // 只在真落子后才扣料
  ctx.log(`🛏 搭好一张病榻`);
  ctx.finishCard(p);
}
