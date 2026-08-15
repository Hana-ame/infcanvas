// 跨包契约登记表（2026-08-15 一致性校验：字符串契约不拼错、不静默失效）
// 背景：meta.warmth / meta.wearable / extra.worn 等字符串键由不同包读写，拼错静默失效、
//   只靠测试兜底（用户 2026-08-15 裁决修复）。方案：
//   ① **key 常量**：跨包键只在此定义，写方/读方一律引用常量——拼错 = 编译期错误（无魔法串）；
//   ② **登记表**：每条契约声明写方/读方/类型/存在性谓词（check），装配后由管理器统一校验
//      （validateContracts）——写方在场却未写出键 = 违例（运行时防线，防"常量改名但忘了写"）。
//   ③ **一致性**：内核系统与玩法包、服务端与客户端读同一张表（server/hud/renderer 也引常量），
//      不因层不同而各写各的魔法串。
// 边界：单包自洽键（如 clothing 的 meta.dye/tailor、thermo 的 meta.heat、cooking 的
//   meta.cookSpiced）不入表——契约表只登记**跨包/跨层**键（写方 ≠ 读方）。building meta
//   深合并共存（registry.overrideDef 深合并，registry.ts:454 背景）与本表正交。
import type { ModRegistry } from './registry';
import { weightRulesOf } from './query';

// ---- 跨包键常量（写方/读方引用处唯一权威；改名 = 编译期全网纠错）----
export const K_WARMTH = 'warmth';      // item.meta.warmth：clothing 写（正=御寒/负=散热）、thermo 读
export const K_WEARABLE = 'wearable';  // item.meta.wearable：clothing 写（HUD 穿衣过滤）、协议 w 透传
export const K_WORN = 'worn';          // pawn.extra.worn：clothing 写（{ body: itemId }）、thermo/渲染读
// item.meta.dye：clothing 写（染色款标记 = 染料 id）。**单包自洽键**不入契约表，但 CONTRACTS
// 的 check 谓词依赖它做"衣物族"检测 → 定常量防拼错（审计 2026-08-15：check 曾裸串 'dye'，
// 键改名时校验防线会静默失效，与"拼错 = 编译期错误"纪律冲突）
export const K_DYE = 'dye';
// ---- RW-1（2026-08-15 工作优先级 + 征召战斗）----
// pawn.extra[K_WORK_PRIORITIES]：work-priority 玩法包写（Record<jobId, 0|1|2|3|4>）、
// 权重规则/服务端 protocol 透传读。**跨包/跨层键**（包写 + server 协议读 + 客户端 HUD 读）
// 入契约表；值语义 = 缺键 = 未设置（自主），0 = 显式禁止。
export const K_WORK_PRIORITIES = 'workPriorities';
// pawn.extra[K_DRAFTED]：drafting 玩法包写（boolean 征召标志）、behavior 是否自决/渲染/服务端
// protocol 读。跨包/跨层键入契约表；值语义 = true = 征召中（不自主决策）。
export const K_DRAFTED = 'drafted';
// pawn.extra[K_ATTACK]：drafting 玩法包写（{ hostileIndex } 指定攻击目标）、raidSystem 结算读。
// 跨包/跨层键入契约表；值 = 目标敌人下标（undefined = 无指定目标，走自动接战）。
export const K_ATTACK = 'attackTarget';

// ---- 契约登记条目 ----
export interface MetaContract {
  key: string;        // 键路径描述（文档）；check 用 m 查实际 defs
  writer: string;     // 写方（包/系统/层）
  reader: string;     // 读方（包/系统/层）
  type: string;       // 值类型说明（人读）
  check: (m: ModRegistry) => boolean; // 存在性谓词：写方在场时必须为 true（否则违例）
}

