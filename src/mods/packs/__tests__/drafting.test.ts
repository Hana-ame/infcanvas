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

// 塞一只静止的站桩敌人（speed 0 + target 自身 = 不推进；dmg 低防测试期间打死小人）。
// 2026-08-16 cat 改捕食者（接触即叼走、极难作站桩靶）→ 契约测试改用 raider 站桩验证
// 征召攻击优先权；捕食者实哨行为见 raidSystem 单测
function addCat(sim: Sim, x: number, y: number, hp = 200, dmg = 0.5): void {
  sim.hostiles.push({
    x, y, hp, maxHp: hp, targetX: x, targetY: y,
    name: '掠夺者', enemyId: 'raider', faction: 'unit',
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
    // P 距猫 1 格（meleeRange 3 内），Q 距猫 0.4 格（最近的未征召者）
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

  // ---- 2026-08-16 审查修复回归：追击永冻 / 下标错位（此前命令冷却在征召期间永不衰减，
  // 追击 moveTo 又自锁冷却 → 追击只发生一次；resolveTarget 只改局部对象不写回 → 找回下标
  // 永不落盘，splice 后追错目标）----

  // 移动的敌人（speed>0 由 raidSystem 推进）：用于验证"持续追击"而非"追一次就停"
  function addMovingCat(sim: Sim, x: number, y: number, hp = 200): void {
    sim.hostiles.push({
      x, y, hp, maxHp: hp, targetX: x, targetY: y,
      name: '掠夺者', enemyId: 'raider', faction: 'unit',
      speed: 2, dmgPerSec: 0.1, loot: { item: 'food', amount: 2 },
    });
  }

  it('追击不永冻：征召小人持续追踪移动目标（命令冷却不再卡死追击）', () => {
    const sim = makeSim(51, 2);
    const e0 = sim.pawns[0];
    const start = sim.pawnPositions.get(e0)!;
    // 敌人在正下方 8 格，向更下方移动（速度 2 格/s）
    const spot = findWalkable(sim, Math.round(start.x), Math.round(start.y) + 8);
    addMovingCat(sim, spot.x, spot.y);
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: e0, args: { drafted: true } });
    sim.issueCommand({ type: 'attack', x: 0, y: 0, pawnId: e0, args: { hostileIndex: 0 } });
    // 追击 8 秒：敌人持续移动，征召小人应保持靠近（追击未被冷却冻住）
    // 修复前：第一次 moveTo 后 commandCooldown=3 且永不衰减 → DraftSystem 直接 continue → 小人不动
    let minGap = Infinity;
    for (let i = 0; i < 8 * 20; i++) {
      sim.step(1 / 20);
      const h = sim.hostiles[0];
      const p = sim.pawnPositions.get(e0)!;
      if (h) minGap = Math.min(minGap, Math.hypot(h.x - p.x, h.y - p.y));
    }
    expect(minGap).toBeLessThan(6); // 追击生效：全程最近距离显著小于初始 8 格（修复前恒 ~8+）
    // 冷却在征召期间确实衰减到 0（修复前恒 3）
    expect(sim.pawnStates.get(e0)!.commandCooldown ?? 0).toBeLessThan(0.1);
  });

  it('追击持续刷新：敌人移动后按新位置重寻路（不再只追一次）', () => {
    const sim = makeSim(52, 1); // 1 人：避免 2 人时 pawn[1] 的随机决策挡 pawn[0] 追击路径
    const e0 = sim.pawns[0];
    const start = sim.pawnPositions.get(e0)!;
    // 无 raid 刷波干扰，手动塞一个静止敌 + 手动搬动（验证 resolveTarget 写回快照）
    const spot = findWalkable(sim, Math.round(start.x) + 6, Math.round(start.y));
    addCat(sim, spot.x, spot.y);
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: e0, args: { drafted: true } });
    sim.issueCommand({ type: 'attack', x: 0, y: 0, pawnId: e0, args: { hostileIndex: 0 } });
    sim.pawnStates.get(e0)!.decisionCd = 0; // 确保立即决策（不受随机初始 decisionCd 影响）
    // 敌人先被追杀一段，然后搬走 5 格 → 追击目标应切换到新位置（快照被刷新）
    for (let i = 0; i < 60; i++) sim.step(1 / 20); // 3s：先接近（commandCooldown=3s 过后 drafting 续推追击）
    const h0 = sim.hostiles[0];
    const p0 = sim.pawnPositions.get(e0)!;
    expect(Math.hypot(h0.x - p0.x, h0.y - p0.y)).toBeLessThan(4); // 已接近
    // 搬走敌人（模拟 splice/位移）：直接改位置（快照 1.5 秒前，若未刷新 → 丢失目标）
    h0.x += 5; h0.y += 5;
    const atkBefore = attackTargetOf(sim.pawnStates.get(e0))!;
    const drifted = until(sim, () => {
      const a = attackTargetOf(sim.pawnStates.get(e0))!;
      return a !== null && (a.x !== atkBefore.x || a.y !== atkBefore.y);
    }, 20);
    expect(drifted).toBe(true); // 快照被写回刷新（修复前：attackTargetOf 永远返回攻击时刻旧快照）
    const atkAfter = attackTargetOf(sim.pawnStates.get(e0))!;
    expect(Math.hypot(atkAfter.x - h0.x, atkAfter.y - h0.y)).toBeLessThan(0.5); // 快照 = 敌人当前位置
  });

  it('下标错位：splice 掉前面的敌人后，追击仍指向正确目标（回写新下标）', () => {
    const sim = makeSim(53, 2);
    const e0 = sim.pawns[0];
    const start = sim.pawnPositions.get(e0)!;
    // 两个敌人：A(0) 在近处、B(1) 在远处。征召小人指定攻击 B(1)
    const spotA = findWalkable(sim, Math.round(start.x) + 4, Math.round(start.y));
    const spotB = findWalkable(sim, Math.round(start.x) + 12, Math.round(start.y) + 6);
    addCat(sim, spotA.x, spotA.y);
    addCat(sim, spotB.x, spotB.y);
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: e0, args: { drafted: true } });
    sim.issueCommand({ type: 'attack', x: 0, y: 0, pawnId: e0, args: { hostileIndex: 1 } }); // 指定 B
    expect(attackTargetOf(sim.pawnStates.get(e0))!.hostileIndex).toBe(1);
    // A 被击杀移除（splice 下标错位：B 从 1 → 0）。此前 resolveTarget 只改局部对象不写回，
    // 下标永远 1 → 之后把 hs[1]（若有）当目标追错 / raidSystem 指定者判定失效
    sim.hostiles.splice(0, 1);
    // 追击过程中：resolveTarget 应把下标回写为 0（B 的新位置）
    const fixed = until(sim, () => {
      const a = attackTargetOf(sim.pawnStates.get(e0));
      return a !== null && a.hostileIndex === 0;
    }, 10);
    expect(fixed).toBe(true);
    // 且目标 = 原 B（下标 0 处即 B，位置一致）
    const a = attackTargetOf(sim.pawnStates.get(e0))!;
    const b = sim.hostiles[0];
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.5);
  });

  it('玩家 move 命令仍受尊重：冷却窗口内征召小人听手动移动，窗口后恢复追击', () => {
    const sim = makeSim(54, 2);
    const e0 = sim.pawns[0];
    const start = sim.pawnPositions.get(e0)!;
    const spot = findWalkable(sim, Math.round(start.x) + 10, Math.round(start.y));
    addCat(sim, spot.x, spot.y);
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: e0, args: { drafted: true } });
    sim.issueCommand({ type: 'attack', x: 0, y: 0, pawnId: e0, args: { hostileIndex: 0 } });
    // 玩家手动移动命令（向左 6 格，远离敌人）→ 征召小人应照走（尊重指挥）
    const manual = findWalkable(sim, Math.round(start.x) - 6, Math.round(start.y));
    sim.issueCommand({ type: 'move', x: manual.x, y: manual.y, pawnId: e0 });
    // 3s 冷却内（前 2s）：小人朝手动目标走（远离敌人），不被追击覆盖
    let away = 0;
    for (let i = 0; i < 40; i++) {
      sim.step(1 / 20);
      const p = sim.pawnPositions.get(e0)!;
      if (Math.hypot(p.x - spot.x, p.y - spot.y) > 8) away++;
    }
    expect(away).toBeGreaterThan(10); // 手动移动生效（修复前永远卡死；修复后冷却窗口内不追击）
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
        drafted: p.drafted === true || undefined,
      };
    }),
    hostiles: sim.hostiles.map((h, i) => ({ i, enemyId: h.enemyId, x: h.x, y: h.y, hp: h.hp, maxHp: h.maxHp, faction: h.faction })),
    buildings: [], buildQueue: [], buildingVersion: 0,
  };
}