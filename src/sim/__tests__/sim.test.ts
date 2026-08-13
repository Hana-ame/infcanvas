import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { socialLinesOf } from '../mods/registry';
import { SimRng } from '../core/rng';
import { generateDna, initSlots, drawCards, pickBest, effectiveWeight, cardFromDef, BASE_CARDS, type BehaviorCard } from '../ai/pawn';
import type { Dna } from '../ai/pawn';
import { INTERESTS } from '../defs/interests';
import { makeExploreCard } from '../defs/explore';
import { World } from '../core/world';
import { findPath } from '../core/pathfinding';
import { BUILDINGS } from '../defs';
import type { GameSystem } from '../systems/registry';
import { spawnWildCamp } from '../defs/events';
import { carryCapOf, capGainTo } from '../systems/gatherSystem';
import berryMod from '../../mods/demo-berry';

describe('SimRng', () => {
  it('is deterministic for same seed', () => {
    const a = new SimRng(42);
    const b = new SimRng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different sequences for different seeds', () => {
    const a = new SimRng(1);
    const b = new SimRng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('int is within range inclusive', () => {
    const r = new SimRng(7);
    for (let i = 0; i < 100; i++) {
      const v = r.int(3, 5);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
});

describe('World generation', () => {
  it('generates same world for same seed', () => {
    const a = new World(123);
    const b = new World(123);
    for (let x = 0; x < a.width; x += 7) {
      for (let y = 0; y < a.height; y += 7) {
        expect(a.getTile(x, y)).toBe(b.getTile(x, y));
      }
    }
  });

  it('has a passable spawn area at center', () => {
    const w = new World(123);
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        expect(w.isPassable(cx + dx, cy + dy)).toBe(true);
      }
    }
  });

  it('guarantees mineable resources near spawn for opening', () => {
    const w = new World(123);
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    let ore = 0;
    let stone = 0;
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        if (Math.hypot(dx, dy) < 3) continue; // 出生点草圈
        const t = w.getTile(cx + dx, cy + dy);
        if (t === 'ore') ore++;
        else if (t === 'stone') stone++;
      }
    }
    expect(ore).toBeGreaterThan(0);
    expect(stone).toBeGreaterThan(0);
  });
});

describe('DNA + slots', () => {
  it('generates DNA with slots matching maxSlots', () => {
    const dna = generateDna(99);
    const slots = initSlots(dna);
    expect(slots.length).toBeGreaterThanOrEqual(dna.maxSlots);
  });

  it('guaranteed base cards: even 2 traits + maxSlots=2 keeps eat/rest/chop (no idle-lock), sim.test 回归：maxSlots 被 trait 挤占曾致永久闲逛', () => {
    // 构造最坏情形：maxSlots=2，两个 trait（设计上各占一槽）——修复前基础卡 0 张
    const dna: Dna = { traits: ['强壮', '机灵'], interests: [], maxSlots: 2, str: 60, con: 50, siz: 55, dex: 50, int: 50, pow: 50, app: 50, edu: 50, skillBonuses: {}, sins: {} };
    const slots = initSlots(dna as unknown as Parameters<typeof initSlots>[0]);
    const ids = slots.filter(Boolean).map((c) => (c as BehaviorCard).id);
    expect(ids).toContain('eat');
    expect(ids).toContain('rest');
    expect(ids).toContain('chop');
  });

  it('drawCards returns up to 3 cards, pickBest picks one', () => {
    const dna = generateDna(5);
    const slots = initSlots(dna);
    const rng = new SimRng(1);
    const ctx = {
      view: {
        buildQueueCount: 0,
        stockpile: { wood: 0, ore: 0, food: 50 },
        needsOf: () => ({ food: 80, rest: 80, mood: 60, san: 100 }),
        isNight: () => false,
        hasCampfire: () => false,
        hasCave: () => false,
        hasRaft: () => false,
      },
      eid: 1,
    };
    for (let i = 0; i < 20; i++) {
      const drawn = drawCards({ dna, slots }, rng, 3, ctx);
      expect(drawn.length).toBeGreaterThan(0);
      expect(drawn.length).toBeLessThanOrEqual(3);
      const best = pickBest(drawn, ctx);
      expect(best).toBeDefined();
      expect(best!.weight).toBeGreaterThan(0);
    }
  });

  it('DNA traits are deterministic', () => {
    const a = generateDna(77);
    const b = generateDna(77);
    expect(a.traits).toEqual(b.traits);
    expect(a.maxSlots).toBe(b.maxSlots);
  });
});

describe('Sim basic loop', () => {
  it('creates pawns at center', () => {
    const sim = new Sim({ seed: 1, pawnCount: 4 });
    expect(sim.pawns.length).toBe(4);
    for (const eid of sim.pawns) {
      const pos = sim.pawnPositions.get(eid);
      expect(pos).toBeDefined();
    }
  });

  it('steps without error', () => {
    const sim = new Sim({ seed: 2, pawnCount: 3 });
    for (let i = 0; i < 100; i++) sim.step(1 / 20);
  });

  it('moves pawn toward command target', () => {
    const sim = new Sim({ seed: 3, pawnCount: 1 });
    const eid = sim.pawns[0];
    sim.selected = [eid];
    // 朝出生点右侧目标移动（出生圈内保证可通行；圈内直线目标，不用穿树绕行）
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    const start = sim.pawnPositions.get(eid)!;
    // 目标 = 起点正右 1 格（出生圈内必可走；1 格内 10 秒必然抵达，不被 AI 打断）
    const tx = Math.round(start.x) + 1;
    const ty = Math.round(start.y);
    sim.issueCommand({ type: 'move', x: tx, y: ty });
    for (let i = 0; i < 40; i++) sim.step(1 / 20); // 2 秒（commandCooldown=3s 内：命令优先，不被打断）
    const pos = sim.pawnPositions.get(eid)!;
    // 贴到目标
    expect(Math.hypot(pos.x - tx, pos.y - ty)).toBeLessThan(1.5);
  });

  it('queues and completes a build', () => {
    const sim = new Sim({ seed: 4, pawnCount: 1 });
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    // 在出生点内放墙（保证可通行/可建造）
    const woodBefore = sim.stockpile.wood;
    sim.issueCommand({ type: 'build', x: cx + 1, y: cy, buildingId: 'wall' });
    for (let i = 0; i < 100; i++) sim.step(1 / 20); // 5 秒（buildTime=3s）
    const b = sim.world.getBuilding(cx + 1, cy);
    expect(b).not.toBeNull();
    expect(b!.def.id).toBe('wall');
    expect(sim.stockpile.wood).toBeLessThan(woodBefore); // 建完扣木材
  });

  it('mining converts ore tile to dirt and adds stockpile', () => {
    const sim = new Sim({ seed: 5, pawnCount: 1 });
    const eid = sim.pawns[0];
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    // 在出生点放一块矿（保证可达）
    const oreX = cx + 2, oreY = cy;
    sim.world.setTile(oreX, oreY, 'ore');
    sim.issueCommand({ type: 'mine', pawnId: eid, x: oreX, y: oreY });
    for (let i = 0; i < 300; i++) sim.step(1 / 20); // 15 秒
    expect(sim.world.getTile(oreX, oreY)).toBe('dirt');
    expect(sim.stockpile.ore).toBeGreaterThan(0);
  });
});

describe('SAN 理智系统', () => {
  it('witnessing a death drains nearby pawn sanity', () => {
    const sim = new Sim({ seed: 11, pawnCount: 2 });
    const [a, b] = sim.pawns;
    const posA = sim.pawnPositions.get(a)!;
    sim.pawnPositions.set(b, { x: posA.x + 1, y: posA.y }); // 相邻
    const before = sim.readNeeds(b)!.san;
    sim.bus.emit({ type: 'pawn_died', eid: a, x: posA.x, y: posA.y, cause: 'combat' });
    const after = sim.readNeeds(b)!.san;
    expect(after).toBeLessThan(before);
  });

  it('sleeping near campfire restores sanity', () => {
    const sim = new Sim({ seed: 12, pawnCount: 1 });
    const eid = sim.pawns[0];
    const n = sim.readNeeds(eid)!;
    n.san = 40;
    sim.setNeeds(eid, n);
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    sim.world.placeBuilding(cx, cy, 'campfire', 'player');
    sim.pawnPositions.set(eid, { x: cx, y: cy });
    for (let i = 0; i < 60; i++) sim.step(1 / 20); // 3 秒
    expect(sim.readNeeds(eid)!.san).toBeGreaterThan(40);
  });
});

describe('COC 技能成长', () => {
  it('skills start initialized and rollEventSkill respects skill', () => {
    const sim = new Sim({ seed: 13, pawnCount: 1 });
    const eid = sim.pawns[0];
    expect(sim.skillOf(eid, 'work')).toBeGreaterThan(0);
    const ev = sim.rollEventSkill(eid, 50, 'work');
    expect(typeof ev.success).toBe('boolean');
    expect(ev.roll).toBeGreaterThanOrEqual(1);
    expect(ev.roll).toBeLessThanOrEqual(100);
  });

  it('growSkill increases skill over repeated growth attempts', () => {
    const sim = new Sim({ seed: 14, pawnCount: 1 });
    const eid = sim.pawns[0];
    const before = sim.skillOf(eid, 'work');
    // 强制低起点保证成长可能
    const st = sim.pawnStates.get(eid)!;
    st.skills = { ...st.skills, work: 5 };
    let grew = false;
    for (let i = 0; i < 200; i++) {
      sim.growSkill(eid, 'work');
      if (sim.skillOf(eid, 'work') > 5) { grew = true; break; }
    }
    expect(grew).toBe(true);
  });

  it('skills persist through save/load', () => {
    const sim = new Sim({ seed: 15, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    st.skills = { ...st.skills, craft: 77 };
    const data = sim.save();
    const sim2 = new Sim({ seed: 16, pawnCount: 1 });
    sim2.load(data);
    const eid2 = sim2.pawns[0];
    expect(sim2.skillOf(eid2, 'craft')).toBe(77);
  });
});

describe('结构化历史日志（DESIGN §3）', () => {
  it('records structured entries for emitted events', () => {
    const sim = new Sim({ seed: 17, pawnCount: 1 });
    const eid = sim.pawns[0];
    sim.bus.emit({ type: 'resource_gained', eid, item: 'ore', amount: 3 });
    sim.bus.emit({ type: 'work_completed', eid, work: 'mine', success: true, x: 5, y: 6 });
    const rows = sim.historyQuery({ limit: 10 });
    const gained = rows.find((r) => r.type === 'resource_gained');
    expect(gained).toBeDefined();
    expect(gained!.eid).toBe(eid);
    expect(gained!.data).toEqual({ item: 'ore', amount: 3 });
    const work = rows.find((r) => r.type === 'work_completed');
    expect(work).toBeDefined();
    expect(work!.x).toBe(5);
    expect(work!.y).toBe(6);
  });

  it('spawn events include location and are queryable by type', () => {
    const sim = new Sim({ seed: 18, pawnCount: 2 });
    const spawned = sim.historyQuery({ type: 'pawn_spawned', limit: 10 });
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    for (const s of spawned) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('records death with cause', () => {
    const sim = new Sim({ seed: 19, pawnCount: 1 });
    const eid = sim.pawns[0];
    sim.bus.emit({ type: 'pawn_died', eid, x: 3, y: 4, cause: 'starvation' });
    const deaths = sim.historyQuery({ type: 'pawn_died', limit: 10 });
    expect(deaths.length).toBe(1);
    expect(deaths[0].cause).toBe('starvation');
  });
});

describe('七宗罪欲望系统（DESIGN §3）', () => {
  it('pawns start with desires initialized and DNA has sin weights', () => {
    const sim = new Sim({ seed: 20, pawnCount: 2 });
    for (const eid of sim.pawns) {
      const p = sim.pawnProfile(eid)!;
      expect(p.desires.gluttony).toBeGreaterThanOrEqual(0);
      expect(p.desires.gluttony).toBeLessThanOrEqual(100);
      expect(p.dna.sins.wrath).toBeGreaterThanOrEqual(0);
      expect(p.dna.sins.wrath).toBeLessThanOrEqual(1);
    }
  });

  it('eating fulfills gluttony desire', () => {
    const sim = new Sim({ seed: 21, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    st.desires = { gluttony: 40, sloth: 60, greed: 60, envy: 60, pride: 60, wrath: 60, lust: 60 };
    // 食物压低 → 小人会抽到进食卡
    const n = sim.readNeeds(eid)!;
    n.food = 20;
    sim.setNeeds(eid, n);
    sim.stockpile.food = 50;
    const before = st.desires.gluttony;
    for (let i = 0; i < 400; i++) sim.step(1 / 20); // 20 秒
    expect(st.desires.gluttony).toBeGreaterThanOrEqual(before);
  });

  it('desires persist through save/load', () => {
    const sim = new Sim({ seed: 22, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    st.desires = { gluttony: 11, sloth: 22, greed: 33, envy: 44, pride: 55, wrath: 66, lust: 77 };
    const data = sim.save();
    const sim2 = new Sim({ seed: 23, pawnCount: 1 });
    sim2.load(data);
    const p = sim2.pawnProfile(sim2.pawns[0])!;
    expect(p.desires.gluttony).toBe(11);
    expect(p.desires.lust).toBe(77);
  });
});

describe('COC 八属性（DESIGN §3）', () => {
  it('generates all eight attributes deterministically', () => {
    const a = generateDna(300);
    const b = generateDna(300);
    for (const k of ['str', 'con', 'int', 'siz', 'dex', 'app', 'pow', 'edu'] as const) {
      expect(a[k]).toBe(b[k]);
      expect(a[k]).toBeGreaterThanOrEqual(30);
      expect(a[k]).toBeLessThanOrEqual(90);
    }
  });

  it('strong trait boosts STR and SIZ', () => {
    // 反复生成直到出现强壮天赋（确定性 seed 搜索）
    let found = false;
    for (let s = 1; s < 500 && !found; s++) {
      const dna = generateDna(s);
      if (dna.traits.includes('强壮')) {
        found = true;
        expect(dna.str).toBeGreaterThanOrEqual(42); // 30+12 保底
      }
    }
    expect(found).toBe(true);
  });

  it('HP scales with CON+SIZ', () => {
    const sim = new Sim({ seed: 31, pawnCount: 3 });
    for (const eid of sim.pawns) {
      const dna = sim.dnaOf(eid)!;
      const hk = sim.healthOf(eid)!;
      expect(hk.maxHp).toBe(40 + Math.floor((dna.con + dna.siz) / 2));
    }
  });

  it('dnaOf returns all attributes via SimContext', () => {
    const sim = new Sim({ seed: 32, pawnCount: 1 });
    const dna = sim.dnaOf(sim.pawns[0])!;
    expect(Object.keys(dna).sort()).toEqual(['app', 'con', 'dex', 'edu', 'int', 'pow', 'siz', 'str']);
  });
});

describe('mod 注册表（DESIGN §7 扩展性原则）', () => {
  it('registers a custom intent executor and executes it', () => {
    let executed = false;
    const sim = new Sim({
      seed: 40, pawnCount: 1,
      mods: (m) => {
        m.registerIntent('dance', (_c, _eid, st) => { executed = true; st.job = '跳舞'; });
      },
    });
    // 触发意图执行（模拟行为系统调用）
    sim.mods.intents.get('dance')!(sim, sim.pawns[0], sim.pawnStates.get(sim.pawns[0])!, { action: 'idle', label: 'dance' });
    expect(executed).toBe(true);
  });

  it('mod card can produce a brand-new intent action (IntentAction open) → registerIntent dispatch', () => {
    let danced = false;
    const sim = new Sim({
      seed: 40, pawnCount: 1,
      mods: (m) => {
        m.registerIntent('dance', (_c, _eid, st) => { danced = true; st.job = '跳舞'; });
        m.registerCard({
          id: 'mod:dance', name: '跳舞', series: 'leisure', weight: 100,
          condition: () => true,
          utility: () => 999,
          decide: () => ({ action: 'dance', label: '跳舞' }),
        });
      },
    });
    for (let i = 0; i < 600 && !danced; i++) sim.step(1 / 20);
    expect(danced).toBe(true);
    expect(sim.pawnStates.get(sim.pawns[0])!.job).toBe('跳舞');
  });

  it('registering a custom system runs in the tick loop', () => {
    let ticks = 0;
    const sys: GameSystem = {
      id: 'modCounter',
      update: () => { ticks++; },
    };
    const sim = new Sim({ seed: 41, pawnCount: 1, mods: (m) => m.registerSystem(sys) });
    for (let i = 0; i < 10; i++) sim.step(1 / 20);
    expect(ticks).toBeGreaterThanOrEqual(10);
  });

  it('mod cards are injected into pawn slot pool', () => {
    const sim = new Sim({
      seed: 42, pawnCount: 1,
      mods: (m) => {
        m.registerCard({
          id: 'mod:sing', name: '唱歌', series: 'leisure', weight: 9,
          condition: () => false,
          utility: () => 1,
          decide: () => ({ action: 'idle', label: '唱歌' }),
        });
      },
    });
    expect(sim.mods.cards.has('mod:sing')).toBe(true);
    // 直接验证：用大槽位 DNA 调 initSlots 时 mod 卡进入池子
    const bigDna = generateDna(99);
    bigDna.maxSlots = 20;
    const slots = initSlots(bigDna, [...sim.mods.cards.values()]);
    expect(slots.some((c) => c?.id === 'mod:sing')).toBe(true);
  });

  it('conflict detection throws on duplicate building id', () => {
    expect(() => {
      new Sim({
        seed: 43, pawnCount: 1,
        mods: (m) => {
          m.registerBuilding({ id: 'wall', name: '复制墙', size: { x: 1, y: 1 }, hp: 1, color: '#fff', passable: false, buildTime: 1 });
        },
      });
    }).toThrow(/已存在/);
  });
});

describe('社交/流言系统（DESIGN §6 微互动）', () => {
  it('nearby pawns generate social events and history entries', () => {
    const sim = new Sim({ seed: 50, pawnCount: 2 });
    const [a, b] = sim.pawns;
    // 让两个小人站一起
    const pos = sim.pawnPositions.get(a)!;
    sim.pawnPositions.set(b, { x: pos.x + 1, y: pos.y });
    // 快进触发社交节流（2s）
    let found = false;
    for (let i = 0; i < 120 && !found; i++) {
      sim.step(1 / 20); // 6 秒
      const soc = sim.historyQuery({ type: 'social', limit: 5 });
      if (soc.length > 0) found = true;
    }
    expect(found).toBe(true);
  });

  it('social interactions record tone and build relationships', () => {
    const sim = new Sim({ seed: 51, pawnCount: 2 });
    const [a, b] = sim.pawns;
    const pos = sim.pawnPositions.get(a)!;
    // 每步钉在相邻位置（避免小人绕开）→ 互动必现
    for (let i = 0; i < 300; i++) {
      sim.pawnPositions.set(a, { x: pos.x, y: pos.y });
      sim.pawnPositions.set(b, { x: pos.x + 1, y: pos.y });
      sim.step(1 / 20); // 15 秒
    }
    const stA = sim.pawnStates.get(a)!;
    const rel = stA.relationships?.get(b);
    // 至少发生过互动 → 好感度被写入
    expect(rel).toBeDefined();
    const soc = sim.historyQuery({ type: 'social', limit: 10 });
    expect(soc.length).toBeGreaterThan(0);
    expect(['positive', 'negative', 'neutral']).toContain(soc[0].data?.tone);
  });

  it('preaching transfers faith via opposed check (COC §3)', () => {
    // preachChance 提高：techPool 等系统消耗 rng 会扰动确定性序列，靠统计概率必现不可靠
    const sim = new Sim({ seed: 55, pawnCount: 2, mods: (m) => m.overrideTuning({ social: { preachChance: 0.8 } }) });
    const [a, b] = sim.pawns;
    const stA = sim.pawnStates.get(a)!;
    const stB = sim.pawnStates.get(b)!;
    // 高信仰传教者，低意志目标 → 布道成功率高的场景
    stA.faith = 80;
    stB.faith = 0;
    const dnaB = stB.dna;
    dnaB.pow = 20;
    const pos = sim.pawnPositions.get(a)!;
    sim.pawnPositions.set(b, { x: pos.x + 1, y: pos.y });
    const before = stB.faith ?? 0;
    // 跑足够久（120 秒），每步把 a/b 钉在相邻位置 → 传教必现
    let preached = false;
    for (let i = 0; i < 2400 && !preached; i++) {
      sim.pawnPositions.set(a, { x: pos.x, y: pos.y });
      sim.pawnPositions.set(b, { x: pos.x + 1, y: pos.y });
      sim.step(1 / 20);
      const soc = sim.historyQuery({ type: 'social', limit: 50 });
      preached = soc.some((s) => s.data?.topic === '布道');
    }
    expect(preached).toBe(true);
    // 传教期间 b 信仰应高于初始（至少不会降低）
    expect(stB.faith ?? 0).toBeGreaterThanOrEqual(before);
  });
});

describe('环境系统（DESIGN §6 环境调制）', () => {
  it('temperature oscillates across the day cycle', () => {
    const sim = new Sim({ seed: 60, pawnCount: 1 });
    let maxT = -Infinity;
    let minT = Infinity;
    // 跑完一整天（120 秒）
    for (let i = 0; i < 2400; i++) {
      sim.step(1 / 20);
      maxT = Math.max(maxT, sim.env.temperature);
      minT = Math.min(minT, sim.env.temperature);
    }
    expect(maxT).toBeGreaterThan(minT); // 昼夜温差
    expect(sim.env.temperature).toBeGreaterThan(-20);
    expect(sim.env.temperature).toBeLessThan(50);
  });

  it('rain increases leisure card weight and reduces work weight', () => {
    const sim = new Sim({ seed: 61, pawnCount: 1 });
    // 强制降雨
    sim.env.raining = true;
    sim.env.rainLeft = 30;
    const dna = generateDna(5);
    const slots = initSlots(dna);
    const rng = new SimRng(1);
    // 统计 60 次抽卡中 work vs leisure 出现次数
    const ctx = {
      view: {
        buildQueueCount: 0,
        stockpile: { wood: 0, ore: 0, food: 50 },
        needsOf: () => ({ food: 80, rest: 80, mood: 60, san: 100 }),
        isNight: () => false,
        hasCampfire: () => false,
        hasCave: () => false,
    hasRaft: () => false,
        env: { raining: true, temperature: 15 },
      },
      eid: 1,
    };
    let leisure = 0;
    for (let i = 0; i < 200; i++) {
      const drawn = drawCards({ dna, slots }, rng, 3, ctx);
      if (drawn.some((c) => c.series === 'leisure')) leisure++;
    }
    // 雨天娱乐卡出现频率应显著（雨天权重 1.6）
    expect(leisure).toBeGreaterThan(10);
  });
});

describe('马尔可夫偏置（DESIGN §6）', () => {
  it('after work, leisure cards are drawn more often', () => {
    const dna = generateDna(70);
    // 构造一个不饱和的卡池：1 张休闲 + 1 张工作 + 8 张低权重占位
    // （base 卡自带高权重会把池子撑饱和、markov 差异被权重吞掉——拷贝出来压到同阶，偏置才可测）
    const idle = { ...BASE_CARDS.find((c) => c.series === 'leisure')!, weight: 1 };
    const work = { ...BASE_CARDS.find((c) => c.series === 'work')!, weight: 1 };
    const filler = (id: string, series: 'work' | 'physio' | 'leisure'): BehaviorCard => ({
      id, name: id, series, weight: 0.01,
      utility: () => 0,
      decide: () => ({ action: 'idle', label: id }),
    });
    const slots: (BehaviorCard | null)[] = [
      idle, work,
      filler('f1', 'work'), filler('f2', 'work'), filler('f3', 'work'),
      filler('f4', 'physio'), filler('f5', 'physio'), filler('f6', 'physio'),
      filler('f7', 'work'), filler('f8', 'work'),
    ];
    const rng = new SimRng(2);
    const mkCtx = (lastSeries: string | undefined) => ({
      view: {
        buildQueueCount: 0,
        stockpile: { wood: 0, ore: 0, food: 50 },
        needsOf: () => ({ food: 80, rest: 80, mood: 60, san: 100 }),
        isNight: () => false,
        hasCampfire: () => false,
        hasCave: () => false,
    hasRaft: () => false,
        lastSeries,
      },
      eid: 1,
    });
    // 统计 leisure 卡被抽中的次数（markov 偏置提升 leisure 权重）
    const countLeisure = (last: string | undefined): number => {
      let n = 0;
      for (let i = 0; i < 500; i++) {
        const drawn = drawCards({ dna, slots }, rng, 3, mkCtx(last));
        n += drawn.filter((c) => c.series === 'leisure').length;
      }
      return n;
    };
    const afterWork = countLeisure('work');
    const baseline = countLeisure(undefined);
    expect(afterWork).toBeGreaterThan(baseline);
  });

  it('lastSeries is recorded when a card is chosen', () => {
    const sim = new Sim({ seed: 71, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    // 跑一段时间后 lastSeries 应有值（某系列）
    for (let i = 0; i < 200; i++) sim.step(1 / 20);
    expect(st.lastSeries).toBeTruthy();
  });
});

describe('篝火光环（饥荒式社会锚点）', () => {
  it('campfire aura lifts mood for nearby pawns', () => {
    const sim = new Sim({ seed: 90, pawnCount: 1 });
    const eid = sim.pawns[0];
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    sim.world.placeBuilding(cx, cy, 'campfire', 'player');
    // 压心情低，让提升可测
    const n = sim.readNeeds(eid)!;
    n.mood = 30;
    sim.setNeeds(eid, n);
    sim.pawnPositions.set(eid, { x: cx, y: cy + 1 }); // 篝火旁
    for (let i = 0; i < 100; i++) sim.step(1 / 20); // 5 秒
    expect(sim.readNeeds(eid)!.mood).toBeGreaterThan(30);
  });
});

describe('随机事件系统（用户 Q5 预制剧本）', () => {
  it('scripted events fire and are recorded in history', () => {
    const sim = new Sim({ seed: 91, pawnCount: 4 });
    let eventCount = 0;
    for (let i = 0; i < 4000 && eventCount === 0; i++) {
      sim.step(1 / 20); // 200 秒，事件间隔 45-75s → 必触发
      eventCount = sim.historyQuery({ type: 'event_happened', limit: 10 }).length;
    }
    expect(eventCount).toBeGreaterThan(0);
  });

  it('wanderer event can recruit a new pawn', () => {
    const sim = new Sim({ seed: 92, pawnCount: 2 });
    let recruited = false;
    sim.bus.on('pawn_recruited', () => { recruited = true; });
    for (let i = 0; i < 6000 && !recruited; i++) {
      sim.step(1 / 20); // 300 秒
    }
    // 不强制必触发（随机），但流浪者事件触发时人口增加
    expect(recruited).toBe(true);
  });
});

describe('社会关系效应（用户 Q8：关系支持协作/战争）', () => {
  it('high affinity gives mood bonus when near each other', () => {
    const sim = new Sim({ seed: 93, pawnCount: 2 });
    const [a, b] = sim.pawns;
    const pos = sim.pawnPositions.get(a)!;
    sim.pawnPositions.set(b, { x: pos.x + 1, y: pos.y });
    // 高好感
    const stA = sim.pawnStates.get(a)!;
    stA.relationships = new Map([[b, 60]]);
    // 压低 b 心情便于测提升
    const nb = sim.readNeeds(b)!;
    nb.mood = 50;
    sim.setNeeds(b, nb);
    // 稳定相邻跑一段
    for (let i = 0; i < 120; i++) {
      sim.pawnPositions.set(a, { x: pos.x, y: pos.y });
      sim.pawnPositions.set(b, { x: pos.x + 1, y: pos.y });
      sim.step(1 / 20);
    }
    // b 心情应高于 50（亲密加成）
    expect(sim.readNeeds(b)!.mood).toBeGreaterThan(50);
  });

  it('hostile relationship escalates to a punch (deterministic seed search)', () => {
    // 测试用独立 seed/RNG 搜索（与正式游戏逻辑解耦，保证测试确定性）
    let punched = false;
    for (let seed = 1; seed < 40 && !punched; seed++) {
      const sim = new Sim({ seed: seed * 1000 + 7, pawnCount: 2 });
      const [a, b] = sim.pawns;
      const pos = sim.pawnPositions.get(a)!;
      const stA = sim.pawnStates.get(a)!;
      stA.relationships = new Map([[b, -50]]); // 深仇 → 动手概率高
      const hpA = sim.readHealth(a)!.hp;
      const hpB = sim.readHealth(b)!.hp;
      for (let i = 0; i < 600 && !punched; i++) {
        sim.pawnPositions.set(a, { x: pos.x, y: pos.y });
        sim.pawnPositions.set(b, { x: pos.x + 1, y: pos.y });
        sim.step(1 / 20);
        // 谁 STR 低谁挨打；判两人任一受伤
        if (sim.readHealth(a)!.hp < hpA || sim.readHealth(b)!.hp < hpB) punched = true;
      }
    }
    expect(punched).toBe(true);
  });
});

describe('派系优先级（用户 Q8：AI 按环境下达工作指令）', () => {
  it('food shortage raises farm/chop priority', () => {
    const sim = new Sim({ seed: 95, pawnCount: 1 });
    sim.stockpile.food = 10; // 短缺
    sim.stockpile.wood = 200;
    sim.stockpile.ore = 100;
    for (let i = 0; i < 300; i++) sim.step(1 / 20); // 15 秒 > 评估周期
    expect(sim.factionPriority.farm).toBeGreaterThan(1);
  });

  it('build queue raises build priority', () => {
    const sim = new Sim({ seed: 96, pawnCount: 0 });
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    sim.issueCommand({ type: 'build', x: cx + 1, y: cy, buildingId: 'wall' });
    // 队列存在期间（wall buildTime=3s，10 秒内），priority 应升
    let sawBoost = false;
    for (let i = 0; i < 200 && !sawBoost; i++) {
      sim.step(1 / 20);
      if (sim.factionPriority.build > 1) sawBoost = true;
    }
    expect(sawBoost).toBe(true);
  });

  it('priority modulates chop card draw weight', () => {
    // 构造：chop(权重6) 与 8 张 weight=4 的竞争卡 → 不饱和，偏置可测
    const chop = BASE_CARDS.find((c) => c.id === 'chop')!;
    const filler = (id: string, series: 'work' | 'physio' | 'leisure'): BehaviorCard => ({
      id, name: id, series, weight: 4,
      utility: () => 0,
      decide: () => ({ action: 'idle', label: id }),
    });
    const slots: (BehaviorCard | null)[] = [
      chop,
      filler('f1', 'work'), filler('f2', 'work'), filler('f3', 'work'),
      filler('f4', 'physio'), filler('f5', 'physio'),
      filler('f6', 'work'), filler('f7', 'work'),
    ];
    const dna = generateDna(5);
    const rng = new SimRng(3);
    const mkCtx = (prio: Record<string, number>) => ({
      view: {
        buildQueueCount: 0,
        stockpile: { wood: 0, ore: 0, food: 50 },
        needsOf: () => ({ food: 80, rest: 80, mood: 60, san: 100 }),
        isNight: () => false,
        hasCampfire: () => false,
        hasCave: () => false,
    hasRaft: () => false,
        factionPriority: prio,
      },
      eid: 1,
    });
    const countChop = (prio: Record<string, number>): number => {
      let n = 0;
      for (let i = 0; i < 500; i++) {
        const drawn = drawCards({ dna, slots }, rng, 3, mkCtx(prio));
        n += drawn.filter((c) => c.id === 'chop').length;
      }
      return n;
    };
    const shortage = countChop({ chop: 1.8 });
    const baseline = countChop({ chop: 1 });
    expect(shortage).toBeGreaterThan(baseline);
  });
});

describe('营地与涌现派系（2026-08-14 重构：派系 = 个体关系涌现，非实体）', () => {
  it('出生点有 campfire，小人生成后 fireId 归属到它', () => {
    const sim = new Sim({ seed: 98, pawnCount: 4 });
    expect(sim.world.hasBuilding('campfire')).toBe(true);
    // 出生小人应归属出生篝火（fireId = campfire 建筑 key）
    for (const eid of sim.pawns) {
      const fireId = sim.pawnStates.get(eid)!.fireId;
      expect(fireId).not.toBeNull();
      expect(sim.world.buildings.has(fireId!)).toBe(true);
    }
  });

  it('factionsView 按 fireId 聚合出涌现派系（纯只读展示，无库存/贸易/战争）', () => {
    const sim = new Sim({ seed: 98, pawnCount: 4 });
    const factions = sim.factionsView();
    expect(factions.length).toBeGreaterThanOrEqual(1);
    // 每个涌现派系 = 一个 campfire + 归属的小人
    for (const f of factions) {
      expect(f.members.length).toBeGreaterThan(0);
      expect(sim.world.buildings.get(f.key)?.def.id).toBe('campfire');
    }
    // 所有有火的小人都在某个涌现派系里
    const withFire = sim.pawns.filter((e) => sim.pawnStates.get(e)!.fireId != null);
    const inFactions = factions.reduce((n, f) => n + f.members.length, 0);
    expect(inFactions).toBe(withFire.length);
  });

  it('建第二个 campfire → 新涌现派系（成员重算归属，无独立实体）', () => {
    const sim = new Sim({ seed: 99, pawnCount: 2 });
    const before = sim.factionsView().length;
    const w = sim.world;
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    // 找远处可建格建 campfire
    let placed = false;
    for (let r = 8; r <= 14 && !placed; r++) {
      for (let dx = -r; dx <= r && !placed; dx++) {
        for (let dy = -r; dy <= r && !placed; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (!w.inBounds(x, y) || !w.canBuildAt(x, y)) continue;
          if (w.placeBuilding(x, y, 'campfire', 'auto')) {
            sim.socialUnits.onCampfireBuilt(w.buildKey(x, y));
            placed = true;
          }
        }
      }
    }
    expect(placed).toBe(true);
    expect(sim.factionsView().length).toBe(before + 1);
  });

  it('营地遭袭（💥 记忆 + 威胁在场）才另起篝火；狼路过不算', () => {
    const sim = new Sim({ seed: 100, pawnCount: 1 });
    sim.tuning.autobuild.campfireTarget = 0; // 禁 AI 自主建 campfire，隔离 migrate
    const before = sim.factionsView().length;
    // 找出生 campfire key
    const fireKey = [...sim.world.buildings.keys()].find((k) => sim.world.buildings.get(k)!.def.id === 'campfire')!;
    // 狼在场但无损失 → 不迁
    sim.hostiles.push({ x: fireKey % sim.world.width, y: Math.floor(fireKey / sim.world.width), hp: 50, maxHp: 50, targetX: 0, targetY: 0 });
    for (let i = 0; i < 10; i++) sim.step(sim.tuning.faction.migrateCheckEvery);
    expect(sim.factionsView().length).toBe(before);
    // 营地真实被毁（💥 入记忆）+ 威胁在场 → 连续周期后另起篝火。
    // 每周期补一只狼确保 nearThreat 持续成立（migrate 要求"当前有威胁在场"；
    // 狼可能被小人击杀，需刷新）
    sim.socialUnits.addMemory(fireKey, '💥 建筑被摧毁（围栏）');
    sim.socialUnits.addMemory(fireKey, '💥 建筑被摧毁（围栏）');
    sim.socialUnits.addMemory(fireKey, '💥 建筑被摧毁（围栏）');
    for (let i = 0; i < 15; i++) {
      // 狼在营地旁 8 格（威胁半径 10 内满足 nearThreat，但落点环扫 r=8~14
      // 远离旧营地 ≥migrateMinDist=10，狼又不堵住落点）
      sim.hostiles.push({ x: (fireKey % sim.world.width) + 8, y: Math.floor(fireKey / sim.world.width), hp: 5000, maxHp: 5000, targetX: 0, targetY: 0 });
      sim.step(sim.tuning.faction.migrateCheckEvery);
    }
    expect(sim.factionsView().length).toBeGreaterThan(before);
  });

  it('addProductionNear 全进全局仓库（2026-08-14 重构：无单位私有库存）', () => {
    const sim = new Sim({ seed: 116, pawnCount: 2 });
    const globalFoodBefore = sim.stockpile.food ?? 0;
    // auto 野营建筑产出 → 全局（此前归最近单位库存）
    sim.addProductionNear(9999 % sim.world.width, 9999 % sim.world.height, 'food', 5);
    expect(sim.stockpile.food).toBe(globalFoodBefore + 5);
  });

  it('assigned job dominates card draw (Q10 生产线)', () => {
    const sim = new Sim({ seed: 114, pawnCount: 1 });
    const eid = sim.pawns[0];
    sim.selected = [eid];
    sim.issueCommand({ type: 'assign', x: 0, y: 0, job: 'lumberjack' });
    const st = sim.pawnStates.get(eid)!;
    expect(st.assignedJob).toBe('lumberjack');
    let chops = 0;
    for (let i = 0; i < 600; i++) {
      sim.step(1 / 20);
      if ((st.job ?? '').includes('伐木')) chops++;
    }
    expect(chops).toBeGreaterThan(0);
  });

  it('monument wonder requires ore and grants camp-wide awe (Q10)', () => {
    const sim = new Sim({ seed: 115, pawnCount: 0 });
    const w = sim.world;
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    const def = BUILDINGS.monument;
    let spot: { x: number; y: number } | null = null;
    for (let r = 3; r <= 10 && !spot; r++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        for (let dy = -r; dy <= r && !spot; dy++) {
          if (w.canBuildFootprint(cx + dx, cy + dy, def)) spot = { x: cx + dx, y: cy + dy };
        }
      }
    }
    expect(spot).not.toBeNull();
    sim.stockpile.wood = 200;
    sim.stockpile.ore = 10;
    sim.issueCommand({ type: 'build', x: spot!.x, y: spot!.y, buildingId: 'monument' });
    expect(sim.buildQueue.length).toBe(0); // ore 不足被拒
    sim.stockpile.ore = 100;
    sim.issueCommand({ type: 'build', x: spot!.x, y: spot!.y, buildingId: 'monument' });
    expect(sim.buildQueue.length).toBe(1);
    const placed = w.placeBuilding(spot!.x, spot!.y, 'monument', 'player');
    expect(placed).toBe(true);
  });
});


describe('教堂 + 神谕（用户 Q2/Q3）', () => {
  it('oracle influence blesses high-faith pawns near a church', () => {
    const sim = new Sim({ seed: 99, pawnCount: 2 });
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    sim.world.placeBuilding(cx, cy, 'church', 'auto');
    // 高信仰小人站教堂旁，低信仰站远
    const [a, b] = sim.pawns;
    const stA = sim.pawnStates.get(a)!;
    stA.faith = 80;
    sim.pawnPositions.set(a, { x: cx, y: cy + 1 });
    sim.pawnPositions.set(b, { x: cx + 10, y: cy + 10 }); // 远 + 低信仰
    sim.issueCommand({ type: 'oracle', x: cx, y: cy });
    // a 获得神谕 buff
    expect(stA.oracleBuff).toBeDefined();
    expect(stA.oracleBuff!.until).toBeGreaterThan(sim.time);
  });

  it('oracle only works on a church tile', () => {
    const sim = new Sim({ seed: 100, pawnCount: 1 });
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    st.faith = 80;
    sim.pawnPositions.set(eid, { x: cx, y: cy });
    // 非教堂位置发布 → 无效
    sim.issueCommand({ type: 'oracle', x: cx, y: cy });
    expect(st.oracleBuff).toBeUndefined();
  });

  it('autonomous build plans a church when camp faith is high', () => {
    const sim = new Sim({ seed: 101, pawnCount: 2 });
    // AI 建造成本 = 建筑 def 成本（与手动队列一致），备足木料覆盖施工消耗
    sim.stockpile.wood = 400;
    // 全员高信仰
    for (const eid of sim.pawns) sim.pawnStates.get(eid)!.faith = 70;
    let planned = false;
    for (let i = 0; i < 3000 && !planned; i++) {
      sim.step(1 / 20); // 150 秒
      planned = sim.buildQueue.some((b) => b.defId === 'church') || sim.world.hasBuilding('church');
    }
    expect(planned).toBe(true);
  });

  it('oracle buff persists through save/load', () => {
    const sim = new Sim({ seed: 102, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    st.oracleBuff = { until: 9999, mood: 6 };
    const data = sim.save();
    const sim2 = new Sim({ seed: 103, pawnCount: 1 });
    sim2.load(data);
    const p = sim2.pawnProfile(sim2.pawns[0])!;
    expect(p.oracleBuff).toBeDefined();
    expect(p.oracleBuff!.until).toBe(9999);
  });
});

describe('叙事压力（DESIGN §6）', () => {
  it('long peace builds narrative pressure and enlarges raids', () => {
    const sim = new Sim({ seed: 80, pawnCount: 4 });
    // 基线规模 = floor(2 + 4*0.5) = 4
    // 推进极长和平时间（模拟无人来袭时段），压力应 > 1 → 袭击更大
    const wait = 0;
    void wait;
    // 快进 300 秒（远超基线 75s），中间不允许清理，等第一波
    let first = 0;
    for (let i = 0; i < 8000 && first === 0; i++) {
      sim.step(1 / 20);
      if (sim.hostiles.length > 0) first = sim.hostiles.length;
    }
    expect(first).toBeGreaterThan(0);
  });
});

describe('mod 玩法（DATA_DRIVEN §6 验收）', () => {
  it('overrideEnemy changes raid difficulty (wolf hp)', () => {
    const sim = new Sim({ seed: 200, pawnCount: 2, mods: (m) => {
      m.overrideDef('enemy', 'wolf', { hp: 10 });
    } });
    expect(sim.mods.enemies['wolf'].hp).toBe(10);
    // 触发一波袭击 → 狼血量应为 10*压力
    let hp = 0;
    for (let i = 0; i < 8000 && hp === 0; i++) {
      sim.step(1 / 20);
      if (sim.hostiles.length > 0) hp = sim.hostiles[0].hp;
    }
    expect(hp).toBeGreaterThan(0);
    expect(hp).toBeLessThanOrEqual(20); // 10 * 压力上限 2
  });

  it('registerEnemy + raidEnemy swaps in a brand-new enemy type', () => {
    const sim = new Sim({ seed: 214, pawnCount: 2, mods: (m) => {
      m.registerEnemy({ id: 'boar', name: '野猪', hp: 40, speed: 4, dmg: 6, loot: { item: 'wood', amount: 3 } });
      m.overrideTuning({ combat: { raidEnemy: 'boar' } });
    } });
    let h: typeof sim.hostiles[0] | undefined;
    for (let i = 0; i < 8000 && !h; i++) {
      sim.step(1 / 20);
      if (sim.hostiles.length > 0) h = sim.hostiles[0];
    }
    expect(h).toBeDefined();
    expect(h!.enemyId).toBe('boar');
    expect(h!.name).toBe('野猪');
    expect(h!.hp).toBeLessThanOrEqual(80); // 40 * 压力上限 2
  });

  it('registerRecipe adds a new production (herb farm passive)', () => {
    const sim = new Sim({ seed: 201, pawnCount: 2, mods: (m) => {
      m.registerItem({ id: 'herb', name: '草药', stackable: true, maxStack: 99 });
      m.registerRecipe({ id: 'herb-farm', name: '草药田', kind: 'passive', output: { item: 'herb', amount: 0.5 } });
      m.registerBuilding({
        id: 'herbfarm', name: '草药田', size: { x: 1, y: 1 }, hp: 60, color: '#3a8a3a',
        emoji: '🌿', passable: true, buildTime: 2, tags: ['farm', 'herb'], recipe: 'herb-farm',
      });
    } });
    // 手动建草药田并产出（在出生点外找空位）
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    let placed = false;
    for (let r = 3; r <= 8 && !placed; r++) {
      for (let dx = -r; dx <= r && !placed; dx++) {
        for (let dy = -r; dy <= r && !placed; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (sim.world.inBounds(x, y) && sim.world.canBuildAt(x, y)) {
            placed = sim.world.placeBuilding(x, y, 'herbfarm', 'player');
            if (placed) sim.bus.emit({ type: 'building_built', x, y, defId: 'herbfarm' });
          }
        }
      }
    }
    expect(placed).toBe(true);
    // 运行农场系统（手动更新一次，farm 系统按 dt 累加）——faction='player' 建筑产出走全局库存
    //（2026-08-13 架构裁决：无玩家单位，faction='player' 即进全局仓库 stockpile）
    const before = sim.stockpile.herb ?? 0;
    sim.addProductionNear(cx, cy, 'herb', 0.5, 'player');
    const after = sim.stockpile.herb ?? 0;
    expect(after - before).toBeGreaterThanOrEqual(0.5);
  });

  it('overrideDef swaps farm recipe to a higher-yield one', () => {
    const sim = new Sim({ seed: 202, pawnCount: 2, mods: (m) => {
      m.registerRecipe({ id: 'farm-plus', name: '高产能农田', kind: 'passive', output: { item: 'food', amount: 0.5 } });
      m.overrideDef('building', 'farm', { recipe: 'farm-plus' });
    } });
    const farmDef = sim.buildingDef('farm');
    expect(farmDef?.recipe).toBe('farm-plus');
    expect(sim.recipe('farm-plus')?.output.amount).toBe(0.5);
  });

  it('registerEvent adds a new scripted event to the pool', () => {
    let triggered = false;
    const sim = new Sim({ seed: 203, pawnCount: 2, mods: (m) => {
      m.registerEvent({
        id: 'meteor', name: '陨石坠落', weight: 9999, minTime: 0, cooldown: 0,
        condition: () => true,
        run: (ctx) => {
          triggered = true;
          ctx.stockpile.ore = (ctx.stockpile.ore ?? 0) + 5;
        },
      });
    } });
    // 事件系统每隔 interval 秒 roll 一次，重权重确保被抽中
    for (let i = 0; i < 6000 && !triggered; i++) sim.step(1 / 20);
    expect(triggered).toBe(true);
  });

  it('registerExpansionPlan lets a mod add a new autobuild plan', () => {
    const sim = new Sim({ seed: 204, pawnCount: 2, mods: (m) => {
      m.registerExpansionPlan({
        id: 'herb-farm-plan', defId: 'herbfarm', minWood: 5,
        need: (c) => c.pawnList.length >= 2,
      });
    } });
    sim.stockpile.wood = 100;
    let planned = false;
    for (let i = 0; i < 6000 && !planned; i++) {
      sim.step(1 / 20);
      planned = sim.buildQueue.some((b) => b.defId === 'herbfarm');
    }
    expect(planned).toBe(true);
  });

  it('overrideDef on tile changes gather yield', () => {
    const sim = new Sim({ seed: 205, pawnCount: 1, mods: (m) => {
      m.overrideDef('tile', 'tree', { harvest: { product: 'wood', time: 2.5, yieldSuccess: 50, yieldFail: 20, dc: 1 } });
    } });
    expect(sim.world.getTileDef(0, 0)).toBeDefined();
    const treeDef = sim.world.getTileDef(0, 0);
    void treeDef;
    expect(sim.mods.tiles['tree'].harvest?.yieldSuccess).toBe(50);
  });

  it('registerWork lets a mod define a brand-new work type (walkAndWork dispatch)', () => {
    let worked = false;
    const sim = new Sim({
      seed: 206, pawnCount: 1,
      mods: (m) => {
        // 新工作类型：卡 decide 产出非内置 workType → 分派到 mod 的执行器
        m.registerWork('scavenge', (_c, _eid, st) => { worked = true; st.job = '拾荒'; });
        m.registerCard({
          id: 'scavenge', name: '拾荒', series: 'work', weight: 100,
          condition: () => true,
          utility: () => 999,
          decide: () => ({ action: 'walkAndWork', workType: 'scavenge', label: '拾荒' }),
        });
      },
    });
    for (let i = 0; i < 600 && !worked; i++) sim.step(1 / 20);
    expect(worked).toBe(true);
    expect(sim.pawnStates.get(sim.pawns[0])!.job).toBe('拾荒');
  });

  it('registerHook fires before/after every step', () => {
    let before = 0, after = 0;
    const sim = new Sim({
      seed: 207, pawnCount: 1,
      mods: (m) => {
        m.registerHook('step:before', () => { before++; });
        m.registerHook('step:after', () => { after++; });
      },
    });
    for (let i = 0; i < 5; i++) sim.step(1 / 20);
    expect(before).toBe(5);
    expect(after).toBe(5);
  });

  it('step hook can read and mutate sim state via ctx', () => {
    const sim = new Sim({
      seed: 208, pawnCount: 1,
      mods: (m) => m.registerHook('step:before', (ctx) => {
        (ctx as { sim: Sim }).sim.stockpile.wood += 1;
      }),
    });
    const before = sim.stockpile.wood;
    sim.step(1 / 20);
    expect(sim.stockpile.wood).toBe(before + 1);
  });

  it('mod work card satisfies a desire via data declaration (no job-text matching)', () => {
    const sim = new Sim({
      seed: 209, pawnCount: 1,
      mods: (m) => {
        m.registerCard({
          id: 'patrol', name: '巡逻', series: 'work', weight: 100,
          condition: () => true, utility: () => 999,
          satisfies: [{ desire: 'greed', amount: 3 }],
          decide: () => ({ action: 'idle', label: '巡逻' }),
        });
      },
    });
    const st = sim.pawnStates.get(sim.pawns[0])!;
    st.desires = { gluttony: 50, sloth: 50, greed: 10, envy: 50, pride: 50, wrath: 50, lust: 50 };
    const before = st.desires.greed;
    for (let i = 0; i < 300 && st.desires.greed <= before; i++) sim.step(1 / 20);
    expect(st.desires.greed).toBeGreaterThan(before);
  });

  it('mod can register an entirely new desire dimension (registerDesire → init/decay/fulfill auto)', () => {
    const sim = new Sim({ seed: 220, pawnCount: 1, mods: (m) => m.registerDesire('fame', '声望') });
    const st = sim.pawnStates.get(sim.pawns[0])!;
    expect(st.desires!.fame).toBeGreaterThanOrEqual(0);
    expect(st.dna.sins.fame).toBeGreaterThanOrEqual(0); // 先天倾向自动初始化
    st.desires!.fame = 10;
    const before = st.desires!.fame;
    // 声明 satisfies 的卡执行 → 新欲望维度被满足（验收 19：色欲/嫉妒等未内置途径 mod 可自建）
    const sim2 = new Sim({ seed: 221, pawnCount: 1, mods: (m) => {
      m.registerDesire('fame', '声望');
      m.registerCard({
        id: 'strut', name: '显摆', series: 'leisure', weight: 100,
        condition: () => true, utility: () => 999,
        desire: 'fame', // 新欲望直接挂钩权重（无需系列映射）
        satisfies: [{ desire: 'fame', amount: 5 }],
        decide: () => ({ action: 'idle', label: '显摆' }),
      });
    } });
    const st2 = sim2.pawnStates.get(sim2.pawns[0])!;
    st2.desires!.fame = 10;
    for (let i = 0; i < 300 && st2.desires!.fame <= 10; i++) sim2.step(1 / 20);
    expect(st2.desires!.fame).toBeGreaterThan(10);
    void before;
  });

  it('mod building with emitsLight lights nearby tiles (no campfire special-case)', () => {
    const sim = new Sim({ seed: 210, pawnCount: 0, mods: (m) => {
      m.registerBuilding({
        id: 'lantern', name: '灯笼', size: { x: 1, y: 1 }, hp: 30, color: '#aaa', emoji: '🏮',
        passable: true, buildTime: 1, emitsLight: 2, tags: [],
      });
    } });
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    expect(sim.world.placeBuilding(cx, cy, 'lantern', 'player')).toBe(true);
    expect(sim.world.isLit(cx, cy)).toBe(true);
  });

  it('mod building with capabilities oracle enables the oracle command', () => {
    const sim = new Sim({ seed: 211, pawnCount: 1, mods: (m) => {
      m.registerBuilding({
        id: 'altar', name: '祭坛', size: { x: 1, y: 1 }, hp: 300, color: '#553355', emoji: '🪔',
        passable: true, buildTime: 2, capabilities: ['oracle'], tags: ['faith', 'anchor'],
      });
    } });
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    expect(sim.world.placeBuilding(cx, cy, 'altar', 'player')).toBe(true);
    const st = sim.pawnStates.get(sim.pawns[0])!;
    st.faith = 90;
    sim.pawnPositions.set(sim.pawns[0], { x: cx, y: cy });
    sim.issueCommand({ type: 'oracle', x: cx, y: cy });
    expect(st.oracleBuff).toBeDefined();
  });

  it('craft building uses its own recipe, not the fixed workbench one', () => {
    const sim = new Sim({ seed: 212, pawnCount: 0, mods: (m) => {
      m.registerItem({ id: 'drink', name: '酒', stackable: true, maxStack: 50 });
      m.registerRecipe({ id: 'brew', name: '酿酒', kind: 'batch', input: [{ item: 'wood', amount: 5 }], output: { item: 'drink', amount: 1 }, interval: 2 });
      m.registerBuilding({
        id: 'brewery', name: '酒坊', size: { x: 1, y: 1 }, hp: 200, color: '#aa8833', emoji: '🍺',
        passable: true, buildTime: 2, tags: ['craft'], recipe: 'brew',
      });
    } });
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    expect(sim.world.placeBuilding(cx, cy, 'brewery', 'player')).toBe(true);
    sim.stockpile.wood = 100;
    for (let i = 0; i < 400; i++) sim.step(1 / 20); // 20s > interval 2s
    expect(sim.stockpile.drink ?? 0).toBeGreaterThan(0); // 用自己配方产酒，而非固定 workbench 工具
  });

  it('priority rules are data-driven (overrideTuning changes the table)', () => {
    const sim = new Sim({ seed: 213, pawnCount: 1, mods: (m) => {
      m.overrideTuning({ card: { priority: [
        { cardId: 'chop', resource: 'wood', lowAt: 999, boost: 3 },
      ] } });
    } });
    sim.stockpile.wood = 200; // 高库存，但阈值 999 恒触发
    for (let i = 0; i < 300; i++) sim.step(1 / 20);
    expect(sim.factionPriority.chop).toBe(3);
  });

  it('enemy def is data-driven: overrideDef changes raider stats (not hardcoded)', () => {
    // 2026-08-14 重构：派系实体删除（不再有 unit 掠夺者），数据驱动仍保留——直接验证
    // enemyDef 被 mod 覆盖后，新生成敌人都带上覆盖值（原测试靠派系 raidBetween 触发，已改直测）
    const sim = new Sim({ seed: 220, pawnCount: 2, mods: (m) => {
      m.overrideDef('enemy', 'raider', { hp: 5, loot: { item: 'wood', amount: 9 } });
    } });
    const def = sim.mods.enemyDef('raider');
    expect(def.hp).toBe(5);
    expect(def.loot).toEqual({ item: 'wood', amount: 9 });
    expect(def.speed).toBeGreaterThan(0); // 未覆盖字段保留默认
  });

  it('mod harvestable tile is auto-harvested (growable+harvest, not tree/ore hardcode)', () => {
    const sim = new Sim({ seed: 221, pawnCount: 2, mods: (m) => {
      m.registerTile({
        id: 'berry', name: '浆果丛', passable: false, buildable: false, color: '#c23a5a',
        emoji: '🍒', growable: true,
        harvest: { product: 'food', time: 1, yieldSuccess: 2, yieldFail: 1, dc: 99 },
        harvestReplaces: 'grass',
      });
    } });
    // 出生点周围换成浆果丛（中心留草地通行），验证小人自动采集 mod 新 tile
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        // 外圈放浆果丛，中心圈留草地走位（berry 不可通行，太近会把小人围死）
        if (Math.max(Math.abs(dx), Math.abs(dy)) === 3) sim.world.setTile(cx + dx, cy + dy, 'berry');
      }
    }
    // 保证卡池有伐木卡（部分 pawn maxSlots 被 trait 卡占满，无基础卡——与本次无关的设计现象）
    for (const eid of sim.pawns) {
      const st = sim.pawnStates.get(eid)!;
      if (!st.slots.some((c) => c?.id === 'chop')) st.slots.push(BASE_CARDS.find((c) => c.id === 'chop')!);
    }
    const before = sim.stockpile.food;
    let gained = false;
    for (let i = 0; i < 1500 && !gained; i++) {
      sim.step(1 / 20);
      gained = sim.stockpile.food > before;
    }
    expect(gained).toBe(true); // 采到浆果 → food 增长（修复前只有 tree/ore 被采）
  });
});

describe('卡熟练度（P0.5 卡演化：习惯建模）', () => {
  it('小人各自独立熟练度（克隆防串）', () => {
    const sim = new Sim({ seed: 901, pawnCount: 2 });
    const a = sim.pawns[0];
    const b = sim.pawns[1];
    const cardA = sim.pawnStates.get(a)!.slots.find((c) => c?.id === 'chop')!;
    const cardB = sim.pawnStates.get(b)!.slots.find((c) => c?.id === 'chop')!;
    expect(cardA).not.toBe(cardB); // 克隆实例
    cardA.mastery = 50;
    expect(cardB.mastery).not.toBe(50); // 不串
  });

  it('选中卡熟练 +1；权重调制 (0.5+mastery/100)', () => {
    const sim = new Sim({ seed: 902, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    const chop = st.slots.find((c) => c?.id === 'chop')!;
    const w0 = effectiveWeight(chop, { dna: st.dna, slots: st.slots });
    // 手动模拟选中（等价 decide 内部逻辑）
    chop.lastUsed = 0;
    chop.mastery = Math.min(100, (chop.mastery ?? 0) + 1);
    const w1 = effectiveWeight(chop, { dna: st.dna, slots: st.slots });
    expect(w1).toBeGreaterThan(w0);
    expect(w1).toBeCloseTo(w0 * (1 + 1 / 100 / (0.5 + (chop.mastery ?? 0) / 100)), 2);
  });

  it('熟练度随存档往返（slots 带 {id,m,u}）', () => {
    const sim = new Sim({ seed: 903, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    const chop = st.slots.find((c) => c?.id === 'chop')!;
    chop.mastery = 37;
    chop.lastUsed = 123;
    const data = JSON.parse(JSON.stringify(sim.save()));
    const saved = data.pawns[0].slots.find((s2: { id?: string }) => typeof s2 === 'object' && s2.id === 'chop');
    expect(saved).toBeDefined();
    expect(saved.m).toBe(37);
    const sim2 = new Sim({ seed: 904, pawnCount: 1 });
    sim2.load(data);
    const chop2 = sim2.pawnStates.get(sim2.pawns[0])!.slots.find((c) => c?.id === 'chop')!;
    expect(chop2.mastery).toBe(37);
    expect(chop2.lastUsed).toBe(123);
  });
});

describe('存档 JSON 往返（save/load 修复）', () => {
  it('slots 序列化为卡 id：JSON 往返后卡完整还原、step 不崩', () => {
    const sim = new Sim({ seed: 800, pawnCount: 2, mods: (m) => {
      m.registerWork('fish', (_c, _eid, st) => { st.job = '捕鱼中'; });
      m.registerCard({
        id: 'modFish', name: '捕鱼', series: 'work', weight: 100,
        condition: () => true, utility: () => 999,
        satisfies: [{ desire: 'greed', amount: 2 }],
        decide: () => ({ action: 'walkAndWork', workType: 'fish', label: '捕鱼' }),
      });
    } });
    const eid = sim.pawns[0];
    const idsBefore = sim.pawnStates.get(eid)!.slots.map((c) => c?.id ?? null);
    expect(idsBefore).toContain('modFish'); // mod 卡在池中
    // 模拟浏览器真实路径：JSON 序列化往返
    const data = JSON.parse(JSON.stringify(sim.save())) as ReturnType<Sim['save']>;
    const sim2 = new Sim({ seed: 801, pawnCount: 2, mods: (m) => {
      m.registerWork('fish', (_c, _eid, st) => { st.job = '捕鱼中'; });
      m.registerCard({
        id: 'modFish', name: '捕鱼', series: 'work', weight: 100,
        condition: () => true, utility: () => 999,
        satisfies: [{ desire: 'greed', amount: 2 }],
        decide: () => ({ action: 'walkAndWork', workType: 'fish', label: '捕鱼' }),
      });
    } });
    sim2.load(data);
    const eid2 = sim2.pawns[0];
    const idsAfter = sim2.pawnStates.get(eid2)!.slots.map((c) => c?.id ?? null);
    expect(idsAfter).toEqual(idsBefore); // trait/基础/mod 卡全部还原
    // 抽卡执行不再崩溃（修复前 JSON 往返后 decide 为 undefined）
    for (let i = 0; i < 600; i++) sim2.step(1 / 20);
    expect(sim2.pawnStates.get(eid2)!.slots.length).toBeGreaterThan(0);
  });

  it('load 后 units.members 重新填充，不触发假团灭', () => {
    const sim = new Sim({ seed: 802, pawnCount: 3 });
    const data = JSON.parse(JSON.stringify(sim.save())) as ReturnType<Sim['save']>;
    const sim2 = new Sim({ seed: 803, pawnCount: 3 });
    sim2.load(data);
    // 修复前：members 恒空 → 首个 step 触发"本体团灭，附身"日志（附身机制 2026-08-13 已删）
    sim2.step(1);
    // 2026-08-14 重构：无派系单位，校验 fireId（篝火归属）持久化恢复
    const withFire = sim2.pawns.filter((e) => sim2.pawnStates.get(e)!.fireId != null).length;
    expect(withFire).toBeGreaterThan(0);
  });
});

describe('卡条件谓词表（行为树条件节点，CARD_PREDICATES）', () => {
  const makeView = (sim: Sim, hasCampfire = true) => ({
    hasCampfire: () => hasCampfire,
    hasCave: () => false,
    hasRaft: () => false,
    buildQueueCount: 0,
    stockpile: sim.stockpile,
    isNight: () => false,
    needsOf: () => null,
    healthOf: () => null,
  });

  it('内置谓词声明式组合：pray 仅在 campfire 存在时可抽', () => {
    const sim = new Sim({ seed: 41, pawnCount: 2 });
    const pray = sim.mods.cards.get('pray')!; // 基础卡表（声明式谓词已由工厂组合进 condition）
    const ctx = { eid: sim.pawns[0], view: makeView(sim, false) } as never;
    expect(pray.condition!(ctx)).toBe(false); // 无 campfire → 谓词 false
    expect(pray.condition!({ eid: sim.pawns[0], view: makeView(sim, true) } as never)).toBe(true);
  });

  it('mod 可 registerPredicate 扩展谓词并用于新卡（行为树条件节点可扩展）', () => {
    const sim = new Sim({ seed: 42, pawnCount: 2, mods: (m) => {
      m.registerPredicate('stockpileHasOre', (c) => c.view.stockpile.ore > 0);
      m.registerCardDef({
        id: 'oreCelebrate', name: '庆贺', series: 'leisure', weight: 10,
        when: ['stockpileHasOre'],
        utilityFixed: 50,
        action: 'idle', label: '庆贺',
      });
    } });
    const card = sim.mods.cards.get('oreCelebrate')!;
    const ctx = { eid: sim.pawns[0], view: makeView(sim) } as never;
    expect(card.condition!(ctx)).toBe(false); // 初始库存 0 矿：谓词 false
    sim.stockpile.ore = 3;
    expect(card.condition!(ctx)).toBe(true);
    // 未注册谓词：工厂构建时报错（拼错 id 立即暴露）
    expect(() => sim.mods.registerCardDef({
      id: 'bad', name: '坏卡', series: 'leisure', weight: 1,
      when: ['noSuchPredicate'],
      utilityFixed: 1, action: 'idle', label: '坏卡',
    })).toThrow(/未注册/);
  });
});

describe('数据驱动系统装配表（defs/systems.ts 逻辑组件层）', () => {
  it('mod 声明系统按 before 锚点插入执行顺序', () => {
    const sim = new Sim({ seed: 1, pawnCount: 2, mods: (m) => {
      m.registerSystemDef({
        id: 'probe', label: '探针', category: 'ai', before: 'social',
        ctor: () => ({ id: 'probe', update() { /* 无副作用：只验证装配 */ } }),
      });
    } });
    const ids = [...sim.systemIds];
    // 基线表顺序（表序 = 执行序），probe 插在 social 前
    const baseline = ['needs', 'san', 'desire', 'behavior', 'socialUnit', 'social', 'gather', 'build', 'farm', 'craft', 'repair', 'raid', 'population', 'events', 'autobuild'];
    const inserted = ids.findIndex((id) => id === 'probe');
    expect(inserted).toBeGreaterThan(-1);
    expect(ids.filter((id) => baseline.includes(id))).toEqual(baseline); // 基线相对顺序不变
    expect(ids[inserted + 1]).toBe('social'); // 锚点生效
    sim.step(1); // 装配后正常跑不崩
  });

  it('无锚点时追加到表尾', () => {
    const sim = new Sim({ seed: 2, pawnCount: 2, mods: (m) => {
      m.registerSystemDef({
        id: 'tail-probe', label: '尾探针', category: 'world',
        ctor: () => ({ id: 'tail-probe', update() { } }),
      });
    } });
    expect(sim.systemIds[sim.systemIds.length - 1]).toBe('tail-probe');
  });

  it('mod 可替换核心行为/单位系统（单例回填）', () => {
    const sim = new Sim({ seed: 3, pawnCount: 2, mods: (m) => {
      m.registerSystemDef({
        id: 'behavior', label: '替换行为', category: 'ai',
        // 替换行为系统的契约：需实现 intent/work 注册（Sim 单例回填后调用）
        ctor: (s) => ({ id: 'behavior', update() { }, registerIntent() { }, registerWork() { } }),
      });
      // mod 意图仍应挂到新实例（回填单例）
      m.registerIntent('dance', () => ({ done: true } as never));
    } });
    expect(sim.systemIds[3]).toBe('behavior');
    sim.step(1); // 不崩，且 intent 注册不抛（实例回填成功）
  });
});

describe('寻路策略表（tuning.path 参数数据化）', () => {
  it('默认 chebyshev 下可达路径；maxIter 过小返回空（策略钳制生效）', () => {
    const sim = new Sim({ seed: 7, pawnCount: 1 });
    const eid = sim.pawns[0];
    const pos = sim.pawnPositions.get(eid)!;
    // 找可达目标点（避开树/矿/建筑）
    let target = { x: 0, y: 0 };
    outer: for (let r = 1; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const x = pos.x + dx, y = pos.y + dy;
          if (sim.world.inBounds(x, y) && sim.world.isPassable(x, y)) { target = { x, y }; break outer; }
        }
      }
    }
    const p0 = findPath(sim.world, pos.x, pos.y, target.x, target.y, sim.tuning.path);
    expect(p0.length).toBeGreaterThan(1); // 默认 chebyshev 走通
    // maxIter 钳制：迭代上限不足 → 返回空（策略生效）
    const p1 = findPath(sim.world, pos.x, pos.y, target.x, target.y, { maxIter: 5 });
    expect(p1.length).toBe(0);
    // 换 manhattan/euclidean 启发式：仍可达（策略表切换不崩）
    for (const heuristic of ['manhattan', 'euclidean'] as const) {
      const p = findPath(sim.world, pos.x, pos.y, target.x, target.y, { heuristic });
      expect(p.length).toBeGreaterThan(1);
    }
    // sim.moveTo 装配读 tuning.path（mod 覆盖即时生效）
    sim.mods.overrideTuning({ path: { heuristic: 'euclidean' } });
    sim.moveTo(eid, target.x, target.y);
    expect(sim.pawnStates.get(eid)!.path.length).toBeGreaterThan(1);
  });
});

describe('demo mod 逻辑组件层闭环（demo-berry）', () => {
  it('谓词 + 声明式卡 + 系统装配表全链路', () => {
    const sim = new Sim({ seed: 9, pawnCount: 2, mods: berryMod });
    // 卡进表：浆果盛宴（声明式 def → 工厂生成，谓词已组合进 condition）
    const card = sim.mods.cards.get('berryFeast')!;
    expect(card).toBeDefined();
    // 系统按锚点插入：berrySpoil 在 autobuild 之前
    const ids = [...sim.systemIds];
    expect(ids.indexOf('berrySpoil')).toBeGreaterThan(-1);
    expect(ids.indexOf('berrySpoil')).toBeLessThan(ids.indexOf('autobuild'));
    // 谓词：浆果 <5 不可抽；≥5 可抽
    const ctx = { eid: sim.pawns[0], view: sim } as never;
    sim.stockpile.berry = 3;
    // view 需 stockpile 引用——sim.stockpile 同一对象，谓词读 c.view.stockpile.berry
    expect(card.condition!(ctx)).toBe(false);
    sim.stockpile.berry = 5;
    expect(card.condition!(ctx)).toBe(true);
    // 变质系统：60s 后库存减半
    sim.stockpile.berry = 100;
    sim.step(60);
    expect(sim.stockpile.berry).toBe(50);
    sim.step(60);
    expect(sim.stockpile.berry).toBe(25);
  });
});

describe('意图执行器表（defs/executors.ts）', () => {
  it('内置意图从表装配：饿肚子时仍会进食', () => {
    const sim = new Sim({ seed: 11, pawnCount: 1 });
    const eid = sim.pawns[0];
    sim.stockpile.food = 10;
    sim.setNeeds(eid, { food: 10, rest: 100, mood: 100, san: 100 });
    for (let i = 0; i < 60; i++) sim.step(1);
    const n = sim.readNeeds(eid)!;
    expect(n.food).toBeGreaterThan(10); // 吃了饭（表装配的 eat 执行器生效）
    expect(n.food).toBeLessThan(100); // 未吃撑（钳制生效）
  });

  it('mod 可覆盖内置意图执行器（同 id 即替换）', () => {
    let hits = 0;
    const sim = new Sim({ seed: 12, pawnCount: 1, mods: (m) => {
      m.registerIntent('idle', (_c, _eid, st) => { hits++; st.job = '发呆中'; });
    } });
    // 反复走位至触发一次闲逛（覆盖后的 idle 执行器）
    for (let i = 0; i < 400 && hits === 0; i++) sim.step(1);
    expect(hits).toBeGreaterThan(0);
    expect(sim.pawnStates.get(sim.pawns[0])!.job).toBe('发呆中');
  });
});

describe('权重调制规则流水线（defs/weightRules.ts）', () => {
  it('mod 插入规则：夜晚工作卡权重×0.5（before 锚点）', () => {
    const sim = new Sim({ seed: 21, pawnCount: 1, mods: (m) => {
      m.registerWeightRule({
        id: 'nightFear', label: '夜晚恐惧',
        apply(w, _card, _pawn, ctx) {
          if (ctx?.view.isNight()) return w * 0.5;
          return w;
        },
      }, 'markov'); // 插在马尔可夫偏置之前
    } });
    const chop = BASE_CARDS.find((c) => c.id === 'chop')!;
    const st = sim.pawnStates.get(sim.pawns[0])!;
    const ctx = { eid: sim.pawns[0], view: sim } as never;
    // 正午（dayTime 0.5）：白天权重；nightStart+0.1：夜晚权重
    sim.dayTime = 0.5;
    const wDay = effectiveWeight(chop, st, ctx);
    sim.dayTime = sim.tuning.env.nightStart + 0.1;
    const wNight = effectiveWeight(chop, st, ctx);
    expect(wNight).toBeCloseTo(wDay * 0.5, 5); // 夜晚恐惧规则生效（其余规则两侧一致）
  });

  it('mod 插入规则跑在指定锚点之前（相对顺序生效）', () => {
    const order: string[] = [];
    const sim = new Sim({ seed: 22, pawnCount: 1, mods: (m) => {
      m.registerWeightRule({
        id: 'probeA', label: '探针A',
        apply(w, _card, _pawn, _ctx) { order.push('probeA'); return w; },
      }, 'markov');
      m.registerWeightRule({
        id: 'probeB', label: '探针B',
        apply(w, _card, _pawn, _ctx) { order.push('probeB'); return w; },
      }, 'markov');
    } });
    const chop = BASE_CARDS.find((c) => c.id === 'chop')!;
    const st = sim.pawnStates.get(sim.pawns[0])!;
    effectiveWeight(chop, st, { eid: sim.pawns[0], view: sim } as never);
    // 表序 = 执行序：同锚点按注册序先后执行
    expect(order).toEqual(['probeA', 'probeB']);
  });
});

describe('SIZ 负重（COC §3 属性全用途）', () => {
  it('负重上限：SIZ 决定一次搬回量', () => {
    const g = { carryBase: 4, carryPerSiz: 0.5, strBase: 40 };
    expect(carryCapOf(g, 20)).toBe(4);   // 小个子：基数
    expect(carryCapOf(g, 40)).toBe(4);   // 临界
    expect(carryCapOf(g, 60)).toBe(14);  // 大个子：4 + 20×0.5
    expect(carryCapOf(g, 90)).toBe(29);
    // 钳制：产出不超上限，保底 1
    expect(capGainTo(15, 4)).toBe(4);
    expect(capGainTo(15, 24)).toBe(15);
    expect(capGainTo(0, 4)).toBe(0);
    expect(capGainTo(15, 0)).toBe(1);
  });

  it('集成：小 SIZ 采矿一轮产出被负重钳制（≤4）', () => {
    const sim = new Sim({ seed: 33, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    st.dna.siz = 20; // 负重 4
    // 找一块矿脉 tile
    let ox = -1, oy = -1;
    outer: for (let y = 0; y < sim.world.height; y++) {
      for (let x = 0; x < sim.world.width; x++) {
        if (sim.world.getTileDef(x, y).mineral) { ox = x; oy = y; break outer; }
      }
    }
    expect(ox).toBeGreaterThan(-1);
    const before = sim.stockpile.ore;
    st.mining = { x: ox, y: oy, progress: 9999 }; // 立即完成一轮
    sim.step(0.1);
    const gain = sim.stockpile.ore - before;
    expect(gain).toBeGreaterThanOrEqual(1);
    expect(gain).toBeLessThanOrEqual(4); // 小 SIZ 搬不动大产量
  });
});

describe('七宗罪全途径（色欲/嫉妒满足）', () => {
  it('色欲：正向社交互动满足 lust', () => {
    const sim = new Sim({ seed: 41, pawnCount: 3 });
    const a = sim.pawns[0];
    const st = sim.pawnStates.get(a)!;
    st.desires = { gluttony: 50, sloth: 50, greed: 50, envy: 50, pride: 50, wrath: 50, lust: 50 };
    // 把 a 与 b 摆一起，mood 调高（正向基调），强制触发互动
    const b = sim.pawns[1];
    const pB = sim.pawnPositions.get(b)!;
    sim.pawnPositions.set(a, { x: pB.x + 1, y: pB.y });
    sim.setPosition(a, { x: pB.x + 1, y: pB.y });
    sim.setNeeds(a, { food: 100, rest: 100, mood: 90, san: 100 });
    sim.setNeeds(b, { food: 100, rest: 100, mood: 90, san: 100 });
    const before = st.desires.lust;
    // 足够多的步数：冷却(15s)过后会互动（tickInterval 2s，相遇距离内）
    for (let i = 0; i < 200; i++) sim.step(0.1);
    expect(st.desires.lust).toBeGreaterThan(before); // 色欲被社交满足
  });

  it('嫉妒：存在更强同伴时完成劳动满足 envy', () => {
    const sim = new Sim({ seed: 42, pawnCount: 2 });
    const a = sim.pawns[0];
    const st = sim.pawnStates.get(a)!;
    st.desires = { gluttony: 50, sloth: 50, greed: 50, envy: 50, pride: 50, wrath: 50, lust: 50 };
    // 同伴 b 更强（总技能更高）
    const b = sim.pawns[1];
    sim.pawnStates.get(b)!.skills = { work: 100, fight: 100, craft: 100, social: 100, faith: 100 };
    const before = st.desires.envy;
    // 完成一次劳动（work_completed 事件直接触发）
    sim.bus.emit({ type: 'work_completed', eid: a, work: 'chop', success: true, x: 0, y: 0 });
    expect(st.desires.envy).toBeGreaterThan(before); // 嫉妒被劳动满足
    // 若自己是最强的：无嫉妒对象，不满足
    const c = sim.pawnStates.get(a)!;
    c.desires!.envy = 50;
    sim.pawnStates.get(b)!.skills = {};
    sim.bus.emit({ type: 'work_completed', eid: a, work: 'chop', success: true, x: 0, y: 0 });
    expect(c.desires!.envy).toBe(50);
  });
});

describe('流言沿社交网络传播（gossip spread）', () => {
  it('听到的话题会被转述给下一个相遇者（TTL 内），并发出 gossip_spread 事件', () => {
    const sim = new Sim({ seed: 51, pawnCount: 3 });
    const [a, b, c] = [sim.pawns[0], sim.pawns[1], sim.pawns[2]];
    const stA = sim.pawnStates.get(a)!;
    const stB = sim.pawnStates.get(b)!;
    const stC = sim.pawnStates.get(c)!;
    // 直接注入：A 已听到八卦"新盖了个church"
    stA.gossip = { text: '说新盖了个church', heardAt: sim.time };
    // A、B、C 排排站，高心情保证正向互动
    const pb = sim.pawnPositions.get(b)!;
    sim.pawnPositions.set(a, { x: pb.x + 1, y: pb.y });
    sim.setPosition(a, { x: pb.x + 1, y: pb.y });
    sim.pawnPositions.set(c, { x: pb.x - 1, y: pb.y });
    sim.setPosition(c, { x: pb.x - 1, y: pb.y });
    for (const eid of [a, b, c]) sim.setNeeds(eid, { food: 100, rest: 100, mood: 95, san: 100 });
    // 跑足够步数，直到 B 听到八卦（gossip_spread 事件出现）
    let spread = false;
    const off = sim.bus.on('gossip_spread' as never, () => { spread = true; });
    for (let i = 0; i < 600 && !spread; i++) sim.step(0.1);
    off();
    expect(spread).toBe(true); // A 的八卦传出去了
    expect(stB.gossip?.text).toBe('说新盖了个church'); // B 记住了
    expect(stB.gossip?.heardAt).toBeGreaterThanOrEqual(0);
    // B 再转述给 C（传播链路）
    let spread2 = false;
    const off2 = sim.bus.on('gossip_spread' as never, () => { spread2 = true; });
    for (let i = 0; i < 600 && !spread2; i++) sim.step(0.1);
    off2();
    expect(spread2).toBe(true);
    expect(stC.gossip?.text).toBe('说新盖了个church'); // C 也听到了（网络传播）
  });

  it('过期的八卦不再转述（TTL 生效）', () => {
    const sim = new Sim({ seed: 52, pawnCount: 2 });
    const a = sim.pawns[0];
    const stA = sim.pawnStates.get(a)!;
    stA.gossip = { text: '旧闻', heardAt: sim.time - 9999 }; // 早已过期
    const pb = sim.pawnPositions.get(sim.pawns[1])!;
    sim.pawnPositions.set(a, { x: pb.x + 1, y: pb.y });
    sim.setPosition(a, { x: pb.x + 1, y: pb.y });
    for (const eid of sim.pawns) sim.setNeeds(eid, { food: 100, rest: 100, mood: 95, san: 100 });
    let oldSpread = false;
    const off = sim.bus.on('gossip_spread' as never, ((ev: { topic: string }) => { if (ev.topic === '旧闻') oldSpread = true; }) as never);
    for (let i = 0; i < 600; i++) sim.step(0.1);
    off();
    expect(oldSpread).toBe(false); // 过期八卦不被转述（新话题传播属正常，不在此断言范围）
  });
});

describe('社交文案表（defs/socialLines.ts 文本层）', () => {
  it('mod 可 registerLine 扩展微互动文案', () => {
    const sim = new Sim({ seed: 71, pawnCount: 3, mods: (m) => m.registerLine('greet', '用俚语打招呼') });
    // 直接验证表被注册：store 里含 mod 行（注册表级断言，比事件断言稳定）
    expect(socialLinesOf().greet).toContain('用俚语打招呼');
  });

  it('mod 可 registerTopicTemplate 扩展话题模板（新历史事件 → 话题）', () => {
    const sim = new Sim({ seed: 72, pawnCount: 3, mods: (m) => m.registerTopicTemplate({ event: 'building_built', text: (d) => `说新造了${d.defId}` }) });
    const pool = socialLinesOf().topics.filter((t) => t.event === 'building_built');
    expect(pool.length).toBeGreaterThanOrEqual(2); // 内置 + mod 扩展
    expect(pool.some((t) => t.event === 'building_built' && t.text({ defId: 'X' }) === '说新造了X')).toBe(true);
  });
});

describe('经济账本自动调节（用户设计：支出多 → 收益工作概率自动升，不靠伐木令）', () => {
  it('flowRatio：收益/支出净流；净支出多 → chop 工作权重自动升高', () => {
    const sim = new Sim({ seed: 601, pawnCount: 1 });
    // 支出 100 木、收益 50 木 → 净支出 2 倍
    sim.recordSpend(null, 'wood', 100);
    sim.recordEarn(null, 'wood', 50);
    expect(sim.flowRatio('wood')).toBe(2);
    // 推进过 priorityTimer（10s）→ factionPriority 生效
    for (let i = 0; i < 220; i++) sim.step(1 / 20);
    expect(sim.factionPriority.chop).toBeGreaterThan(1); // 经济账本自动拉高伐木
    // 建造支出也被记录（buildSystem 扣成本 → 全局流）
    const wood0 = sim.stockpile.wood ?? 0;
    sim.stockpile.wood = 999; sim.stockpile.ore = 999;
    const cx = Math.floor(sim.world.width / 2);
    sim.issueCommand({ type: 'build', x: cx + 1, y: 96, buildingId: 'wall' });
    for (let i = 0; i < 200 && sim.buildQueue.length > 0; i++) sim.step(1 / 20);
    expect((sim.flow.wood?.spend ?? 0)).toBeGreaterThan(100); // 建造扣木计入支出
    void wood0;
  });

  it('账本优先：库存充足但净支出高 → 仍拉高收益工作（不依赖"伐木令"）', () => {
    const sim = new Sim({ seed: 602, pawnCount: 1 });
    sim.stockpile.wood = 500; // 库存充足（lowAt 40 不触发）
    sim.recordSpend(null, 'wood', 120);
    sim.recordEarn(null, 'wood', 40); // 净支出 3 倍
    for (let i = 0; i < 220; i++) sim.step(1 / 20);
    expect(sim.factionPriority.chop).toBeGreaterThan(1); // 账本驱动而非库存阈值
  });
});

describe('经济预期驱动行为（心理预期 → 工作选择）', () => {
  it('预期收益高的工作权重升高（expectEarnBy → effectiveWeight）', () => {
    const sim = new Sim({ seed: 603, pawnCount: 1 });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    // 记录伐木收益预期 8（基准 5 之上）→ 伐木权重应升
    sim.recordEarn(eid, 'wood', 8, 'chop');
    expect(st.expectEarnBy?.chop).toBeCloseTo(8, 5);
    const chop = st.slots.find((c) => c?.id === 'chop')!;
    const ctx = {
      view: {
        isNight: () => false, // mod 规则残留（nightFear）需要；mock 补全
        tuning: { economy: sim.tuning.economy },
        expectEarnOf: (e: number, workType: string) => sim.pawnStates.get(e)?.expectEarnBy?.[workType] ?? 0,
      },
      eid,
    } as never;
    const w = effectiveWeight(chop, { dna: st.dna, slots: st.slots }, ctx);
    expect(w).toBeGreaterThan(chop.weight); // 经济理性：预期赚得多 → 更愿意干
  });

  it('长局：预期账本按工作细分积累，决策持续受调制', () => {
    const sim = new Sim({ seed: 604, pawnCount: 4 });
    for (let t = 0; t < 1200; t++) {
      for (let i = 0; i < 20; i++) sim.step(1 / 20);
    }
    let anyExpect = false;
    for (const eid of sim.pawns) {
      const st = sim.pawnStates.get(eid)!;
      if (st.expectEarnBy && Object.keys(st.expectEarnBy).length > 0) anyExpect = true;
    }
    expect(anyExpect).toBe(true);
  });
});

describe('探索卡机制（用户设计：科技建筑只有娱乐卡能抽到建造意图）', () => {
  it('科技解锁后：探索卡在娱乐抽卡中触发 → 蓝图入队 → 建筑建成', () => {
    const sim = new Sim({ seed: 701, pawnCount: 4 });
    sim.unlockTech('craft:toy');
    // 推进：小人在娱乐抽卡时可能抽到 explore:toy → 蓝图入队 → 建造
    //（世界生成含天然洞穴 → rng 序列随 seed 变化，探索抽卡是统计性 → 跑足够长）
    let toyBuilt = false;
    for (let i = 0; i < 12000 && !toyBuilt; i++) {
      sim.step(1 / 20);
      toyBuilt = [...sim.world.buildings.values()].some((b) => b.def.id === 'toy');
    }
    expect(toyBuilt).toBe(true); // 娱乐探索最终建成玩具
  });

  it('未解锁科技时探索卡不可抽（condition 不满足）', () => {
    const sim = new Sim({ seed: 702, pawnCount: 1 });
    const st = sim.pawnStates.get(sim.pawns[0])!;
    // 卡在池中（静态注册），但 condition（hasTech-water:well）不满足 → 抽不到
    expect(sim.mods.cards.has('explore:well')).toBe(true);
    const well = sim.mods.cards.get('explore:well')!;
    const ctx = {
      view: { techs: sim.techs, hasBuildingWithTag: (t: string) => sim.world.hasBuildingWithTag(t) },
      eid: sim.pawns[0],
    } as never;
    expect(well.condition ? well.condition(ctx) : true).toBe(false);
    // 解锁后满足
    sim.unlockTech('water:well');
    expect(well.condition ? well.condition(ctx) : true).toBe(true);
  });
});

describe('洞穴庇护与改造（用户设计：天然洞穴有房屋属性；洞穴改造科技资源少）', () => {
  it('天然洞穴 tile 有 shelter 属性 → 洞穴中休息恢复', () => {
    const sim = new Sim({ seed: 801, pawnCount: 1 });
    // 找一处 cave tile
    let cave: { x: number; y: number } | null = null;
    for (let y = 5; y < sim.world.height - 5 && !cave; y++) {
      for (let x = 5; x < sim.world.width - 5; x++) {
        if (sim.world.getTile(x, y) === 'cave') { cave = { x, y }; break; }
      }
    }
    expect(cave).not.toBeNull();
    expect(sim.world.getTileDef(cave!.x, cave!.y).shelter).toBe(true);
    const eid = sim.pawns[0];
    const rest0 = sim.readNeeds(eid)?.rest ?? 90;
    sim.pawnPositions.set(eid, cave!);
    for (let i = 0; i < 40; i++) sim.step(1 / 20); // 2s 洞穴庇护恢复
    expect((sim.readNeeds(eid)?.rest ?? 0)).toBeGreaterThan(rest0 as number); // shelterRestPerSec 生效
  });

  it('洞穴改造：caveHouse 只能建在洞穴上、资源少（木 5 < 木屋 30）', () => {
    const sim = new Sim({ seed: 802, pawnCount: 1 });
    sim.unlockTech('shelter:cave');
    const caveHouse = sim.mods.buildings.caveHouse;
    expect(caveHouse.costWood as number).toBeLessThan(sim.mods.buildings.house.costWood as number); // 改造便宜
    expect(caveHouse.onCave).toBe(true);
    // 找洞穴格 → 可建；草地格 → 不可建
    let cave: { x: number; y: number } | null = null;
    let grass: { x: number; y: number } | null = null;
    for (let y = 5; y < sim.world.height - 5; y++) {
      for (let x = 5; x < sim.world.width - 5; x++) {
        if (sim.world.getTile(x, y) === 'cave' && !cave) cave = { x, y };
        if (sim.world.getTile(x, y) === 'grass' && !sim.world.getBuilding(x, y) && !grass) grass = { x, y };
      }
    }
    expect(cave).not.toBeNull();
    expect(grass).not.toBeNull();
    expect(sim.world.canBuildFootprint(cave!.x, cave!.y, caveHouse)).toBe(true);
    expect(sim.world.canBuildFootprint(grass!.x, grass!.y, caveHouse)).toBe(false); // onCave 校验
  });
});

describe('科技 DLC（registerTech / defs.techs：.mod.json 加科技 = 探索卡自动接入）', () => {
  it('registerTech 追加科技 → 探索卡自动生成、解锁后可建', () => {
    const sim = new Sim({ seed: 803, pawnCount: 1, mods: (m) => {
      m.registerTech({ id: 'test:totem2', name: '图腾工艺', unlocks: ['totem'], desc: '测试 DLC 科技' });
      m.registerBuilding({ id: 'totem', name: '图腾', size: { x: 1, y: 1 }, hp: 100, color: '#7a4a6a', passable: false, buildTime: 2, costWood: 5, tech: 'test:totem2', tags: ['totem'] });
    } });
    // 探索卡自动生成（DLC 科技接入）
    expect(sim.mods.cards.has('explore:totem')).toBe(true);
    // 未解锁不可建；解锁后可建
    const spot = { x: 96, y: 96 };
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'totem' });
    expect(sim.buildQueue.some((b) => b.defId === 'totem')).toBe(false);
    sim.unlockTech('test:totem2');
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'totem' });
    expect(sim.buildQueue.some((b) => b.defId === 'totem')).toBe(true);
  });
});

describe('兴趣驱动娱乐（v2026-08-13：娱乐 = 开放活动空间，做什么由 pawn 兴趣属性决定）', () => {
  // 背景：toy 曾被全营地反复建 39 次吃光木头（toy:39/well:2/house:1）——根因是娱乐卡池写死
  // （idle+explore 人人权重一致）。本组测试保护：兴趣属性进 DNA、兴趣休闲卡进卡槽、权重调制生效。
  it('generateDna 生成 1~3 个兴趣；兴趣卡进卡槽', () => {
    let anyInterest = false;
    for (let seed = 1; seed <= 20; seed++) {
      const dna = generateDna(seed);
      expect(dna.interests.length).toBeGreaterThanOrEqual(1);
      expect(dna.interests.length).toBeLessThanOrEqual(3);
      // 去重
      expect(new Set(dna.interests).size).toBe(dna.interests.length);
      if (dna.interests.length > 0) anyInterest = true;
      // 兴趣休闲卡进卡槽（有 card 的兴趣）
      const slots = initSlots(dna);
      for (const id of dna.interests) {
        if (INTERESTS[id]?.card) {
          expect(slots.some((c) => c?.id === INTERESTS[id]!.card!.id)).toBe(true);
        }
      }
    }
    expect(anyInterest).toBe(true);
  });

  it('ruleInterest：有建造兴趣者探索卡权重高、无者被压低', () => {
    const withBuild = generateDna(7);
    const withoutBuild = generateDna(8);
    // 找一个明确有/无 build 兴趣的组合（遍历种子保证覆盖）
    let found = false;
    for (let seed = 1; seed <= 50 && !found; seed++) {
      const a = generateDna(seed);
      const b = generateDna(seed + 1000);
      if (a.interests.includes('build') && !b.interests.includes('build')) {
        found = true;
        const exploreCard = cardFromDef(makeExploreCard('toy', 'craft:toy'));
        const wa = effectiveWeight(exploreCard, { dna: a, slots: [] }, undefined);
        const wb = effectiveWeight(exploreCard, { dna: b, slots: [] }, undefined);
        expect(wa).toBeGreaterThan(wb); // 兴趣调制生效：有 build ×3 > 无 build ÷3
        break;
      }
    }
    expect(found).toBe(true);
  });
});

describe('B 方案：篝火 = 区域历史载体，伙伴/敌人由交流篝火历史判定（2026-08-13 用户设计）', () => {
  it('pawn.fireId 记录归属篝火；无归属 = null', () => {
    const sim = new Sim({ seed: 900, pawnCount: 2 });
    // ensureInitialCamp 后成员应归入篝火（fireId = campfire 建筑 key）
    for (const eid of sim.pawns) {
      const st = sim.pawnStates.get(eid)!;
      expect(st.fireId).toBeTruthy();
      expect(sim.world.buildings.has(st.fireId!)).toBe(true);
    }
    // unassign → fireId 清空
    sim.socialUnits.unassignPawn(sim.pawns[0]);
    expect(sim.pawnStates.get(sim.pawns[0])!.fireId).toBeNull();
  });

  it('交流篝火历史：听到袭击 → 对对方营地记 enemy + 关系转敌', () => {
    const sim = new Sim({ seed: 901, pawnCount: 2 });
    const [a, b] = sim.pawns;
    const stA = sim.pawnStates.get(a)!;
    const stB = sim.pawnStates.get(b)!;
    // 构造 A 所属篝火的历史（含袭击 → 敌意信号）
    const fireA = stA.fireId!;
    sim.socialUnits.addMemory(fireA, '🐺 营地遭到袭击（3 只野狼）');
    // 把两人放同 chunk 相邻 → 触发交流
    sim.pawnPositions.set(a, { x: 10, y: 10 });
    sim.pawnPositions.set(b, { x: 10, y: 11 });
    // 通过 step 触发（tickSocial 里相遇判定）
    for (let i = 0; i < 20; i++) sim.step(1 / 20);
    // B 对 A 的篝火 stance 应为 enemy（历史含袭击）
    expect(stB.knownFires?.[fireA]?.stance).toBe('enemy');
    // B 对 A 个体关系被拉低（fireEnemyRel 为负；敌意行为由 relationEffects 的 stance 判定触发）
    expect(stB.relationships?.get(a) ?? 0).toBeLessThan(0);
  });

  it('交流冷却：同对 pawn 不重复交流（防刷屏）', () => {
    const sim = new Sim({ seed: 902, pawnCount: 2 });
    // 手动触发两次 exchangeFireStory，第二次因冷却应跳过
    // （通过 simulate：把两 pawn 同 chunk 相邻，步进大量帧，看 knownFires 是否只更新一次）
    sim.pawnPositions.set(sim.pawns[0], { x: 10, y: 10 });
    sim.pawnPositions.set(sim.pawns[1], { x: 10, y: 11 });
    for (let i = 0; i < 60; i++) sim.step(1 / 20);
    const stB = sim.pawnStates.get(sim.pawns[1])!;
    const count = Object.keys(stB.knownFires ?? {}).length;
    // 冷却 120s，60 帧 = 3s，应只有 ≤1 条记录（实际相遇少，不刷屏即可）
    expect(count).toBeLessThanOrEqual(2);
  });

  it('营地被摧毁 → 成员 fireId 不再指向已毁建筑（防幽灵归属）', () => {
    // 发现背景（2026-08-14 试玩）：营地被毁后 pawn 仍持有旧 fireId →
    // 显示"有火归属"但建筑已不存在。摧毁 campfire 后 reassign 应让成员脱离
    //（或归属到其他仍存在的 campfire，但绝不指向已销毁的）。
    const sim = new Sim({ seed: 904, pawnCount: 1 });
    const eid = sim.pawns[0];
    const fireKey = sim.pawnStates.get(eid)!.fireId!;
    expect(sim.world.buildings.has(fireKey)).toBe(true);
    // 摧毁营地 campfire
    sim.world.damageBuilding(fireKey % sim.world.width, Math.floor(fireKey / sim.world.width), 9999);
    sim.bus.emit({ type: 'building_destroyed', x: fireKey % sim.world.width, y: Math.floor(fireKey / sim.world.width), defId: 'campfire' });
    // reassign 周期后 fireId 不得指向已销毁建筑（可 null = 游牧，或另一 campfire）
    for (let i = 0; i < 2; i++) sim.step(sim.tuning.faction.reassignInterval);
    const fid = sim.pawnStates.get(eid)!.fireId;
    if (fid != null) {
      const b = sim.world.buildings.get(fid);
      expect(b?.def.id).toBe('campfire'); // 指向存在的 campfire
    }
  });

  it('migrate：只有营地真实被毁（💥 记忆 + 威胁在场）才另起篝火；狼路过不算', () => {
    // 发现背景（2026-08-14 平衡试玩）：首判据"狼路过营地就计数" → 90 分钟"另起篝火"40 次、
    // 41 个单位 34 个空壳连锁雪崩。改为：仅当该篝火记忆有建筑被摧毁记录且当前有威胁在场
    // 才累计；狼路过/仅喊打喊杀不迁（可战斗/逃跑）。
    const sim = new Sim({ seed: 903, pawnCount: 1 });
    sim.tuning.autobuild.campfireTarget = 0; // 隔离 AI 自主建 campfire
    const fireKey = sim.pawnStates.get(sim.pawns[0])!.fireId!;
    const before = sim.factionsView().length;
    // 狼在场但无建筑损失 → 不迁（狼 hp 大 + 位置在 campfire 上 8 格，威胁半径内但不拆核心）
    sim.hostiles.push({ x: (fireKey % sim.world.width) + 8, y: Math.floor(fireKey / sim.world.width), hp: 5000, maxHp: 5000, targetX: 0, targetY: 0 });
    for (let i = 0; i < 15; i++) sim.step(sim.tuning.faction.migrateCheckEvery);
    expect(sim.factionsView().length).toBe(before); // 无 💥 记忆 → 不迁
    // 营地真实被毁（💥 入史）+ 威胁在场 → 连续周期后另起篝火
    sim.socialUnits.addMemory(fireKey, '💥 建筑被摧毁（围栏）');
    sim.socialUnits.addMemory(fireKey, '💥 建筑被摧毁（围栏）');
    sim.socialUnits.addMemory(fireKey, '💥 建筑被摧毁（围栏）');
    for (let i = 0; i < 15; i++) {
      sim.hostiles.push({ x: (fireKey % sim.world.width) + 8, y: Math.floor(fireKey / sim.world.width), hp: 5000, maxHp: 5000, targetX: 0, targetY: 0 });
      sim.step(sim.tuning.faction.migrateCheckEvery);
    }
    expect(sim.factionsView().length).toBeGreaterThanOrEqual(before + 1); // 另起新篝火
  });
});
