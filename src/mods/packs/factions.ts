/**
 * factions 包 —— 派系外交：部落（篝火）/ 声望 / 贸易 / 掠夺 / 传闻。
 *
 * 种子出处（docs/SEED.md 逐词拆解）：
 *   「结盟与贸易」→ trade 卡（SER_TRADE）+ 双向声望；
 *   「突袭与背叛」→ 掠夺系统（局面驱动的 raider 生成，不是波次脚本）；
 *   「故事活在传闻里」→ gossip：掠夺之后上升、随时间衰减，并压低 SER_SOCIAL 权重。
 *
 * 红线对照（本包是 7 条线里最复杂的，逐条钉住）：
 *  ① 一切皆抽卡：贸易是**一张卡**（SER_TRADE），没有外交 AI、没有任务队列、
 *     没有"××令"。掠夺是**局面驱动的生成**（谓词 rep(a,b) < hostileThresh →
 *     效果 spawnHostile）——与 raid 包的叙事压力同构，不是脚本波次。
 *  ② 数据驱动：全部数值在 tuning.factions，本文件零魔法数。
 *  ③ 跨 tick 状态一律走 ctx.scratch（键 "factions.*"），零闭包 → 存档可还原。
 *  ④ 卸载不破坏核心（**双向都成立**）：
 *     - 卸载 factions → 无 trade 卡、无 raider、无 SER_TRADE 系列；tuning.factions
 *       留在出厂表但无人读，raid 包的猫照常出没。核心照跑。
 *     - 卸载 raid → 本包**不许**偷偷补写 raider 的 AI。见下方 registerEnemy 注释。
 *  ⑤ series 用 contracts 的 SER_* 常量（SER_TRADE / SER_SOCIAL）。
 *  ⑥ 依赖链单向：factions 产生 raider → raid 驱动 raider。requires 声明 raid，
 *     所以"只挂 factions 不挂 raid"会在**挂载期响亮失败**，而不是运行期留下一堆
 *     没人驱动、永不出场的 raider 幽灵。
 */
import type { ModPack } from '../pack';
import { K_STOCK_FOOD, K_STOCK_WOOD, K_TAG_FIRE, SER_SOCIAL, SER_TRADE } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { BuildingState, PawnState } from '../../sim/types';

/** 派系数据键（scratch 随档；导出供测试与未来包复用，避免键格式在包外漂移） */
export const FACTION_KEYS = {
  /** 登记序号：seq 0 = 「鼠团」，seq n≥1 = 「野营-(n+1)」。名字由序号派生而非存字符串，
   *  因为 ctx.scratch 是 Record<string, number> —— 只放数字才能原样随档。 */
  seq: 'factions.seq',
  name: (id: string) => `factions.name.${id}`,
  /** 有向声望：a 对 b 的看法（-100..100，缺省 0 = 中立）。两个方向各一个键。 */
  rep: (a: string, b: string) => `factions.rep.${a}.${b}`,
  /** 传闻等级 0..1：掠夺之后上升，随时间衰减。 */
  gossip: (id: string) => `factions.gossip.${id}`,
  /** 该派系对的掠夺冷却到期时刻（绝对 sim 秒；到期前不再刷）。 */
  raidCd: (a: string, b: string) => `factions.raidCd.${a}.${b}`,
  /** 掠夺检查节拍累积器。 */
  checkAcc: 'factions.checkAcc',
  /** 本只鼠当前贸易目标的 seq 号（不是建筑 id：scratch 只放 number）。
   *  锁定原因见 tradeTargetOf 注释——不锁定鼠会走到半路折返。 */
  tradeTarget: (eid: number) => `factions.tradeTarget.${eid}`,
};

