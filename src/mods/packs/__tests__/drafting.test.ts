// 征召战斗玩法包（drafting）测试（RW-1 M2，2026-08-15）
// 覆盖 required 8 项：征召不自主 / 解除征召恢复自主 / 攻击=移动+伤害 / 指定攻击优先于自动
// 索敌 / 玩家移动命令对征召小人仍有效 / 存档往返（drafted + attackTarget）/ 远程 snapshot+
// delta 携带 drafted / cmdValidate 拒绝非法 pawnId 与 hostileIndex。附：被动衰减不豁免。
// 战斗断言依赖 raidSystem 结算（伤害/闪避公式不复制、不重测——本文件只测"指挥语义"）。
import { describe, it, expect } from 'vitest';
import { Sim } from '../../../sim/sim';
import { ModRegistry } from '../../../sim/mods/registry';
import { buildDelta } from '../../../server/diff';
import type { SnapshotMsg } from '../../../shared/protocol';
import { validateCommand, type CmdGuardState } from '../../../server/cmdValidate';
import { draftedOf, attackTargetOf, setDrafted, setAttackTarget, clearAttackTarget } from '../drafting';
import { K_DRAFTED } from '../../../sim/mods/contracts';

function makeSim(seed = 41, pawnCount = 2): Sim {
  return new Sim({ seed, pawnCount, registry: ModRegistry.default() });
}

function until(sim: Sim, cond: () => boolean, maxSec = 60): boolean {
  for (let i = 0; i < maxSec * 20; i++) {
    if (cond()) return true;
    sim.step(1 / 20);
  }
  return cond();
}

// 找一块可走动的空地（画布/营地附近；敌袭/追击寻路需要可达目标）
function findWalkable(sim: Sim, nearX: number, nearY: number): { x: number; y: number } {
  const w = sim.world;
  const climb = sim.tuning.pawn.climb;
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = nearX + dx, y = nearY + dy;
        if (!w.inBounds(x, y)) continue;
        if (!w.isPassable(x, y, undefined, climb)) continue;
        if (Math.abs(dx) + Math.abs(dy) > r) continue;
        return { x, y };
      }
    }
  }
  throw new Error('找不到可走动空地');
}

// 塞一只静止野猫（speed 0 + target 自身 = 不推进；dmg 低防测试期间打死小人）
function addCat(sim: Sim, x: number, y: number, hp = 200, dmg = 0.5): void {
  sim.hostiles.push({
    x, y, hp, maxHp: hp, targetX: x, targetY: y,
    name: '野猫', enemyId: 'cat', faction: 'cat',
    speed: 0, dmgPerSec: dmg, loot: { item: 'food', amount: 2 },
  });
}

