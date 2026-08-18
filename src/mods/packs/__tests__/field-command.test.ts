// 战场指挥 DLC（field-command 玩法包）测试（2026-08-16）
// 覆盖：装配（系统+命令+战术表）/ 册封编队与自动晋升 / 训练（掌握+去重+冷却）/ 级联下发
// 与收兵 / 集火需目标+全队指定 / 固守不动（含 drafting 不追击）/ 冲锋先敌接敌 / 撤退远离 /
// 集结靠拢 / 指挥官死亡级联解除 / 玩家解除征召 = 战术失效 / 编制死亡清理 / 存档往返 /
// 卸载安全 / 协议 snapshot+delta 携带 commander+tactic / cmdValidate 形状校验 / 契约无违例。
// 战斗结算（伤害/掉落）不重测（raidSystem 单测覆盖）；本文件只测"指挥语义"。
import { describe, it, expect } from 'vitest';
import { Sim } from '../../../sim/sim';
import { ModRegistry } from '../../../sim/mods/registry';
import { TILES, BUILDINGS, ITEMS } from '../../../sim/defs';
import { TUNING } from '../../../sim/defs/tuning';
import { ENEMIES } from '../../../sim/defs/enemies';
import { RECIPES } from '../../../sim/defs/recipes';
import { BASE_CARDS } from '../../../sim/ai/pawn';
import { DEFAULT_PLAYSTYLE_PACKS, PLAYSTYLE_PACKS } from '../playstyle';
import { validateContracts } from '../../../sim/mods/contracts';
import type { ModPack } from '../../../mods/pack';
import { buildDelta } from '../../../server/diff';
import type { SnapshotMsg } from '../../../shared/protocol';
import { validateCommand, type CmdGuardState } from '../../../server/cmdValidate';
import { TACTICS, commanderOf, tacticsOf, tacticOf } from '../field-command';
import { draftedOf } from '../drafting';

function makeSim(seed = 41, pawnCount = 2): Sim {
  return new Sim({ seed, pawnCount, registry: ModRegistry.default() });
}

function stepN(sim: Sim, seconds: number, dt = 1 / 20): void {
  const n = Math.ceil(seconds / dt);
  for (let i = 0; i < n; i++) sim.step(dt);
}

// 站桩敌人（speed 0 = 不移动；dmg 低防测试期间打伤小人干扰位置断言）
function addRaider(sim: Sim, x: number, y: number, hp = 500, dmg = 0.01): void {
  sim.hostiles.push({
    x, y, hp, maxHp: hp, targetX: x, targetY: y,
    name: '掠夺者', enemyId: 'raider', faction: 'unit',
    speed: 0, dmgPerSec: dmg, loot: { item: 'food', amount: 2 },
  });
}

