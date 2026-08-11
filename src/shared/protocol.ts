// 网络协议类型（DESIGN §8）—— WSS，sim 双端同源，类型单一定义
// C→S 命令复用 Sim.Command 形状；S→C 推快照/事件/defs（defs 只读）
import type { Command } from '../sim/sim';

// ---- C → S ----
export interface CmdMsg { type: 'cmd'; cmd: Command }
export interface HelloMsg { type: 'hello'; name?: string }
export type ClientMsg = HelloMsg | CmdMsg;

// ---- S → C ----
// welcome：建立连接时发一次世界底（chunk 全量 tile + defs 只读表）
// 服务端下发的客户端 UI 常量（与 server 同一份 tuning，消除双真值源）
export interface WelcomeTuning {
  needs: { foodMoodLow: number };               // 食物告急阈值
  faction: { unitCapChurch: number; unitCapCampfire: number }; // 派系单位成员上限
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
  items: Record<string, { id: string; name: string }>;
  tileGrid: string[];        // width*height 的 tile id（世界全量，一次性）
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
  }[];
  hostiles: { i: number; enemyId?: string; x: number; y: number; hp: number; maxHp: number; faction?: string }[];
  buildings: { defId: string; x: number; y: number; hp: number; maxHp: number; faction: string; footprint: { x: number; y: number }[] }[];
  buildQueue: { x: number; y: number; defId: string }[];
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
    removed?: boolean;      // pawn 消失（死亡/重生）
  }[];
  // pawn 集合整体变化（增/删）时带全量列表，client 据此重建 pawns 顺序
  pawnList?: number[];
  hostiles?: { i: number; enemyId?: string; x: number; y: number; hp: number; maxHp: number; faction?: string }[];
  buildings?: { key: number; defId: string; hp: number; maxHp: number; faction: string; footprint: { x: number; y: number }[]; removed?: boolean }[];
  buildingVersion?: number;
  buildQueue?: { x: number; y: number; defId: string }[];
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

export type ServerMsg = WelcomeMsg | SnapshotMsg | DeltaMsg | EventMsg;
