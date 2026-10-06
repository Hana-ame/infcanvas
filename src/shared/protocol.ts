/**
 * shared/protocol.ts —— 远程协议（阶段④）：稀疏快照 + 命令 + 事件流。
 *
 * 形态：
 *  - server→client：welcome（新连接：seed/tuning/全量状态）> full（周期全量对账 ~5s）
 *    > delta（增量 ~500ms：只带变化的 pawn + 删除名单 + 新事件；hostiles/buildings
 *      数量级小，直接全发）。
 *  - client→server：cmd（type+args，服务端白名单校验后走 issueCommand 同一入口）。
 *
 * 地形策略：无限地图不下发地形——客户端用 welcome 里的 seed+tuning 本地重建 World
 * 纯函数推导 tile；特征余量/冷却属于运行态，随 full 快照的 world 段同步。
 */
import type { BuildingState, Eid, Hostile, LogEvent, PawnState } from '../sim/types';
import type { SaveData } from '../sim/sim-save';
import type { Tuning } from '../sim/tuning';

/** 全量状态（welcome/full 共用体；不含 tuning——welcome 单独带一次） */
export interface FullState {
  time: number;
  stockpile: Record<string, number>;
  pawns: PawnState[];
  hostiles: Hostile[];
  buildings: BuildingState[];
  events: LogEvent[];
  /** 特征运行态（余量/冷却），客户端本地 World 用它回答 featureAt */
  world: SaveData['world'];
  /**
   * 科技抽卡池状态（R2-1）：已解锁 id 列表 + 各科技碎片数。
   * 走 full/welcome 段同步而**不走 delta**：科技碎片每 ~120s 才变一次，
   * 放进 500ms 的增量帧纯属浪费带宽；且 delta 的基线比对是逐 pawn JSON 对照，
   * 科技是全局状态另开一路反而复杂。客户端最迟 5s 看到新碎片——
   * 抽卡节奏本身就是分钟级，这个延迟不可感知。
   */
  techs: string[];
  techFragments: Record<string, number>;
  /**
   * 玩法包运行态子集（R3-HUD，2026-10-06）：**只带 HUD 面板要显示的那几个键**，
   * 不是把整个 scratch 推下去。
   *
   * 为什么需要它：敌袭叙事压力存在 raid 包的 scratch 键 'raid.pressure' 里，
   * HUD 威胁面板要显示它（玩家此前完全看不到"下一波还有多久"）。
   * 但 scratch 是 Record<string, number>——整份外推等于把**所有包的内部实现细节**
   * 变成网络契约（将来某个包加个内部累加器就会悄悄变成协议字段）。
   * 所以服务端在出口白名单挑选：键集变化成为**有意识的契约变更**，不会被顺带捎进来。
   *
   * 只随 full/welcome 走、不进 delta：压力是分钟级低频量（默认约每 180s 一波），
   * 放进 500ms 增量帧纯属浪费带宽；玩家最迟 5s 看到，与抽卡节奏同一量级，不可见。
   */
  hudScratch: Record<string, number>;
}

/** HUD 面板依赖的 scratch 键白名单（R3-HUD）。
 *  为什么写死在这里而不是让实现方遍历：这是协议契约的一部分，改这里 = 改网络契约。 */
export const HUD_SCRATCH_KEYS: readonly string[] = ['raid.pressure'];

export interface WelcomeMsg {
  t: 'welcome';
  d: FullState & { seed: number; tuning: Tuning };
}
export interface FullMsg {
  t: 'full';
  d: FullState;
}
export interface DeltaMsg {
  t: 'delta';
  d: {
    time: number;
    stockpile: Record<string, number>;
    /** 只含与上次不同的 pawn（JSON 逐只比较） */
    pawns: PawnState[];
    removedPawns: Eid[];
    hostiles: Hostile[]; // 数量小，直接全量
    buildings: BuildingState[]; // 同上
    newEvents: LogEvent[];
    /** 特征运行态只在 full 里同步；delta 不带（低频变化可容忍 5s 延迟） */
  };
}
/**
 * 心跳帧（R1-1）：服务端每 PING_MS_MS 一帧无条件广播。
 * 为什么是**服务端主动发**而不是客户端发 ping 等 pong：
 *  - 单向帧就够判定链路活着，不必为 pong 再加一条消息类型与状态机；
 *  - 服务端主动发能同时探测"服务端→客户端"方向（NAT/代理下上行通不代表下行通）；
 *  - 断连期间客户端也能靠它确认"服务端还活着，只是我这条断了"，从而立即重连
 *    而不是傻等 15s 看门狗。
 * 客户端只要 15s 内没收到**任何**消息（不只 ping）就判定假死。
 */
