// 意图/工作执行器实现（2026-08-16 大文件拆分：自 cardSystem.ts 迁出）
// 背景：BehaviorSystem 660 行中约 300 行是执行器——除 walkAndWork 需查 mod 注册的
// 工作执行器表外全部只依赖 SimContext（零系统内部状态，原以类方法 + defs/executors.ts
// 的 handler 名字符串反射装配）。迁出后 = 实现表（与声明表同源数据驱动），BehaviorSystem
// 只留决策循环/移动/到达回执；handler 字段语义 = 本表键名（INTENT_IMPL/WORK_IMPL）。
// 类型与注册面（IntentExecutor/WorkExecutor）从本文件导出，cardSystem re-export 保持
// sim.ts/registry.ts 等既有 import 不变。
import type { SimContext } from './context';
import type { BehaviorIntent } from '../ai/pawn';
import { fulfill } from '../core/desires';
import { World } from '../core/world';
import { TECHS } from '../defs/techs';
import type { PawnState, PositionData } from '../sim';
import { beginHeal } from './heal';

// 意图执行器：mod 可注册新意图
export type IntentExecutor = (ctx: SimContext, eid: number, st: PawnState, intent: BehaviorIntent) => void;

// 工作执行器：mod 可注册新工作类型（walkAndWork 按 workType 分派到执行器）
export type WorkExecutor = (ctx: SimContext, eid: number, st: PawnState, intent: BehaviorIntent) => void;

// 内置实现表条目签名：统一 5 参（deps = 系统运行时依赖，仅 walkAndWork 用——
// workExecutors 是 mod 运行期注册的工作表，必须在执行时才查而非装配时快照）
export interface ExecutorDeps {
  workExecutors: Map<string, WorkExecutor>;
}
export type IntentImpl = (c: SimContext, eid: number, st: PawnState, intent: BehaviorIntent, deps: ExecutorDeps) => void;
export type WorkImpl = (c: SimContext, eid: number, st: PawnState) => void;

// ---- 意图实现 ----

const execIdle: IntentImpl = (_c, _eid, st) => {
  st.job = '闲逛';
};

// 探索（用户设计：科技建筑只有娱乐卡能"想到"建）：娱乐时灵光一现 → 规划蓝图入队
// 蓝图落点：营地（首个 campfire）旁环扫可建格；目标建筑从卡 id 解析（explore:well → well）
const execExplore: IntentImpl = (c, eid, st, intent) => {
  st.job = intent.label;
  const buildingId = intent.label.split(':')[1] ?? '';
  const def = c.buildingDef(buildingId);
  if (!def) { st.job = '闲逛'; return; }
  // 已有该建筑（被别人建了）→ 不再探索
  if (c.world.hasBuildingWithTag(buildingId)) { st.job = '闲逛'; return; }
  // 蓝图已在队列（重复探索）→ 跳过（防蓝图堆积：垦田令同款去重）
  if (c.buildQueue.some((b) => b.defId === buildingId)) { st.job = '闲逛'; return; }
  // 营地位置（首个 campfire）
  let camp: { x: number; y: number } | null = null;
  for (const [k, b] of c.world.buildings) {
    if (b.def.id === 'campfire') { camp = World.keyToXY(k); break; }
  }
  if (!camp) { st.job = '闲逛'; return; }
  // 环扫找落点（2→5 回退；靠营地内圈，减少外围被猫拆）
  for (let r = 3; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = camp.x + dx;
        const y = camp.y + dy;
        if (c.world.canBuildFootprint(x, y, def)) {
          c.issueCommand({ type: 'build', x, y, buildingId });
          c.logEvent(`🎈 #${eid} 玩耍时灵光一现：在这里建${def.name}！`);
          return;
        }
      }
    }
  }
  st.job = '闲逛';
};

// 走位工作：按意图的 workType 分派到工作执行器（mod 可注册新工作类型）
const execWalkAndWork: IntentImpl = (c, eid, st, intent, deps) => {
  const exec = intent.workType ? deps.workExecutors.get(intent.workType) : undefined;
  if (exec) exec(c, eid, st, intent);
  else st.job = '闲逛';
};