describe('战场指挥 DLC（field-command 玩法包，2026-08-16）', () => {
  it("① 装配：系统 'field-command' 在场 + 3 命令注册 + 战术表 5 项（数据驱动）", () => {
    const sim = makeSim();
    expect(sim.systemIds).toContain('field-command');
    expect(sim.mods.commandHandlers.has('commander')).toBe(true);
    expect(sim.mods.commandHandlers.has('train')).toBe(true);
    expect(sim.mods.commandHandlers.has('dispatch')).toBe(true);
    expect(Object.keys(TACTICS)).toEqual(['charge', 'hold', 'focus', 'retreat', 'regroup']);
    // 契约传导：默认装配 playstyleManager apply 已跑 validateContracts；此处再显式断言
    expect(validateContracts(sim.mods).length).toBe(0);
  });

  it('② 册封/编队：officer 身份 + 编组人数；辖下有队长自动晋升军团长（多层零配置）', () => {
    const sim = makeSim(42, 3);
    const [g, a, b] = sim.pawns;
    // g 册封队长，a/b 入编
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [a, b] } });
    let c = commanderOf(sim.pawnStates.get(g));
    expect(c?.role).toBe('officer');
    expect(c?.subordinates).toEqual([a, b]);
    // a 也册封队长 → 再让 g 辖 a → g 自动晋升 general
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: a, args: { subordinates: [] } });
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [a, b] } });
    c = commanderOf(sim.pawnStates.get(g));
    expect(c?.role).toBe('general');
    // 重复编组幂等：同命令再发不报错、结构不变
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [a, b] } });
    expect(commanderOf(sim.pawnStates.get(g))?.subordinates).toEqual([a, b]);
  });

  it('③ 训练：掌握战术入 learned（随档）；重复训练去重；冷却内拒绝', () => {
    const sim = makeSim(43, 2);
    const e0 = sim.pawns[0];
    sim.issueCommand({ type: 'train', x: 0, y: 0, pawnId: e0, args: { tactic: 'charge' } });
    expect(tacticsOf(sim.pawnStates.get(e0))?.learned).toContain('charge');
    // 未知战术拒绝（不进入 learned）
    sim.issueCommand({ type: 'train', x: 0, y: 0, pawnId: e0, args: { tactic: 'chargex' } });
    expect(tacticsOf(sim.pawnStates.get(e0))?.learned).toEqual(['charge']);
    // 冷却：15s 内重复训练 = 已掌握提示（learned 不变）；推进 16s 后可学第二个
    sim.issueCommand({ type: 'train', x: 0, y: 0, pawnId: e0, args: { tactic: 'hold' } });
    expect(tacticsOf(sim.pawnStates.get(e0))?.learned).toEqual(['charge']); // 冷却中拒绝
    stepN(sim, 16);
    sim.issueCommand({ type: 'train', x: 0, y: 0, pawnId: e0, args: { tactic: 'hold' } });
    expect(tacticsOf(sim.pawnStates.get(e0))?.learned).toEqual(['charge', 'hold']);
  });

  it('④ 级联下发：军团长 dispatch → 队长与兵全部受命（含自己）+ 征召；收兵全解除', () => {
    const sim = makeSim(44, 4);
    const [g, o, s1, s2] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: o, args: { subordinates: [s1, s2] } });
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [o] } }); // g=general（辖队长）
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'hold' } });
    for (const eid of [g, o, s1, s2]) {
      const st = sim.pawnStates.get(eid)!;
      expect(draftedOf(st)).toBe(true);
      expect(tacticOf(st)).toBe('hold'); // 生效战术 = underOrder（覆盖编排位）
      expect(tacticsOf(st)?.underOrder?.from).toBe(g); // 命令源 = 军团长
    }
    // 收兵（'none'）：全树解除征召 + 清命令
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'none' } });
    for (const eid of [g, o, s1, s2]) {
      expect(draftedOf(sim.pawnStates.get(eid))).toBe(false);
      expect(tacticsOf(sim.pawnStates.get(eid))?.underOrder).toBeNull();
    }
  });

  it('⑤ 集火：缺 hostileIndex 拒绝；有效 → 全队 attackTarget 设定（指挥官指定目标派遣）', () => {
    const sim = makeSim(45, 3);
    const [g, s1, s2] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [s1, s2] } });
    // 缺目标：拒绝（hostiles 已有一个 → 不加 = 校验失败路径）
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'focus' } });
    expect(tacticOf(sim.pawnStates.get(s1))).toBeNull();
    // 有效目标
    addRaider(sim, Math.round(sim.pawnPositions.get(g)!.x) + 6, Math.round(sim.pawnPositions.get(g)!.y));
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'focus', hostileIndex: 0 } });
    for (const eid of [g, s1, s2]) {
      expect(tacticsOf(sim.pawnStates.get(eid))?.underOrder?.target).toBe(0);
    }
    // 驱动几 tick 后 attackTarget 已设定（drafting 追击拖动）
    stepN(sim, 3);
    for (const eid of [g, s1, s2]) {
      const atk = sim.pawnStates.get(eid)!.extra?.attackTarget as { hostileIndex: number } | undefined;
      expect(atk?.hostileIndex).toBe(0);
    }
  });

