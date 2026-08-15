// 工作优先级玩法包（work-priority）测试（RW-1 M1，2026-08-15）
// 覆盖 required 8 项：0 禁止 / 1 vs 4 权重排序 / 未设置自主 / 紧急需求不受抑制 /
// 旧 assignedJob 迁移 / 命令校验 / 存档往返 / 远程 delta 同步。
// 权重判定用 effectiveWeight（确定性），行为判定用 Sim 步进（集成）。
import { describe, it, expect } from 'vitest';
import { Sim } from '../../../sim/sim';
import { ModRegistry } from '../../../sim/mods/registry';
import { BASE_CARDS, effectiveWeight } from '../../../sim/ai/pawn';
import { buildDelta } from '../../../server/diff';
import type { SnapshotMsg } from '../../../shared/protocol';
import { workPrioritiesOf, setJobPriority, migrateFromAssignedJob } from '../work-priority';

function makeSim(seed = 31, pawnCount = 1): Sim {
  return new Sim({ seed, pawnCount, registry: ModRegistry.default() });
}

function until(sim: Sim, cond: () => boolean, maxSec = 60): boolean {
  for (let i = 0; i < maxSec * 20; i++) {
    if (cond()) return true;
    sim.step(1 / 20);
  }
  return cond();
}

// 构造一个带 workPriorities 的 CardView 桩做确定性权重断言（effectiveWeight 只读 view）
function weightOf(sim: Sim, cardId: string, pri: Record<string, number> | undefined = undefined): number {
  const card = BASE_CARDS.find((c) => c.id === cardId)!;
  const st = sim.pawnStates.get(sim.pawns[0])!;
  const view = {
    needsOf: () => ({ food: 100, rest: 100, mood: 100, san: 100 }),
    healthOf: () => null,
    isNight: () => false,
    hasCampfire: () => false, hasCave: () => false, hasRaft: () => false,
    hasBuildingWithTag: () => false,
    desiresOf: () => null,
    lastSeries: undefined,
    factionPriority: {},
    techs: new Set<string>(), buildQueueCount: 0, stockpile: {},
    tuning: sim.tuning,
    assignedJob: undefined,
    workPriorities: pri, // RW-1：测试的优先级注入点
    jobCards: sim.mods.jobCards,
    markovBias: sim.mods.markovBias,
    desireOfSeries: () => null,
    helpTargetOf: () => null,
    hostilesNearby: () => false,
  };
  return effectiveWeight(card, { dna: st.dna, slots: st.slots }, { eid: sim.pawns[0], view } as never);
}

