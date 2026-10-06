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
 *
 * ================= 分区块同步（2026-10-06，line/net） =================
 *
 * ROADMAP 已知限制表登记的缺口「服务器 tick 无快照压缩（规模大后带宽）」在本轮部分清偿。
 * 做法：**按区块（CHUNK_SIZE=64，见 shared/chunks.ts）切分快照，客户端只收视口附近区块**。
 *
 * ### 兼容性：纯增量，旧客户端 / 新服务端可互通
 *
 * 新增字段一律**可选**（`?`），语义统一为「缺省 = 不做区块裁剪 = v1 行为」：
 *  - 服务端不发 `scope` → 客户端理解为"全量世界"（旧行为），不会因字段缺失而画成空白；
 *  - 客户端不上行 `interest` → 服务端理解为"要全世界"（旧行为）。
 * 于是**未升级的客户端连新区块化服务器仍然正确**，只是拿不到带宽收益。
 * 这是刻意选的方向：区块化若做成破坏性变更，有活跃玩家的联机协议无法部署。
 *
 * ### 为什么裁剪靠"显式 scope + dropped"，而不是"服务端直接不发"
 *
 * 被裁掉的部分不是丢弃，而是"这一帧没说"。若服务端只是沉默地少发，客户端无法区分
 * 「这块没变化」与「这块被删了/这帧超出 scope」——前者该保留旧数据，后者必须卸载。
 * 所以每条区块化消息都自带区块坐标范围，delta 额外带 `droppedChunks`（退出租图的块），
 * 客户端据此做**远端区块卸载**（RemoteSim.applyChunkScope）。
 */
import type { BuildingState, Eid, Hostile, LogEvent, PawnState } from '../sim/types';
import type { SaveData } from '../sim/sim-save';
import type { Tuning } from '../sim/tuning';
import type { ChunkCoord } from './chunks';

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

  /**
   * 本帧快照覆盖的区块坐标范围（line/net，2026-10-06）。**可选**：
   *  - 缺失 = 老服务端 / 未开裁剪 → 客户端保持全量投影不动（旧行为，逐位不变）；
   *  - 存在 = 这一份 pawns/hostiles/buildings/world.featureLeft 等**只覆盖该范围**，
   *    范围外的本地投影应当卸载（而不是保留陈旧数据——那会让玩家在走回旧区块时
   *    看到已经不存在的建筑）。
   *
   * 之所以是"坐标范围"而不是区块列表：区块集合在客户端可由范围直接算出来，
   * 只传包围盒能省一个随规模增长的数组（视口 3×3 块时 4 个 int vs 9 个对象）。
   *
   * 与 hudScratch（R3-HUD）**正交**：那条线做字段白名单，这条线做视野裁剪，
   * 两者同时生效、互不覆盖（hudScratch 只随 full 走，scope 每帧都可能在变）。
   */
  scope?: ChunkCoord[];
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
    /**
     * 本帧 delta 覆盖的区块（line/net，2026-10-06）。**可选**，缺省 = v1 全量语义。
     *
     * 注意与 full 的 scope 语义差别：delta 是"这些块里**发生了变化**的东西"，
     * 所以 scope 在 delta 里的含义是"变化可能发生在哪些块"，
     * **不能**用来卸载（没出现≠没了）。卸载只认 droppedChunks。
     */
    scope?: ChunkCoord[];
    /**
     * 退出了该连接 scope 的区块：客户端必须卸载其投影（line/net，2026-10-06）。
     *
     * 为什么必须有这条：区块化后"服务端没提到某栋建筑"有了两种含义——
     * 它没变，或者它已经不在我订阅的范围里。不显式告知，客户端只能选择
     * 永久保留（陈旧幽灵建筑）或者每次清空重发（退化成全量）。这条信号是
     * 让"局部更新"成立的前提，也让"卸载"成为可验证的行为而非猜测。
     */
    droppedChunks?: ChunkCoord[];
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
/**
 * 兴趣区生效确认（line/net，2026-10-06 补）。
 *
 * **为什么需要这条 ack**：`interest` 是**单向**的，服务端此前不回任何确认，
 * 于是客户端无从知道"服务端已经按新视口裁剪了"。这有两个真实后果，
 * 不只是测试问题：
 *
 *  1. **客户端可能先收到一帧按旧视口（甚至默认 512 半径）裁剪的 delta/full**。
 *     镜头已经推远、服务端还没处理完 interest 时，那一帧就是超范围的。
 *     对带宽的影响是"多发一帧"（可容忍），但对**正确性**有隐患：
 *     客户端会把这一帧的 scope 当成自己当前应该持有的范围，而真正生效的那一帧里
 *     已退出的区块未必出现在 `droppedChunks` 里（差集是相对"上一轮 delta 生效的集合"
 *     算的，见 game-server 的 lastScope 注释）—— 于是可能残留幽灵实体。
 *  2. **测试只能靠 sleep 赌时序**：`chunked-server.test.ts` 原本
 *    「发 interest → 立刻 await delta」在 CI 上偶发红（实测 `expected 49 to be 1`，
 *    49 = 默认 512 半径的 7×7 块），本地与另一 node 版本只是碰巧不撞上。
 *    有 ack 之后「interest 已生效」变成**可观测事实**而不是时间假设。
 *
 * **为什么不能靠加长 sleep 解决**：那是在用"等久一点"掩盖"没有信号"，
 * 而且会让每个测试都变慢、且仍不稳定。协议缺确认信号就是协议缺陷。
 *
 * 兼容性：这是**新增消息类型**，旧客户端不认识会忽略（服务端从不回显错误是既有纪律），
 * 不影响既有流式语义，故不构成破坏性变更。
 */