it('⑤b 编排槽 active：commander 命令写入持久预设；临战下达覆盖、收兵后回落到编排；随档', () => {
    const sim = makeSim(44, 2);
    const [g, s] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [s], active: 'hold' } });
    expect(tacticOf(sim.pawnStates.get(g))).toBe('hold'); // 无临战命令 → 按编排执行
    // 临战下达（hold 编排 vs 临战 charge）→ 临战优先
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'charge' } });
    expect(tacticOf(sim.pawnStates.get(g))).toBe('charge');
    // 收兵 → 编排槽回落（持久预设不随收兵消失）
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'none' } });
    expect(tacticOf(sim.pawnStates.get(g))).toBe('hold');
    // 清编排（active:'none'）与脏数据宽容（战术表外 id = 清）
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { active: 'none' } });
    expect(tacticOf(sim.pawnStates.get(g))).toBeNull();
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { active: 'charge' } });
    const data = JSON.parse(JSON.stringify(sim.save()));
    const sim2 = new Sim({ seed: 44, pawnCount: 0 });
    sim2.load(data);
    expect(tacticOf(sim2.pawnStates.get(g))).toBe('charge'); // 编排随档
  });

  it('⑥ 固守：敌人贴近也不动（战术优先级高于自动接敌——drafting 追击跳过 hold）', () => {
    const sim = makeSim(46, 2);
    const [g, s] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [s] } });
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'hold' } });
    const gp = sim.pawnPositions.get(g)!;
    // 站桩敌 5 格外（正常自动接敌半径 14 内早追过去了）
    addRaider(sim, Math.round(gp.x) + 5, Math.round(gp.y));
    const hold0 = { ...sim.pawnPositions.get(s)! };
    stepN(sim, 8);
    const hold1 = sim.pawnPositions.get(s)!;
    expect(Math.hypot(hold1.x - hold0.x, hold1.y - hold0.y)).toBeLessThan(0.5); // 纹丝不动
  });

  it('⑦ 冲锋：半径 20 内敌人（>14 自动接敌）仍被主动指派攻击', () => {
    const sim = makeSim(47, 2);
    const [g, s] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [s] } });
    const gp = sim.pawnPositions.get(g)!;
    addRaider(sim, Math.round(gp.x) + 17, Math.round(gp.y)); // 17 格：>14 自动、<20 冲锋
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'charge' } });
    stepN(sim, 4);
    const atk = sim.pawnStates.get(s)!.extra?.attackTarget as { hostileIndex: number } | undefined;
    expect(atk?.hostileIndex).toBe(0);
  });

  it('⑧ 撤退：敌人贴脸 → 受命小人远离（反方向转移）', () => {
    const sim = makeSim(48, 2);
    const [g, s] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [s] } });
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'retreat' } });
    const sp = sim.pawnPositions.get(s)!;
    addRaider(sim, Math.round(sp.x) + 2, Math.round(sp.y)); // 2 格贴脸
    const d0 = Math.hypot(sim.pawnPositions.get(s)!.x - sim.hostiles[0].x, sim.pawnPositions.get(s)!.y - sim.hostiles[0].y);
    stepN(sim, 6);
    const d1 = Math.hypot(sim.pawnPositions.get(s)!.x - sim.hostiles[0].x, sim.pawnPositions.get(s)!.y - sim.hostiles[0].y);
    expect(d1).toBeGreaterThan(d0 + 2); // 明显拉开
  });

  it('⑨ 集结：指挥官挪远 → 兵向指挥官身边靠拢（八方向散布落位）', () => {
    const sim = makeSim(49, 2);
    const [g, s] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [s] } });
    // 指挥官移到远处空地（避免寻路找路失败）
    const target = { x: Math.round(sim.pawnPositions.get(g)!.x) + 15, y: Math.round(sim.pawnPositions.get(g)!.y) };
    sim.issueCommand({ type: 'move', x: target.x, y: target.y, pawnId: g });
    stepN(sim, 5); // 指挥官先走过去
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'regroup' } });
    const d0 = Math.hypot(
      sim.pawnPositions.get(s)!.x - sim.pawnPositions.get(g)!.x,
      sim.pawnPositions.get(s)!.y - sim.pawnPositions.get(g)!.y);
    stepN(sim, 8);
    const d1 = Math.hypot(
      sim.pawnPositions.get(s)!.x - sim.pawnPositions.get(g)!.x,
      sim.pawnPositions.get(s)!.y - sim.pawnPositions.get(g)!.y);
    expect(d1).toBeLessThan(d0); // 靠拢
  });

  it('⑩ 指挥官死亡 → 级联解除整树（兵恢复自主）；兵死亡 → 编制摘除', () => {
    const sim = makeSim(50, 3);
    const [g, o, s] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: o, args: { subordinates: [s] } });
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [o] } });
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'hold' } });
    expect(draftedOf(sim.pawnStates.get(s))).toBe(true);
    // 先跑几帧让系统建立树快照（死亡级联读上帧快照——killPawn 同步删 extra，死后
    // 编制表读不到了；真实游戏每帧都在刷快照，这里模拟"作战中阵亡"的时序）
    stepN(sim, 0.5);
    // 军团长阵亡 → 队长与兵全解除（命令链断裂）
    sim.killPawn(g);
    stepN(sim, 1);
    expect(draftedOf(sim.pawnStates.get(o))).toBe(false);
    expect(tacticsOf(sim.pawnStates.get(o))?.underOrder).toBeNull();
    expect(draftedOf(sim.pawnStates.get(s))).toBe(false);
    // 单独一队（o 自己当队长带 s）：兵死亡 → 编制摘除
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: o, args: { subordinates: [s] } });
    sim.killPawn(s);
    stepN(sim, 1);
    expect(commanderOf(sim.pawnStates.get(o))?.subordinates).toEqual([]);
  });

  it('⑪ 玩家解除征召 → 战术命令失效（尊重玩家指挥，不拉回）', () => {
    const sim = makeSim(51, 2);
    const [g, s] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [s] } });
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'hold' } });
    expect(draftedOf(sim.pawnStates.get(s))).toBe(true);
    sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: s, args: { drafted: false } });
    stepN(sim, 1);
    expect(draftedOf(sim.pawnStates.get(s))).toBe(false);
    expect(tacticsOf(sim.pawnStates.get(s))?.underOrder).toBeNull(); // 战术清（不拉回）
  });

  it('⑫ 存档往返：commander/tactics 随档透传，读档后树结构完好', () => {
    const sim = makeSim(52, 3);
    const [g, o, s] = sim.pawns;
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [o, s] } });
    sim.issueCommand({ type: 'train', x: 0, y: 0, pawnId: o, args: { tactic: 'charge' } });
    // 集火需要真实敌人（command 处理器校验 hostileIndex 存在性——先放站桩敌再下令）
    addRaider(sim, Math.round(sim.pawnPositions.get(g)!.x) + 5, Math.round(sim.pawnPositions.get(g)!.y));
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'focus', hostileIndex: 0 } });
    stepN(sim, 2);
    const data = JSON.parse(JSON.stringify(sim.save()));
    const sim2 = new Sim({ seed: 53, pawnCount: 0 });
    sim2.load(data);
    expect(commanderOf(sim2.pawnStates.get(g))?.subordinates).toEqual([o, s]);
    expect(tacticsOf(sim2.pawnStates.get(o))?.learned).toContain('charge');
    // 受命态随档（征召也是）——读档后继续受命执行；存档不含 hostiles（敌袭是运行时
    // 状态），集火目标须重新在场：目标消失自动解除是产品语义，场上有目标则命令保持
    expect(draftedOf(sim2.pawnStates.get(o))).toBe(true);
    addRaider(sim2, Math.round(sim2.pawnPositions.get(o)!.x) + 5, Math.round(sim2.pawnPositions.get(o)!.y));
    stepN(sim2, 1);
    expect(tacticOf(sim2.pawnStates.get(o))).toBe('focus'); // 命令链随档透传保持
  });

  it('⑬ 卸载安全：清单无 field-command → 装配/步进正常、3 命令不注册、战术残留零处置无害', () => {
    const r = new ModRegistry({
      tiles: TILES, buildings: BUILDINGS, items: ITEMS, enemies: ENEMIES,
      cards: BASE_CARDS, recipes: RECIPES, tuning: TUNING, intents: [], works: [],
    });
    const list = DEFAULT_PLAYSTYLE_PACKS.filter((p) => p !== 'field-command');
    const mgr: ModPack = {
      id: 'test-manager-no-fc',
      apply(m: ModRegistry): void {
        for (const id of list) {
          const pack = PLAYSTYLE_PACKS[id];
          if (!pack) throw new Error(`mod: 测试清单引用了未登记包 "${id}"`);
          m.registerPack(pack);
        }
        const agg: ModPack = { id: 'test-agg-no-fc', requires: list, apply() {} };
        m.mount(agg);
        const violations = validateContracts(m);
        if (violations.length > 0) throw new Error(violations.join('\n'));
      },
    };
    r.registerPack(mgr);
    r.mount({ id: 'test-root-no-fc', requires: ['test-manager-no-fc'], apply() {} });
    const sim = new Sim({ seed: 41, pawnCount: 2, registry: r });
    expect(sim.systemIds).not.toContain('field-command');
    expect(sim.mods.commandHandlers.has('commander')).toBe(false);
    expect(sim.mods.commandHandlers.has('train')).toBe(false);
    expect(sim.mods.commandHandlers.has('dispatch')).toBe(false);
    stepN(sim, 3); // 60 帧不崩（战术语义无人驱动 = 无处置者，残留字段无害）
  });

  it('⑭ 协议：snapshot 携带 commander/tactic，delta 仅在变化时下发（仿 server 快照填充）', () => {
    const sim = makeSim(54, 2);
    const [g, s] = sim.pawns;
    // 模拟 server 端快照填充（server/index.ts 从 extra 序列化 commander/tactic 的等价行为）
    const snapLike = (): SnapshotMsg => ({
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
          lastDecision: undefined,
          worn: '',
          drafted: p.drafted === true || undefined,
          commander: p.commander,
          tactic: p.tactic,
        };
      }),
      hostiles: [], buildings: [], buildQueue: [], buildingVersion: 0,
    });
    const snap1 = snapLike();
    // 册封 + 下发战术 → 第二次快照含 commander/tactic
    sim.issueCommand({ type: 'commander', x: 0, y: 0, pawnId: g, args: { subordinates: [s] } });
    sim.issueCommand({ type: 'dispatch', x: 0, y: 0, pawnId: g, args: { tactic: 'hold' } });
    const snap2 = snapLike();
    const pg = snap2.pawns.find((p) => p.eid === g)!;
    const ps = snap2.pawns.find((p) => p.eid === s)!;
    expect(pg.commander?.role).toBe('officer');
    expect(pg.commander?.subordinates).toEqual([s]);
    expect(pg.tactic).toBe('hold'); // 指挥官自身也受命（战术回显）
    expect(ps.tactic).toBe('hold');
    expect(ps.commander).toBeUndefined(); // 兵不是指挥官
    expect(ps.drafted).toBe(true); // 受命伴随征召（HUD 征召渲染一致）
    // delta：册封动作 3 个变化（g.commander/g.tactic/s.tactic）逐项下发
    const d1 = buildDelta(snap1, snap2)!;
    const pdg = d1.pawns?.find((p) => p.eid === g)!;
    expect(pdg.commander?.subordinates).toEqual([s]);
    expect(pdg.tactic).toBe('hold');
    expect(d1.pawns?.find((p) => p.eid === s)?.tactic).toBe('hold');
    // 无变化 → 不发 pawns delta（带宽纪律：战术静止不刷屏）
    const snap3 = snapLike();
    const d2 = buildDelta(snap2, snap3);
    expect(d2).toBeNull(); // 无变化 → buildDelta 返回 null（不发 pawns 增量：战术静止不刷屏）
  });

  it('⑮ cmdValidate：commander/train/dispatch 形状校验（非法拒绝、合法放行）', () => {
    const sim = makeSim(55, 2);
    const e0 = sim.pawns[0];
    const guard: CmdGuardState = { lastCmdAt: 0, budget: 10 };
    const ok = (c: unknown) => validateCommand(sim, c, guard, 1).ok;
    // 合法
    expect(ok({ type: 'commander', pawnId: e0, x: 0, y: 0, args: { role: 'officer', subordinates: [] } })).toBe(true);
    expect(ok({ type: 'train', pawnId: e0, x: 0, y: 0, args: { tactic: 'charge' } })).toBe(true);
    expect(ok({ type: 'dispatch', pawnId: e0, x: 0, y: 0, args: { tactic: 'none' } })).toBe(true);
    // 非法
    expect(ok({ type: 'commander', pawnId: e0, x: 0, y: 0, args: { role: 'marshal' } })).toBe(false); // 未知 role
    expect(ok({ type: 'commander', pawnId: e0, x: 0, y: 0, args: { subordinates: [9999] } })).toBe(false); // 下属不存在
    expect(ok({ type: 'commander', pawnId: 9999, x: 0, y: 0, args: {} })).toBe(false); // 小人不存在
    expect(ok({ type: 'train', pawnId: e0, x: 0, y: 0, args: { tactic: 'unknownTac' } })).toBe(false); // 战术不存在
    expect(ok({ type: 'dispatch', pawnId: e0, x: 0, y: 0, args: { tactic: 'focus', hostileIndex: 5 } })).toBe(false); // 敌人越界
    expect(ok({ type: 'dispatch', pawnId: 9999, x: 0, y: 0, args: { tactic: 'hold' } })).toBe(false);
  });
});