// prison 玩法包独立测试（2026-08-14：俘虏/囚笼/招降）
// 覆盖：① 垂死敌人被拖进笼子（捕获）；② 招降成功 → spawnPawn 在笼子旁（转正入伙）；
// ③ 断粮逃逸（无论是否喂过——review 修复：此前只放走"从未喂过"的囚犯，
// 喂过之后断粮的被无限关押）。
// 发现背景（review 2026-08-14）：笼子坐标用 `key % world.width` 解码新 key 编码
// （x + y*2^31），y 坐标解码成上亿假值 → 捕获距离、招降 spawn 位置全错；
// 本文件同时回归"spawn 位置 = 笼子旁 1 格"（bug 时会 spawn 到巨大坐标）。
import { describe, it, expect, beforeEach } from 'vitest';
import { makeMinCtx } from '../../sim/__tests__/helpers/minCtx';
import { PrisonSystem } from '../packs/prison';
import type { MinCtx } from '../../sim/__tests__/helpers/minCtx';

// 找一块可建笼子的空地（campfire 出生营火已被 Sim 逻辑放置前，出生圈是草地必然可建）
const findSpot = (ctx: MinCtx): { x: number; y: number } => {
  const cx = Math.floor(ctx.world.width / 2);
  const cy = Math.floor(ctx.world.height / 2);
  for (let r = 0; r < 20; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (ctx.world.placeBuilding(x, y, 'cage', 'player')) return { x, y };
      }
    }
  }
  throw new Error('找不到可建笼子的位置');
};

// 垂死敌人（hp < 25%）：构造最小合法 hostile
const dyingHostile = (x: number, y: number): object => ({
  x, y, hp: 12, maxHp: 60, targetX: 0, targetY: 0,
  name: '野猫', enemyId: 'cat', faction: 'wild', speed: 3.5, dmgPerSec: 5, loot: { item: 'ore', amount: 2 },
});

describe('prison 玩法包', () => {
  let ctx: MinCtx;
  let sys: PrisonSystem;
  let cage: { x: number; y: number };

  beforeEach(() => {
    ctx = makeMinCtx(11);
    sys = new PrisonSystem(ctx);
    sys.init();
    cage = findSpot(ctx);
  });

  it('捕获：场内垂死敌人（hp<25%）被拖进空闲囚笼并从 hostiles 移除', () => {
    ctx.hostiles.push(dyingHostile(cage.x + 3, cage.y + 1) as never);
    sys.update(1);
    expect(ctx.hostiles.length).toBe(0);
    const b = ctx.world.getBuilding(cage.x, cage.y)!;
    expect((b.extra?.captive as { name: string } | undefined)?.name).toBe('野猫');
  });

  it('招降成功 → 在笼子旁一格 spawnPawn 转正入伙（回归：笼子坐标解码必须正确）', () => {
    // 发现背景：`key % w` 旧解码把笼子 y 坐标算成上亿 → spawn 位置错到天边；
    // 断言 spawn 点 = (cage.x, cage.y+1) 让解码错误显形
    ctx.spawnPawn(20, 20); // 说服者（social 技能最高的鼠鼠；persuader===-1 时跳过招降）
    ctx.hostiles.push(dyingHostile(cage.x + 3, cage.y + 1) as never);
    ctx.rollEventSkill = () => ({ success: true, roll: 100 }); // 招降恒成功（检定语义让位）
    sys.update(1); // 捕获
    sys.update(200); // 跨过 feed 40s + convert 120s 周期
    expect(ctx._spawned.some((s) => s.x === cage.x && s.y === cage.y + 1)).toBe(true);
  });

  it('断粮逃逸：喂过之后断粮超 2 周期也逃（review 修复：此前无限关押）', () => {
    const b = ctx.world.getBuilding(cage.x, cage.y)!;
    b.extra = { captive: { enemyId: 'cat', name: '俘虏甲', capturedAt: 1000, lastFed: 1010, rolls: 0 } };
    ctx.stockpile.food = 0; // 断粮
    ctx.time = 2000;        // 距上次进食 990s >> 2×40s
    sys.update(1);
    expect(b.extra?.captive).toBeUndefined();
    expect(ctx._log.some((l) => l.includes('逃走'))).toBe(true);
  });

  it('未喂过 + 断粮超 2 周期也逃（原行为保留）', () => {
    const b = ctx.world.getBuilding(cage.x, cage.y)!;
    b.extra = { captive: { enemyId: 'cat', name: '俘虏乙', capturedAt: 1000, lastFed: -1, rolls: 0 } };
    ctx.stockpile.food = 0;
    ctx.time = 1200; // 距入狱 200s > 80s
    sys.update(1);
    expect(b.extra?.captive).toBeUndefined();
  });

  it('有粮则喂食（扣 1 food、记录 lastFed），不逃', () => {
    const b = ctx.world.getBuilding(cage.x, cage.y)!;
    b.extra = { captive: { enemyId: 'cat', name: '俘虏丙', capturedAt: 1000, lastFed: -1, rolls: 0 } };
    ctx.stockpile.food = 5;
    ctx.time = 1500;
    sys.update(1);
    expect(b.extra?.captive).toBeDefined(); // 仍在笼
    expect(ctx.stockpile.food).toBe(4);
    expect((b.extra?.captive as { lastFed: number }).lastFed).toBe(1500);
    // 记账（审计中③）：喂食是营地支出——recordSpend 入 economy 流（此前直扣不记账）
    expect(ctx._spend).toContainEqual({ eid: null, item: 'food', amount: 1 });
  });
});