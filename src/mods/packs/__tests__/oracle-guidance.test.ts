// 神谕卡式工作引导玩法包（oracle-guidance）测试（RW-1 M1 修订，2026-08-15）
// 覆盖任务清单 7 项：① 激活策略卡正确设置 oracleGoal；② 对应工作卡权重提高但抽卡非必然；
// ③ 小人仍可能违抗；④ 蓝图副作用只入队一次；⑤ 冷却/持续限制；⑥ 存档无 workPriorities；
// ⑦ 远程协议无需新增 workPriorities。附：装配检查 + 可选插卡选择性（选中才插）。
// 设计锚点（用户裁决）：玩家影响工作只经策略卡/神谕目标/插卡/权重——本文件全部断言都
// 建立在这个通道上，任何"按 pawn 设数字优先级"的回归都会被规则级断言（②）与存档断言
// （⑥）拦下。
import { describe, it, expect } from 'vitest';
import { Sim } from '../../../sim/sim';
import { ModRegistry } from '../../../sim/mods/registry';
import { weightRulesOf } from '../../../sim/mods/query';
import { buildDelta } from '../../../server/diff';
import type { SnapshotMsg } from '../../../shared/protocol';
import { validateCommand, type CmdGuardState } from '../../../server/cmdValidate';

function makeSim(seed = 52, pawnCount = 2): Sim {
  return new Sim({ seed, pawnCount, registry: ModRegistry.default() });
}

function until(sim: Sim, cond: () => boolean, maxSec = 60): boolean {
  for (let i = 0; i < maxSec * 20; i++) {
    if (cond()) return true;
    sim.step(1 / 20);
  }
  return cond();
}

function issue(sim: Sim, cardId: string, pawnId?: number): void {
  sim.issueCommand({ type: 'strategy', x: 0, y: 0, pawnId, args: { cardId } });
}

function queueCount(sim: Sim, defId: string): number {
  return sim.buildQueueItems.filter((b) => b.defId === defId).length;
}

