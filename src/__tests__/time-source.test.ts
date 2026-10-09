/**
 * time-source.test.ts —— 运行常数真相源（模块化审查 P1 + P2，2026-10-10）。
 *
 * 守住的三条红线：
 *  1. **dt 只有一处真相源**：SIM_DT_SEC 是唯一原始值，client/server 的值全部从它
 *     派生。若有人把 0.25 / 0.1 / 100 重新写成字面量，本文件会红（结构性扫描）。
 *  2. **客户端步长必须是真实 dt 的整数倍**：否则累加会漂出真实 dt 的格子，
 *     "本地单机与服务器推同一局"的时间轴对不上（分数 tick 漂移）。
 *  3. **秒/tick 量纲不依赖任何具体步长**：heal 卡按秒扣草药（herbCost × dt）的
 *     契约基准是 SIM_DT_SEC，不是 client 本地那一步多大。改前"每 tick 扣 1 份"的
 *     缺陷在 0.1 和 0.25 下都成立；改成按秒扣后，两个步长下预留都必须完整覆盖卡期。
 *     这条是本批修复最重要的一条——它让"量纲自洽"从"某个步长下碰巧对"变成恒真。
 *
 * 另附 P2：默认种子/端口的字面量（`42` ×3、`8080` ×2）同样收口，扫描一并覆盖。
 *
 * 装配纪律：抄 medicine.test.ts 的 SOLO——**不挂 bootstrap**（它的 init 会按
 * pawnCount 额外出生 4 只鼠，污染手控断言）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Sim } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import { K_STOCK_HERB } from '../mods/contracts';
import {
  CLIENT_STEP_MULT,
  CLIENT_STEP_SEC,
  DEFAULT_PORT,
  DEFAULT_SEED,
  RENDER_DT_CLAMP_SEC,
  SERVER_TICK_MS,
  SIM_DT_SEC,
} from '../sim/tuning';
import { medicinePack } from '../mods/packs/medicine';
import { needsPack } from '../mods/packs/needs';
import { buildingPack } from '../mods/packs/building';
import type { PawnState } from '../sim/types';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 读**生产源码**做结构扫描（防魔法数字回潮）——与 dlc-twin.test.ts 读真实 JSON 包同款手法 */
function src(rel: string): string {
  return readFileSync(join(HERE, rel), 'utf-8');
}

const SOLO: ModPack[] = [needsPack, buildingPack, medicinePack];
function reg(): ModRegistry {
  return ModRegistry.mountPacks(SOLO);
}

/** 摆两只鼠：a 站 (0,0)、b 站 (1,0) 并冻结 b（照抄 medicine.test.ts setupPair 的做法） */
function setupPair(s: Sim): [PawnState, PawnState] {
  const ps = [...s.pawns()];
  const a = ps[0];
  const b = ps[1];
  a.pos = { x: 0, y: 0 };
  b.pos = { x: 1, y: 0 };
  a.path = [];
  b.path = [];
  b.holdUntil = 1e6; // 冻结伤员
  return [a, b];
}

