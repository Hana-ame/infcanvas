// 网络协议类型（DESIGN §8）—— WSS，sim 双端同源，类型单一定义
// C→S 命令复用 Sim.Command 形状；S→C 推快照/事件/defs（defs 只读）
import type { Command } from '../sim/sim';
import type { ChunkData } from '../sim/core/world';

// ---- C → S ----
export interface CmdMsg { type: 'cmd'; cmd: Command }
export interface HelloMsg { type: 'hello'; name?: string }
export type ClientMsg = HelloMsg | CmdMsg;

// ---- S → C ----
// welcome：建立连接时发一次世界底（chunk 全量 tile + defs 只读表）
// 服务端下发的客户端 UI 常量（与 server 同一份 tuning，消除双真值源）
export interface WelcomeTuning {
  needs: { foodMoodLow: number };               // 食物告急阈值
  faction: Record<string, number>; // 2026-08-14 重构：派系实体删除，预留参数槽
  env: { dayLength: number; baseTemp: number }; // 昼夜时长/基础气温
}

export interface WelcomeMsg {
  type: 'welcome';
  you: number;               // 分配到的 clientId
  seed: number;
  tickHz: number;
  dayLength: number;         // 昼夜时长（秒，读 sim tuning）
  tuning: WelcomeTuning;     // 客户端 UI 常量快照
  world: { width: number; height: number };
  tiles: Record<string, { id: string; color: string; passable: boolean; buildable: boolean; emoji?: string; sprite?: string }>;
  buildings: Record<string, { id: string; name: string; size: { x: number; y: number }; color: string; emoji?: string; passable: boolean; hp: number; costWood?: number; costOre?: number }>;
  items: Record<string, { id: string; name: string; w?: boolean }>; // w = 可穿（clothing 玩法包 2026-08-15：客户端穿衣按钮过滤）
  tileGrid: ChunkData[];     // 已生成 chunk 的完整地形（DESIGN §382 chunkData 的 P0 快照形态；缺省 = 未知区域）
}

// 周期快照（骨架期 2Hz 全量；P2 增量后：仅新连接与定期对账时发全量）
export interface SnapshotMsg {
  type: 'snapshot';
  t: number;                 // sim 时间（秒）
  paused: boolean;
  speed: number;
  isNight: boolean;
  day: number;
  weather: { raining: boolean; temperature: number };
  stockpile: Record<string, number>;
  pawns: {
    eid: number;
    x: number; y: number;
    hp: number; maxHp: number;
    job?: string; assignedJob?: string;
    needs?: { food: number; rest: number; mood: number; san: number };
    faith: number;
    attrs: { str: number; con: number; siz: number; dex: number; int: number; pow: number; app: number; edu: number };
    skills: Record<string, number>;
    traits: string[];
    maxSlots: number;
    slots: { id: string; name: string }[];  // 卡（非 null 槽位）
    desires: Record<string, number>;
    lastDecision?: { drawn: string[]; picked: string; time: number };
    worn?: string; // 穿着衣物物品 id（clothing 玩法包 2026-08-15：客户端染色 tint 用；
    //   空串 "" = 无穿着——2026-08-15 审计：undefined 会被 JSON.stringify 丢弃，delta 无法表达"脱下"）
    drafted?: boolean; // RW-1 征召（drafting 包）：true = 征召中（不自主决策）。缺省 = 未征召
    // 战场指挥 DLC（field-command 包 2026-08-16）：编制树/生效战术回显（server 从
    // pawn.extra 序列化）。commander 缺省 undefined = 非指挥官；tactic 缺省 undefined = 无战术
    commander?: { role: 'officer' | 'general'; subordinates: number[] };
    tactic?: string;
  }[];
  hostiles: { i: number; enemyId?: string; x: number; y: number; hp: number; maxHp: number; faction?: string }[];
  buildings: { key: number; defId: string; x: number; y: number; hp: number; maxHp: number; faction: string; footprint: { x: number; y: number }[] }[];
  // key = World 编码 x + y*2^31（2026-08-15 审计：与 DeltaMsg.buildings.key 统一同一编码——
  // 此前 snapshot 无 key，diff 端用魔数 x + y*1000000 重拼，客户端按 World.keyToXY(2^31)
  // 解码 → y≠0 建筑 delta 坐标错乱到 (x+1000000,0)，5s 对账才纠正）
  buildQueue: { x: number; y: number; defId: string; progress: number }[];
  buildingVersion: number;
}

// 增量快照（tick delta，P2）：快照之间的变化量，只有变化的字段才带。
// 身份规则：pawn 按 eid、建筑按 key(x+y*width) 对齐；hostiles/全局字段整体覆盖。
// 兜底：server 每 SNAPSHOT_RECONCILE_MS 发一次全量对账，防止丢失/相消累积偏差。
export interface DeltaMsg {
  type: 'delta';
  t: number;
  paused?: boolean;
  speed?: number;
  isNight?: boolean;
  day?: number;
  weather?: { raining: boolean; temperature: number };
  stockpile?: Record<string, number>;
  pawns?: {
    eid: number;
    x?: number; y?: number;
    hp?: number; maxHp?: number;
    job?: string; assignedJob?: string;
    needs?: { food: number; rest: number; mood: number; san: number };
    faith?: number;
    attrs?: { str: number; con: number; siz: number; dex: number; int: number; pow: number; app: number; edu: number }; // 新 pawn 首现必带
    skills?: Record<string, number>;
    traits?: string[];
    maxSlots?: number;
    slots?: { id: string; name: string }[];
    desires?: Record<string, number>;
    lastDecision?: { drawn: string[]; picked: string; time: number };
    worn?: string;      // 穿着衣物（同 SnapshotMsg）
    drafted?: boolean;  // RW-1 征召（同 SnapshotMsg；缺省 = 未征召）
    commander?: { role: 'officer' | 'general'; subordinates: number[] }; // 战场指挥（同 SnapshotMsg）
    tactic?: string;    // 战场指挥：生效战术 id（同 SnapshotMsg）
    removed?: boolean;      // pawn 消失（死亡/重生）
  }[];
  // pawn 集合整体变化（增/删）时带全量列表，client 据此重建 pawns 顺序
  pawnList?: number[];
  hostiles?: { i: number; enemyId?: string; x: number; y: number; hp: number; maxHp: number; faction?: string }[];
  buildings?: { key: number; defId: string; hp: number; maxHp: number; faction: string; footprint: { x: number; y: number }[]; removed?: boolean }[];
  buildingVersion?: number;
  buildQueue?: { x: number; y: number; defId: string; progress: number }[];
}

// 增量（快照之间的小事件：采集换 tile、资源获得飘字、社交/袭击等文本）
export interface EventMsg {
  type: 'event';
  t: number;
  events: {
    kind: 'tileChanged' | 'resourceGained' | 'feed';
    x?: number; y?: number; tileId?: string;
    eid?: number; item?: string; amount?: number;
    text?: string;
  }[];
}

// 心跳（2026-08-16 审计 M1）：服务器 2s 一发，唯一职责 = 让客户端看门狗在静默期
//（暂停/无事件/无增量）仍能区分"连接活着"与"连接断了"。不带业务字段（t = 权威时间，
// 客户端 t 锚定顺带刷新——暂停时 t 不变，锚定无损）。
export interface PingMsg { type: 'ping'; t: number }

export type ServerMsg = WelcomeMsg | SnapshotMsg | DeltaMsg | EventMsg | PingMsg;