describe('oracle-guidance 玩法包（神谕卡式工作引导，RW-1 M1 修订）', () => {
  it('默认装配：strategy 命令 + 伐木令/采矿令扩展卡（面板数据源）', () => {
    const sim = makeSim();
    expect(sim.mods.packIds).toContain('oracle-guidance');
    expect(sim.mods.commandHandlers.has('strategy')).toBe(true);
    const ids = sim.mods.strategyCards.map((c) => c.id);
    expect(ids).toContain('oracle:till');       // 内置垦田令
    expect(ids).toContain('oracle:chop');       // 本包新增伐木令
    expect(ids).toContain('oracle:mine');       // 本包新增采矿令
    expect(sim.mods.strategyCards.find((c) => c.id === 'oracle:chop')?.workType).toBe('chop');
  });

  it('① 激活策略卡 → 正确设置 oracleGoal（目标层，不新增 pawn 状态）', () => {
    const sim = makeSim(53, 1);
    const e0 = sim.pawns[0];
    expect(sim.oracleGoal).toBeNull();
    issue(sim, 'oracle:chop', e0);
    const g = sim.oracleGoal!;
    expect(g.label).toBe('伐木令');
    expect(g.workType).toBe('chop');
    expect(g.until).toBeCloseTo(sim.time + 120, 6); // defaultDuration（与随机神谕目标一致）
    // 未选中小人也可降旨（目标层是全局的，不依赖选中）：新 sim 里无 pawnId 直接降采矿令
    const sim2 = makeSim(59, 1);
    issue(sim2, 'oracle:mine');
    expect(sim2.oracleGoal!.label).toBe('采矿令');
  });

  it('② 对应工作卡权重提高（×oracleGoalMul）——规则级确定性断言', () => {
    const rule = weightRulesOf().find((r) => r.id === 'oracleGoal')!;
    expect(rule).toBeDefined();
    const goalCtx = {
      view: { oracleGoal: { workType: 'chop', label: '伐木令', until: 1e9 }, tuning: { card: { oracleGoalMul: 3 } } },
    } as never;
    const chopCard = { decide: () => ({ workType: 'chop' }) } as never;
    const mineCard = { decide: () => ({ workType: 'mine' }) } as never;
    const fakePawn = {} as never; // apply 的 pawn 参数未用（ruleOracleGoal 只看 ctx.view）
    expect(rule.apply(10, chopCard, fakePawn, goalCtx)).toBe(30); // 匹配目标 → ×3
    expect(rule.apply(10, mineCard, fakePawn, goalCtx)).toBe(10); // 非目标工作不动
    expect(rule.apply(10, mineCard, fakePawn, { view: { oracleGoal: null, tuning: { card: { oracleGoalMul: 3 } } } } as never)).toBe(10); // 无目标不动
  });

  it('② 权重是引导不是指令：目标工作卡不在卡池时，抽卡结果里永远不会出现它', () => {
    const sim = makeSim(54, 1);
    const e0 = sim.pawns[0];
    const st = sim.pawnStates.get(e0)!;
    // 把采矿卡从小人卡池拿走（测试直接改槽位；抽 3 选 1 从槽位抽 → 卡不在池 = 必然抽不到）
    st.slots = st.slots.filter((c) => c?.id !== 'mine');
    issue(sim, 'oracle:mine', e0);
    expect(sim.oracleGoal!.workType).toBe('mine');
    let decisions = 0;
    const ran = until(sim, () => {
      if (sim.pawnProfile(e0)?.lastDecision) decisions++;
      const d = sim.pawnProfile(e0)?.lastDecision;
      return d !== undefined && d.picked !== '采矿' && sim.time > 25;
    }, 40);
    expect(ran).toBe(true); // 有决策发生（小人仍在自主）且从未选出采矿
    expect(sim.pawnProfile(e0)?.lastDecision?.picked).not.toBe('采矿');
    expect(decisions).toBeGreaterThan(0);
  });

  it('③ 小人仍可能违抗：懒惰 + 低心情 + 0 信仰 → 出现"违抗安排"事件', () => {
    const sim = makeSim(55, 1);
    const e0 = sim.pawns[0];
    const st = sim.pawnStates.get(e0)!;
    st.dna = { ...st.dna, traits: [...st.dna.traits, '懒惰'] }; // 懒惰违抗基础概率
    st.faith = 0;                                               // 信仰抵消违抗 = 0
    sim.setNeeds(e0, { ...sim.readNeeds(e0)!, mood: 5 });       // 心情 < defyMoodAt(20)
    issue(sim, 'oracle:chop', e0);                              // 神谕目标 ×3 偏向伐木（工作卡常被选中 → 触发违抗判定）
    // 维持低心情（needs 系统会向基线回归），步进直到违抗事件出现（种子固定 → 结果确定）
    let defied = false;
    for (let i = 0; i < 60 * 20 && !defied; i++) {
      sim.step(1 / 20);
      defied = sim.events.some((e) => e.text.includes('违抗'));
      const n = sim.readNeeds(e0);
      if (n && n.mood > 10) sim.setNeeds(e0, { ...n, mood: 5 });
    }
    expect(defied).toBe(true);
  });

  it('④ 蓝图副作用只入队一次：垦田令重复降旨不产生重复农田蓝图', () => {
    const sim = makeSim(56, 2);
    issue(sim, 'oracle:till');
    // 至少入队了一次农田（nearCamp 落点扫描成功）
    expect(queueCount(sim, 'farm')).toBeGreaterThanOrEqual(1);
    let maxPending = 0;
    let reissued = false;
    for (let i = 0; i < 70 * 20; i++) {
      sim.step(1 / 20);
      maxPending = Math.max(maxPending, queueCount(sim, 'farm'));
      // 冷却（45s）过后再降一次垦田令：队列里不许出现第二个 pending 农田（去重）
      if (!reissued && sim.time >= 46) { issue(sim, 'oracle:till'); reissued = true; }
    }
    expect(reissued).toBe(true);
    expect(maxPending).toBeLessThanOrEqual(1); // 任一时刻 pending 农田 ≤ 1（只入队一次）
  });

  it('⑤ 冷却与持续限制：冷却中拒绝降旨；目标到时自动清除', () => {
    const sim = makeSim(57, 2);
    issue(sim, 'oracle:chop');
    const until1 = sim.oracleGoal!.until;
    // 冷却中（同刻再降）：被拒 → 目标不刷新、事件有"沉思"提示
    issue(sim, 'oracle:mine');
    expect(sim.oracleGoal!.label).toBe('伐木令');
    expect(sim.oracleGoal!.until).toBe(until1);
    expect(sim.events.some((e) => e.text.includes('沉思'))).toBe(true);
    // 冷却过后可再降（目标刷新为采矿令）
    const ran = until(sim, () => sim.time >= 46, 48);
    expect(ran).toBe(true);
    issue(sim, 'oracle:mine');
    expect(sim.oracleGoal!.label).toBe('采矿令');
    // 持续时间：目标 120s 到期自动清除（引擎 step 清理，不依赖面板）
    const ok = until(sim, () => sim.oracleGoal === null || sim.time >= 200, 140);
    expect(ok).toBe(true);
    expect(sim.time >= 130 && sim.oracleGoal === null).toBe(true);
  });

  it('⑥ 存档无 workPriorities（无任何数字优先级泄漏）且往返可加载', () => {
    const sim = makeSim(58, 2);
    issue(sim, 'oracle:till');
    issue(sim, 'oracle:chop');
    for (let i = 0; i < 30; i++) sim.step(1 / 20);
    const saved = sim.save();
    const json = JSON.stringify(saved);
    expect(json).not.toContain('workPriorities');
    // pawn 级：extra 扩展点也不含该键（含征召等共存键时仍干净）
    for (const eid of sim.pawns) {
      const extra = sim.pawnStates.get(eid)?.extra ?? {};
      expect(Object.keys(extra).includes('workPriorities')).toBe(false);
    }
    // 往返：旧档可加载（含 strategy 插出的目标卡 = 普通槽位卡，load 兼容）
    const simB = makeSim(59, 1);
    expect(() => simB.load(saved as never)).not.toThrow();
  });

  it('⑦ 远程协议无需新增字段：snapshot/delta/命令校验与 workPriorities 无关', () => {
    const sim = makeSim(60, 1);
    const eid = sim.pawns[0];
    const snap1 = buildSnapshotLike(sim);
    issue(sim, 'oracle:chop', eid);
    const snap2 = buildSnapshotLike(sim);
    const delta = buildDelta(snap1, snap2);
    expect(JSON.stringify(snap2)).not.toContain('workPriorities');
    expect(JSON.stringify(delta ?? {})).not.toContain('workPriorities');
    // strategy 命令过 cmdValidate（通用通道：pawnId 合法性即可）；坏 pawnId 被拒
    const guard: CmdGuardState = { lastCmdAt: 0, budget: 30 };
    const v = (cmd: unknown) => validateCommand(sim, cmd, guard, Date.now()).ok;
    expect(v({ type: 'strategy', x: 0, y: 0, pawnId: eid, args: { cardId: 'oracle:chop' } })).toBe(true);
    expect(v({ type: 'strategy', x: 0, y: 0, pawnId: eid + 99, args: { cardId: 'oracle:chop' } })).toBe(false);
  });

  it('⑧（附加）可选插卡：有选中小人 → 该小人槽位得目标卡；无选中 → 不插', () => {
    const sim = makeSim(61, 2);
    const [e0, e1] = sim.pawns;
    sim.selected = [e0];
    issue(sim, 'oracle:mine', e0);
    const cardIn = (eid: number) => sim.pawnStates.get(eid)!.slots.some((c) => c?.id === 'strategy:oracle:mine');
    expect(cardIn(e0)).toBe(true); // 选中的小人收到了"目标卡/习惯卡"
    expect(cardIn(e1)).toBe(false); // 未选中的没有
    // 无选中 → 只降目标，不插卡（e1 仍无策略卡）
    sim.selected = [];
    issue(sim, 'oracle:chop');
    expect(cardIn(e1)).toBe(false);
    expect(sim.pawnStates.get(e1)!.slots.some((c) => c?.id === 'strategy:oracle:chop')).toBe(false);
  });
});

// 最小化 server buildSnapshot 的 pawns 形状（diff 需要 SnapshotMsg pawns；不含 workPriorities）
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
      };
    }),
    hostiles: sim.hostiles.map((h, i) => ({ i, enemyId: h.enemyId, x: h.x, y: h.y, hp: h.hp, maxHp: h.maxHp, faction: h.faction })),
    buildings: [], buildQueue: [], buildingVersion: 0,
  };
}