// thermo 玩法包独立测试（2026-08-14：空间温度场热源定位）
// 覆盖：① 冷天热源半径外 → 冻掉心情（惩罚可见）；② 篝火中心回温显著优于野外；
// ③ 暖炉半径内回温、半径外冻。
// 发现背景（review 2026-08-14）：热源坐标用 `key % world.width` 解码新 key 编码
// （x + y*2^31），y 解码成上亿假坐标 → 篝火旁有效温度永不回升，取暖机制整体失效
// 且无测试暴露。本测试断言"火旁 pawn 的 mood 流失 < 野外 pawn"让解码错误显形。
import { describe, it, expect } from 'vitest';
import { makeMinCtx, attach } from '../../sim/__tests__/helpers/minCtx';
import { ThermoSystem } from '../packs/thermo';
import type { MinCtx } from '../../sim/__tests__/helpers/minCtx';

describe('thermo 玩法包（温度场）', () => {
  const coldDay = (seed: number, temp: number) => {
    const ctx = makeMinCtx(seed);
    ctx.env = { raining: false, temperature: temp }; // 冷天（低于 comfortLo=2）
    const sys = new ThermoSystem(ctx);
    sys.init();
    return { ctx, sys };
  };

  // 建热源建筑：返回落点坐标（mods.buildings 来自 ModRegistry.default() = 默认含玩法包 def）
  const place = (ctx: MinCtx, defId: string): { x: number; y: number } => {
    const cx = Math.floor(ctx.world.width / 2);
    const cy = Math.floor(ctx.world.height / 2);
    for (let r = 0; r < 20; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (ctx.world.placeBuilding(x, y, defId, 'player')) return { x, y };
        }
      }
    }
    throw new Error(`找不到可建 ${defId} 的位置`);
  };

  // 单次评估（2s）后 pawn 的 mood delta（_moodAdj 记录最后一次 adjustMood）
  const evalAt = (ctx: MinCtx, sys: ThermoSystem, eid: number, x: number, y: number): number | undefined => {
    ctx.setPosition(eid, { x, y });
    ctx._moodAdj.clear();
    sys.update(2);
    return ctx._moodAdj.get(eid);
  };

  it('冷天热源半径外：pawn 冻掉心情（惩罚生效）', () => {
    const { ctx, sys } = coldDay(21, -8);
    const eid = ctx.spawnPawn(5, 5);
    const fire = place(ctx, 'campfire');
    // pawn 站在半径（4）外的无热源地带：eff = -8 < comfortLo → 惩罚
    const delta = evalAt(ctx, sys, eid, fire.x + 30, fire.y + 30);
    expect(delta!).toBeLessThan(0);
  });

  it('篝火中心回温：火堆旁 mood 流失显著小于野外（回归：热源坐标解码）', () => {
    const { ctx, sys } = coldDay(22, -8);
    const eidA = ctx.spawnPawn(5, 5);
    const eidB = ctx.spawnPawn(5, 6);
    const fire = place(ctx, 'campfire');
    // 火堆中心（campfire passable）d=0 → boost=6 → eff=-2；野外 eff=-8
    const nearFire = evalAt(ctx, sys, eidA, fire.x, fire.y)!;
    const farCold = evalAt(ctx, sys, eidB, fire.x + 30, fire.y + 30)!;
    expect(nearFire).toBeLessThan(0); // 冷天仍略有流失（冷胜过热）
    // bug 时热源定位错误 → 两者惩罚相同（本断言使解码错误显形）
    expect(farCold).toBeLessThan(nearFire - 0.05);
  });

  it('暖炉（heater 半径 6）覆盖区内回温；半径外仍冻', () => {
    const { ctx, sys } = coldDay(23, -8);
    const eid = ctx.spawnPawn(5, 5);
    const h = place(ctx, 'heater');
    // 半径 6 内（d=5 → boost = 8×(1-5/6) ≈ 1.33）
    const inRange = evalAt(ctx, sys, eid, h.x + 5, h.y)!;
    const outRange = evalAt(ctx, sys, eid, h.x + 20, h.y)!;
    expect(outRange).toBeLessThan(inRange);
  });

  it('夜晚温度保持：夜里火堆覆盖区温度不沉（维持 nightWarmFloor），野外照常冻', () => {
    // 发现背景（用户 2026-08-14「要有夜晚温度保持」）：夜晚环境温度降（雨天夜可到
    // 4°C，未来冷天更低），热源只叠加 boost 随环境下沉——火堆旁夜里也会冷；
    // 需求 = 火旁夜里温度"保持"：eff = max(envT+boost, nightWarmFloor=15)，白天不干涉。
    const ctx = makeMinCtx(24);
    ctx.env = { raining: false, temperature: -8 }; // 冷夜（比实测夜 4~8°C 更狠的边界）
    ctx.isNight = () => true;
    const sys = attach(ctx, new ThermoSystem(ctx));
    sys.init();
    const eidFire = ctx.spawnPawn(5, 5);
    const eidOut = ctx.spawnPawn(5, 6);
    const fire = place(ctx, 'campfire');
    // 火堆中心（d=0）：夜晚保底下 eff=15 无冷惩罚 → 无惩罚写回（正向烤火心情不落 _moodAdj）
    const atFire = evalAt(ctx, sys, eidFire, fire.x, fire.y);
    expect(atFire).toBeUndefined();
    // 野外同一冷夜：无热源 → eff=-8 < comfortLo → 冻
    const outside = evalAt(ctx, sys, eidOut, fire.x + 30, fire.y + 30)!;
    expect(outside).toBeLessThan(0);
  });
});