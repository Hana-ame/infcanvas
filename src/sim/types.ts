// 引擎公开类型（2026-08-16 大文件拆分：自 sim.ts 迁出）
// 背景：Sim 类 ~1120 行里近 200 行是纯类型声明（数据接口/存档格式/命令协议），
// 与实现混在一起增大阅读面。迁出后 sim.ts 只留实现，类型权威在此——
// sim.ts 以 re-export 保持既有 import 路径（'../sim'）不变，本文件零运行时依赖
// （全部 import 为 type-only），无循环风险。
import type { Dna, SkillId, BehaviorCard } from './ai/pawn';
import type { DesireId } from './core/desires';
import type { LeanKey } from './core/lean';
import type { ChunkData } from './core/world';
import type { ScriptedEvent } from './systems/eventSystem';
import type { ModRegistry } from './mods/registry';
import type { IntentExecutor, WorkExecutor } from './systems/executors';

// behavior 能力（2026-08-15 纯引擎：决策引擎 = 玩法包提供的能力，Sim 只消费注册面）
export interface BehaviorCap {
  registerIntent(id: string, fn: IntentExecutor): void;
  registerWork(type: string, fn: WorkExecutor): void;
}

// ---- 数据组件定义 ----
export interface PositionData { x: number; y: number }
export interface NeedsData { food: number; rest: number; mood: number; san: number }
export interface SpeedData { v: number }
export interface HealthData { hp: number; maxHp: number }

export interface PawnState {
  dna: Dna;
  climb: number; // 通过能力（高差上限；spawn 时从 tuning.pawn.climb 取——单位各自能力，mod 可 overrideTuning）
  // ⚠️ 差距登记（2026-08-15 审计）：实现 = spawn 取 tuning 后从不修改，全小人恒同值；
  // 存档不还原也无差别（值恒等于 tuning）。若未来做个体差异（如天赋加攀爬），
  // 需在 SaveData 增加 climb 字段并随档。enemyDef.climb 差异化不受影响（寻路读各自 def）。
  slots: (BehaviorCard | null)[];
  path: { x: number; y: number }[];
  pathIndex: number;
  urgent?: 'eat' | 'rest';
  mining?: { x: number; y: number; progress: number };
  mineTarget?: { x: number; y: number };
  chopTarget?: { x: number; y: number };
  caveTarget?: { x: number; y: number }; // 矿洞工作目标
  caveWork?: { x: number; y: number; progress: number; duration?: number; buildingId?: string }; // 建筑内持续工作（矿洞/竹筏，buildingId=recipe）
  chopXY?: { x: number; y: number };
  chopProgress?: number;
  prayTarget?: { x: number; y: number }; // 祈祷点（篝火）
  praying?: { x: number; y: number; progress: number };
  healTarget?: { x: number; y: number }; // 疗伤点
  healing?: { progress: number };
  commandCooldown?: number; // 玩家命令后的一段时间不自动决策
  decisionCd?: number; // 决策节流冷却（2026-08-16：非零时不抽卡，保持上次意图——降 CPU）
  faith?: number; // 信仰度（祈祷积累，影响违抗与心情）
  defyCd?: number; // 违抗后的冷却时间（秒）
  crazyCooldown?: number; // 狂乱乱跑冷却
  farScanCd?: number;     // 远距回扫冷却（miss 后不重复大半径扫描）
  pathCd?: number;        // 寻路节流冷却（两次寻路最小间隔，防每帧重寻路风暴）
  expectEarn?: number;    // 个人经济预期：工作赚多少（滚动平均）
  expectSpend?: number;   // 个人经济预期：花费花多少（滚动平均）
  expectEarnBy?: Record<string, number>; // 按工作类型的收益预期（决策调制：赚得多的活更愿意干）
  crazyTime?: number;     // SAN 狂乱累计时长（超过阈值 → 逃向篝火）
  crazyFleeTarget?: { x: number; y: number }; // 崩溃逃向的篝火目标
  skills?: Partial<Record<SkillId, number>>; // COC 技能（百分制，越用越强）
  desires?: Record<DesireId, number>; // 七宗罪满足度（DESIGN §3）
  lastNeedRec?: number; // 需求写入篝火记忆的节流等级（needsSystem.recordNeed 用，防刷屏）
  huntTarget?: { x: number; y: number }; // 狩猎目标猫位置（采集狩猎 mod 的 huntCombat 系统推进攻击）
  huntScanCd?: number; // 狩猎目标扫描冷却（发现背景：hunt 卡提权后无缓存无冷却 → 每帧全图扫猫+寻路，30 分钟局 20s→240s+ 超时）
  huntElapsed?: number; // 追猫累计时长（超时放弃，防猫在水上/建筑中打不到 → 无限追+每 pathCd 重寻路死循环）
  huntSkillCd?: number; // 狩猎技能成长节流（每帧 growSkill → EWA 学习表更新开销大，profile 实测为热点）
  inventory?: Record<string, number>; // 个人私有物品（2026-08-14 用户设计：私有物品 + 真以物易物；
  // 当前实现仅食物私有化：主动采集的食入口袋，进食优先扣个人；木材/矿石仍走全局公共仓库）
  relationships?: Map<number, number>; // 对其他小人的好感度（社交系统）
  socialCd?: number; // 社交冷却
  job?: string;
  // 最近决策记录（设计文档：小人闪过哪3个念头、选了哪个）
  lastDecision?: { drawn: string[]; picked: string; time: number };
  lastSeries?: string; // 上一轮执行的卡系列（马尔可夫偏置，DESIGN §6）
  oracleBuff?: { until: number; mood: number }; // 神谕祝福（到期时间戳，心情加成）
  assignedJob?: string; // 指派职业（Q10 生产线：lumberjack/miner/farmer/crafter）
  lean?: Record<LeanKey, number>; // 行为倾向（勒沙特列反馈：按 profit 自平衡）
  gossip?: { text: string; heardAt: number }; // 听到的八卦（社交网络传播，TTL 内可转述）
  // 关联篝火（用户 2026-08-13 B 方案：每个人保存一个篝火，在篝火周围生存；
  // 不舒适可另起篝火）。null = 游牧（暂无营地归属）
  fireId?: number | null; // 关联篝火建筑 key（2026-08-14 重构：无派系单位，指向 campfire 主格）
  // 对"听说的篝火"的看法（B 方案：通过交流篝火历史判断伙伴/敌人）
  // stance: friend/enemy/unknown；basis = 判断依据（听到的历史事件描述）
  knownFires?: Record<number, { stance: 'friend' | 'enemy' | 'unknown'; basis: string; at: number }>;
  // mod 系统自定义字段（存档扩展点 2026-08-14：伤情/囚犯/温度等由玩法包自由读写，
  // save 原样序列化、load 原样还原——解决"mod 状态一存档就丢"；契约：值必须 JSON-safe）
  extra?: Record<string, unknown>;
  onArriveWork?: () => void; // mod 工作的到达回执（非序列化，仅当 tick 行为态：走到点后调用）
}

