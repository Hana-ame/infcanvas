// raidSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：定时袭击（猫群刷出）/ 击杀掉落（食物私有化进个人口袋）/ 袭击间隔受叙事压力缩短
import { describe, it, expect, beforeEach } from 'vitest';
import { RaidSystem } from '../../systems/raidSystem';
import { makeMinCtx } from '../helpers/minCtx';

describe('RaidSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(10);
  beforeEach(() => { ctx = makeMinCtx(10); });

  it('无敌人时按 initialRaidDelay 刷出袭击波（raid_started 事件）', () => {
    const sys = new RaidSystem(ctx);
    const eid = ctx.spawnPawn(40, 40);
    let raids = 0;
    ctx.bus.on('raid_started', () => { raids++; });
    // 跑过 initialRaidDelay（默认 90s）
    const t = ctx.tuning.combat;
    for (let i = 0; i < Math.ceil(t.initialRaidDelay) + 5; i++) sys.update(1);
    expect(raids).toBeGreaterThanOrEqual(1);
    expect(ctx.hostiles.length).toBeGreaterThan(0);
  });

  it('击杀野猫掉落食物 → 进击杀者个人口袋（私有化）', () => {
    // 采集狩猎 mod 让猫掉肉（overrideDef），验证私有化路径
    ctx.mods.overrideDef('enemy', 'cat', { loot: { item: 'food', amount: 4 } });
    const sys = new RaidSystem(ctx);
    const eid = ctx.spawnPawn(40, 40);
    // 直接放一只猫在身旁（接近 meleeRange 触发战斗）
    const t = ctx.tuning.combat;
    const cat = ctx.mods.enemies['cat'];
    ctx.hostiles.push({ x: 40.5, y: 40, hp: 10, maxHp: cat.hp, targetX: 40, targetY: 40, enemyId: 'cat', name: cat.name, speed: cat.speed, dmgPerSec: cat.dmg, loot: cat.loot });
    // 跑战斗帧直到猫死（pawnDmg * dt 每次攻击，猫 10hp 快速击杀）
    for (let i = 0; i < 50; i++) sys.update(1);
    // 猫已死且掉落食物进击杀者个人口袋
    const st = ctx._pawnStates.get(eid)!;
    expect(ctx.hostiles.length).toBe(0);
    expect((st.inventory?.['food'] ?? 0)).toBeGreaterThan(0);
    expect(ctx.stockpile.food ?? 0).toBe(0); // 私有化：不进全局
  });

  it('和平越久袭击间隔越短（叙事压力）', () => {
    const sys = new RaidSystem(ctx);
    const eid = ctx.spawnPawn(40, 40);
    const t = ctx.tuning.combat;
    // 跑过首波 + 清空敌人后，第二波间隔 < 基线间隔（压力缩短）
    for (let i = 0; i < Math.ceil(t.initialRaidDelay) + 5; i++) sys.update(1);
    // 清空当前敌人，记录清空时刻
    ctx.hostiles = [];
    let nextRaidAt = 0;
    ctx.bus.on('raid_started', () => { nextRaidAt = i; });
    let i = 0;
    for (i = 0; i < Math.ceil(t.baseInterval) + 5; i++) {
      sys.update(1);
      if (ctx.hostiles.length > 0) break;
    }
    // 第二波应比基线间隔早（peaceTime 已累积 → pressure > 1 → 间隔缩短）
    expect(i).toBeLessThan(Math.ceil(t.baseInterval));
  });
});
