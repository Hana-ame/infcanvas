/**
 * server/dlc-load.ts —— `dlc_load.json` 读取（DLC 分层 P0，对位 HOI4 的同名文件）。
 *
 * 作用：一份**用户侧清单**，决定启动时装哪些 DLC。对位 HOI4（见
 * facts-hoi4-dlc-system.md §7）：`dlc_load.json` 保存"启用的 mod + 停用的 DLC"，
 * 启动器改写，也可以手改——DLC 是"随时可摘的增量"。
 *
 * ★ 最重要的一条语义：**文件不存在 = 只挂本体**（`present: false`）。★
 *   DLC 因此是**显式 opt-in**，不是"放了就默认开"。理由：
 *   ① 这是"原版能玩"的**唯一无条件保证**——不依赖任何配置正确性；
 *   ② 与 packs/playstyle.ts「DLC 不进默认清单」的既有规则同向；
 *   ③ 对位 HOI4：默认全摘，勾选才戴。
 *
 * 失败策略（仓库铁律：响亮失败，绝不静默）：
 *  - 坏 JSON / 形状不对 / 未知字段 → **抛错并带文件名**。未知字段尤其要报：
 *    拼错的键若被静默忽略，作者会以为"我配了"而实际没配（同 mod-schema.ts:69-79）。
 *
 * 为什么放 server/ 而不是 shared/：本文件用 `node:fs` 读盘，浏览器侧不可用；
 * 而"格式"（键名与语义）本身与 shared/mod-schema 同级——若将来编辑器要导出
 * dlc_load.json，再把纯类型抽到 shared/（现在抽是过早抽象）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 配置文件名（与 .mod.json 同目录平铺；`scanModDir` 只收 `.mod.json`，不会误吃它） */
export const DLC_LOAD_FILE = 'dlc_load.json';

/** dlc_load.json 允许的键（未知键 = 加载期报错，不是"以后再说"） */
export const DLC_LOAD_KEYS = ['base', 'enabledDlc', 'disabledDlc'] as const;

export interface DlcLoadConfig {
  /** 本体系列标记（信息性，对位 HOI4 dlcmetadata 的 supported_version） */
  base?: string;
  /** 要启用的 DLC id（查 DLC_PACKS 表；未登记 = 装配期抛错） */
  enabledDlc: string[];
  /** 要停用的 DLC id——**优先于 enabledDlc**（"买了也能停"，对位 HOI4 启动器） */
  disabledDlc: string[];
  /** 配置文件是否实际存在。false = 默认：只挂本体（原版体验） */
  present: boolean;
}

/** 缺省配置：文件不存在时的返回值（只挂本体） */
export function emptyDlcLoad(): DlcLoadConfig {
  return { enabledDlc: [], disabledDlc: [], present: false };
}

function assertIdArray(v: unknown, key: string, fileName: string): string[] {
  if (!Array.isArray(v)) throw new Error(`dlc_load.json 的 ${key} 必须是字符串数组：${fileName}`);
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim()) {
      throw new Error(`dlc_load.json 的 ${key} 含非法项 ${JSON.stringify(x)}（须为非空字符串）：${fileName}`);
    }
  }
  return [...(v as string[])];
}

/**
 * 解析 dlc_load.json 文本。fileName 仅用于错误定位——坏配置必须能报到文件级，
 * 否则用户只看到一句"Unexpected token"完全不知道是哪个文件坏了。
 */
export function parseDlcLoad(text: string, fileName: string): DlcLoadConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`dlc_load.json 不是合法 JSON：${fileName}：${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`dlc_load.json 必须是 JSON 对象：${fileName}`);
  }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!(DLC_LOAD_KEYS as readonly string[]).includes(k)) {
      throw new Error(
        `dlc_load.json 含未知键 "${k}"（允许：${DLC_LOAD_KEYS.join(' / ')}）：${fileName}`,
      );
    }
  }
  if (obj.base !== undefined && typeof obj.base !== 'string') {
    throw new Error(`dlc_load.json 的 base 必须是字符串：${fileName}`);
  }
  const enabledDlc = obj.enabledDlc === undefined ? [] : assertIdArray(obj.enabledDlc, 'enabledDlc', fileName);
  const disabledDlc = obj.disabledDlc === undefined ? [] : assertIdArray(obj.disabledDlc, 'disabledDlc', fileName);
  return {
    ...(obj.base !== undefined ? { base: obj.base as string } : {}),
    enabledDlc,
    disabledDlc,
    present: true,
  };
}

/** 最大允许的 dlc_load.json 体积（字节）——防 OOM，防恶意/误写大文件 */
const DLC_LOAD_MAX_BYTES = 64 * 1024; // 64 KiB

/**
 * 从目录读 dlc_load.json。
 * **文件不存在 = emptyDlcLoad()（只挂本体）**，不报错——"没配置"是合法且默认的状态。
 * 文件过大 → 抛错（响亮失败，不让 OOM 悄悄发生）。
 */
export function readDlcLoad(dir: string): DlcLoadConfig {
  const full = join(dir, DLC_LOAD_FILE);
  if (!existsSync(full)) return emptyDlcLoad();
  const stat = statSync(full);
  if (stat.size > DLC_LOAD_MAX_BYTES) {
    throw new Error(`dlc_load.json 过大（${stat.size} 字节，上限 ${DLC_LOAD_MAX_BYTES}）：${full}`);
  }
  return parseDlcLoad(readFileSync(full, 'utf-8'), full);
}