export interface PingMsg {
  t: 'ping';
  /** 服务端 sim.time（秒）：兼作链路活性 + 时间对齐的粗校验 */
  d: { time: number };
}
export type ServerMsg = WelcomeMsg | FullMsg | DeltaMsg | PingMsg;

/** 心跳广播周期（ms）。ROADMAP R1-1 规定 10s。 */
export const PING_MS = 10000;

/** 客户端看门狗阈值（ms）：超过这么久没收到任何消息即判定假死。ROADMAP R1-1 规定 15s。 */
export const WATCHDOG_MS = 15000;

export interface CmdMsg {
  t: 'cmd';
  c: { type: string; args?: Record<string, unknown>; src?: string; token?: string };
}
export type ClientMsg = CmdMsg;

/**
 * 服务端命令白名单：基础指挥面。新命令要上行必须在此登记（防任意调用注入）。
 * 注意：不登记 ≠ 报错，而是**静默丢弃并计入 rejectedCommands**（服务端不给客户端
 * 错误回显通道是刻意的，见 game-server 头注释）——所以漏登记极难排查。
 * R1-5 新增 save/load 即踩过这个坑：命令发出去没反应，必须在此登记才生效。
 */
export const SERVER_COMMANDS: readonly string[] = ['move', 'save', 'load'];

/** move 参数校验：坐标有限且在防御边界内；eids 存在性由 Sim.issueCommand 自行过滤 */
export function validMoveArgs(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  const x = args.x as number;
  const y = args.y as number;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (Math.abs(x) > 30000 || Math.abs(y) > 30000) return false;
  return true;
}

/**
 * save 参数校验：无参或 { name }。
 * name 是**存档名**（不含扩展名），服务端会拼成 saves/<name>.json。
 * 这里只校字符集：挡掉 ../ 与绝对路径（目录穿越），不替代调用方的 admin 鉴权。
 */
export function validSaveArgs(args: Record<string, unknown> | undefined): boolean {
  if (args === undefined) return true;
  const name = args.name;
  if (name === undefined) return true;
  if (typeof name !== 'string') return false;
  return isSafeSaveName(name);
}

/**
 * load 参数校验：{ file } 必填，且必须是安全的存档名/文件名。
 * 与 save 共用字符集校验——存档文件名同时是路径分量，必须同标准。
 */
export function validLoadArgs(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  const file = args.file;
  if (typeof file !== 'string' || file === '') return false;
  // 允许带不带 .json 后缀，两种写法都归一（玩家手敲命令行时最容易忘后缀）
  const stem = file.endsWith('.json') ? file.slice(0, -'.json'.length) : file;
  return isSafeSaveName(stem);
}

/**
 * 存档名安全校验：只允许 [A-Za-z0-9_-]。
 * 为什么这么严：name 会直接拼进文件路径 saves/<name>.json，放开 . / \ 就是
 * 目录穿越（../../etc/passwd 之类）。宁可拒绝用户想要的中文名——那只是可用性损失，
 * 而目录穿越是安全事故。名字里带时间戳正是设计者要的默认形态，纯 ASCII 够用。
 */
function isSafeSaveName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

/**
 * 管理命令（save/load）的入参校验分发表。
 * 与 move 一样在服务端统一入口校验——白名单只管"这个命令存在吗"，
 * 参数是否合法是第二道闸；两道都过才交给具体实现。
 */
export function validateAdminArgs(type: string, args: Record<string, unknown> | undefined): boolean {
  if (type === 'save') return validSaveArgs(args);
  if (type === 'load') return validLoadArgs(args);
  return false;
}
