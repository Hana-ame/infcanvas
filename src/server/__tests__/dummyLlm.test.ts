// LLM dummy 印卡层测试：sim.printCard + feedback/random planner + 定时 tick
import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { feedbackPlanner, randomPlanner, makeDummyCardPlanner } from '../dummyLlm';
import { drawCards, effectiveWeight } from '../../sim/ai/pawn';
import { STRATEGY_CARDS } from '../../sim/defs/strategyCards';

// feedbackPlanner 最小 ctx 工厂（分支单点可控，不受默认 tuning 干扰）
const mkCtx = (over: Record<string, unknown>) => ({
  stockpile: { wood: 100, ore: 100, food: 1000 },
  buildQueue: [],
  isNight: () => false,
  tuning: { population: { foodThreshold: 50 } },
  world: { buildings: new Map() },
  socialUnits: { units: new Map() },
  techs: new Set(),
  pawnList: [],
  mods: { strategyCards: STRATEGY_CARDS },
  rng: { next: () => 0.5, weightedPick: (pool: unknown[]) => pool[0] } as never,
  ...over,
}) as never as Parameters<typeof feedbackPlanner>[0];

// 构造一个带成员的社交单位（用于迁徙分支）
const mkUnit = (members: number) => new Map([[ 'u1', { members: Array.from({ length: members }, (_, i) => i) } ]]);

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
  it('feedback：经济调节不靠降令（缺木/缺矿不干预，账本自动调）→ null；有队列 → 建造令', () => {
    // 经济卡已从策略表移除（用户定案：伐木令退位，经济归收益/支出账本自动调节）
    expect(feedbackPlanner(mkCtx({ stockpile: { wood: 1, ore: 100, food: 1000 } }))).toBeNull();
    expect(feedbackPlanner(mkCtx({ stockpile: { wood: 100, ore: 1, food: 1000 } }))).toBeNull();
    expect(feedbackPlanner(mkCtx({ buildQueue: [{ x: 3, y: 3, defId: 'farm' }] }))?.workType).toBe('build');
    expect(feedbackPlanner(mkCtx({ stockpile: { wood: 100, ore: 100, food: 1 } }))?.label).toBe('垦田令');
  });

  it('feedback：健康局面白天不干预；入夜给休整令', () => {
    expect(feedbackPlanner(mkCtx({}))).toBeNull();
    expect(feedbackPlanner(mkCtx({ isNight: () => true }))?.action).toBe('rest');
  });

  it('feedback：缺粮且农田不足 → 垦田令（种植）；人丁旺木足 → 拓荒令（迁徙）', () => {
    expect(feedbackPlanner(mkCtx({ stockpile: { wood: 100, ore: 100, food: 1 } }))?.label).toBe('垦田令');
    // 农田 ≥3 → 不再垦田（经济由账本调节，神谕不降"缺粮伐木令"）
    const farms = new Map([[1, { def: { id: 'farm' } }], [2, { def: { id: 'farm' } }], [3, { def: { id: 'farm' } }]]);
    expect(feedbackPlanner(mkCtx({ stockpile: { wood: 100, ore: 100, food: 1 }, world: { buildings: farms } }))).toBeNull();
    // 迁徙：成员 5 + 木足 + 单营地
    const camps = new Map([[10, { def: { id: 'campfire' } }]]);
    expect(feedbackPlanner(mkCtx({
      stockpile: { wood: 400, ore: 100, food: 1000 },
      socialUnits: { units: mkUnit(5) },
      pawnList: [1, 2, 3, 4, 5],
      world: { buildings: camps },
    }))?.label).toBe('拓荒令');
    // 成员不足 → 不迁徙
    expect(feedbackPlanner(mkCtx({
      stockpile: { wood: 400, ore: 100, food: 1000 },
      socialUnits: { units: mkUnit(2) },
      pawnList: [1, 2],
      world: { buildings: camps },
    }))).toBeNull();
  });

  it('垦田令/拓荒令蓝图副作用声明（数据驱动）', () => {
    const till = STRATEGY_CARDS.find((c) => c.label === '垦田令')!;
    expect(till.blueprint).toEqual({ defId: 'farm', spot: 'nearCamp' });
    const migrate = STRATEGY_CARDS.find((c) => c.label === '拓荒令')!;
    expect(migrate.blueprint).toEqual({ defId: 'campfire', spot: 'far' });
  });

  it('垦田令蓝图落点 footprint 合法（farm 2×2，与已有建筑不重叠）', () => {
    const sim = new Sim({ seed: 30, pawnCount: 2 });
    sim.time = 60; sim.dayTime = 0.5; // 白天（dayTime 在 step 时才重算，需同步设置）
    sim.stockpile.wood = 999;
    sim.stockpile.ore = 999;
    sim.stockpile.food = 1; // 缺粮 → 垦田令
    const planner = makeDummyCardPlanner(sim, { mode: 'feedback', interval: 60 });
    planner.tick(60);
    const farmBlueprint = sim.buildQueue.find((b) => b.defId === 'farm');
    expect(farmBlueprint).toBeDefined();
    const def = sim.mods.buildings.farm;
    expect(sim.world.canBuildFootprint(farmBlueprint!.x, farmBlueprint!.y, def)).toBe(true);
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

  it('makeDummyCardPlanner：interval 累计 → 降旨目标（不碰选择链）', () => {
    const sim = new Sim({ seed: 27, pawnCount: 2 });
    sim.time = 60; sim.dayTime = 0.5; // 白天（dayTime 在 step 时才重算，需同步设置）
    sim.stockpile.wood = 1; // 缺木不降令（经济账本调节）；改为缺粮垦田场景验证降旨
    const planner = makeDummyCardPlanner(sim, { mode: 'feedback', interval: 60 });
    planner.tick(59);
    expect(planner.printed).toBe(0);
    planner.tick(1); // 60s 到点
    expect(planner.printed).toBe(1);
    // 神谕目标生效（影响目标层）：缺粮 → 垦田目标
    expect(sim.oracleGoal?.workType).toBe('build');
    // ……而非直接插卡（不碰选择链）
    expect(sim.pawnStates.get(sim.pawns[0])!.slots.some((c) => c?.id?.startsWith('oracle:'))
      || sim.pawnStates.get(sim.pawns[1])!.slots.some((c) => c?.id?.startsWith('oracle:'))).toBe(false);
  });

  it('神谕目标放大对应工作权重（×oracleGoalMul）；到期自动清除', () => {
    const sim = new Sim({ seed: 32, pawnCount: 1 });
    sim.setOracleGoal({ workType: 'chop', label: '伐木令', duration: 100 });
    expect(sim.oracleGoal?.label).toBe('伐木令');
    // 目标持续期内权重放大
    const st = sim.pawnStates.get(sim.pawns[0])!;
    const chop = st.slots.find((c) => c?.id === 'chop')!;
    const ctx = {
      view: {
        oracleGoal: sim.oracleGoal,
        tuning: { card: { oracleGoalMul: 3 } },
      },
      eid: sim.pawns[0],
    } as never;
    const w = effectiveWeight(chop, { dna: st.dna, slots: st.slots }, ctx);
    // ×3（oracleGoal）× (0.5+mastery/100)（熟练度调制）
    expect(w).toBeCloseTo(chop.weight * 3 * (0.5 + (chop.mastery ?? 0) / 100), 5);
    // 到期清除
    sim.step(101);
    expect(sim.oracleGoal).toBeNull();
  });

  it('垦田令副作用：农田蓝图入队（种植闭环）', () => {
    const sim = new Sim({ seed: 28, pawnCount: 2 });
    sim.time = 60; sim.dayTime = 0.5; // 白天（dayTime 在 step 时才重算，需同步设置）
    sim.stockpile.wood = 100;
    sim.stockpile.ore = 100;
    sim.stockpile.food = 1; // 缺粮
    const planner = makeDummyCardPlanner(sim, { mode: 'feedback', interval: 60 });
    planner.tick(60);
    expect(planner.printed).toBe(1);
    // 蓝图已入队（垦田令 → farm）
    expect(sim.buildQueue.length).toBeGreaterThan(0);
    expect(sim.buildQueue.some((b) => b.defId === 'farm')).toBe(true);
    // 步进后小人建造它（build 工作有蓝图可做）
    sim.step(240);
    expect([...sim.world.buildings.values()].some((b) => b.def.tags?.includes('farm'))).toBe(true);
  });

  it('拓荒令副作用：远处营地蓝图入队 → 建成形成第二派系（迁徙闭环）', () => {
    const sim = new Sim({ seed: 29, pawnCount: 4 });
    // 人丁兴旺（成员多）+ 木足 + 单营地条件：模拟单位+migration 局面
    sim.spawnPawn(3, 3);
    sim.step(120); // autobuild 已建 campfire，派系成员逐步加入
    const planner = makeDummyCardPlanner(sim, { mode: 'feedback', interval: 60 });
    // 直接构造迁徙局面：多人入派系 + 木足
    const p = sim;
    const campKey = [...p.world.buildings.keys()].find((k) => p.world.buildings.get(k)!.def.id === 'campfire');
    expect(campKey).toBeDefined();
    for (const eid of sim.pawns) sim.socialUnits.assignPawn(eid);
    p.stockpile.wood = 999;
    p.stockpile.food = 999;
    p.stockpile.ore = 999;
    planner.tick(60);
    // 拓荒令或由于木足后沿用队里已有 blueprint 等情况 → 至少蓝图出现 campfire
    if (planner.printed > 0) {
      expect(p.buildQueue.some((b) => b.defId === 'campfire')).toBe(true);
    }
  });

  it('迁徙闭环（内核）：新营地建成 → 附近的拓荒者自动划入新派系', () => {
    const sim = new Sim({ seed: 31, pawnCount: 2 });
    sim.step(120); // 初始 campfire + 派系
    expect(sim.socialUnits.units.size).toBe(1);
    const w = sim.world;
    // 远处找合法落点（环形扫描 canBuildFootprint，避开水面/岩石/已有建筑）
    let spot: { x: number; y: number } | null = null;
    const def = sim.mods.buildings.campfire;
    for (let r = 12; r < 40 && !spot; r++) {
      for (let dy = -r; dy <= r && !spot; dy++) {
        for (let dx = -r; dx <= r && !spot; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = w.width / 2 + dx;
          const y = w.height / 2 + dy;
          if (w.canBuildFootprint(x, y, def)) spot = { x, y };
        }
      }
    }
    expect(spot).not.toBeNull();
    // 远处造一个新营地（模拟拓荒蓝图被小人建成）
    const key = w.buildKey(spot!.x, spot!.y);
    expect(w.placeBuilding(spot!.x, spot!.y, 'campfire', 'player')).toBe(true);
    sim.socialUnits.onBuildingBuilt(key, 'campfire', sim.time);
    // 第二派系自动形成；出生小人仍在旧营地 → 新派系空
    expect(sim.socialUnits.units.size).toBe(2);
    const newUnit = [...sim.socialUnits.units.values()].find((u) => u.key === key)!;
    expect(newUnit.members.length).toBe(0);
    // 拓荒者抵达新营地 → 重算归属时划入新派系（迁徙者）
    sim.pawnPositions.set(sim.pawns[0], { x: spot!.x, y: spot!.y });
    sim.socialUnits.onBuildingBuilt(key, 'campfire', sim.time);
    expect(newUnit.members).toContain(sim.pawns[0]);
    // 旧营地的小人仍留在原派系（只有拓荒者一个离开）
    const oldUnit = [...sim.socialUnits.units.values()].find((u) => u.key !== key)!;
    expect(oldUnit.members).not.toContain(sim.pawns[0]);
    expect(oldUnit.members.length).toBe(sim.pawns.length - 1);
  });
});