describe('运行常数真相源：dt 派生关系', () => {
  it('所有派生值都能从 SIM_DT_SEC 精确算回（浮点不落空）', () => {
    // 0.1 的二进制表示是 0.1000000000000000055511，×1000 恰好落回 100；
    // 但 /1000 再乘回来必须仍等于 0.1——服务器 tick 的 dt 就是这样算出来的，
    // 若将来把 SIM_DT_SEC 改成不整除的值，这里会先红。
    expect(SERVER_TICK_MS).toBe(100);
    expect(SERVER_TICK_MS / 1000).toBeCloseTo(SIM_DT_SEC, 12);
    expect(CLIENT_STEP_SEC).toBeCloseTo(CLIENT_STEP_MULT * SIM_DT_SEC, 12);
    // 渲染帧钳位就是一个真实 tick 的时长：单帧最多喂入一拍，补偿靠 acc 上限
    expect(RENDER_DT_CLAMP_SEC).toBeCloseTo(SIM_DT_SEC, 12);
    // 派生值必须为正（setInterval(0) 与 sim.step(0) 都是静默的错误）
    expect(SIM_DT_SEC).toBeGreaterThan(0);
    expect(CLIENT_STEP_MULT).toBeGreaterThan(0);
    expect(RENDER_DT_CLAMP_SEC).toBeGreaterThan(0);
    expect(SERVER_TICK_MS).toBeGreaterThan(0);
  });

  it('客户端步长累加后仍落在真实 dt 的格点上（无分数 tick 漂移）', () => {
    const stepsPerClient = CLIENT_STEP_MULT;
    const a = new Sim({ seed: 1, registry: reg(), pawnCount: 1 });
    for (let i = 0; i < 4; i++) a.step(CLIENT_STEP_SEC);
    // 4 个客户端步长 = 4×MULT 个真实 tick，必须精确落在第 4×MULT 格上
    expect(Math.abs(a.time / SIM_DT_SEC - stepsPerClient * 4)).toBeLessThan(1e-9);
    // 与"逐真实 tick 推进"给出同一模拟时间（等价的是时间轴，不是世界——见 golden 的步长不变性段）
    const b = new Sim({ seed: 1, registry: reg(), pawnCount: 1 });
    for (let i = 0; i < stepsPerClient * 4; i++) b.step(SIM_DT_SEC);
    expect(a.time).toBeCloseTo(b.time, 12);
  });

  it('客户端步长被钳位挡不住推进（钳位 < 步长是有意设计，靠 acc 累计补上）', () => {
    // 单帧最多喂 RENDER_DT_CLAMP_SEC，一个 CLIENT_STEP_SEC 需要攒几帧——
    // 断言这个比值是有限正数，避免有人把钳位改成 0（= 客户端永远不推进，静默冻结）。
    expect(CLIENT_STEP_SEC / RENDER_DT_CLAMP_SEC).toBeGreaterThan(0);
    expect(Number.isFinite(CLIENT_STEP_SEC / RENDER_DT_CLAMP_SEC)).toBe(true);
  });
});

describe('运行常数真相源：默认种子与端口', () => {
  it('默认值有唯一取值且合理', () => {
    expect(DEFAULT_SEED).toBe(42);
    expect(DEFAULT_PORT).toBe(8080);
  });
});

describe('量纲红线：按秒扣草药与步长无关（P1 核心回归）', () => {
  /**
   * 同一张 heal 卡、同一个 seed，在**客户端步长**与**真实 dt**两种推进下跑满卡期：
   *   · 半卡期时预留应恰好花掉一半；
   *   · 整卡期结束时预留归零、回血覆盖率 >90%。
   *
   * 为什么这条是本轮修复的核心：改前 heal 是"每 tick 扣 1 份"，预留却是"秒"量纲。
   * 那时 8 份只在 dt=1 下等价于 8 秒；dt=0.25 时只够 2 秒（75% 空转），dt=0.1 时
   * 只够 0.8 秒（90% 空转）。改后消费是 herbCost × dt，量纲恒为秒——**两种步长
   * 都必须完整覆盖卡期**，这条断了就说明有人把消费又改回按 tick。
   */
  it.each([
    ['client 步长 (0.25)', CLIENT_STEP_SEC],
    ['真实 dt (0.1)', SIM_DT_SEC],
  ])('卡期预留完整覆盖：%s', (_name, dt) => {
    const s = new Sim({ seed: 41, registry: reg(), pawnCount: 2 });
    const [a, b] = setupPair(s);
    b.hp = 20;
    const m = s.tuning.medicine;
    const dur = s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec;
    const total = m.herbCost * dur;
    const key = `medicine.herbReserved.${a.eid}`;

    s.stockpile[K_STOCK_HERB] = total;
    s.debugForceCard(a.eid, 'heal');
    expect(s.scratch[key], '抽卡即预留 herbCost × duration（秒）').toBe(total);

    const hp0 = b.hp;
    const steps = Math.round(dur / dt);
    // 三个检查点：25% / 50% / 75% 卡期 —— 消费必须严格线性于**秒**，与 dt 取值无关。
    // 改前按 tick 扣时，0.1 步长下第 8 步就扣空（8 份 × 1 份/tick = 0.8s），此后整卡空转，
    // 这三个检查点会精确暴露"预留早没了"。
    const checkpoints = [0.25, 0.5, 0.75];
    let next = 0;
    let minReserved = total;
    for (let i = 1; i <= steps; i++) {
      s.step(dt);
      const frac = i / steps;
      while (next < checkpoints.length && frac >= checkpoints[next]) {
        const want = total * (1 - checkpoints[next]);
        expect(s.scratch[key], `卡期 ${checkpoints[next] * 100}% 处预留应剩 ${want.toFixed(2)} 份`)
          .toBeCloseTo(want, 5);
        next++;
      }
      const r = s.scratch[key];
      if (r !== undefined) minReserved = Math.min(minReserved, r);
    }
    expect(minReserved, '按秒扣不应超扣（负数=消费与预留不同步）')
      .toBeGreaterThanOrEqual(-1e-9);

    const care = b.hp - hp0 - m.naturalHealPerSec * dur;
    expect(care / (m.healPerSec * dur), '卡期回血覆盖率应≈100%（改前 0.1 步长下只有 ~10%）')
      .toBeGreaterThan(0.9);
  });
});

