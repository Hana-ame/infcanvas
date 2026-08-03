import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { SimRng } from '../core/rng';
import { generateDna, initSlots, drawCards, pickBest } from '../ai/pawn';
import { World } from '../core/world';

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
});

describe('DNA + slots', () => {
  it('generates DNA with slots matching maxSlots', () => {
    const dna = generateDna(99);
    const slots = initSlots(dna);
    expect(slots.length).toBeGreaterThanOrEqual(dna.maxSlots);
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
    // 朝出生点右下移动（出生点 5x5 保证可通行）
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    const start = sim.pawnPositions.get(eid)!;
    sim.issueCommand({ type: 'move', x: cx + 2, y: cy + 2 });
    for (let i = 0; i < 200; i++) sim.step(1 / 20); // 10 秒
    const pos = sim.pawnPositions.get(eid)!;
    // 贴到目标（出生点内，可通行）
    expect(Math.hypot(pos.x - (cx + 2), pos.y - (cy + 2))).toBeLessThan(1.5);
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