export const factionsPack: ModPack = {
  id: 'factions',
  // 依赖声明（拓扑由 pack.topoSort 推导，清单顺序不承担约束）：
  //  - building：篝火是本包唯一的派系锚点（K_TAG_FIRE 由 building 包注册）。
  //  - raid：raider 的追猎 AI 由 raid 包的 tickCats 驱动。写显式依赖是为了让
  //    「只挂 factions 不挂 raid」在挂载期响亮失败，而不是运行期堆 raider 幽灵。
  //  - bootstrap：factions-sync.init() 要把"出生篝火"登记为首个派系（seq 0 = 鼠团），
  //    而出生篝火由 bootstrap.init() 创建。两个系统同在 'boot' 类别，组内按注册序
  //    （= 拓扑序）执行，所以必须显式声明这个先后关系——pack.ts 的纪律是
  //    「靠清单顺序维护挂载序迟早漂移，显式依赖才是唯一事实」。
  //    init() 对空世界也安全（没有火就什么都不登记），但那样首个派系要等到
  //    tick 1 才登记，行为上看不出差别，只是不该依赖隐式顺序。
  requires: ['building', 'raid', 'bootstrap'],
  apply(m) {
    // ---- 敌人数据：侵略者 ----
    // 【为什么本包不写 raider 的 AI】raid 包的 tickCats 每 tick 遍历全部 hostile、
    // 跳过 def.passive 的，剩下的一律按"追最近鼠 / 近身咬 / 够不着就走"的动物智能驱动。
    // raider 只要**不标 passive**，就会被 raid 包自动接管——本包负责"什么时候刷、
    // 刷在哪、刷几只"，行为的智能是 raid 包的。这条依赖链是**单向**的：
    //   factions 产生 raider → raid 驱动 raider
    // 反向绝不成环（raid.requires 恒为 []），否则卸载 factions 会让 raid 隐式失效。
    // 数值：比猫（hp24/dmg3/speed4.0）更强更主动——它是"派系间的背叛"，不是"野外偶遇"。
    m.registerEnemy({ id: 'raider', name: '侵略者', hp: 30, dmg: 5, speed: 4.4, atkCd: 1.3, climb: 2 });

    // ---- 权重钩子：传闻压低社交（"故事活在传闻里"的态度层表达）----
    // gossip > 0 时，本派系成员的 SER_SOCIAL 权重 ×(1 - gossip × socialPenalty)。
    // 只在 gossip > 0 时干预：中立/和平时期社交不受影响，不永久固化。
    m.registerHook('cardWeight', (p, card, ctx) => {
      if (card.series !== SER_SOCIAL) return 1;
      const home = nearestFireOf(p, ctx);
      if (!home) return 1;
      const g = ctx.scratch[FACTION_KEYS.gossip(home.id)] ?? 0;
      return g > 0 ? Math.max(0, 1 - g * ctx.tuning.factions.socialPenalty) : 1;
    });

    // ---- 卡：贸易（SER_TRADE）----
    // 磁铁范式（照抄 social/farming/cooking 的既有正确写法）：
    //   condition 用 tradeMagnetRadius（"看得见友好营地，值得走过去"），
    //   action 里没到 tradeWorkRadius（"站到对方火边"）就只走路、不结算。
    // 【为什么是卡而不是"外交 AI"】红线①：抽卡决定"要不要去贸易"，
    //   走到哪、能不能到，是引擎 moveStep 的本职。
    m.registerCard({
      id: 'trade',
      label: '贸易',
      series: SER_TRADE,
      weight: 3,
      // duration 必须**装得下整段跋涉**，而不是"在火边待多久"。
      //   commit() 写 busyUntil = time + duration，而 stepPawn 的顺序是
      //   「到期检查 → 跑 action → moveStep」——action 在 moveStep **之前**。
      //   所以一只鼠要到第 N+1 拍才第一次以"已抵达"的姿态看到自己的 action，
      //   而第 N+1 拍同时会先做过期检查。推导：抵达需要 ceil(磁铁距离/speed) 拍，
      //   结算需要再多 1 拍，故 duration ≥ ceil(tradeMagnetRadius / pawn.speed) + 1
      //                          = ceil(28 / 4.5) + 1 = 7 + 1 = 8。
      //   给 3 的后果（已实测）：8.5 格的贸易在第 4 拍到期重抽，鼠永远走不完，
      //   trade 是死代码——和 chat 卡当年 chatRadius=2.5 那类"看得见到不了"的坑同款。
      //   短途贸易不会被卡满 8 拍：到位即结算 + finishCard，duration 只是上限。
      duration: 8,
      condition: (p, ctx) => wantTrade(p, ctx),
      action: (p, ctx) => doTrade(p, ctx),
    });

    // ---- 系统①：派系同步（category 'boot'，恒表尾）----
    // 每 tick 扫描篝火：新出现的登记为新派系（名字递增），被移除的清理名字键。
    // 声望键**保留**——传闻不随建筑消失（火灭了，故事还在）。
    m.registerSystemDef({
      id: 'factions-sync',
      category: 'boot',
      ctor: (ctx: SimContext) => ({
        id: 'factions-sync',
        init() {
          syncFactions(ctx); // 出生篝火 → 首个派系（seq 0 = 「鼠团」）
        },
        update(dt) {
          syncFactions(ctx);
          decayGossip(ctx, dt);
        },
      }),
    });

    // ---- 系统②：掠夺（category 'raid'，与 raid 包同类别，组内排在 raid 之后）----
    // 每 checkSec 检查一次：遍历所有派系对 (a,b)，rep(a,b) < hostileThresh 且冷却到期
    //   → 从 b 的营地外围刷 1~maxRaiderWave 只 raider，rep(a,b) 再降，a 的 gossip +。
    // 这是种子句里「背叛与战争」的唯一来源；冷却键按对派系独立，防刷屏。
    m.registerSystemDef({
      id: 'factions-raid',
      category: 'raid',
      ctor: (ctx: SimContext) => ({
        id: 'factions-raid',
        update(dt) {
          let acc = (ctx.scratch[FACTION_KEYS.checkAcc] ?? 0) + dt;
          if (acc < ctx.tuning.factions.checkSec) {
            ctx.scratch[FACTION_KEYS.checkAcc] = acc;
            return;
          }
          acc -= ctx.tuning.factions.checkSec; // 保留余量（长 dt 不丢节拍，与 tech-pool 同手法）
          ctx.scratch[FACTION_KEYS.checkAcc] = acc;
          checkRaids(ctx);
        },
      }),
    });
  },
};

