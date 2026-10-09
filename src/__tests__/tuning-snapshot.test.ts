/**
 * tuning-snapshot.test.ts —— 拆分后 DEFAULT_TUNING 行为不变契约（模块化审查 T3 §4 护栏）。
 *
 * 原理：
 *   1. 拆分前捕获 DEFAULT_TUNING 的 JSON 快照（baseline）
 *   2. 拆分后重新组装的 DEFAULT_TUNING 必须与 baseline 深比较相等
 *   3. golden 指纹必须逐位不变（纯搬家；指纹变即说明搬家时动了数据）
 *
 * baseline 来源：/tmp/tuning-snapshot.json（由拆分前的 tuning.ts 导出）。
 * 若 baseline 文件不存在，测试自动跳过（首次拆分时生成）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { DEFAULT_TUNING } from '../sim/tuning';
import {
  SIM_DT_SEC, CLIENT_STEP_MULT, CLIENT_STEP_SEC,
  RENDER_DT_CLAMP_SEC, SERVER_TICK_MS, DEFAULT_SEED, DEFAULT_PORT,
} from '../sim/tuning';
import { fingerprint } from '../sim/fingerprint';

const BASELINE_PATH = '/tmp/tuning-snapshot.json';

function loadBaseline(): { constants: Record<string, number>; tuning: unknown } | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
}

describe('DEFAULT_TUNING 拆分后深比较（护栏）', () => {
  const baseline = loadBaseline();

  it('§0 运行常数与 baseline 一致', () => {
    if (!baseline) return;
    const b = baseline.constants;
    expect(SIM_DT_SEC).toBe(b.SIM_DT_SEC);
    expect(CLIENT_STEP_MULT).toBe(b.CLIENT_STEP_MULT);
    expect(CLIENT_STEP_SEC).toBe(b.CLIENT_STEP_SEC);
    expect(RENDER_DT_CLAMP_SEC).toBe(b.RENDER_DT_CLAMP_SEC);
    expect(SERVER_TICK_MS).toBe(b.SERVER_TICK_MS);
    expect(DEFAULT_SEED).toBe(b.DEFAULT_SEED);
    expect(DEFAULT_PORT).toBe(b.DEFAULT_PORT);
  });

  it('DEFAULT_TUNING 深比较 === baseline（纯搬家，零数据变更）', () => {
    if (!baseline) return;
    expect(DEFAULT_TUNING).toEqual(baseline.tuning);
  });

  it('DEFAULT_TUNING 键顺序与 Tuning 接口一致', () => {
    const keys = Object.keys(DEFAULT_TUNING);
    expect(keys).toEqual([
      'world', 'pawn', 'needs', 'build', 'gathering',
      'farming', 'cooking', 'medicine',
      'social', 'raid', 'hunting', 'combat', 'env',
      'factions', 'fortify',
      'techs', 'techPool', 'bootstrap', 'events',
      'tiles', 'buildings', 'enemies', 'traits',
    ]);
  });
});

describe('golden 指纹不变量（拆分后行为等价）', () => {
  it('seed 2026 跑 900 tick 指纹与 baseline 一致', async () => {
    const { Sim } = await import('../sim');
    const { ModRegistry } = await import('../mods');

    const sim = new Sim({ seed: 2026, registry: ModRegistry.default() });
    sim.run(900);
    const fp = fingerprint(sim);

    // golden 基线指纹（与 __tests__/golden.test.ts 的 GOLDEN['2026@900'] 一致）
    expect(fp).toBe('fp_122ecc8d');
  });
});
