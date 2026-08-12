// LLM dummy 印卡层测试：sim.printCard + feedback/random planner + 定时 tick
import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { feedbackPlanner, randomPlanner, makeDummyCardPlanner } from '../dummyLlm';
import { drawCards } from '../../sim/ai/pawn';

// feedbackPlanner 最小 ctx 工厂（分支单点可控，不受默认 tuning 干扰）
const mkCtx = (over: Record<string, unknown>) => ({
  stockpile: { wood: 100, ore: 100, food: 1000 },
  buildQueue: [],
  isNight: () => false,
  tuning: { population: { foodThreshold: 50 } },
  ...over,
}) as never as Parameters<typeof feedbackPlanner>[0];

describe('sim.printCard（LLM 印卡 API：DESIGN §6 只印卡不进选择链路）', () => {
  it('印卡插入目标小人槽位，抽卡可命中', () => {
    const sim = new Sim({ seed: 21, pawnCount: 2 });
    const ret = sim.printCard({
      id: 'dummy:chop', name: '伐木令', series: 'work', weight: 10,
      action: 'walkAndWork', workType: 'chop', label: '伐木令',
    });
    expect(sim.pawns).toContain(ret); // 随机目标：任一活人
    const st = sim.pawnStates.get(ret!)!;
    expect(st.slots.some((c) => c?.id === 'dummy:chop')).toBe(true);
    // 抽卡链路可见（权重高必抽中）
    const ctx = {
      eid: ret,
      view: {
        needsOf: () => ({ food: 80, rest: 80, mood: 60, san: 100 }),
        healthOf: () => ({ hp: 100, maxHp: 100 }),
        isNight: () => false,
        hasCampfire: () => true,
        hasCave: () => false,
        buildQueueCount: 0,
        stockpile: sim.stockpile,
      },
    } as never;
    const pawn = { dna: st.dna, slots: st.slots };
    for (let i = 0; i < 20; i++) {
      const drawn = drawCards(pawn as never, sim.rng, sim.tuning.card.drawCount, ctx as never);
      expect(drawn.some((c) => c.id === 'dummy:chop')).toBe(true);
    }
    expect(sim.events.some((e) => e.text.includes('收到策略卡'))).toBe(true);
  });

  it('槽位满时替换 weight 最低的卡（神谕策略卡可顶基础卡）', () => {
    const sim = new Sim({ seed: 22, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    const slots = st.slots.length;
    // 印满槽位（weight 高，留在最上）
    for (let i = 0; i < slots + 5; i++) {
      sim.printCard({
        id: `dummy:fill${i}`, name: `令${i}`, series: 'work', weight: 90,
        action: 'idle', label: `令${i}`,
      });
    }
    // 槽位不超上限
    expect(st.slots.filter(Boolean).length).toBe(slots);
    // 最低 weight 的基础卡被顶掉：所有槽位都是 weight 90 的印卡
    for (const c of st.slots) if (c) expect(c.weight).toBe(90);
  });

  it('指定 target / 无活人返回 null', () => {
    const sim = new Sim({ seed: 23, pawnCount: 1 });
    const eid = sim.pawns[0];
    expect(sim.printCard({ id: 'x1', name: 'X', series: 'work', weight: 1, action: 'idle', label: 'X' }, { target: eid })).toBe(eid);
    for (const p of sim.pawns) sim.killPawn(p);
    expect(sim.printCard({ id: 'x2', name: 'Y', series: 'work', weight: 1, action: 'idle', label: 'Y' })).toBeNull();
  });
});

describe('dummy planner（feedback / random）', () => {
  it('feedback：缺木 → 伐木令；缺矿 → 采矿令；有队列 → 建造令', () => {
    expect(feedbackPlanner(mkCtx({ stockpile: { wood: 1, ore: 100, food: 1000 } }))?.workType).toBe('chop');
    expect(feedbackPlanner(mkCtx({ stockpile: { wood: 100, ore: 1, food: 1000 } }))?.workType).toBe('mine');
    expect(feedbackPlanner(mkCtx({ buildQueue: [{ x: 3, y: 3, defId: 'farm' }] }))?.workType).toBe('build');
    expect(feedbackPlanner(mkCtx({ stockpile: { wood: 100, ore: 100, food: 1 } }))?.workType).toBe('chop');
  });

  it('feedback：健康局面白天不干预；入夜给休整令', () => {
    expect(feedbackPlanner(mkCtx({}))).toBeNull();
    expect(feedbackPlanner(mkCtx({ isNight: () => true }))?.action).toBe('rest');
  });

  it('random：随机印工作/生活卡（确定性种子结构）', () => {
    const sim = new Sim({ seed: 26, pawnCount: 1 });
    let work = 0;
    let life = 0;
    for (let i = 0; i < 200; i++) {
      const def = randomPlanner(sim);
      expect(def).not.toBeNull();
      if (def!.action === 'walkAndWork') work++;
      else life++;
    }
    expect(work).toBeGreaterThan(0);
    expect(life).toBeGreaterThan(0);
  });

  it('makeDummyCardPlanner：interval 累计 → 印卡 + 计数', () => {
    const sim = new Sim({ seed: 27, pawnCount: 2 });
    sim.stockpile.wood = 1; // 缺木局面，feedback 稳定印伐木令
    const planner = makeDummyCardPlanner(sim, { mode: 'feedback', interval: 60 });
    planner.tick(59);
    expect(planner.printed).toBe(0);
    planner.tick(1); // 60s 到点
    expect(planner.printed).toBe(1);
    expect(sim.pawnStates.get(sim.pawns[0])!.slots.some((c) => c?.id === 'dummy:chop')
      || sim.pawnStates.get(sim.pawns[1])!.slots.some((c) => c?.id === 'dummy:chop')).toBe(true);
  });
});