// ================= 派系枚举与命名 =================

/** 现存派系 = 带 K_TAG_FIRE 标签的篝火（派系 id = 建筑 id）。 */
function firesOf(ctx: SimContext): BuildingState[] {
  const out: BuildingState[] = [];
  for (const b of ctx.buildingsAll()) if (hasTag(ctx, b, K_TAG_FIRE)) out.push(b);
  return out;
}

function hasTag(ctx: SimContext, b: BuildingState, tag: string): boolean {
  return ctx.tuning.buildings[b.defId]?.tags?.includes(tag) ?? false;
}

/** 全部现存派系 id，按登记序号升序（第一个建火的就是「鼠团」）。 */
export function factionIds(ctx: SimContext): string[] {
  const out: { id: string; seq: number }[] = [];
  for (const b of firesOf(ctx)) {
    const seq = ctx.scratch[FACTION_KEYS.name(b.id)];
    if (seq === undefined) continue; // 还没同步（syncFactions 会补上）
    out.push({ id: b.id, seq });
  }
  return out.sort((a, b) => a.seq - b.seq).map((x) => x.id);
}

/** 派系名由登记序号派生（scratch 只放 number，名字不落盘）。 */
export function factionNameOf(ctx: SimContext, id: string): string {
  const seq = ctx.scratch[FACTION_KEYS.name(id)];
  if (seq === undefined) return '无名派系';
  return seq === 0 ? '鼠团' : `野营-${seq + 1}`;
}

/** 有向声望读取（缺省 0 = 中立）。 */
function repOf(ctx: SimContext, a: string, b: string): number {
  return ctx.scratch[FACTION_KEYS.rep(a, b)] ?? 0;
}