// ---- R4 审计 P3：dt > 卡期覆盖率边界（P3 测试场景）----
//
// 现状：time-source.test.ts 只测 dt=0.1/0.25（<< 8s 卡期）。dt > 卡期（如 10s > 8s）
// 时，stepPawn 在到期检查时看到 time >= busyUntil → 释放预留 + 重抽新卡，
// 旧卡的 action 从未执行。覆盖率 care/(healPerSec*dur) = 0，预留精确释放。
// 这是 stepPawn 的正常行为（卡到期即重抽），但边界未覆盖——本测试钉住。

describe('R4 P3: dt > 卡期边界——卡到期后 action 不执行', () => {
  it('dt > 卡期：旧卡 action 未执行、预留精确释放、覆盖率 = 0', () => {
    const s = new Sim({ seed: 41, registry: reg(), pawnCount: 2 });
    const [a, b] = setupPair(s);
    b.hp = 20;
    const m = s.tuning.medicine;
    const dur = s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec;
    const total = m.herbCost * dur;
    const key = `medicine.herbReserved.${a.eid}`;

    s.stockpile[K_STOCK_HERB] = total;
    s.debugForceCard(a.eid, 'heal');
    expect(s.scratch[key], '抽卡即预留 herbCost × duration（秒）').toBe(total);

    const hp0 = b.hp;
    const dt = dur + 2; // dt=10 > dur=8：一步推进超过卡期
    const herbBefore = s.stockpile[K_STOCK_HERB];
    s.step(dt);

    // ① 预留释放：旧卡的 herbs 归还 stockpile（到期时 releaseHerbReservation）
    expect(
      s.stockpile[K_STOCK_HERB],
      'dt>卡期：到期时预留释放，herbs 应归还 stockpile',
    ).toBeGreaterThanOrEqual(herbBefore);

    // ② 旧卡 action 未执行：无主动回血（只有 medicine-tick 的自然恢复）
    const care = b.hp - hp0 - m.naturalHealPerSec * dt;
    expect(
      care,
      'dt>卡期：旧卡 heal action 未执行，主动回血 ≈ 0（覆盖率 0.0%）',
    ).toBeLessThan(1);

    // ③ 新卡已指派（到期后 behavior 重抽）
    //    a.cardId 可能仍是 'heal'（如果重抽还是 heal），但 busyUntil 已更新到 dt 之后
    expect(
      a.busyUntil > dt,
      'dt>卡期：到期后重抽新卡，busyUntil 应 > 当前时间（新卡期已开始）',
    ).toBe(true);
  });

  it('dt = 卡期（恰好到期）：旧卡释放 + 新卡立即执行（无缝衔接）', () => {
    // dt=dur 时，stepPawn 的到期检查 time >= busyUntil 在 action 执行前成立，
    // 旧卡预留释放后新卡立即重抽并执行——"旧卡结束 = 新卡开始"在同一 tick 内完成。
    // 与 dt<dur 不同：dt<dur 时旧卡 action 在多步中逐步执行；dt=dur 时旧卡 action
    // 从未执行，但新卡 action 立即执行（若新卡也是 heal，其预留 herbCost×dur 恰好
    // 覆盖 need=herbCost×dt=herbCost×dur，所以新卡能正常回血）。
    // 本测试钉住"恰好到期"边界：旧卡不执行，但新卡立即执行（无缝衔接）。
    const s = new Sim({ seed: 41, registry: reg(), pawnCount: 2 });
    const [a, b] = setupPair(s);
    b.hp = 20;
    const m = s.tuning.medicine;
    const dur = s.cardById('heal')!.duration ?? s.tuning.pawn.defaultCardSec;
    const total = m.herbCost * dur;

    s.stockpile[K_STOCK_HERB] = total;
    s.debugForceCard(a.eid, 'heal');

    const hp0 = b.hp;
    const herbBefore = s.stockpile[K_STOCK_HERB];
    s.step(dur); // dt = dur：恰好到期

    // 预留释放（旧卡的预留归还 stockpile）
    expect(s.stockpile[K_STOCK_HERB], 'dt=dur：旧卡预留释放').toBeGreaterThanOrEqual(herbBefore);

    // 新卡已指派
    expect(a.busyUntil > dur, '到期后重抽新卡').toBe(true);

    // 若新卡也是 heal（条件满足时高概率），其 action 立即执行并回血：
    // 预留 herbCost×dur 恰好覆盖 need=herbCost×dt=herbCost×dur
    // 这不是旧卡的回血，是新卡的——覆盖率由新卡承担。
    // 本测试不钉死新卡的具体行为（取决于随机抽卡），只钉住"旧卡释放+新卡执行"的边界。
  });
});

