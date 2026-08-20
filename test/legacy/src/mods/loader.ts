// Mod 打包/沙箱加载器
// 包 = 自包含 JSON（manifest + defs 纯数据声明 + 可选 scripts 字符串）：
//   - defs.json：零代码内容声明（物品/建筑/卡/配方/…），全部走 registry 公开 API
//   - scripts.js：函数式扩展（谓词/系统/事件/权重规则/钩子），new Function 白名单注入执行
// 沙箱边界（诚实声明）：同进程信任边界——防"手滑污染全局/挂载失败拖垮主 sim"，
//   不防恶意代码（标识符解析属 JS 引擎层，同进程无法真隔离）。scripts 内禁止
//   import/require（无注入即不可达）。
// 用法：
//   const pkg = parseModPackage(await (await fetch('/mods/foo.mod.json')).text());
//   const res = mountModPackage(pkg, registry); // registry 未初始化前可先挂载（回调解耦）
//   new Sim({ mods: buildModMount(pkg) })       // 或直接当 Sim mods 回调

import { ModRegistry } from '../sim/mods/registry';
import type { ItemDef } from '../sim/defs';
import { declaredEventToScripted } from '../sim/defs/events';
import type { DeclaredEvent } from '../sim/defs/events';
import type { StrategyCardDef } from '../sim/defs/strategyCards';
import type { TechDef } from '../sim/defs/techs';
import type { InterestDef } from '../sim/defs/interests';
import type { LeanDef } from '../sim/core/lean';


export const CORE_VERSION = '0.1.0'; // 与 package.json version 同步

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  requires?: {
    coreVersion?: string;
    // 跨文件依赖（2026-08-20 修复：此前仅 coreVersion，DLC 之间无依赖位——服务端按
    // 文件名序独立挂载，与 in-code ModPack 的 requires/topoSort DAG 不等价；DLC A 依赖
    // DLC B 的 def 时可能先挂 A 报"def 缺失"。挂载器按此列表拓扑喂序，缺失依赖 = 报错跳过）
    mods?: string[];
  };
}

export interface ModDefsJson {
  tuning?: Record<string, unknown>;
  items?: ItemDef[];
  tiles?: unknown[];
  buildings?: unknown[];
  recipes?: unknown[];
  enemies?: unknown[];
  cards?: Record<string, unknown>[];
  jobs?: { id: string; label: string; cardId: string }[];
  leans?: LeanDef[];
  markov?: { fromSeries: string; toMuls: Record<string, number> }[];
  seriesDesires?: { series: string; desire: string }[];
  lines?: { category: 'greet' | 'positive' | 'negative'; text: string }[];
  topics?: { event: string; template: string }[];
  events?: DeclaredEvent[]; // 声明式事件（DLC：when 谓词 + effects 效果表）
  strategyCards?: StrategyCardDef[]; // 策略卡（神谕降旨：条件/蓝图/权重声明式）
  techs?: TechDef[]; // 科技（DLC：registerTech 自动接入探索卡/门控）
  interests?: InterestDef[]; // 兴趣（2026-08-13：registerInterest 自动接入抽选/休闲卡/权重调制）
}

export interface ModPackage {
  manifest: ModManifest;
  defs?: ModDefsJson;
  scripts?: string;
}

// mod id 白名单字符集（字母数字/连字符/下划线/点）：防路径穿越、URL/文件名注入字符
const ID_RE = /^[a-z0-9][a-z0-9-_.]*$/i;
const CARD_FN_FIELDS = ['condition', 'extraUtility', 'decide'] as const;

// ---- 解析与校验 ----

