// raidSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：定时袭击（猫群刷出）/ 击杀掉落（食物私有化进个人口袋）/ 袭击间隔受叙事压力缩短
// 2026-08-16 追加捕食者语义：独行 1 只 / 叼走（cause captured）+ 逃跑 / 得手消失 / 近身反击
import { describe, it, expect, beforeEach } from 'vitest';
import { RaidSystem } from '../../systems/raidSystem';
import { makeMinCtx } from '../helpers/minCtx';
import { K_DRAFTED } from '../../mods/contracts';

describe('RaidSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(10);
  beforeEach(() => { ctx = makeMinCtx(10); });

  it('无敌人时按 initialRaidDelay 刷出袭击波（raid_started 事件）', () => {
    const sys = new RaidSystem(ctx);
    ctx.spawnPawn(40, 40);
    let raids = 0;
    ctx.bus.on('raid_started', () => { raids++; });
    // 跑过 initialRaidDelay（默认 90s）
    const t = ctx.tuning.combat;
    for (let i = 0; i < Math.ceil(t.initialRaidDelay) + 5; i++) sys.update(1);
    expect(raids).toBeGreaterThanOrEqual(1);
    expect(ctx.hostiles.length).toBeGreaterThan(0);
  });

  it('击杀敌人掉落食物 → 进击杀者个人口袋（私有化）——非捕食者路径', () => {
    // 私有化语义与捕食者无关。哈基米=捕食者后不原地磨血（接触即叼走）,原"磨死野猫"场景
    // 用掠夺者(非捕食者)验证:近战对耗 → 击杀 → loot food 私有化
    ctx.mods.overrideDef('enemy', 'raider', { loot: { item: 'food', amount: 4 } });
    const sys = new RaidSystem(ctx);
    const eid = ctx.spawnPawn(40, 40);
    const raider = ctx.mods.enemies['raider'];
    ctx.hostiles.push({ x: 40.5, y: 40, hp: 10, maxHp: raider.hp, targetX: 40, targetY: 40, enemyId: 'raider', name: raider.name, speed: raider.speed, dmgPerSec: raider.dmg, loot: raider.loot });
    for (let i = 0; i < 50; i++) sys.update(1);
    const st = ctx._pawnStates.get(eid)!;
    expect(ctx.hostiles.length).toBe(0);
    expect((st.inventory?.['food'] ?? 0)).toBeGreaterThan(0); // 私有化：进击杀者口袋
    expect(ctx.stockpile.food ?? 0).toBe(0);                   // 不进全局
  });

  it('和平越久袭击间隔越短（叙事压力）', () => {
    const sys = new RaidSystem(ctx);
    ctx.spawnPawn(40, 40);
    const t = ctx.tuning.combat;
    // 跑过首波 + 清空敌人后，第二波间隔 < 基线间隔（压力缩短）
    for (let i = 0; i < Math.ceil(t.initialRaidDelay) + 5; i++) sys.update(1);
    // 清空当前敌人，记录清空时刻
    ctx.hostiles = [];
    let i = 0;
    for (; i < Math.ceil(t.baseInterval) + 5; i++) {
      sys.update(1);
      if (ctx.hostiles.length > 0) break;
    }
    // 第二波应比基线间隔早（peaceTime 已累积 → pressure > 1 → 间隔缩短）
    expect(i).toBeLessThan(Math.ceil(t.baseInterval));
  });

  it('捕食者独行:一波只刷 1 只猫（不随人口/压力成群）', () => {
    const sys = new RaidSystem(ctx);
    ctx.spawnPawn(96, 96);
    let count = 0;
    ctx.bus.on('raid_started', (ev) => { count = (ev as { count: number }).count; });
    const t = ctx.tuning.combat;
    for (let i = 0; i < Math.ceil(t.initialRaidDelay) + 5; i++) sys.update(1);
    expect(count).toBe(1);          // raid_started count = 1（独行）
    expect(ctx.hostiles.length).toBe(1);
  });

  it('捕食者接触鼠 → 叼走（pawn_died cause captured）+ 逃跑朝向远离营地', () => {
    const sys = new RaidSystem(ctx);
    // 鼠放营地中心(96,96)附近:得手判定以营地中心为基准,离中心太远猫叼完立即消失
    const eid = ctx.spawnPawn(96, 96);
    const cat = ctx.mods.enemies['cat'];
    let cause = '';
    ctx.bus.on('pawn_died', (ev) => { cause = (ev as { cause?: string }).cause ?? ''; });
    // 猫放鼠旁(≤ captureRange)。DEX 闪避会跳帧,循环直到叼走(猫速 6.5,鼠不动,必抓到)
    ctx.hostiles.push({ x: 96.6, y: 96, hp: 50, maxHp: cat.hp, targetX: 96, targetY: 96, enemyId: 'cat', name: cat.name, speed: cat.speed, dmgPerSec: cat.dmg, loot: cat.loot });
    for (let i = 0; i < 10 && !ctx._killed.includes(eid) && ctx.hostiles.length > 0; i++) sys.update(1);
    expect(ctx._killed.includes(eid)).toBe(true); // 捕获 = killPawn 被调用(minCtx 桩记 _killed)
    expect(cause).toBe('captured');
    // 猫在 (96.6,96) 捕获:d=0.6 → 逃跑方向 dx≈0.6/0.6=1(朝右/远离中心),dy≈0
    const h = ctx.hostiles[0];
    expect(h.carried).toBeTruthy();
    expect(h.carried!.dirX).toBeGreaterThan(0);
  });

  it('叼走后跑离营地 captureFleeDist → 猫消失（得手）,全程不拆家不磨血', () => {
    const sys = new RaidSystem(ctx);
    ctx.spawnPawn(96, 96);
    ctx.world.placeBuilding(96, 99, 'wall', 'player'); // 墙在猫逃跑路线附近:捕食者不拆家
    const wallBefore = [...ctx.world.buildings.keys()].length;
    const cat = ctx.mods.enemies['cat'];
    ctx.hostiles.push({ x: 96.6, y: 96, hp: 50, maxHp: cat.hp, targetX: 96, targetY: 96, enemyId: 'cat', name: cat.name, speed: cat.speed, dmgPerSec: cat.dmg, loot: cat.loot });
    // 捕获(容忍闪避帧) → 逃跑:cat speed 8×1.5≈12/帧,96→离中心 ≥32 需 ~4 帧
    for (let i = 0; i < 60 && ctx.hostiles.length > 0; i++) sys.update(1);
    expect(ctx.hostiles.length).toBe(0);                    // 得手消失
    expect([...ctx.world.buildings.keys()].length).toBe(wallBefore); // 没拆墙
  });

  it('近身反击:捕食者冲向鼠时被自动近身反击砍死（不叼人）', () => {
    const sys = new RaidSystem(ctx);
    // 猫放鼠 meleeRange(3) 内、captureRange(1.5) 外（约 2.5 格：在反击圈内又没到叼人距离）:鼠恰好能砍,猫还叼不到
    const eid = ctx.spawnPawn(96, 96);
    const t = ctx.tuning.combat;
    const cat = ctx.mods.enemies['cat'];
    ctx.hostiles.push({ x: 96 + t.captureRange + 1, y: 96, hp: 5, maxHp: cat.hp, targetX: 96, targetY: 96, enemyId: 'cat', name: cat.name, speed: cat.speed, dmgPerSec: cat.dmg, loot: cat.loot });
    // 非征召自动反击 = pawnDmg(5) × predatorReactionMul(0.25) = 1.25/帧 → 5hp 需 5 帧
    for (let i = 0; i < 6; i++) sys.update(1);
    expect(ctx.hostiles.length).toBe(0);           // 猫被砍死
    expect(ctx._killed.includes(eid)).toBe(false); // 鼠没被叼（反击在先,猫先死）
  });

  it('捕食者近身反击：自动减半、征召全伤（2026-08-16 战斗平衡——指挥有真实价值）', () => {
    const sys = new RaidSystem(ctx);
    const eid = ctx.spawnPawn(96, 96);
    const t = ctx.tuning.combat;
    const cat = ctx.mods.enemies['cat'];
    ctx.hostiles.push({ x: 96 + t.captureRange + 1, y: 96, hp: 100, maxHp: cat.hp, targetX: 96, targetY: 96, enemyId: 'cat', name: cat.name, speed: cat.speed, dmgPerSec: cat.dmg, loot: cat.loot });
    // 非征召鼠：自动近身反击 = pawnDmg × predatorReactionMul(0.25) = 2/帧
    sys.update(1);
    expect(ctx.hostiles[0]!.hp).toBeCloseTo(100 - t.pawnDmg * t.predatorReactionMul, 5);
    // 征召鼠（K_DRAFTED）：全伤 = pawnDmg = 8/帧
    const st = ctx.pawnStates.get(eid)!;
    st.extra = { ...(st.extra ?? {}), [K_DRAFTED]: true };
    sys.update(1);
    expect(ctx.hostiles[0]!.hp).toBeCloseTo(100 - t.pawnDmg * t.predatorReactionMul - t.pawnDmg, 5);
  });
});