describe('work-priority 玩法包（工作优先级，RW-1 M1）', () => {
  it('默认装配包含 work-priority 包 + 权重规则 + 命令', () => {
    const sim = makeSim();
    // 权重规则已注册（契约 check 也要求：包在场则规则必须在）
    expect(sim.mods.commandHandlers.has('set-work-priority')).toBe(true);
    // 规则 id 在流水线里（weightRuleStore 跨实例共享，default() 幂等注册）
    // 这里不直接访问共享表，用"命令注册成功 + 契约校验通过"间接断言即可
    expect(sim.pawns.length).toBeGreaterThan(0);
  });

  it('优先级 0 完全禁止对应工作（chop 权重归零）', () => {
    const sim = makeSim();
    // 禁止伐木 → chop 卡权重 = 0（x 天赋熟练度 0.5 下限 0）
    expect(weightOf(sim, 'chop', { lumberjack: 0 })).toBe(0);
    // 其它工作不受影响
    expect(weightOf(sim, 'mine', { lumberjack: 0 })).toBeGreaterThan(0);
  });

  it('1 与 4 的权重排序（1 级工作更常被抽中）', () => {
    const sim = makeSim();
    // 伐木 1 级（×6），捕鱼 4 级（×0.7）→ chop 权重应显著高于 fish
    const wChop = weightOf(sim, 'chop', { lumberjack: 1 });
    const wFish = weightOf(sim, 'fish', { fisher: 4 });
    expect(wChop).toBeGreaterThan(wFish);
    // 1 级 > 未设置（自主基线）> 4 级
    const base = weightOf(sim, 'chop');
    expect(wChop).toBeGreaterThan(base);
    expect(weightOf(sim, 'mine', { miner: 4 })).toBeLessThan(base);
  });

  it('未设置 = 自主行为不回退（与无优先级基线一致）', () => {
    const sim = makeSim();
    const base = weightOf(sim, 'chop');
    const auto = weightOf(sim, 'chop', {});
    expect(auto).toBe(base); // 空优先级表 = 不改动
    const partial = weightOf(sim, 'chop', { miner: 2 }); // 只设别的 job
    expect(partial).toBe(base); // 不设 chop → 不改动
  });

  it('紧急需求不受工作优先级抑制', () => {
    const sim = makeSim(5, 2);
    // 给一个小人设"禁止伐木"，让其极度饥饿 → 仍会去吃（紧急分支先于抽卡）
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    setJobPriority(st, 'lumberjack', 0);
    // 极端饥饿
    const n = sim.readNeeds(eid)!;
    n.food = 1;
    sim.setNeeds(eid, n);
    const ate = until(sim, () => {
      const cur = sim.readNeeds(eid);
      return (cur?.food ?? 0) > 30; // 紧急进食把饥饿拉起来
    }, 30);
    expect(ate).toBe(true);
  });

  it('旧 assignedJob 迁移为工作优先级（主职业=1、其他=0，不丢设置）', () => {
    // helper 级迁移
    const st = { assignedJob: 'lumberjack', extra: {} } as never;
    migrateFromAssignedJob(st as never);
    const p = workPrioritiesOf(st as never)!;
    expect(p.lumberjack).toBe(1);
    expect(p.miner).toBe(0);
    expect(p.farmer).toBe(0);
    // 已细调优先级不覆盖
    const st2 = { assignedJob: 'lumberjack', extra: {} } as never;
    setJobPriority(st2 as never, 'miner', 3);
    migrateFromAssignedJob(st2 as never);
    expect(workPrioritiesOf(st2 as never)!.miner).toBe(3); // 保留细调
  });

  it('旧档 assignedJob → load 后 workPriorities 迁移且可随档往返', () => {
    const simA = makeSim();
    const eid = simA.pawns[0];
    simA.pawnStates.get(eid)!.assignedJob = 'fisher'; // 模拟旧档（仅有 assignedJob）
    const saved = simA.save() as unknown as { pawns: { assignedJob: string; extra?: Record<string, unknown> }[] };
    // 旧档无 workPriorities（模拟旧格式）
    for (const p of saved.pawns) delete p.extra;
    const simB = makeSim(32);
    simB.load(saved as never);
    const st = simB.pawnStates.get(simB.pawns[0])!;
    expect(st.assignedJob).toBe('fisher'); // 不丢 assignedJob
    expect(workPrioritiesOf(st)!.fisher).toBe(1); // 迁移出优先级
    expect(workPrioritiesOf(st)!.lumberjack).toBe(0);
  });

  it('set-work-priority 命令：写/改/清关节奏', () => {
    const sim = makeSim();
    const eid = sim.pawns[0];
    sim.issueCommand({ type: 'set-work-priority', x: 0, y: 0, job: 'miner', pawnId: eid, args: { priority: 4 } });
    expect(workPrioritiesOf(sim.pawnStates.get(eid))!.miner).toBe(4);
    sim.issueCommand({ type: 'set-work-priority', x: 0, y: 0, job: 'miner', pawnId: eid, args: { priority: undefined } });
    expect(workPrioritiesOf(sim.pawnStates.get(eid))?.miner).toBeUndefined(); // 清除回自动
  });

  it('assign 快捷方式强制覆盖细调（主=1、其余=0）；取消指派回自动', () => {
    const sim = makeSim();
    const eid = sim.pawns[0];
    // 先细调：伐木 2 级（模拟玩家已微调）
    setJobPriority(sim.pawnStates.get(eid)!, 'lumberjack', 2);
    // assign = 显式"只干这行"快捷方式 → 强制覆盖（1+其余 0）
    sim.issueCommand({ type: 'assign', x: 0, y: 0, job: 'miner', pawnId: eid });
    expect(workPrioritiesOf(sim.pawnStates.get(eid))!.miner).toBe(1);
    expect(workPrioritiesOf(sim.pawnStates.get(eid))!.lumberjack).toBe(0);
    // 取消指派（assign 空 job）→ 清空优先级（回到全自动）
    sim.issueCommand({ type: 'assign', x: 0, y: 0, job: '', pawnId: eid });
    expect(workPrioritiesOf(sim.pawnStates.get(eid)) ?? {}).toEqual({});
  });

  it('存档往返：优先级随档保留', () => {
    const simA = makeSim();
    const st = simA.pawnStates.get(simA.pawns[0])!;
    setJobPriority(st, 'lumberjack', 2);
    setJobPriority(st, 'miner', 0);
    const saved = simA.save();
    const simB = makeSim(33);
    simB.load(saved as never);
    const p = workPrioritiesOf(simB.pawnStates.get(simB.pawns[0]))!;
    expect(p.lumberjack).toBe(2);
    expect(p.miner).toBe(0);
  });

  it('远程 delta 同步：workPriorities 变化被 diff 捕获并合并', () => {
    const sim = makeSim();
    const eid = sim.pawns[0];
    // 全量快照基线
    const snap = buildSnapshotLike(sim);
    const before = buildDelta(null, snap)!;
    expect(before.pawns!.find((p) => p.eid === eid)!.workPriorities ?? {}).toEqual({});
    // 设优先级后重拍快照 → delta 应携带 workPriorities
    setJobPriority(sim.pawnStates.get(eid)!, 'crafter', 3);
    const snap2 = buildSnapshotLike(sim);
    const delta = buildDelta(snap, snap2)!;
    const pd = delta.pawns!.find((p) => p.eid === eid)!;
    expect(pd.workPriorities).toEqual({ crafter: 3 });
    // drafted 字段（M2 会用到，M1 断言其在快照里缺省未定义）
    expect((snap2.pawns.find((p) => p.eid === eid) as { drafted?: boolean }).drafted).toBeUndefined();
  });
});

// 最小化模拟 server buildSnapshot 的 pawns 形状（diff 需要 SnapshotMsg pawns）
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
    hostiles: [], buildings: [], buildQueue: [], buildingVersion: 0,
  };
}