describe('drafting 玩法包（征召战斗，RW-1 M2）', () => {
  it('默认装配包含 drafting 系统 + draft/attack 命令', () => {
    const sim = makeSim();
    expect(sim.systemIds).toContain('drafting');
    expect(sim.mods.commandHandlers.has('draft')).toBe(true);
    expect(sim.mods.commandHandlers.has('attack')).toBe(true);
  });

  it('征召中：不自主抽卡/工作/休闲（保持站位待命），被动衰减不豁免', () => {
    const sim = makeSim(41, 2);
    const e0 = sim.pawns[0];
    const start = sim.pawnPositions.get(e0)!;
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: e0, args: { drafted: true } });
    // 极端饥饿/困倦：若在自主决策，早就去吃了/睡了
    const n = sim.readNeeds(e0)!;
    n.food = 8; n.rest = 8;
    sim.setNeeds(e0, n);
    const food0 = sim.readNeeds(e0)!.food;
    // 被动衰减：foodDecay ≈ 0.15/s，10+ 秒必降（不豁免；若豁免则永不降）
    const ran = until(sim, () => sim.readNeeds(e0)!.food < food0 - 1, 20);
    expect(ran).toBe(true); // 被动衰减照跑（不豁免）
    expect(sim.pawnProfile(e0)?.job).toBe('待命'); // 不自主 = 只待命
    // 位置纹丝不动（无敌人时不被拉走）
    const now = sim.pawnPositions.get(e0)!;
    expect(Math.hypot(now.x - start.x, now.y - start.y)).toBeLessThan(0.5);
    // 饥饿没被"吃"回来（自主进食被门挡住）
    expect(sim.readNeeds(e0)!.food).toBeLessThan(food0);
  });

  it('解除征召：恢复自主行事（不再只是待命）', () => {
    const sim = makeSim(42, 2);
    const e0 = sim.pawns[0];
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: e0, args: { drafted: true } });
    for (let i = 0; i < 20; i++) sim.step(1 / 20);
    expect(sim.pawnProfile(e0)?.job).toBe('待命');
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: e0, args: { drafted: false } });
    const resumed = until(sim, () => sim.pawnProfile(e0)?.job !== '待命', 40);
    expect(resumed).toBe(true);
    expect(draftedOf(sim.pawnStates.get(e0))).toBe(false);
  });

  it('征召中仍听玩家移动命令（move 照走）', () => {
    const sim = makeSim(43, 2);
    const e0 = sim.pawns[0];
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: e0, args: { drafted: true } });
    const start = sim.pawnPositions.get(e0)!;
    const dst = findWalkable(sim, Math.round(start.x) + 6, Math.round(start.y));
    sim.issueCommand({ type: 'move', x: dst.x, y: dst.y, pawnId: e0 });
    const moved = until(sim, () => {
      const p = sim.pawnPositions.get(e0)!;
      return Math.hypot(p.x - dst.x, p.y - dst.y) < 1.5;
    }, 30);
    expect(moved).toBe(true);
    // 走到后仍是被征召的待命态（没有被自主活动接管）
    expect(sim.pawnProfile(e0)?.job).toBe('待命');
    expect(draftedOf(sim.pawnStates.get(e0))).toBe(true);
  });

  it('attack 命令：移动到目标附近并产生伤害（不复制战斗公式）', () => {
    const sim = makeSim(44, 2);
    const e0 = sim.pawns[0];
    const start = sim.pawnPositions.get(e0)!;
    const spot = findWalkable(sim, Math.round(start.x) + 8, Math.round(start.y) + 8);
    addCat(sim, spot.x, spot.y);
    const d0 = Math.hypot(spot.x - start.x, spot.y - start.y);
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: e0, args: { drafted: true } });
    sim.issueCommand({ type: 'attack', x: 0, y: 0, pawnId: e0, args: { hostileIndex: 0 } });
    expect(attackTargetOf(sim.pawnStates.get(e0))?.hostileIndex).toBe(0);
    // 移动 + 交战：小人靠近目标，野猫 hp 被 raidSystem 结算打掉（或已击杀移除）
    const fought = until(sim, () => {
      const cat = sim.hostiles[0];
      const p = sim.pawnPositions.get(e0)!;
      const closer = Math.hypot(spot.x - p.x, spot.y - p.y) < d0 * 0.5;
      return closer && (cat === undefined || cat.hp < 200);
    }, 45);
    expect(fought).toBe(true);
  });

  it('指定攻击优先于自动索敌（更近的未征召小人不抢指定者的目标）', () => {
    const sim = makeSim(45, 2);
    const eP = sim.pawns[0]; // 征召指定者（较远）
    const eQ = sim.pawns[1]; // 未征召（更近）
    const cx = Math.round(sim.world.width / 2);
    const cy = Math.round(sim.world.height / 2);
    const spot = findWalkable(sim, cx, cy);
    addCat(sim, spot.x, spot.y);
    // P 距猫 1 格（meleeRange 5 内），Q 距猫 0.4 格（最近的未征召者）
    sim.setPosition(eP, { x: spot.x - 1, y: spot.y });
    sim.setPosition(eQ, { x: spot.x + 0.4, y: spot.y });
    sim.setNeeds(eQ, { ...sim.readNeeds(eQ)!, food: 100, rest: 100 });
    sim.setNeeds(eP, { ...sim.readNeeds(eP)!, food: 100, rest: 100 });
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: eP, args: { drafted: true } });
    // 指定目标 = 下标 0
    sim.issueCommand({ type: 'attack', x: 0, y: 0, pawnId: eP, args: { hostileIndex: 0 } });
    // 出生技能非零（随机天赋）：记基线，断言"指定者增长、未征召者零增长"
    const p0 = sim.pawnProfile(eP)?.skills.fight ?? 0;
    const q0 = sim.pawnProfile(eQ)?.skills.fight ?? 0;
    // 交战几秒：指定者（P）接敌涨战斗经验；更近的 Q（未征召）不参战（技能零增长——
    // 即便 Q 闲逛路过猫旁边，指定者的优先权也不让它抢）
    const engaged = until(sim, () => (sim.pawnProfile(eP)?.skills.fight ?? 0) > p0 + 1, 25);
    expect(engaged).toBe(true);
    expect(sim.pawnProfile(eQ)?.skills.fight ?? 0).toBe(q0);
  });

  it('存档往返：drafted + attackTarget 随档保留', () => {
    const simA = makeSim(46, 1);
    const st = simA.pawnStates.get(simA.pawns[0])!;
    const spot = findWalkable(simA, Math.round(simA.world.width / 2), Math.round(simA.world.height / 2));
    addCat(simA, spot.x, spot.y);
    setDrafted(st, true);
    setAttackTarget(st, 0, spot.x, spot.y);
    const saved = simA.save();
    const simB = makeSim(47, 1);
    simB.load(saved as never);
    const stB = simB.pawnStates.get(simB.pawns[0])!;
    expect(stB.extra?.[K_DRAFTED]).toBe(true);
    const atk = attackTargetOf(stB)!;
    expect(atk.hostileIndex).toBe(0);
    expect(atk.x).toBe(spot.x);
    expect(atk.y).toBe(spot.y);
    // 解除征召清攻击指定（语义联动）
    clearAttackTarget(stB);
    expect(attackTargetOf(stB)).toBeNull();
  });

  it('远程 snapshot + delta 携带 drafted 状态', () => {
    const sim = makeSim(48, 1);
    const eid = sim.pawns[0];
    const snap1 = buildSnapshotLike(sim);
    setDrafted(sim.pawnStates.get(eid)!, true);
    const snap2 = buildSnapshotLike(sim);
    const delta = buildDelta(snap1, snap2)!;
    const pd = delta.pawns!.find((p) => p.eid === eid)!;
    expect(pd.drafted).toBe(true);
    expect((snap2.pawns.find((p) => p.eid === eid) as { drafted?: boolean }).drafted).toBe(true);
    // 解除 → delta 再发 drafted:false（归一回 undefined 与未征召区分：diff 端归一）
    setDrafted(sim.pawnStates.get(eid)!, false);
    const snap3 = buildSnapshotLike(sim);
    const delta2 = buildDelta(snap2, snap3)!;
    const pd2 = delta2.pawns!.find((p) => p.eid === eid)!;
    expect(pd2.drafted).toBe(false);
  });

  it('cmdValidate：拒绝非法 pawnId / hostileIndex / drafted 类型', () => {
    const sim = makeSim(49, 1);
    const eid = sim.pawns[0];
    const guard: CmdGuardState = { lastCmdAt: 0, budget: 30 };
    const v = (cmd: unknown) => validateCommand(sim, cmd, guard, Date.now()).ok;
    expect(v({ type: 'draft', x: 0, y: 0, pawnId: eid, args: { drafted: true } })).toBe(true);
    expect(v({ type: 'draft', x: 0, y: 0, pawnId: eid + 99, args: { drafted: true } })).toBe(false); // 坏 pawnId
    expect(v({ type: 'draft', x: 0, y: 0, pawnId: eid, args: { drafted: 'yes' } })).toBe(false);   // drafted 非布尔
    expect(v({ type: 'attack', x: 0, y: 0, pawnId: eid + 99, args: { hostileIndex: 0 } })).toBe(false); // 坏 pawnId
    expect(v({ type: 'attack', x: 0, y: 0, pawnId: eid, args: { hostileIndex: 5 } })).toBe(false);      // 越界（无敌人）
    expect(v({ type: 'attack', x: 0, y: 0, pawnId: eid, args: { hostileIndex: 0 } })).toBe(false);      // 无敌人时 0 也越界
    addCat(sim, 5, 5);
    expect(v({ type: 'attack', x: 0, y: 0, pawnId: eid, args: { hostileIndex: 0 } })).toBe(true);       // 有敌人后合法
    expect(v({ type: 'attack', x: 0, y: 0, pawnId: eid, args: { hostileIndex: -1 } })).toBe(false);     // 负下标
  });
});