// 互助执行（2026-08-14 用户设计：小人对小人好感高 → 帮忙 = 满足对方食物/娱乐需求）。
// 对象 = findHelpTarget 判定的"值得帮的弱势邻人"（缺食/受伤/低落 + 我好感高）。
// 送食从自己口袋转给对方（私有食物）；疗伤直接回血；陪伴加心情。受助方好感提升（互惠）。
const execHelp: IntentImpl = (c, eid, st) => {
  const target = findHelpTarget(c, eid);
  if (target === null) { st.job = '闲逛'; return; }
  const s = c.tuning.social;
  const stT = c.pawnStates.get(target);
  if (!stT) return;
  const need = c.readNeeds(target);
  const hp = c.readHealth(target);
  // 送食（对方缺食且我有私粮）
  if (need && need.food < s.helpFoodNeedAt && (st.inventory?.food ?? 0) >= s.helpFoodAmount) {
    st.inventory = { ...st.inventory, food: (st.inventory?.food ?? 0) - s.helpFoodAmount };
    stT.inventory = { ...stT.inventory, food: (stT.inventory?.food ?? 0) + s.helpFoodAmount };
    c.recordSpend(eid, 'food', s.helpFoodAmount);
    need.food = Math.min(100, need.food + 15); // 收到食物 → 饱腹
    c.setNeeds(target, need);
    logHelp(c, eid, target, `🤝 #${eid} 把食物分给了饥饿的 #${target}`);
  } else if (hp && hp.hp < s.helpHpNeedAt) {
    // 疗伤（对方受伤）
    hp.hp = Math.min(hp.maxHp, hp.hp + s.helpHealPerSec);
    c.setHealth(target, hp);
    logHelp(c, eid, target, `🩹 #${eid} 为受伤的 #${target} 包扎伤口`);
  } else if (need && need.mood < s.helpMoodNeedAt) {
    // 陪伴（对方低落）
    need.mood = Math.min(100, need.mood + s.helpMoodGain);
    c.setNeeds(target, need);
    logHelp(c, eid, target, `💗 #${eid} 陪伴情绪低落的 #${target} 说说话`);
  }
  // 互惠：受助方对施助方好感提升
  const relT = stT.relationships ?? new Map<number, number>();
  relT.set(eid, Math.max(s.relFloor, Math.min(s.relCap, (relT.get(eid) ?? 0) + s.helpGiveRel)));
  stT.relationships = relT;
  st.job = '互助';
};

// 互助日志 + 好感（施助方对受助方也微增，巩固友谊）
const logHelp = (c: SimContext, eid: number, target: number, text: string): void => {
  c.logEvent(text);
  const st = c.pawnStates.get(eid);
  if (st) {
    const rel = st.relationships ?? new Map<number, number>();
    const s = c.tuning.social;
    rel.set(target, Math.max(s.relFloor, Math.min(s.relCap, (rel.get(target) ?? 0) + 1)));
    st.relationships = rel;
  }
};

// 互助目标探测（2026-08-14 互助卡）：相邻距离内的邻人，满足"弱势（缺食/受伤/低落）"且
// 我对 TA 好感 ≥ helpFriendAt（亲密才帮）。返回最优目标 eid 或 null。
//（2026-08-16 拆分：原为 BehaviorSystem 类方法，与 execHelp 一并迁出；decide 的
// CardView.helpTargetOf 谓词仍借用——见 cardSystem.ts decide）
export const findHelpTarget = (c: SimContext, eid: number): number | null => {
  const s = c.tuning.social;
  const me = c.pawnPositions.get(eid);
  if (!me) return null;
  const myRel = c.pawnStates.get(eid)?.relationships;
  let best: number | null = null;
  let bestNeed = 0;
  for (const other of c.pawnList) {
    if (other === eid) continue;
    const pos = c.pawnPositions.get(other);
    if (!pos) continue;
    if (Math.hypot(pos.x - me.x, pos.y - me.y) > s.meetDist) continue; // 必须相邻
    // 好感门槛：亲密才帮（帮助不是义务，是情分）
    const rel = myRel?.get(other) ?? 0;
    if (rel < s.helpFriendAt) continue;
    const need = c.readNeeds(other);
    const hp = c.readHealth(other);
    let score = 0;
    if (need && need.food < s.helpFoodNeedAt) score += 40 - need.food; // 缺食（送食）
    if (hp && hp.hp < s.helpHpNeedAt) score += 60 - hp.hp;             // 受伤（疗伤）
    if (need && need.mood < s.helpMoodNeedAt) score += 30 - need.mood; // 低落（陪伴）
    if (score > bestNeed) { bestNeed = score; best = other; }
  }
  return best;
};

const execEat: IntentImpl = (c, eid, st) => {
  const n = c.readNeeds(eid);
  if (!n) return;
  // 私有食物（2026-08-14）：优先吃自己口袋的；没有 → 公共粮仓兜底
  if (consumeFood(c, eid, st, c.tuning.card.eatCost)) {
    n.food = Math.min(100, n.food + c.tuning.card.eatAmount);
    c.setNeeds(eid, n);
    if (st.desires) fulfill(st.desires, 'gluttony', c.tuning.desire.fulfillGluttony);
    c.recordOutcome(eid, 'eat', c.tuning.card.eatAmount);
    c.bus.emit({ type: 'eat', eid });
  }
};

