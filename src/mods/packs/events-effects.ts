/**
 * mods/packs/events-effects.ts —— 事件效果的"纯计算"与"副作用"分离（calc 线拆分第一刀）。
 *
 * ## 动机（2026-10-08）
 *
 * events.ts 的 applyEffects / handleExpiry 把**确定效果值**与**实际写入状态**混在一起：
 *
 *   applyEffects(ctx, seed) {
 *     const e = resolve(seed, ctx);  // ← 确定效果值（纯函数！但被副作用包围）
 *     ctx.log(e.log);                 // ← 副作用
 *     ctx.stockpile[k] += v;          // ← 副作用
 *     ...
 *   }
 *
 * 分离后：
 *   const effects = resolveEffects(seed, ctx);   // 纯函数：输入=seed+ctx → 输出=EventEffects
 *   applyResolvedEffects(ctx, effects);           // 副作用：把确定的 effects 写到 ctx
 *
 * 价值：
 *  ① **确定性护城河**：resolveEffects 纯函数可直接断言 == 等价，不依赖 mock ctx 的完整实现；
 *  ② **可回放**：先 resolve 所有效果再统一 apply，单 tick 内效果互不干扰（如 "tempShift + 瘟疫"
 *     同时触发时，顺序不影响最终态——因为两个效果写两个不同的键）；
 *  ③ **可测试**：resolveEffects 不依赖 ctx 的模拟层，只需 tuning + stockpile/scratch 几个字段；
 *  ④ **与既有 applyEffects 向后兼容**：events.ts 的 update 方法只改一处调用。
 */
import type { SimContext } from '../../sim/context';
import type { EventEffects, EventSeedDef } from '../registry';

/**
 * 解析事件效果表：纯函数，无副作用。
 *
 * 输入：事件种子 + 现场快照（通过 ctx 只读查询）
 * 输出：确定的效果表
 *
 * 为什么不能完全不用 ctx：
 *   effect 可以是函数（`(ctx) => ({ log, stock })`），
 *   它需要读 tuning（如 `ctx.tuning.events.effects.harvestStockDelta`）。
 *   但**只是读**，没有写——所以 resolve 仍然是纯的（读 ctx 的确定字段不构成副作用）。
 */
export function resolveEffects(seed: EventSeedDef, ctx: SimContext): EventEffects {
  if (typeof seed.effects === 'function') {
    return seed.effects(ctx);
  }
  return seed.effects;
}

/**
 * 应用已解析的效果表到 ctx（纯副作用）。
 *
 * 与旧 applyEffects 的三处不同：
 *  ① **不接受 seed，只接受 resolved effects** —— 调用方必须先 resolve；
 *  ② 不重复判断 `typeof seed.effects === 'function'` —— 调用方在上层做完；
 *  ③ 返回 void（只写 ctx，读 ctx 只做幂等安全查询如 `?? 0`）。
 *
 * 每个效果字段都有幂等保护（钳制 ≥0 / 复制列表防迭代中变动），
 * 语义与原 applyEffects 完全一致（可以逐字段 grep 差异）。
 *
 * @param expiryKey 持续效果的到期 scratch 键，如 "events.expire.coldsnap"。
 *   由调用方传入（调用方知道种子 id），保证键唯一且可追踪。
 */
export function applyResolvedEffects(ctx: SimContext, e: EventEffects, expiryKey?: string): void {
  // log 是效果表的必有字段（即使其他效果都缺，log 也在）
  ctx.log(e.log);

  // stock：库存增减，钳制 ≥0
  if (e.stock) {
    for (const [k, v] of Object.entries(e.stock)) {
      ctx.stockpile[k] = Math.max(0, (ctx.stockpile[k] ?? 0) + v);
    }
  }

  // stockMul：库存乘数
  if (e.stockMul) {
    for (const [k, m] of Object.entries(e.stockMul)) {
      ctx.stockpile[k] = Math.max(0, (ctx.stockpile[k] ?? 0) * m);
    }
  }

  // hpDelta：全体鼠 hp 增减
  if (e.hpDelta !== undefined && e.hpDelta !== 0) {
    for (const p of [...ctx.pawns()]) {
      if (e.hpDelta < 0) {
        ctx.damagePawn(p.eid, -e.hpDelta, 'events');
      } else {
        p.hp = Math.min(p.maxHp, p.hp + e.hpDelta);
      }
    }
  }

  // spawnPawn：新增鼠
  if (e.spawnPawn && e.spawnPawn > 0) {
    for (let i = 0; i < e.spawnPawn; i++) {
      ctx.spawnPawn();
    }
  }

  // tempShift：环境温度修饰（仅当 env 包在场时生效）
  if (e.tempShift !== undefined) {
    if (ctx.scratch['env.temp'] !== undefined) {
      ctx.scratch['env.tempMod'] = (ctx.scratch['env.tempMod'] ?? 0) + e.tempShift;
      if (e.durationSec && e.durationSec > 0 && expiryKey) {
        ctx.scratch[expiryKey] = ctx.time + e.durationSec;
      }
    }
    // env.temp 不存在 → 静默跳过
  }
}

/**
 * 反向效果（持续效果的到期处理）。
 * 与 applyResolvedEffects 的 tempShift 分支反向：退回修饰量。
 */
export function applyReverseEffects(ctx: SimContext, e: EventEffects): void {
  if (e.tempShift !== undefined) {
    if (ctx.scratch['env.temp'] !== undefined) {
      ctx.scratch['env.tempMod'] = (ctx.scratch['env.tempMod'] ?? 0) - e.tempShift;
      ctx.log(`🌡 事件余波散去，温度回升`);
    }
  }
}
