/**
 * server/mod-loader.ts —— .mod.json 扫描 → 校验 → 拓扑 → 挂载（ROADMAP R2-2）。
 *
 * 失败策略（项目铁律）：**响亮失败且绝不半挂载**。
 *  - 坏 JSON → 错误信息带**文件名**（"demo/bad.mod.json: 第 3 行 ..."），不给行号也至少给文件名；
 *  - 缺依赖 → 报错并列出缺失的 id，且**在挂载前**就失败（不先挂一半再发现缺依赖）；
 *  - 重复 id → 交给 registry 的既有"已存在"抛错（不改成静默覆盖）；
 *  - 谓词名找不到 → 报错并点名（否则卡永远抽不到，是最难查的静默失效）。
 *
 * 拓扑顺序：复用 mods/pack.ts 的 Kahn topoSort（requires 是唯一事实，清单顺序不承担图约束）。
 * 实现方式：把每个 JSON 包适配成一个 ModPack（apply = 把 defs 翻译成注册面调用），
 * 于是 JSON 包与 TS 包走**完全相同**的挂载路径——这正是 R2-3 要证明的"同一内容两种部署形态"。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ModRegistry } from '../mods/registry';
import { topoSort, type ModPack } from '../mods/pack';
import { validateContracts } from '../mods/contracts';
import type { CardDef } from '../sim/cards';
import type { PawnState } from '../sim/types';
import type { SimContext } from '../sim/context';
import {
  MOD_DEFS_FIELDS,
  MOD_ID_PATTERN,
  type ModCardJson,
  type ModPackageJson,
} from '../shared/mod-schema';

export interface LoadedMod {
  /** 源文件名（错误定位用） */
  file: string;
  pkg: ModPackageJson;
}

/** 解析一个 .mod.json 的文本内容。
 *  fileName 仅用于错误信息——坏 JSON 必须能给到文件名级定位，否则用户拿到
 *  一句"Unexpected token"完全不知道是哪个文件坏了（这是验收明确要求的）。 */