// 解析 .mod.json 包描述文件（id/requires/defs → ModPackage 结构）
export function parseModPackage(json: string): ModPackage {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`mod 包不是合法 JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('mod 包必须是 JSON 对象');
  const obj = raw as Record<string, unknown>;

  const manifest = obj.manifest as Record<string, unknown> | undefined;
  if (!manifest || typeof manifest !== 'object') throw new Error('mod 包缺少 manifest 字段');
  const m = manifest as unknown as ModManifest;
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) throw new Error(`mod manifest.id 非法（需匹配 ${ID_RE.source}）: ${m.id}`);
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error(`mod "${m.id}" 缺少 name`);
  if (typeof m.version !== 'string' || !m.version.trim()) throw new Error(`mod "${m.id}" 缺少 version`);

  const coreVer = m.requires?.coreVersion;
  if (coreVer !== undefined && coreVer !== CORE_VERSION) {
    throw new Error(`mod "${m.id}" 要求 coreVersion ${coreVer}，当前 ${CORE_VERSION}（版本不兼容）`);
  }

  const depMods = m.requires?.mods;
  if (depMods !== undefined) {
    if (!Array.isArray(depMods)) throw new Error(`mod "${m.id}" requires.mods 必须是 mod id 数组`);
    for (const d of depMods) {
      if (typeof d !== 'string' || !ID_RE.test(d)) throw new Error(`mod "${m.id}" requires.mods 含非法 mod id: ${String(d)}`);
    }
  }

  const defsRaw = obj.defs;
  let defs: ModDefsJson | undefined;
  if (defsRaw !== undefined) {
    let parsed: unknown = defsRaw;
    if (typeof defsRaw === 'string') {
      try {
        parsed = JSON.parse(defsRaw);
      } catch (e) {
        throw new Error(`mod "${m.id}" defs 不是合法 JSON: ${(e as Error).message}`);
      }
    }
    defs = validateDefsJson(m.id, parsed);
  }

  const scripts = obj.scripts;
  if (scripts !== undefined && typeof scripts !== 'string') throw new Error(`mod "${m.id}" scripts 必须是字符串源码`);
  if (scripts !== undefined && /^\s*(import|require)\b/m.test(scripts as string)) {
    throw new Error(`mod "${m.id}" scripts 不允许 import/require（打包器内联一切依赖）`);
  }

  return { manifest: m, defs, scripts: scripts as string | undefined };
}

// 校验 defs JSON 形状（建筑/tile/item/enemy 定义格式正确性检查）
function validateDefsJson(id: string, raw: unknown): ModDefsJson {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`mod "${id}" defs 必须是对象`);
  const d = raw as Record<string, unknown>;

  for (const key of Object.keys(d)) {
    if (key === 'tuning') {
      if (typeof d[key] !== 'object' || d[key] === null) throw new Error(`mod "${id}" defs.tuning 必须是对象`);
    } else if (key === 'cards' || key === 'items' || key === 'tiles' || key === 'buildings' || key === 'recipes' || key === 'enemies' || key === 'jobs' || key === 'leans' || key === 'markov' || key === 'seriesDesires' || key === 'lines' || key === 'topics' || key === 'events' || key === 'strategyCards' || key === 'techs' || key === 'interests') {
      if (!Array.isArray(d[key])) throw new Error(`mod "${id}" defs.${key} 必须是数组`);
    } else {
      throw new Error(`mod "${id}" defs.${key} 未知字段（打包器只支持白名单字段）`);
    }
  }

  const out = d as unknown as ModDefsJson;

  // 卡类函数字段必须进 scripts（defs 是纯 JSON 声明）
  for (const c of out.cards ?? []) {
    for (const f of CARD_FN_FIELDS) {
      if (c[f as string] !== undefined) throw new Error(`mod "${id}" 卡 "${c.id}" 的 ${f} 是函数字段，defs 只接受纯 JSON，请移入 scripts（registerCardDef）`);
    }
  }

  // 话题模板必须是 {key} 占位符模板（函数式模板进 scripts registerTopicTemplate）
  for (const t of out.topics ?? []) {
    if (typeof t.event !== 'string' || !t.event) throw new Error(`mod "${id}" topics 每项需 event 字符串`);
    if (typeof t.template !== 'string') throw new Error(`mod "${id}" topics "${t.event}" 的 template 需为 {key} 模板字符串`);
  }
  for (const l of out.lines ?? []) {
    if (!['greet', 'positive', 'negative'].includes(l.category)) throw new Error(`mod "${id}" lines 类别必须 greet/positive/negative`);
    if (typeof l.text !== 'string' || !l.text) throw new Error(`mod "${id}" lines 需 text 字符串`);
  }
  for (const mk of out.markov ?? []) {
    if (typeof mk.fromSeries !== 'string' || typeof mk.toMuls !== 'object' || mk.toMuls === null) {
      throw new Error(`mod "${id}" markov 每项需 fromSeries + toMuls`);
    }
  }
  return out;
}

// ---- 挂载（defs 翻译 + scripts 沙箱执行）----

// 构建 mount 函数（把 ModPackage 的 defs 注册到 registry；客户端 ?mods= 远程加载用）
export function buildModMount(pkg: ModPackage): (m: ModRegistry) => void {
  return (m: ModRegistry) => {
    // scripts 先（谓词/系统/意图等机制注册，供 defs 引用），defs 后（内容声明）
    mountScripts(m, pkg);
    mountDefs(m, pkg);
  };
}

// 把 defs 纯 JSON 翻译成 registry 调用（零代码内容声明）
function mountDefs(m: ModRegistry, pkg: ModPackage): void {
  const d = pkg.defs;
  if (!d) return;
  const id = pkg.manifest.id;

  const guard = <T,>(kind: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      throw new Error(`mod "${id}" defs.${kind} 挂载失败: ${(e as Error).message}`);
    }
  };

  if (d.tuning) guard('tuning', () => m.overrideTuning(d.tuning as never));
  for (const it of d.items ?? []) guard(`items.${it.id}`, () => m.registerItem(it as ItemDef));
  for (const t of d.tiles ?? []) guard(`tiles.${(t as { id: string }).id}`, () => m.registerTile(t as never));
  for (const b of d.buildings ?? []) guard(`buildings.${(b as { id: string }).id}`, () => m.registerBuilding(b as never));
  for (const r of d.recipes ?? []) guard(`recipes.${(r as { id: string }).id}`, () => m.registerRecipe(r as never));
  for (const e of d.enemies ?? []) guard(`enemies.${(e as { id: string }).id}`, () => m.registerEnemy(e as never));
  for (const c of d.cards ?? []) guard(`cards.${c.id as string}`, () => m.registerCardDef(c as never));
  for (const j of d.jobs ?? []) guard(`jobs.${j.id}`, () => m.registerJob(j.id, j));
  for (const l of d.leans ?? []) guard(`leans.${l.key}`, () => m.registerLean(l));
  for (const mk of d.markov ?? []) guard(`markov.${mk.fromSeries}`, () => m.registerMarkovBias(mk.fromSeries, mk.toMuls));
  for (const sd of d.seriesDesires ?? []) guard(`seriesDesires.${sd.series}`, () => m.registerSeriesDesire(sd.series, sd.desire as never));
  for (const l of d.lines ?? []) guard(`lines.${l.category}`, () => m.registerLine(l.category, l.text));
  // 声明式事件（DLC 形态）：when 谓词 + effects 效果表 → 函数式 ScriptedEvent
  for (const ev of d.events ?? []) {
    guard(`events.${ev.id}`, () => m.registerEvent(declaredEventToScripted(ev)));
  }
  // 策略卡（神谕降旨全数据化）：条件/蓝图/权重声明式，引擎按表采样
  for (const sc of d.strategyCards ?? []) {
    guard(`strategyCards.${sc.id}`, () => m.registerStrategyCard(sc));
  }
  // 科技（DLC 扩展口）：.mod.json 声明新科技 = 探索卡/门控自动接入
  for (const t of d.techs ?? []) {
    guard(`techs.${t.id}`, () => m.registerTech(t));
  }
  // 兴趣（2026-08-13 兴趣驱动娱乐）：.mod.json 声明新兴趣 = 抽选/休闲卡/权重调制自动接入
  for (const it of d.interests ?? []) {
    guard(`interests.${it.id}`, () => m.registerInterest(it));
  }
  for (const t of d.topics ?? []) {
    // {key} 模板 → text 函数（占位符替换）
    guard(`topics.${t.event}`, () => m.registerTopicTemplate({
      event: t.event,
      text: (data: Record<string, unknown>): string | null => {
        let out: string = t.template;
        for (const [k, v] of Object.entries(data)) out = out.split(`{${k}}`).join(String(v));
        if (out.includes('{')) return null; // 缺占位数据 → 不产话题
        return out;
      },
    }));
  }
}

// scripts 沙箱执行：new Function 白名单注入（m + 受限 console），无全局可达依赖
function mountScripts(m: ModRegistry, pkg: ModPackage): void {
  if (!pkg.scripts) return;
  const id = pkg.manifest.id;

  let fn: (mod: ModRegistry, console: Console) => unknown;
  try {
    fn = new Function('m', 'console', `'use strict';\n${pkg.scripts}`) as never;
  } catch (e) {
    throw new Error(`mod "${id}" scripts 编译失败: ${(e as Error).message}`);
  }
  try {
    fn(m, {
      log: (...a: unknown[]) => console.log(`[mod:${id}]`, ...a),
      warn: (...a: unknown[]) => console.warn(`[mod:${id}]`, ...a),
      error: (...a: unknown[]) => console.error(`[mod:${id}]`, ...a),
    } as Console);
  } catch (e) {
    throw new Error(`mod "${id}" scripts 执行失败: ${(e as Error).message}`);
  }
}

// 便捷挂载（用于预初始化 registry；返回错误不抛——失败不拖垮主 sim）
export function mountModPackage(pkg: ModPackage, m: ModRegistry): { ok: true } | { ok: false; error: string } {
  try {
    buildModMount(pkg)(m);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---- 打包 ----

// 序列化 ModPackage → .mod.json 字符串（导出/分享 mod 用）
export function packModPackage(pkg: ModPackage): string {
  return JSON.stringify(pkg, null, 2);
}