// 契约表（默认装配校验；第三方管理器可自行决定是否调用 validateContracts）
export const CONTRACTS: MetaContract[] = [
  {
    key: 'item.meta.warmth',
    writer: 'clothing', reader: 'thermo',
    type: 'number（正=御寒/负=散热）',
    // 衣物（meta.wearable 标记）必须带数字 warmth——thermo 读它算穿着保暖；clothing 卸载
    // 时无衣物 → 空真（谓词不误伤卸载场景，卸载不破坏核心）
    check: (m) => [...m.itemsMap.values()].every((d) => !d.meta?.[K_WEARABLE] || typeof d.meta[K_WARMTH] === 'number'),
  },
  {
    key: 'item.meta.wearable',
    writer: 'clothing', reader: 'thermo/hud/协议 w',
    type: 'boolean（可穿标记）',
    // 有衣物（染料或素衣 meta.dye 表示染色族）则必须标记 wearable；clothing 卸载 → 无衣物
    check: (m) => [...m.itemsMap.values()].every((d) => !d.meta?.[K_DYE] || d.meta[K_WEARABLE] === true),
  },
  {
    key: 'pawn.extra.worn',
    writer: 'clothing', reader: 'thermo/server/渲染',
    type: '{ body?: string }（穿着衣物 itemId）',
    // 运行时数据（随档），装配期无法静态检查写入——拼错防护靠 K_WORN 常量引用（编译期），
    // 本条目为登记 + 文档语义。恒真：不抓主动卸载（卸载 thermo = 用户选择，非拼错缺陷，
    // "卸载不破坏核心"纪律优先；校验只抓"写方在场却漏写/写错"，见上两条）
    check: () => true,
  },
  {
    key: 'pawn.extra.workPriorities',
    writer: 'work-priority', reader: 'behavior(权重规则)/server protocol/HUD',
    type: 'Record<jobId, 0|1|2|3|4>（缺键 = 未设置 = 自主；0 = 禁止）',
    // 运行时数据（随档）。拼错防护靠 K_WORK_PRIORITIES 常量；写方在场但"权重规则未注册"
    // 会静默失效，故 predicate = 若包在场则必须有对应权重规则（workPriority 规则）。
    check: (m) => !m.packIds.includes('work-priority') || weightRulesOf().some((r) => r.id === 'workPriority'),
  },
  {
    key: 'pawn.extra.drafted',
    writer: 'drafting', reader: 'behavior/渲染/server protocol',
    type: 'boolean（true = 征召中，不自主决策）',
    // 运行时数据（随档）。拼错防护靠 K_DRAFTED 常量；drafting 包在场则必须有 draft 命令
    // 处理器（防处理器被删但玩法数据还在的配置漂移）。
    check: (m) => !m.packIds.includes('drafting') || m.commandHandlers.has('draft'),
  },
];

// 是否有衣物族（clothing 写方在场的代理信号：有 meta.wearable 物品 = clothing 已装配）
function hasWearables(m: ModRegistry): boolean {
  return [...m.itemsMap.values()].some((d) => d.meta?.[K_WEARABLE] === true);
}

// ---- 命令契约（2026-08-15 追加：命令名 + args 参数位 + 写方/读方）----
// 背景：命令协议开放（type (string & {}) + args 通用位）后，命令参数键无编译期校验
// （处理器自己 cast）。登记表 = 命令契约唯一权威文档 + 装配期校验（写方在场 → 处理器必须
// 已注册，防"处理器被删但玩法数据还在"的配置漂移）；发令方（HUD/play.ts/远程协议）与
// 处理器（玩法包）都照此表写，未知命令由 issueCommand 报「未知命令」反馈（不静默）。
export interface CommandContract {
  type: string;        // 命令名（Command.type，协议面开放）
  args: string[];      // args 通用位里的参数键（处理器读取的键，如 wear 的 itemId）
  writer: string;      // 发令方（层/工具）
  reader: string;      // 处理器所在包/引擎
  check: (m: ModRegistry) => boolean;
}
export const COMMAND_CONTRACTS: CommandContract[] = [
  {
    type: 'wear',
    args: ['itemId'],   // 缺省 = 脱衣（args 位语义：hud/play.ts 发，clothing 读）
    writer: 'hud/play.ts/客户端', reader: 'clothing',
    check: (m) => !hasWearables(m) || m.commandHandlers.has('wear'),
  },
  {
    type: 'set-work-priority',
    args: ['priority'], // job 走 Command.job 顶层位；priority 走 args 通用位（缺省 = 恢复自动）
    writer: 'hud/play.ts/客户端', reader: 'work-priority',
    // 写方（work-priority 包）在场 → 命令处理器必须已注册（防处理器被删但玩法数据还在）。
    check: (m) => !m.packIds.includes('work-priority') || m.commandHandlers.has('set-work-priority'),
  },
  {
    type: 'draft',
    args: ['drafted'],  // drafted 走 args 通用位（true = 征召）
    writer: 'hud/客户端', reader: 'drafting',
    check: (m) => !m.packIds.includes('drafting') || m.commandHandlers.has('draft'),
  },
];