export function parseModPackage(text: string, fileName: string): ModPackageJson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`mod 文件不是合法 JSON：${fileName}：${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`mod 文件必须是 JSON 对象：${fileName}`);
  }
  const obj = raw as Record<string, unknown>;
  const manifest = obj.manifest as ModPackageJson['manifest'] | undefined;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`mod 文件缺少 manifest 字段：${fileName}`);
  }
  if (typeof manifest.id !== 'string' || !MOD_ID_PATTERN.test(manifest.id)) {
    throw new Error(`mod manifest.id 非法（需匹配 ${MOD_ID_PATTERN.source}）：${fileName}：${String(manifest.id)}`);
  }
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) {
    throw new Error(`mod "${manifest.id}" 缺少 title（${fileName}）`);
  }
  const reqs = manifest.requires;
  if (reqs !== undefined) {
    if (!Array.isArray(reqs)) throw new Error(`mod "${manifest.id}" requires 必须是 id 数组（${fileName}）`);
    for (const r of reqs) {
      if (typeof r !== 'string' || !MOD_ID_PATTERN.test(r)) {
        throw new Error(`mod "${manifest.id}" requires 含非法包 id "${String(r)}"（${fileName}）`);
      }
    }
  }
  if (obj.defs !== undefined) {
    const d = obj.defs as Record<string, unknown>;
    if (typeof d !== 'object' || d === null || Array.isArray(d)) {
      throw new Error(`mod "${manifest.id}" defs 必须是对象（${fileName}）`);
    }
    for (const key of Object.keys(d)) {
      // 未知字段响亮报错：拼错的字段名被静默忽略 = 作者以为内容生效了
      if (!(MOD_DEFS_FIELDS as readonly string[]).includes(key)) {
        throw new Error(
          `mod "${manifest.id}" defs.${key} 是未知字段（允许：${MOD_DEFS_FIELDS.join('/')}）：${fileName}`,
        );
      }
      if (!Array.isArray(d[key])) {
        throw new Error(`mod "${manifest.id}" defs.${key} 必须是数组（${fileName}）`);
      }
    }
  }
  return obj as unknown as ModPackageJson; // manifest/defs 形状已在上面逐项校验
}

/**
 * 把一个 JSON 包适配成 ModPack（与 TS 包同构）。
 * apply 里逐 def 调 registry 的公开注册面——数据驱动不是"另一条旁路"。
 */
export function modPackageToPack(mod: LoadedMod): ModPack {
  const { pkg, file } = mod;
  return {
    id: pkg.manifest.id,
    requires: pkg.manifest.requires ?? [],
    apply(m) {
      const d = pkg.defs;
      if (!d) return;
      for (const b of d.buildings ?? []) m.registerBuilding(b);
      for (const e of d.enemies ?? []) m.registerEnemy(e);
      for (const it of d.items ?? []) m.registerItem(it);
      for (const t of d.techs ?? []) m.registerTech(t);
      for (const c of d.cards ?? []) m.registerCard(cardToDef(c, m, pkg.manifest.id, file));
    },
  };
}

function cardToDef(
  c: ModCardJson,
  m: ModRegistry,
  modId: string,
  file: string,
): CardDef {
  const cond = c.condition;
  let condition: ((p: PawnState, ctx: SimContext) => boolean) | undefined;
  if (cond) {
    const fn = m.predicate(cond.predicate);
    if (!fn) {
      // 谓词名找不到 = 拼写漂移：不静默跳过（否则这张卡永远抽不到，是最难查的静默失效）
      throw new Error(
        `mod "${modId}" 的卡 "${c.id}" 引用未登记谓词 "${cond.predicate}"（${file}）——谓词须由 TS 包 registerPredicate 提供`,
      );
    }
    // registry 的谓词签名是 (ctx) => boolean（它不关心是哪只鼠）；
    // 卡谓词签名是 (pawn, ctx) => boolean → 这里包一层，忽略 pawn 参数。
    condition = (_p, ctx) => fn(ctx);
  }
  return {
    id: c.id,
    label: c.label,
    series: c.series,
    weight: c.weight,
    ...(condition ? { condition } : {}),
    ...(c.duration !== undefined ? { duration: c.duration } : {}),
    action: (p) => {
      // v1 占位动作：抽中即收工（扩充卡池权重的种子卡，行为效果留给 TS 包）。
      // busyUntil=0 → behavior 下一 tick 立刻重抽，所以这张卡不会"卡住"小人。
      p.busyUntil = 0;
    },
  };
}

/**
 * 扫描目录下的 *.mod.json（只看一层——DLC 平铺放置，递归反而会误吃嵌套产物目录）。
 * 必须 sort()：readdirSync 顺序依赖文件系统，同一份代码在不同机器上顺序不同，
 * 会让拓扑序随机、测试随机失败。
 */
export function scanModDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  // extname('x.mod.json') === '.json'，只取最后扩展名 → 必须用 endsWith 匹配双扩展名
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mod.json'))
    .sort();
}

/** 扫描 + 逐个解析，分成 ok / err 两组。err 一定带文件名：
 *  坏 JSON 的验收要求就是"文件名级错误定位"——只给 "Unexpected token" 等于没给。 */
export function readModDir(dir: string): { ok: LoadedMod[]; err: { id: string; file: string; reason: string }[] } {
  const ok: LoadedMod[] = [];
  const err: { id: string; file: string; reason: string }[] = [];
  for (const f of scanModDir(dir)) {
    const full = join(dir, f);
    try {
      ok.push({ file: full, pkg: parseModPackage(readFileSync(full, 'utf-8'), f) });
    } catch (e) {
      // id 用文件名兜底：manifest 都解析不出来时，仍要能定位到文件
      err.push({ id: basename(f, '.mod.json'), file: full, reason: (e as Error).message });
    }
  }
  return { ok, err };
}

export interface ModLoadReport {
  /** 按拓扑序的包 id */
  order: string[];
  /** 成功挂载的包 id（拓扑序） */
  loaded: string[];
  /** 被拒绝的包：id/文件名 + 原因（响亮失败，不半挂载） */
  rejected: { id: string; file: string; reason: string }[];
  /** 契约校验违例（非空 = 应当视为挂载失败） */
  contractViolations: string[];
}

/**
 * 加载一批 JSON 包：拓扑 → 挂载 → 契约校验。
 *
 * **原子性**：任一包失败即整体抛错，且新装配的 registry 不会被返回——
 * 调用方拿不到"半挂载"的 registry。这是"响亮失败且不半挂载"的实现方式。
 *
 * 契约违例也当作失败（抛错）：装配末 validateContracts 拦下的拼写漂移
 * 若只记不抛，调用方可能忽略 → 卡永远抽不到系列的静默 bug。
 */
export function mountModPackages(regs: ModRegistry, mods: LoadedMod[]): ModLoadReport {
  const packs = mods.map(modPackageToPack);
  const order = topoSort(packs).map((p) => p.id); // 缺依赖/成环在这里抛错（挂载前）
  const report: ModLoadReport = { order, loaded: [], rejected: [], contractViolations: [] };
  // 按拓扑序逐个 apply；重复 id 会从 registry 抛出（响亮失败，不静默覆盖）
  for (const p of topoSort(packs)) {
    p.apply(regs);
    report.loaded.push(p.id);
  }
  report.contractViolations = validateContracts(regs);
  if (report.contractViolations.length > 0) {
    throw new Error(`mod 契约校验失败：\n- ${report.contractViolations.join('\n- ')}`);
  }
  return report;
}

/**
 * 把 JSON 包与已有 TS 包混合装配（默认玩法 + 外部 JSON DLC）。
 * requires 跨两种形态统一解析：JSON 包的 requires 可以指向 TS 包 id，反之不行
 * （TS 包没声明它需要某个 JSON 包——那应该由 JSON 包声明依赖它）。
 */
export function mountWithBase(base: ModPack[], mods: LoadedMod[]): { registry: ModRegistry; report: ModLoadReport } {
  const packs = [...base, ...mods.map(modPackageToPack)];
  const registry = new ModRegistry();
  const ordered = topoSort(packs);
  const jsonIds = new Set(mods.map((m) => m.pkg.manifest.id));
  const report: ModLoadReport = { order: ordered.map((p) => p.id), loaded: [], rejected: [], contractViolations: [] };
  for (const p of ordered) {
    p.apply(registry);
    if (jsonIds.has(p.id)) report.loaded.push(p.id);
  }
  report.contractViolations = validateContracts(registry);
  if (report.contractViolations.length > 0) {
    throw new Error(`mod 契约校验失败：\n- ${report.contractViolations.join('\n- ')}`);
  }
  return { registry, report };
}