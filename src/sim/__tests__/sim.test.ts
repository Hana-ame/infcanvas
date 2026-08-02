import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { SimRng } from '../core/rng';
import { generateDna, initSlots, pickNextAction } from '../ai/pawn';
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

  it('pickNextAction always returns a card', () => {
    const dna = generateDna(5);
    const slots = initSlots(dna);
    const rng = new SimRng(1);
    for (let i = 0; i < 20; i++) {
      const card = pickNextAction({ dna, slots }, rng);
      expect(card).toBeDefined();
      expect(card.weight).toBeGreaterThan(0);
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
    // 朝出生点右下角移动
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    sim.issueCommand({ type: 'move', x: cx + 10, y: cy + 10 });
    for (let i = 0; i < 200; i++) sim.step(1 / 20); // 10 秒
    const pos = sim.pawnPositions.get(eid)!;
    // 应该明显向右下移动了
    expect(pos.x).toBeGreaterThan(cx);
    expect(pos.y).toBeGreaterThan(cy);
  });

  it('queues and completes a build', () => {
    const sim = new Sim({ seed: 4, pawnCount: 1 });
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    // 在出生点旁放墙
    sim.issueCommand({ type: 'build', x: cx + 3, y: cy, buildingId: 'wall' });
    // 等建造完成（buildTime=3s）
    for (let i = 0; i < 100; i++) sim.step(1 / 20); // 5 秒
    const b = sim.world.getBuilding(cx + 3, cy);
    expect(b).not.toBeNull();
    expect(b!.def.id).toBe('wall');
  });

  it('mining converts ore tile to dirt and adds stockpile', () => {
    const sim = new Sim({ seed: 5, pawnCount: 1 });
    const eid = sim.pawns[0];
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    // 找出生点附近的矿脉（可达距离内）
    let found = false;
    for (let r = 1; r <= 8 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (sim.world.inBounds(x, y) && sim.world.getTile(x, y) === 'ore') {
            sim.issueCommand({ type: 'mine', pawnId: eid, x, y });
            // 8 格距离，速度 4，最多 2 秒走到 + 3 秒开采
            for (let i = 0; i < 300; i++) sim.step(1 / 20); // 15 秒
            expect(sim.world.getTile(x, y)).toBe('dirt');
            expect(sim.stockpile.ore).toBeGreaterThan(0);
            found = true;
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});