// ---- 协议契约（2026-08-15 追加：跨层字段 server → client）----
// 编译期已有 shared/protocol.ts 类型保护；本表 = 字段语义的唯一权威文档 + 将来扩展校验位。
// 恒真：协议字段由 server 代码填充（类型即契约），不抓主动卸载。
export const PROTOCOL_CONTRACTS: MetaContract[] = [
  { key: 'protocol.pawns.worn', writer: 'server', reader: 'client（渲染 tint）',
    // 值语义 = 穿着衣物 itemId；染色款 id 带 `{dye}_{base}` 前缀（renderer 用 split('_')[0]
    // 解析染料 tint，server 原样透传）——改 id 格式会静默破坏染色渲染，故登记（审计 2026-08-15）
    // 空串 '' = 无穿着（2026-08-15 审计：undefined 被 JSON.stringify 丢弃 → delta 无法表达脱下，
    // 统一 '' 归一；改回 undefined 会静默破坏脱衣 delta）
    type: 'string?（穿着衣物 itemId；染色款 = `${dye}_${base}`，前缀即染料 id）', check: () => true },
  { key: 'protocol.items.w', writer: 'server', reader: 'client（HUD 穿衣按钮过滤）',
    type: 'boolean?（ItemDef.meta.wearable 透传）', check: () => true },
  // RW-1（2026-08-15）：工作优先级 + 征召经协议下发（Field = 值语义文档；server 从
  // pawn.extra 填充，client/HUD 读取渲染 Work Tab / 征召按钮）。值语义：workPriorities =
  // Record<jobId, 0|1|2|3|4>（缺省 = 全自动）、drafted = boolean（true = 征召中）。
  // 约定：改字段名/值格式会静默破坏远程 Work Tab 编辑与征召同步（与 worn 染色同理）。
  { key: 'protocol.pawns.workPriorities', writer: 'server', reader: 'client（Work Tab/HUD）',
    type: 'Record<jobId, 0|1|2|3|4>?（缺省/空 = 全自动）', check: () => true },
  { key: 'protocol.pawns.drafted', writer: 'server', reader: 'client（征召渲染/HUD）',
    type: 'boolean?（缺省 = 未征召）', check: () => true },
];

// 装配后校验：返回违例列表（空 = 全部契约满足）。playstyleManager apply 末尾调用（默认
// 管理器 = 严格模式，违例即抛错防回归）；第三方管理器可跳过或降级为警告。
export function validateContracts(m: ModRegistry): string[] {
  const errs: string[] = [];
  for (const c of CONTRACTS) {
    if (!c.check(m)) errs.push(`mod: 契约违例 ${c.key}（写方 ${c.writer} → 读方 ${c.reader}，类型 ${c.type}）：写方在场但未按要求写出该键`);
  }
  for (const c of COMMAND_CONTRACTS) {
    if (!c.check(m)) errs.push(`mod: 契约违例 命令 ${c.type}（args: ${c.args.join('/')}，发令方 ${c.writer} → 处理器 ${c.reader}）：写方在场但命令处理器未注册`);
  }
  for (const c of PROTOCOL_CONTRACTS) {
    if (!c.check(m)) errs.push(`mod: 契约违例 ${c.key}（写方 ${c.writer} → 读方 ${c.reader}，类型 ${c.type}）`);
  }
  return errs;
}