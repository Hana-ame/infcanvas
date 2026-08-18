// 驯兽守卫 DLC 测试（2026-08-16）：命令测试用完整 Sim（捉 registry 命令注册），
// 系统推进用最小 ctx（手动设 taming 状态，跳过命令层）
import { describe, it, expect, beforeEach } from 'vitest';
import { Sim } from '../../sim/sim';
import { ModRegistry } from '../../sim/mods/registry';
import { BeastTamingSystem, beastTamingPack } from '../packs/beastTaming';
import { makeMinCtx } from '../../sim/__tests__/helpers/minCtx';
import { pushHostile } from '../../sim/systems/hostiles';
import { ENEMIES } from '../../sim/defs/enemies';
import { validateContracts } from '../../sim/mods/contracts';

// 创建一个带 beast-taming 的完整 Sim（命令面、系统推进全活性）
const makeSim = (seed = 41, pawns = 2) => {
  const mods = ModRegistry.default();
  mods.mount(beastTamingPack);
  return new Sim({ seed, pawnCount: pawns, registry: mods });
};

describe('驯兽守卫 DLC（beast-taming，2026-08-16）', () => {
  it('① 装配 + validateContracts 契约校验通过', () => {
    const mods = ModRegistry.default();
    mods.mount(beastTamingPack);
    const sim = new Sim({ seed: 42, pawnCount: 2, registry: mods });
    expect(sim.systemIds).toContain('beastTaming');
    expect(validateContracts(mods)).toEqual([]);
  });

  it('② tame 命令：拒满血猫 / 拒非 cat 敌人', () => {
    const sim = makeSim(42);
    sim.hostiles.push({ x: 0, y: 0, hp: 100, maxHp: 100, targetX: 0, targetY: 0, enemyId: 'raider' });
    sim.issueCommand({ type: 'tame', x: 0, y: 0, args: { hostileIndex: 0 } });
    expect(sim.hostiles[0]!.taming).toBeUndefined();
    // 满血 cat
    sim.hostiles.push({ x: 15, y: 15, hp: 40, maxHp: 40, targetX: 0, targetY: 0, enemyId: 'cat', name: '野猫', faction: 'wild', speed: 3.5, dmgPerSec: 5, loot: { item: 'ore', amount: 2 } });
    sim.issueCommand({ type: 'tame', x: 0, y: 0, args: { hostileIndex: 1 } });
    expect(sim.hostiles[1]!.taming).toBeUndefined();
    // 重伤 cat → 可驯
    sim.hostiles[1]!.hp = 5;
    sim.issueCommand({ type: 'tame', x: 0, y: 0, args: { hostileIndex: 1 } });
    expect(sim.hostiles[1]!.taming).toBeDefined();
    expect(sim.hostiles[1]!.taming!.progress).toBe(0);
  });

  it('③ 驯化推进：投喂消耗 food + 缺粮停滞', () => {
    const ctx = makeMinCtx(43);
    const sys = new BeastTamingSystem(ctx);
    sys.init?.();
    pushHostile(ctx, ENEMIES.cat, 10, 10);
    ctx.hostiles[0]!.hp = 5;
    // 手动设 taming（跳过命令层，直接测系统推进）
    const tamer = ctx.spawnPawn(10, 10); // 驯养人（eid 在 minCtx 中从 9000 起）
    ctx.hostiles[0]!.taming = { progress: 0, tamer };
    // 缺粮停滞
    ctx.stockpile.food = 0;
    sys.update(2);
    expect(ctx.hostiles[0]!.taming!.progress).toBe(0);
    expect(ctx.stockpile.food).toBe(0);
    // 有粮推进
    ctx.stockpile.food = 10;
    sys.update(2);
    expect(ctx.hostiles[0]!.taming!.progress).toBeGreaterThan(0);
    expect(ctx.stockpile.food).toBeLessThan(10);
  });

  it('④ 驯化中 cat 在 raidSystem 中不移动/不攻击（完整 Sim 集成）', () => {
    const sim = makeSim(44, 2);
    sim.hostiles.push({
      x: 50, y: 50, hp: 5, maxHp: 40, targetX: 0, targetY: 0,
      enemyId: 'cat', name: '野猫', faction: 'wild', speed: 3.5, dmgPerSec: 5, loot: { item: 'ore', amount: 2 },
    });
    sim.issueCommand({ type: 'tame', x: 0, y: 0, args: { hostileIndex: 0 } });
    expect(sim.hostiles[0]!.taming).toBeDefined();
    const x0 = sim.hostiles[0]!.x, y0 = sim.hostiles[0]!.y;
    for (let i = 0; i < 30; i++) sim.step(0.1);
    expect(sim.hostiles[0]!.x).toBeCloseTo(x0, 0);
    expect(sim.hostiles[0]!.hp).toBe(5);
  });

  it('⑤ 驯服成功 → faction player（营地守卫）', () => {
    const ctx = makeMinCtx(45);
    const sys = new BeastTamingSystem(ctx);
    sys.init?.();
    pushHostile(ctx, ENEMIES.cat, 10, 10);
    ctx.hostiles[0]!.hp = 5;
    ctx.stockpile.food = 20;
    const tamer = ctx.spawnPawn(10, 10);
    ctx.hostiles[0]!.taming = { progress: 19, tamer }; // 近满
    sys.update(2); // 最后一段推进
    expect(ctx.hostiles[0]!.faction).toBe('player');
    expect(ctx.hostiles[0]!.taming).toBeUndefined();
    expect(ctx.hostiles[0]!.owner).toBe(tamer);
  });

  it('⑥ release 命令：中止驯化 / 放归守卫', () => {
    const sim = makeSim(46);
    sim.hostiles.push({ x: 0, y: 0, hp: 5, maxHp: 40, targetX: 0, targetY: 0, enemyId: 'cat', name: '野猫', faction: 'wild', speed: 3.5, dmgPerSec: 5, loot: { item: 'ore', amount: 2 } });
    sim.issueCommand({ type: 'tame', x: 0, y: 0, args: { hostileIndex: 0 } });
    expect(sim.hostiles[0]!.taming).toBeDefined();
    sim.issueCommand({ type: 'release', x: 0, y: 0, args: { hostileIndex: 0 } });
    expect(sim.hostiles[0]!.taming).toBeUndefined();
    // 守卫放归
    sim.hostiles[0]!.faction = 'player';
    sim.hostiles[0]!.owner = 1;
    sim.issueCommand({ type: 'release', x: 0, y: 0, args: { hostileIndex: 0 } });
    expect(sim.hostiles[0]!.faction).toBe('');
    expect(sim.hostiles[0]!.owner).toBeUndefined();
  });

  it('⑦ cmdValidate 形状校验（tame/release 的 hostileIndex 范围）', async () => {
    const vmod = await import('../../server/cmdValidate');
    const sim = makeSim(47);
    const guard: import('../../server/cmdValidate').CmdGuardState = { lastCmdAt: 0, budget: 30 };
    const v = (cmd: unknown) => vmod.validateCommand(sim, cmd, guard, Date.now()).ok;
    sim.hostiles.push({ x: 0, y: 0, hp: 1, maxHp: 100, targetX: 0, targetY: 0, enemyId: 'cat' });
    expect(v({ type: 'tame', x: 0, y: 0, pawnId: sim.pawns[0], args: { hostileIndex: 0 } })).toBe(true);
    expect(v({ type: 'release', x: 0, y: 0, args: { hostileIndex: 0 } })).toBe(true);
    expect(v({ type: 'tame', x: 0, y: 0, args: { hostileIndex: 5 } })).toBe(false);
    expect(v({ type: 'release', x: 0, y: 0, args: { hostileIndex: -1 } })).toBe(false);
  });

  it('⑧ 卸载安全：默认注册表不含 beast-taming → tame 命令不被认识（日志不崩）', () => {
    const sim = new Sim({ seed: 48, pawnCount: 1 });
    sim.issueCommand({ type: 'tame', x: 0, y: 0, args: { hostileIndex: 0 } });
  });
});