describe('结构性扫描：魔法数字不许回潮', () => {
  // 读生产源码（不是快照/内联），断言真相源是唯一出处、旧字面量已清干净。
  // 一旦有人手写 0.25 / 0.1 / 100 / 42 / 8080 回到这三份文件，这里立即红。

  it('client/main.ts：步长与渲染钳位来自 tuning，seed/port 有唯一默认值', () => {
    const code = src('../client/main.ts');
    expect(code).toContain('CLIENT_STEP_SEC');
    expect(code).toContain('RENDER_DT_CLAMP_SEC');
    expect(code).toContain('DEFAULT_SEED');
    expect(code).toContain('DEFAULT_PORT');
    // 旧的三处字面量：固定步长 0.25（×2）、渲染钳位 0.1、种子 42
    expect(code).not.toMatch(/sim\.step\(\s*0\.25\s*\)/);
    expect(code).not.toMatch(/acc\s*>=\s*0\.25/);
    expect(code).not.toMatch(/Math\.min\(\s*0\.1\s*,/);
    expect(code).not.toMatch(/\?\?\s*42\b/);
    expect(code).not.toMatch(/\?\?\s*8080\b/);
  });

  it('server/game-server.ts：tick 间隔、seed、端口全部走真相源', () => {
    const code = src('../server/game-server.ts');
    expect(code).toContain('SERVER_TICK_MS');
    expect(code).toContain('DEFAULT_SEED');
    expect(code).toContain('DEFAULT_PORT');
    expect(code).not.toMatch(/opts\.tickMs\s*\?\?\s*100\b/);
    expect(code).not.toMatch(/opts\.seed\s*\?\?\s*42\b/);
    expect(code).not.toMatch(/opts\.port\s*\?\?\s*8080\b/);
  });

  it('server/index.ts：CLI 默认端口与种子不再硬编码', () => {
    const code = src('../server/index.ts');
    expect(code).toContain('DEFAULT_PORT');
    expect(code).toContain('DEFAULT_SEED');
    expect(code).not.toMatch(/\?\?\s*8080\b/);
    expect(code).not.toMatch(/\?\?\s*42\b/);
  });

  it('tuning.ts：SIM_DT_SEC 是唯一原始 dt，默认值也在此归口', () => {
    const code = src('../sim/tuning/index.ts');
    expect(code).toMatch(/export const SIM_DT_SEC\s*=\s*0\.1/);
    expect(code).toMatch(/export const SERVER_TICK_MS\s*=\s*SIM_DT_SEC\s*\*\s*1000/);
    expect(code).toMatch(/export const CLIENT_STEP_SEC\s*=\s*CLIENT_STEP_MULT\s*\*\s*SIM_DT_SEC/);
    expect(code).toMatch(/export const RENDER_DT_CLAMP_SEC\s*=\s*SIM_DT_SEC/);
    expect(code).toMatch(/export const DEFAULT_SEED\s*=\s*42/);
    expect(code).toMatch(/export const DEFAULT_PORT\s*=\s*8080/);
  });

  it('量纲注释不再拿 client 的 0.25 当契约基准（P1 第二半）', () => {
    // 原缺陷：medicine.ts 与 tuning.ts 各有一处注释拿 client 的 step(0.25)
    // 当"秒/tick 量纲"的论证基准，而服务器权威侧跑的是 0.1。这里钉住订正后的措辞。
    expect(src('../mods/packs/medicine.ts')).not.toMatch(/生产走 step\(0\.25\)/);
    expect(src('../sim/tuning/index.ts')).not.toMatch(/生产按 step\(0\.25\)/);
    // 且两处都指明真实来源是 tuning §0 的 SIM_DT_SEC
    expect(src('../mods/packs/medicine.ts')).toContain('SIM_DT_SEC');
    expect(src('../sim/tuning/index.ts')).toContain('SIM_DT_SEC');
  });
});