function setRep(ctx: SimContext, a: string, b: string, v: number): void {
  ctx.scratch[FACTION_KEYS.rep(a, b)] = Math.max(-100, Math.min(100, v));
}

/** 仅在键不存在时写入初值（派系登记用）。不覆盖已有值：
 *  建筑 id 单调不复用，所以"已登记派系 + 已存在声望键"的组合只可能来自存档还原，
 *  那时旧值才是事实，初值不该盖掉它。 */
function setRepIfAbsent(ctx: SimContext, a: string, b: string, v: number): void {
  const k = FACTION_KEYS.rep(a, b);
  if (ctx.scratch[k] === undefined) ctx.scratch[k] = Math.max(-100, Math.min(100, v));
}

/** 派系同步：新火登记（并与已有派系建立双向初始声望）、灭火清名（声望保留）。 */
function syncFactions(ctx: SimContext): void {
  const t = ctx.tuning.factions;
  const live = firesOf(ctx);
  const liveIds = new Set(live.map((b) => b.id));
  for (const b of live) {
    if (ctx.scratch[FACTION_KEYS.name(b.id)] !== undefined) continue;
    // 先取"已登记的现存派系"（此时 b 尚未登记，故 peers 不含 b）
    const peers = factionIds(ctx);
    const seq = ctx.scratch[FACTION_KEYS.seq] ?? 0;
    ctx.scratch[FACTION_KEYS.name(b.id)] = seq;
    ctx.scratch[FACTION_KEYS.seq] = seq + 1; // 计数器只增不减：灭火后名字不重名
    // 与每个老派系建立**双向**中立偏友好的初印象。声望是有向的（a 对 b 与 b 对 a
    // 是两个独立键），所以必须各写一次——只写一个方向会让"b 对 a"永远是缺省 0，
    // 而 0 落在死区 [-25,30] 里，那半段关系就永久卡死。
    for (const o of peers) {
      setRepIfAbsent(ctx, b.id, o, t.repInit);
      setRepIfAbsent(ctx, o, b.id, t.repInit);
    }
    ctx.log(`⛺ ${factionNameOf(ctx, b.id)} 立起了篝火`);
  }
  // 清理名字键（灭火）。遍历 scratch 是 O(键数) 且键数很小（每座火 1 个），
  // 不值得为它另维护一份 id 列表（那会是第二个事实源）。
  for (const k of Object.keys(ctx.scratch)) {
    if (!k.startsWith('factions.name.')) continue;
    if (!liveIds.has(k.slice('factions.name.'.length))) delete ctx.scratch[k];
  }
}

/** 传闻衰减：归零即删键，避免长局 scratch 无界增长。 */
function decayGossip(ctx: SimContext, dt: number): void {
  const d = ctx.tuning.factions.gossipDecayPerSec * dt;
  if (d <= 0) return;
  for (const k of Object.keys(ctx.scratch)) {
    if (!k.startsWith('factions.gossip.')) continue;
    const next = Math.max(0, (ctx.scratch[k] ?? 0) - d);
    if (next <= 0) delete ctx.scratch[k];
    else ctx.scratch[k] = next;
  }
}

// ================= 贸易 =================

/** 鼠此刻"在哪个营地"= 离它最近的篝火（无火 = 无归属，不贸易）。 */
function nearestFireOf(p: PawnState, ctx: SimContext): BuildingState | null {
  return ctx.nearestBuildingByTag(K_TAG_FIRE, p.pos.x, p.pos.y) ?? null;
}

/** 最近的篝火但排除 excludeId。贸易结算时必须用它：目标火一旦被走到，它就成了
 *  "最近的篝火"（= 鼠此刻的 home），不排除它就拿不到"来时的家"，方向会整个翻转。 */
function nearestFireExcept(ctx: SimContext, p: PawnState, excludeId: string): BuildingState | null {
  let best: BuildingState | null = null;
  let bestD = Infinity;
  for (const b of firesOf(ctx)) {
    if (b.id === excludeId) continue;
    const d = Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y);
    if (d > bestD) continue;
    best = b;
    bestD = d;
  }
  return best;
}