export interface InterestAckMsg {
  t: 'interestAck';
  d: {
    /** 服务端实际采用的视口中心（tile） */
    x: number;
    y: number;
    /** 服务端**实际生效**的半径（已钳到 [0, MAX_INTEREST_RADIUS]，故可能≠请求值） */
    r: number;
    /** 本次生效的订阅区块数（客户端可用来核对与本地预期是否一致） */
    chunks: number;
  };
}
export type ServerMsg = WelcomeMsg | FullMsg | DeltaMsg | PingMsg | InterestAckMsg;

/** 心跳广播周期（ms）。ROADMAP R1-1 规定 10s。 */
export const PING_MS = 10000;

/** 客户端看门狗阈值（ms）：超过这么久没收到任何消息即判定假死。ROADMAP R1-1 规定 15s。 */
export const WATCHDOG_MS = 15000;

export interface CmdMsg {
  t: 'cmd';
  c: { type: string; args?: Record<string, unknown>; src?: string; token?: string };
}
/**
 * 客户端上行订阅范围（line/net，2026-10-06）。**独立于 cmd**：它不改变游戏状态，
 * 只改变"我需要收到哪些区块"，所以不进 SERVER_COMMANDS 白名单（白名单是防注入的
 * 命令面，把查询类消息混进去会让"未登记即静默丢弃"这条纪律失效）。
 *
 * 为什么不是 cmd 的 args：命令会被计数进 rejectedCommands，而兴趣区被服务器拒绝
 * （越界/坏形状）不该污染"是否有人在攻击服务器"的计数。
 */
export interface InterestMsg {
  t: 'interest';
  /** 视口中心（tile 坐标）+ 半径（tile） */
  d: { x: number; y: number; r: number };
}
export type ClientMsg = CmdMsg | InterestMsg;

/**
 * 兴趣区校验（line/net）。
 *
 * 上限 512 tile 是**带宽保护**不是玩法限制：客户端请求超大范围会让服务端把它当作
 * "要全世界"（等价于关闭裁剪），那等于允许单条消息关掉带宽优化。钳到上限后
 * 最坏情况仍是"多发一点"，不会变成"拒绝服务式的下发"。
 * 半径下限 0：就是中心那一块，允许（单块视野调试用）。
 */
export const MAX_INTEREST_RADIUS = 512;

/** 兴趣区消息校验：形状合法且坐标有限、半径在 [0, MAX_INTEREST_RADIUS] */
export function validInterest(d: unknown): d is { x: number; y: number; r: number } {
  if (typeof d !== 'object' || d === null) return false;
  const { x, y, r } = d as { x?: unknown; y?: unknown; r?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || typeof r !== 'number') return false;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) return false;
  if (r < 0 || r > MAX_INTEREST_RADIUS) return false;
  // 坐标防御：与 validMoveArgs 同一条 ±30000 边界（CHUNK_SIZE=64 下约 ±470 chunk）
  if (Math.abs(x) > 30000 || Math.abs(y) > 30000) return false;
  return true;
}

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
