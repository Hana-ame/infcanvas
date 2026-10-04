/**
 * shared/mod-schema.ts —— .mod.json 数据包格式（ROADMAP R2-2：放文件即装 mod）。
 *
 * 设计目标：**内容种子用纯 JSON 声明，不改一行代码**。
 * 格式：{ manifest: { id, requires, title }, defs: { buildings, enemies, items, cards } }
 *
 * 为什么放 shared/ 而不是 server/：格式是"服务端与工具链共同的契约"——
 * 服务器扫描、CLI 报告、测试构造、将来的编辑器导出都读同一份类型，
 * 类型放 server/ 会逼着非服务端代码反向依赖 server 层（分层破坏）。
 *
 * 卡的可 JSON 化边界（v1 限制，诚实声明）：
 *   CardDef.condition/action 是**函数**，JSON 无法表达。v1 只支持两种卡：
 *    ① 无谓词卡：condition 省略 → 永远可抽（适合"新增一种玩法种子"）；
 *    ② 谓词引用卡：condition 写 { predicate: "已登记名" } → 到 registry.predicate(name)
 *       取回真正的谓词函数。**谓词必须由 TS 包 registerPredicate 先登记**，
 *       否则加载期报错（名字找不到 = 拼写漂移，静默跳过会变成"卡永远抽不到"的谜题）。
 *   action 字段 v1 一律不支持：它必须执行游戏逻辑，只能由 TS 包提供。
 */
import type { BuildingTuningEntry, EnemyTuningEntry, TechTuningEntry } from '../sim/tuning';
import type { ItemDef } from '../mods/registry';

/** 包标识：字母数字/连字符/下划线/点，首字符必须字母数字。
 *  这个字符集同时防：路径穿越（../）、URL 注入、文件名非法字符。 */
export const MOD_ID_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/i;

export interface ModManifestJson {
  id: string;
  title: string;
  /** 前置包 id 列表（DLC 依赖）。缺省 = 无依赖（与"忘了写"区分不了，
   *  但 MOD_ID_PATTERN 之外的拼写会在加载期响亮报错，不会静默） */
  requires?: string[];
  /** 作者/说明（信息性，不参与装配） */
  author?: string;
  description?: string;
  version?: string;
}

/** 卡的条件：v1 只支持"引用已登记谓词名"，不支持内联表达式 */
export interface ModCardCondition {
  predicate: string;
}

export interface ModCardJson {
  id: string;
  label: string;
  /** 系列：必须是 contracts.ALL_SERIES 里的已登记系列（装配末 validateContracts 把关） */
  series: string;
  weight: number;
  /** 缺省 = 无谓词（永远可抽） */
  condition?: ModCardCondition;
  /** 承诺秒数（缺省走 tuning.pawn.defaultCardSec） */
  duration?: number;
}

export interface ModDefsJson {
  buildings?: Array<BuildingTuningEntry & { id: string }>;
  enemies?: Array<EnemyTuningEntry & { id: string }>;
  items?: ItemDef[];
  cards?: ModCardJson[];
  /** R2-3 的同源扩展位：科技条目也能纯数据声明（接 tuning.techs 表） */
  techs?: Array<TechTuningEntry & { id: string }>;
}

export interface ModPackageJson {
  manifest: ModManifestJson;
  defs?: ModDefsJson;
}

/** defs 下允许的字段白名单（未知字段 = 加载期报错，不是"以后再说"——
 *  拼错的字段名若被静默忽略，作者会以为内容生效了） */
export const MOD_DEFS_FIELDS = ['buildings', 'enemies', 'items', 'cards', 'techs'] as const;
