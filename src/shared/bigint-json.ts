/**
 * bigint-json.ts —— 存档 quantity 字段的 bigint JSON 编码/解码。
 *
 * JSON 原生不支持 bigint。本模块在 saved-store 层对 quantity 字段
 * 做显式编解码，确保存档文件中不残留浮点数。
 *
 * ## 转换规则（encodeSaveDataToFile）
 *
 * 只转换 SaveData 中已知的 quantity 字段，不碰 gameplay float：
 *  - stockpile / techFragments / scratch → Record value 侧
 *  - relations / world.featureLeft / world.harvestCd → [string,n][] 的 n
 *
 * 所有非 quantity 字段（seed/time/rngState/hp/needs/坐标等）原样保留。
 *
 * ## decodeSaveDataFromFile
 *
 * 深搜恢复：把 `{_B:"42"}` 转回 number。兼容旧存档中原始 number。
 *
 * @module
 */

const BIGINT_KEY = '_B';

/**
 * 判断一个值是否是 bigint JSON 包装。
 * 格式：`{"_B":"42"}`（只含一个键 _B，值为数字字符串）。
 */
export function isBigintJson(v: unknown): v is { _B: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    BIGINT_KEY in v &&
    typeof (v as Record<string, unknown>)[BIGINT_KEY] === 'string'
  );
}

/** 把 number 编码为 bigint JSON 包装 */
export function wrapBigint(v: number): { _B: string } {
  return { [BIGINT_KEY]: BigInt(Math.round(v)).toString() };
}

/** 从 bigint JSON 包装解码回 number（兼容旧档：原始 number 直接返回） */
export function unwrapBigint(v: unknown): number {
  if (typeof v === 'number') return v; // 旧档：原始 number
  if (!isBigintJson(v)) return v as number;
  return Number(v._B);
}

/**
 * 编码 SaveData 中的 quantity Record 字段。
 * stockpile / techFragments / scratch。
 */
function encodeRecord(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'number' ? wrapBigint(v) : v;
  }
  return out;
}

/**
 * 编码 [string, number][] 元组（relations / featureLeft / harvestCd）。
 */
function encodeTuples(entries: unknown[]): unknown[] {
  return entries.map((e) => {
    if (Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'number') {
      return [e[0], wrapBigint(e[1])];
    }
    return e;
  });
}

/**
 * 编码 SaveData 中的所有 quantity 字段为 bigint JSON 包装。
 * 在 save-store.write 之前调用。
 */
export function encodeSaveDataToFile(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data, };
  if (typeof out.stockpile === 'object' && out.stockpile !== null) {
    out.stockpile = encodeRecord(out.stockpile as Record<string, unknown>);
  }
  if (typeof out.scratch === 'object' && out.scratch !== null) {
    out.scratch = encodeRecord(out.scratch as Record<string, unknown>);
  }
  if (typeof out.techFragments === 'object' && out.techFragments !== null) {
    out.techFragments = encodeRecord(out.techFragments as Record<string, unknown>);
  }
  if (Array.isArray(out.relations)) {
    out.relations = encodeTuples(out.relations);
  }
  if (typeof out.world === 'object' && out.world !== null) {
    const w = { ...(out.world as Record<string, unknown>) };
    if (Array.isArray(w.featureLeft)) w.featureLeft = encodeTuples(w.featureLeft);
    if (Array.isArray(w.harvestCd)) w.harvestCd = encodeTuples(w.harvestCd);
    out.world = w;
  }
  return out;
}

/**
 * 深层遍历将 bigint JSON 包装恢复为 number。
 * 在 save-store.read 之后调用。兼容旧档原始 number。
 */
export function decodeSaveDataFromFile(data: unknown): Record<string, unknown> {
  // 原子 bigint 包装 → number
  if (isBigintJson(data)) return Number(data._B) as unknown as Record<string, unknown>;
  // 原子 number（旧档未包装）→ 原样
  if (data === null || typeof data !== 'object') return data as Record<string, unknown>;
  // 数组 → 递归每个元素
  if (Array.isArray(data)) {
    return data.map((e) => decodeSaveDataFromFile(e)) as unknown as Record<string, unknown>;
  }
  // 对象 → 递归每个键值
  const out: Record<string, unknown> = {};
  for (const [k, vin] of Object.entries(data as Record<string, unknown>)) {
    out[k] = decodeSaveDataFromFile(vin);
  }
  return out;
}