// 最小化 server buildSnapshot 的 pawns 形状（diff 需要 SnapshotMsg pawns；drafted 透传）
function buildSnapshotLike(sim: Sim): SnapshotMsg {
  return {
    type: 'snapshot', t: sim.time, paused: false, speed: 1, isNight: false, day: 1,
    weather: { raining: false, temperature: 18 },
    stockpile: { ...sim.stockpile },
    pawns: sim.pawns.map((eid) => {
      const p = sim.pawnProfile(eid)!;
      return {
        eid,
        x: p.pos.x, y: p.pos.y,
        hp: p.health?.hp ?? 0, maxHp: p.health?.maxHp ?? 1,
        job: p.job, assignedJob: p.assignedJob,
        needs: p.needs ?? undefined,
        faith: p.faith,
        attrs: { str: p.dna.str, con: p.dna.con, siz: p.dna.siz, dex: p.dna.dex, int: p.dna.int, pow: p.dna.pow, app: p.dna.app, edu: p.dna.edu },
        skills: { ...p.skills },
        traits: p.dna.traits, maxSlots: p.dna.maxSlots,
        slots: p.slots.filter((c) => c !== null).map((c) => ({ id: c!.id, name: c!.name })),
        desires: p.desires,
        lastDecision: p.lastDecision ? { ...p.lastDecision } : undefined,
        worn: '',
        workPriorities: p.workPriorities,
        drafted: p.drafted === true || undefined,
      };
    }),
    hostiles: sim.hostiles.map((h, i) => ({ i, enemyId: h.enemyId, x: h.x, y: h.y, hp: h.hp, maxHp: h.maxHp, faction: h.faction })),
    buildings: [], buildQueue: [], buildingVersion: 0,
  };
}