// 消耗食物（私有优先，公共兜底）：返回是否吃上。个人 inventory 有 → 扣个人；
// 没有 → 全局粮仓有 → 扣全局（公共资源）。两个都没有 → 吃不上（饿着/求助）。
// 导出：BehaviorSystem.handleUrgent（紧急进食路径）也借用——见 cardSystem.ts
export const consumeFood = (c: SimContext, eid: number, st: PawnState, cost: number): boolean => {
  const inv = st.inventory;
  if ((inv?.food ?? 0) >= cost) {
    st.inventory = { ...inv, food: (inv?.food ?? 0) - cost };
    c.recordSpend(eid, 'food', cost); // 经济账本：支出
    return true;
  }
  if (c.stockpile.food > 0) {
    c.stockpile.food -= cost;
    c.recordSpend(eid, 'food', cost); // 经济账本：支出（公共粮仓）
    return true;
  }
  return false;
};

const execRest: IntentImpl = (c, eid, st) => {
  const n = c.readNeeds(eid);
  if (n) {
    n.rest = Math.min(100, n.rest + c.tuning.card.restAmount);
    c.setNeeds(eid, n);
    if (st.desires) fulfill(st.desires, 'sloth', c.tuning.desire.fulfillSloth);
    c.recordOutcome(eid, 'rest', c.tuning.card.restAmount);
    c.bus.emit({ type: 'rest', eid });
  }
};

// 疗伤：去篝火旁休息回血。实现收敛到共享 beginHeal（2026-08-16 双疗伤路径统一：
// medicine treat 卡执行器与此处同构，两处漂移会静默分叉——见 systems/heal.ts 头注释）
const execHeal: IntentImpl = (c, eid, st) => {
  beginHeal(c, eid, st);
};

const execPray: IntentImpl = (c, eid, st) => {
  const pos = c.readPosition(eid);
  if (!pos) return;
  const fire = c.findNearest(pos, (x, y) => c.world.getBuilding(x, y)?.def.tags?.includes('pray') ?? false, true);
  if (fire) {
    st.prayTarget = fire;
    c.moveAdjacent(eid, fire.x, fire.y);
  } else st.job = '闲逛';
};

// 内置意图实现表（键 = defs/executors.ts BUILTIN_INTENTS 的 handler 字段值，全名对应）
export const INTENT_IMPL: Record<string, IntentImpl> = {
  execWalkAndWork: execWalkAndWork,
  execEat: execEat,
  execRest: execRest,
  execHeal: execHeal,
  execPray: execPray,
  execIdle: execIdle,
  execExplore: execExplore,
  execHelp: execHelp,
};

// ---- 工作实现 ----

const workChop: WorkImpl = (c, eid, st) => {
  const pos = c.readPosition(eid);
  if (!pos) return;
  // 数据驱动目标查找：可收获（growable）且带 harvest 定义的 tile（mod 新采集物自动可采）
  const want = (x: number, y: number): boolean => {
    const t = c.world.getTileDef(x, y);
    return !!t.growable && !!t.harvest;
  };
  // 近距快扫 miss → 远距回扫（营地周边资源采空后仍能远行采伐，防停产）
  const tree = findNearFar(c, st, pos, want);
  if (tree) { st.chopTarget = tree; c.moveAdjacent(eid, tree.x, tree.y); }
  else st.job = '闲逛';
};

const workMine: WorkImpl = (c, eid, st) => {
  const pos = c.readPosition(eid);
  if (!pos) return;
  // 数据驱动目标查找：mineral 且带 harvest 定义的 tile
  const ore = findNearFar(c, st, pos, (x, y) => {
    const t = c.world.getTileDef(x, y);
    return !!t.mineral && !!t.harvest;
  });
  if (ore) { st.mineTarget = ore; c.moveAdjacent(eid, ore.x, ore.y); }
  else st.job = '闲逛';
};

const workCaveMine: WorkImpl = (c, eid, st) => {
  const pos = c.readPosition(eid);
  if (!pos) return;
  const cave = findNearFar(c, st, pos, (x, y) => c.world.getBuilding(x, y)?.def.tags?.includes('mine') ?? false);
  if (cave) { st.caveTarget = cave; c.moveAdjacent(eid, cave.x, cave.y); }
  else st.job = '闲逛';
};

// 捕鱼：找竹筏（站上筏 → 钓水格；产出走筏的 recipe 'fishing'）
const workFish: WorkImpl = (c, eid, st) => {
  const pos = c.readPosition(eid);
  if (!pos) return;
  const raft = findNearFar(c, st, pos, (x, y) => c.world.getBuilding(x, y)?.def.tags?.includes('raft') ?? false);
  if (raft) { st.caveTarget = raft; c.moveAdjacent(eid, raft.x, raft.y); }
  else st.job = '闲逛';
};