export interface SimOptions {
  seed?: number;
  pawnCount?: number;
  tickHz?: number;
  mods?: (m: ModRegistry) => void; // mod 挂载：构造时注册系统/卡/意图（DESIGN §7）
  registry?: ModRegistry;          // 预建注册表（服务端 mod 管理器：先挂载所有包再构造 Sim）；缺省 ModRegistry.default()
  eventProvider?: () => ScriptedEvent | null; // LLM 慢决策层（P1）：替换确定性随机脚本（DESIGN §6）
}

export interface Command {
  // 命令协议（引擎面，2026-08-15 纯插件收敛）：type = 命令名——'move' 引擎内建，
  // 其余由玩法包 registerCommand 提供处理器；`(string & {})` = 开放扩展：玩法包新命令
  // （wear/build/mine/oracle/assign…）无需改内核枚举（IDE 仍提示已知命令）。
  // 命令专属参数走 args 通用位（内核不解释，玩法包自行读取——wear 命令的 itemId 先例）。
  // 曾把 'wear' 写进联合 + itemId 顶层字段，被用户指摘"内核为什么扩展"后收敛为本协议面
  type: 'move' | 'build' | 'haul' | 'mine' | 'oracle' | 'assign' | (string & {});
  pawnId?: number;
  x: number;
  y: number;
  buildingId?: string;
  job?: string; // assign 命令用（lumberjack/miner/farmer/crafter）
  args?: Record<string, unknown>; // 玩法命令参数位（如 wear 的 { itemId }）
}

export interface SaveData {
  // 存档格式版本（2026-08-16 架构优化：版本化 + 迁移注册表）。缺省 0 = 旧档（2026-08-16
  // 前的所有档）。load 拒载 saveVersion > SAVE_VERSION 的档（防新版本格式被旧版读损坏），
  // 并依次跑 SAVE_MIGRATIONS[from..SAVE_VERSION-1] 迁移后按新版本语义读。
  saveVersion?: number;
  time: number;
  dayTime: number;
  stockpile: Record<string, number>;
  tiles: string[] | ChunkData[]; // 旧档 = 全量 string[]（192×192）；新档 = 覆盖层 chunk（DESIGN §375）
  buildings: { key: number; defId: string; hp: number; faction: string; extra?: Record<string, unknown> }[];
  techs?: string[]; // 已解锁科技（旧档缺省空）
  techFragments?: Record<string, number>; // 科技碎片进度（2026-08-14 碎片制；旧档缺省空）
  // 科技解锁时间（2026-08-16 修复：此前不随档 → 读档后 techBuildWeight 恒 0，
  // "解锁时长渐进"机制读档即失效——已解锁科技建筑的自动建造权重永不爬升）
  techUnlockedAt?: Record<string, number>;
  pawns: {
    eid: number; x: number; y: number;
    dna: Dna; slots: (string | { id: string; m: number; u: number } | null)[]; // 卡 id（+熟练度）——JSON-safe
    needs: NeedsData | null; health: HealthData | null;
    faith?: number;
    skills?: Partial<Record<SkillId, number>>;
    desires?: Record<DesireId, number>;
    inventory?: Record<string, number>;
    oracleBuff?: { until: number; mood: number };
    assignedJob?: string;
    fireId?: number | null; // 关联篝火建筑 key（2026-08-14 重构：无派系单位，指向 campfire 主格）
    knownFires?: Record<number, { stance: 'friend' | 'enemy' | 'unknown'; basis: string; at: number }>;
    extra?: Record<string, unknown>; // mod 自定义字段（存档扩展点：JSON-safe，load 原样还原）
  }[];
}