/** seq 号 → 现存篝火（贸易目标以 seq 缓存，靠这个反查；火被灭则返回 null）。 */
function fireOfSeq(ctx: SimContext, seq: number): BuildingState | null {
  for (const b of firesOf(ctx)) {
    if (ctx.scratch[FACTION_KEYS.name(b.id)] === seq) return b;
  }
  return null;
}

/** 贸易意愿（= trade 卡 condition 硬闸）：
 *   ① 手里有可换的 wood（没货这张卡就是死代码）；
 *   ② 磁铁半径内存在**友好**派系的篝火（声望 > friendlyThresh）。
 *  ①② 都放 condition：它们不需要位置配合（库存是全局事实、声望是查表事实）。 */
function wantTrade(p: PawnState, ctx: SimContext): boolean {
  if ((ctx.stockpile[K_STOCK_WOOD] ?? 0) < ctx.tuning.factions.tradeWoodCost) return false;
  // ⚠ 必须走纯查询 findTradeTarget，**不能**调 tradeTargetOf（2026-10-07 R4-GEN
  //   集成期实测定位）：tradeTargetOf 会写 ctx.scratch 锁定贸易目标，而 scratch
  //   进指纹也进存档。把「锁定」放进 condition 意味着 drawCard 光是构建候选集
  //   就改了世界状态——card-liveness 的候选池采样每 7 tick 调一遍全部 condition，
  //   实测因此把 build_store 的读数从 4 抬高到 6（build_store / gather_berry /
  //   chop_tree 单独采样都无扰动，扰动 100% 来自这一处）。
  return findTradeTarget(p, ctx) !== null;
}

/** 纯查询：home 之外、贸易半径内、声望友好的最近一座火。不写任何状态。
 *  条件（谓词）只能调它。 */
function findTradeTarget(p: PawnState, ctx: SimContext): BuildingState | null {
  const home = nearestFireOf(p, ctx);
  if (!home) return null; // 四周没有营地：无处"从哪个派系来"
  return scanTradeTarget(p, ctx, home);
}