// 近距快扫 miss → 远距回扫（营地周边资源采空后仍能远行工作，防长期停产）
// miss 后 5s 冷却内完全跳过扫描：空闲小人（找不到目标）每 tick 都做
// 15 半径环扫（706 格）是长局行为系统 10 倍退化的主因（profiler 火焰图定位）
const findNearFar = (c: SimContext, st: PawnState, pos: PositionData, cond: (x: number, y: number) => boolean): { x: number; y: number } | null => {
  if ((st.farScanCd ?? 0) > 0) return null;
  const near = c.findNearest(pos, cond, true);
  if (near) return near;
  const far = c.findNearest(pos, cond, true, c.tuning.pawn.farScanRadius);
  if (!far) st.farScanCd = 5;
  return far;
};

// 科技建筑渐进权重（用户设计）：解锁初期只有娱乐探索卡能建（权重 0），
// 随解锁时长 techBuildWeight 0→1 爬升——普通建造卡在无队列时按权重概率规划蓝图
const techBuildChance = (c: SimContext, eid: number, st: PawnState): void => {
  const pos = c.readPosition(eid);
  if (!pos) return;
  const t = c.tuning.tech;
  // 建造兴趣门控（v2026-08-13 兴趣驱动娱乐：建造是娱乐活动之一，只有有 build 兴趣的人才会
  // 「按经验规划」科技建筑；无兴趣者即使科技解锁、权重爬满也不主动建——与探索卡同源设计）
  if (!c.pawnStates.get(eid)?.dna.interests.includes('build')) { st.job = '闲逛'; return; }
  // 已解锁的科技建筑（按解锁顺序，取"营地还没有的"）
  const candidates: { techId: string; defId: string }[] = [];
  for (const techId of Object.keys(c.techs)) {
    const w = c.techBuildWeight(techId);
    if (w <= 0) continue;
    for (const defId of TECHS[techId]?.unlocks ?? []) {
      if (c.world.hasBuildingWithTag(defId)) continue;
      if (c.buildQueue.some((b) => b.defId === defId)) continue;
      candidates.push({ techId, defId });
    }
  }
  if (candidates.length === 0) { st.job = '闲逛'; return; }
  // 按权重概率：权重 1 → 每候选 10% 概率规划（渐进接管）；权重低 → 更少
  for (const cand of candidates) {
    const w = c.techBuildWeight(cand.techId);
    if (c.rng.next() < w * 0.1) {
      const def = c.buildingDef(cand.defId);
      if (!def) continue;
      // 营地旁环扫落点（复用探索落点逻辑）
      let camp: { x: number; y: number } | null = null;
      for (const [k, b] of c.world.buildings) {
        if (b.def.id === 'campfire') { camp = World.keyToXY(k); break; }
      }
      if (!camp) continue;
      for (let r = 2; r <= 5; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = camp.x + dx;
            const y = camp.y + dy;
            if (c.world.canBuildFootprint(x, y, def)) {
              c.issueCommand({ type: 'build', x, y, buildingId: cand.defId });
              c.logEvent(`🏗 #${eid} 按经验规划建造${def.name}（科技权重已就位）`);
              return;
            }
          }
        }
      }
    }
  }
  st.job = '闲逛';
};

const workBuild: WorkImpl = (c, eid, st) => {
  if (c.buildQueue.length === 0) {
    // 无队列 → 科技建筑渐进权重接管（解锁初期概率低，权重满后稳定自动建）
    techBuildChance(c, eid, st);
    return;
  }
  if (c.buildQueue.length > 0) {
    // 找最近的蓝图（而不是永远第一个）
    const pos = c.readPosition(eid);
    let best: (typeof c.buildQueue)[number] | null = null;
    let bestD = Infinity;
    if (pos) {
      for (const b of c.buildQueue) {
        const d = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2;
        if (d < bestD) { bestD = d; best = b; }
      }
    }
    const b = best ?? c.buildQueue[0];
    const def = c.buildingDef(b.defId);
    st.job = `建造:${def?.name ?? b.defId}`;
    c.moveTo(eid, b.x, b.y);
  } else st.job = '闲逛';
};

// 内置工作实现表（键 = defs/executors.ts BUILTIN_WORKS 的 handler 字段值，全名对应）
export const WORK_IMPL: Record<string, WorkImpl> = {
  workChop: workChop,
  workMine: workMine,
  workCaveMine: workCaveMine,
  workFish: workFish,
  workBuild: workBuild,
};

// 供 BehaviorSystem 装配：意图表（handler 键 → 实现函数签名适配 5 参 deps）/ 工作表
export const intentImplOf = (handler: string, deps: ExecutorDeps): IntentExecutor | null => {
  const fn = INTENT_IMPL[handler];
  if (!fn) return null;
  return (c, eid, st, intent) => fn(c, eid, st, intent, deps);
};
export const workImplOf = (handler: string): WorkImpl | null => WORK_IMPL[handler] ?? null;