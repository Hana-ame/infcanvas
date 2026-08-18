// 电力玩法包（power）独立测试（2026-08-16：补齐审计发现的无测试包 + forge 修复回归）
// 发现背景：power 包此前无任何测试；审查发现 forge 生产缺节奏（CFG.interval 死参数——
// 电荷够就每帧量产）、组内多 forge 每帧只产一次（第二台永无产出）。本文件保护：
//   ① 单 forge 按 interval 节奏生产（非每帧）；
//   ② 同组双 forge 并行生产（各自节奏、各自抽电扣木）；
//   ③ 记账正确性：双 forge 不超抽电（总扣 = 件数 × forgeCharge）；
//   ④ 电荷不足 → 停产不扣料。
import { describe, it, expect, beforeEach } from 'vitest';
import { makeMinCtx, attach } from '../../../sim/__tests__/helpers/minCtx';
import { PowerSystem } from '../power';
import type { BuildingData } from '../../../sim/core/world';
import { World } from '../../../sim/core/world';

// forgeCharge=6 / interval=4 / woodPerTool=3（与 power.ts CFG 同步，防改表后测试失真）
const FORGE_CHARGE = 6;
const FORGE_INTERVAL = 4;
const WOOD_PER_TOOL = 3;

describe('电力玩法包（power）独立测试（最小 ctx）', () => {
  let ctx = makeMinCtx(3);
  beforeEach(() => { ctx = makeMinCtx(3); });

  // 摆放 battery + forges（相邻 → 同组；wireRange=1 曼哈顿≤1）。charge 直接注入电池 extra
  function setup(forgeCount: number, charge: number): { sys: PowerSystem; batteryKey: number; forgeKeys: number[] } {
    const sys = attach(ctx, new PowerSystem(ctx));
    // 找"电池 + forge 竖排"全部可建的位置（避开树/石/水——placeBuilding 失败会连锁崩断言）
    let bx = -1, by = -1;
    for (let x = 1; x < ctx.world.width - 1 && bx < 0; x++) {
      for (let y = 1; y < ctx.world.height - 1 - forgeCount; y++) {
        let ok = true;
        for (let i = 0; i <= forgeCount; i++) {
          const def = ctx.buildingDef(i === 0 ? 'battery' : 'forge')!;
          if (!ctx.world.canBuildFootprint(x, y + i, def)) { ok = false; break; }
        }
        if (ok) { bx = x; by = y; break; }
      }
    }
    expect(bx).toBeGreaterThanOrEqual(0);
    ctx.world.placeBuilding(bx, by, 'battery', 'player', { charge });
    const forgeKeys: number[] = [];
    for (let i = 1; i <= forgeCount; i++) {
      const x = bx, y = by + i; // 电池向下竖排：各 forge 与电池相邻（曼哈顿 1）→ 同组
      expect(ctx.world.placeBuilding(x, y, 'forge', 'player')).toBe(true);
      forgeKeys.push(ctx.world.buildKey(x, y));
    }
    return { sys, batteryKey: ctx.world.buildKey(bx, by), forgeKeys };
  }

  const chargeOf = (key: number): number => (ctx.world.buildings.get(key)!.extra?.charge as number) ?? 0;

  it('单 forge：按 interval 节奏生产（4s 一件，非每帧量产）', () => {
    ctx.stockpile.wood = 100;
    const { sys, batteryKey, forgeKeys } = setup(1, 100);
    // 首帧进入节奏：冷却为 0 → 立即产 1 件
    sys.update(0.1);
    expect(ctx.stockpile.tools ?? 0).toBe(1);
    expect(ctx.stockpile.wood).toBe(100 - WOOD_PER_TOOL);
    expect(chargeOf(batteryKey)).toBe(100 - FORGE_CHARGE);
    // 冷却窗内（interval 内）不再生产——此前 bug：电荷够就每帧量产
    for (let i = 0; i < 8; i++) sys.update(0.25); // 累计 2s < 4s
    expect(ctx.stockpile.tools ?? 0).toBe(1);
    expect(ctx.stockpile.wood).toBe(100 - WOOD_PER_TOOL);
    // 冷却到期（累计满 interval）→ 下一件
    sys.update(2); // 2+2 = 4s 到点
    expect(ctx.stockpile.tools ?? 0).toBe(2);
    expect(ctx.stockpile.wood).toBe(100 - 2 * WOOD_PER_TOOL);
    expect(chargeOf(batteryKey)).toBe(100 - 2 * FORGE_CHARGE);
  });

  it('同组双 forge：并行生产（各自节奏），不超抽电、不重复扣木', () => {
    ctx.stockpile.wood = 100;
    const { sys, batteryKey, forgeKeys } = setup(2, 100);
    expect(forgeKeys.length).toBe(2);
    sys.update(0.1); // 两台都就绪 → 各产 1 件
    expect(ctx.stockpile.tools ?? 0).toBe(2);
    expect(ctx.stockpile.wood).toBe(100 - 2 * WOOD_PER_TOOL);
    // 记账正确：总扣电 = 2 × forgeCharge（此前单帧快照判定会超抽——第二台看到旧 charge
    // 已够，扣完后电池被抽空但照产）
    expect(chargeOf(batteryKey)).toBe(100 - 2 * FORGE_CHARGE);
    // 冷却窗内两台都不产
    sys.update(1);
    expect(ctx.stockpile.tools ?? 0).toBe(2);
    // 冷却到期 → 两台再各产 1
    sys.update(FORGE_INTERVAL);
    expect(ctx.stockpile.tools ?? 0).toBe(4);
    expect(ctx.stockpile.wood).toBe(100 - 4 * WOOD_PER_TOOL);
    expect(chargeOf(batteryKey)).toBe(100 - 4 * FORGE_CHARGE);
  });

  it('电荷不足 → 停产不扣料（charge < forgeCharge 时不动库存）', () => {
    ctx.stockpile.wood = 100;
    const { sys, batteryKey } = setup(1, FORGE_CHARGE - 1); // 差 1 点电
    sys.update(0.1);
    expect(ctx.stockpile.tools ?? 0).toBe(0);
    expect(ctx.stockpile.wood).toBe(100); // 木未扣
    expect(chargeOf(batteryKey)).toBe(FORGE_CHARGE - 1); // 电未动
    // 补足电量 → 恢复生产
    const b = ctx.world.buildings.get(batteryKey)!;
    b.extra!.charge = FORGE_CHARGE;
    sys.update(0.1);
    expect(ctx.stockpile.tools ?? 0).toBe(1);
  });

  it('木不足 → 停（电不抽、料不扣）', () => {
    ctx.stockpile.wood = WOOD_PER_TOOL - 1; // 差 1 木
    const { sys, batteryKey } = setup(1, 100);
    sys.update(0.1);
    expect(ctx.stockpile.tools ?? 0).toBe(0);
    expect(chargeOf(batteryKey)).toBe(100); // 未抽电（先查后抽）
    // 补木 → 生产
    ctx.stockpile.wood = WOOD_PER_TOOL;
    sys.update(0.1);
    expect(ctx.stockpile.tools ?? 0).toBe(1);
  });
});