/** 扫描本体（纯函数）：排除 home，取半径内友好派系中最近的一座。 */
function scanTradeTarget(p: PawnState, ctx: SimContext, home: BuildingState): BuildingState | null {
  const t = ctx.tuning.factions;
  let best: BuildingState | null = null;
  let bestD = t.tradeMagnetRadius;
  for (const b of firesOf(ctx)) {
    if (b.id === home.id) continue; // 自己人不算贸易对象
    const d = Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y);
    if (d > bestD) continue;
    if (repOf(ctx, home.id, b.id) > t.friendlyThresh) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/** 解析（首次则锁定）本次贸易的目标篝火。找不到返回 null。
 *
 * ⚠ 本函数**有副作用**（写/删 ctx.scratch 的贸易目标键）：只有 action 路径
 *   （doTrade）能调。condition 必须走上面的纯查询——否则抽卡阶段就在改世界。
 *
 * 【为什么必须锁定，缺了它是什么样】trade 的目标是"另一个"营地的火。鼠一路走过去，
 *   到达瞬间那座火就变成了"离它最近的篝火"= 它此刻的 home。若每 tick 都按当前位置
 *   重算目标，鼠会在到岸的那一刻发现"目标成了家、家没了"，于是转身走回出发地——
 *   实测结果是**永远走不完这段路**，贸易永远是死代码。
 *   锁定一次后就固定走这一座，直到成交或目标失效（火被灭 / 声望掉出友好线）。
 * 【为什么存 seq 而不是建筑 id】ctx.scratch 是 Record<string, number>（只放数字才能
 *   原样随档），建筑 id 是字符串 'b1'/'b2'，所以存 seq 号再用 fireOfSeq 反查。 */
function tradeTargetOf(p: PawnState, ctx: SimContext): BuildingState | null {
  const t = ctx.tuning.factions;
  const key = FACTION_KEYS.tradeTarget(p.eid);
  const pinned = ctx.scratch[key];
  if (pinned !== undefined) {
    const target = fireOfSeq(ctx, pinned);
    const home = target ? nearestFireExcept(ctx, p, target.id) : null;
    // 目标仍然有效 = 火还在 + 家还在 + 家对它的看法仍然友好
    if (target && home && repOf(ctx, home.id, target.id) > t.friendlyThresh) return target;
    delete ctx.scratch[key]; // 失效：下面重新找，找不到就收工
  }
  const home = nearestFireOf(p, ctx);
  if (!home) return null;
  const best = scanTradeTarget(p, ctx, home);
  if (best) ctx.scratch[key] = ctx.scratch[FACTION_KEYS.name(best.id)] ?? -1;
  return best;
}

/** 贸易收工：清掉目标缓存（否则这张卡结束后残留的目标会污染下一次抽卡）。 */
function dropTradeTarget(p: PawnState, ctx: SimContext): void {
  delete ctx.scratch[FACTION_KEYS.tradeTarget(p.eid)];
}

/**
 * 贸易动作（磁铁范式）。
 *
 * 【简化说明 —— 必须诚实】本实现是**净转化**，不是"双方各拿一份"：
 *   派系**没有独立库存**——`ctx.stockpile` 是全局唯一的营地仓库，
 *   没有"b 派系的库存"可供扣减，所以"对方给 food"根本无处落地。
 *   因此贸易被建模为一次 wood→food 的折算：
 *     付 tradeWoodCost 份 wood（全局仓库减），
 *     得 round(tradeWoodCost × tradeRatio) 份 food（同一仓库加）。
 *   tradeRatio 就是这个折算率（出厂 2:1 = 0.5，即 2 份 wood 换 1 份口粮）。
 *   声望是双向各 +repGainTrade——这才是"双方受益"的真实落点。
 *
 *  真实贸易需要双向库存 + 运货工作卡（那是新的机制链，超出本包范围）。
 *  这个简化**牺牲了**"对方被掏空 / 贸易有反噬"这一层：目前贸易永远对双方有利，
 *  没有剥削关系可涌现。
 */
function doTrade(p: PawnState, ctx: SimContext): void {
  const t = ctx.tuning.factions;
  const target = tradeTargetOf(p, ctx);
  const home = target ? nearestFireExcept(ctx, p, target.id) : nearestFireOf(p, ctx);
  if (!target || !home) {
    dropTradeTarget(p, ctx);
    ctx.finishCard(p); // 营地没了 / 声望掉出友好线：收工重抽
    return;
  }
  const d = Math.hypot(target.pos.x - p.pos.x, target.pos.y - p.pos.y);
  if (d > t.tradeWorkRadius) {
    // 还不够近——**走过去**（本包全部的"磁铁"含义）。路上不结算。
    if (p.path.length === 0 && !ctx.setPath(p, target.pos.x, target.pos.y)) {
      dropTradeTarget(p, ctx);
      ctx.finishCard(p); // 不可达（水/岩隔断）：收工，防恒真空转
    }
    return;
  }
  p.path = []; // 到位停走
  const wood = ctx.stockpile[K_STOCK_WOOD] ?? 0;
  if (wood < t.tradeWoodCost) {
    dropTradeTarget(p, ctx);
    ctx.finishCard(p); // 走到半路货被别的鼠用光：收工
    return;
  }
  ctx.stockpile[K_STOCK_WOOD] = wood - t.tradeWoodCost;
  ctx.stockpile[K_STOCK_FOOD] = (ctx.stockpile[K_STOCK_FOOD] ?? 0) + Math.round(t.tradeWoodCost * t.tradeRatio);
  // 双向声望：贸易是合作，双方看法都变好（有向键各写一次）
  setRep(ctx, home.id, target.id, repOf(ctx, home.id, target.id) + t.repGainTrade);
  setRep(ctx, target.id, home.id, repOf(ctx, target.id, home.id) + t.repGainTrade);
  ctx.log(`🤝 ${factionNameOf(ctx, home.id)} 与 ${factionNameOf(ctx, target.id)} 互换了货`);
  dropTradeTarget(p, ctx);
  ctx.finishCard(p);
}

// ================= 掠夺 =================

/** 每 checkSec 跑一次：遍历派系对（双向），命中仇恨 + 冷却到期的就刷一波。 */
function checkRaids(ctx: SimContext): void {
  const fires = firesOf(ctx);
  for (let i = 0; i < fires.length; i++) {
    for (let j = i + 1; j < fires.length; j++) {
      // 双向各查一次：声望是有向的，a 恨 b 不等于 b 恨 a
      considerRaid(ctx, fires[i], fires[j]);
      considerRaid(ctx, fires[j], fires[i]);
    }
  }
}

/** 单次掠夺判定（a 打 b）。失败（落点不可站）则**不扣声望、不设冷却**：
 *  掠夺顺延到找到落脚点的那个 tick，绝不生成幽灵 raider（与 raid.trySpawnCat 同语义）。 */
function considerRaid(ctx: SimContext, a: BuildingState, b: BuildingState): void {
  const t = ctx.tuning.factions;
  if (repOf(ctx, a.id, b.id) >= t.hostileThresh) return;
  const cdKey = FACTION_KEYS.raidCd(a.id, b.id);
  if ((ctx.scratch[cdKey] ?? 0) > ctx.time) return; // 冷却中：这一对还在歇战
  const n = 1 + Math.floor(ctx.rng() * Math.max(1, t.maxRaiderWave)); // 1..maxRaiderWave
  let spawned = 0;
  for (let k = 0; k < n; k++) {
    if (!spawnRaiderAt(ctx, b, t.spawnRadius)) break;
    spawned++;
  }
  if (spawned === 0) return;
  // 掠夺成立：仇恨加深、传闻扩散、冷却计时起算
  setRep(ctx, a.id, b.id, repOf(ctx, a.id, b.id) - t.repLossRaid);
  ctx.scratch[FACTION_KEYS.gossip(a.id)] = Math.min(1, (ctx.scratch[FACTION_KEYS.gossip(a.id)] ?? 0) + t.gossipPerRaid);
  ctx.scratch[cdKey] = ctx.time + t.raidCooldownSec;
  ctx.log(`⚔️ ${factionNameOf(ctx, a.id)} 袭击了 ${factionNameOf(ctx, b.id)} 的营地（${spawned} 只侵略者）`);
}

/** 在营地外围刷一只 raider：随机方位 + 螺旋外扩找可站格。找不到返回 false。 */
function spawnRaiderAt(ctx: SimContext, fire: BuildingState, radius: number): boolean {
  const ang = ctx.rng() * Math.PI * 2;
  let bx = Math.round(fire.pos.x + Math.cos(ang) * radius);
  let by = Math.round(fire.pos.y + Math.sin(ang) * radius);
  const ok = (x: number, y: number): boolean => ctx.passable(x, y);
  if (ok(bx, by)) {
    ctx.spawnHostile('raider', bx, by);
    return true;
  }
  // 螺旋外扩（同 raid.trySpawnCat 的防线：不落水里 = 不生成幽灵 raider）。
  // 注意 spiral 内**不再修改 bx/by**：改用一个独立变量记录落脚点，
  // 否则外层 `for (... && !ok(bx,by))` 的守卫会在第一圈内被打断，语义不清晰。
  let sx = bx;
  let sy = by;
  outer: for (let r = 1; r <= 30; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (ok(bx + dx, by + dy)) {
          sx = bx + dx;
          sy = by + dy;
          break outer;
        }
      }
    }
  }
  if (!ok(sx, sy)) return false; // 方圆 30 格没有落脚点：这一波顺延（不扣声望、不设冷却）
  ctx.spawnHostile('raider', sx, sy);
  return true;
}
