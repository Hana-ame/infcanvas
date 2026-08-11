import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { RemoteSim } from '../../client/remote';
import type { WelcomeMsg, SnapshotMsg, EventMsg } from '../../shared/protocol';

// P1 server 骨架（DESIGN §5/§8）：权威在 server，客户端只读视图
describe('server 网络层基础（P1）', () => {
  it('tile 变更经 onTileChange 上报（server 推增量的来源）', () => {
    const sim = new Sim({ seed: 7, pawnCount: 1 });
    const seen: [number, number, string][] = [];
    sim.addTileListener((x, y, id) => seen.push([x, y, id]));
    sim.world.setTile(5, 5, 'grass');
    sim.world.setTile(6, 6, 'dirt');
    sim.world.setTile(5, 5, 'grass'); // 重复 set 不触发
    expect(seen).toEqual([[5, 5, 'grass'], [6, 6, 'dirt']]);
  });

  it('addTileListener 退订后不再上报', () => {
    const sim = new Sim({ seed: 7, pawnCount: 1 });
    let n = 0;
    const off = sim.addTileListener(() => n++);
    sim.world.setTile(3, 3, 'dirt');
    off();
    sim.world.setTile(4, 4, 'dirt');
    expect(n).toBe(1);
  });

  it('RemoteSim: welcome 初始化世界底（defs 只读表 + tileGrid）', () => {
    const rs = new RemoteSim('ws://unused');
    // 手工喂 welcome（等价于 server 下发）
    const welcome: WelcomeMsg = {
      type: 'welcome', you: 1, seed: 42, tickHz: 20, dayLength: 120, tuning: { needs: { foodMoodLow: 30 }, faction: { unitCapChurch: 10, unitCapCampfire: 3 }, env: { dayLength: 120, baseTemp: 18 } },
      world: { width: 4, height: 3 },
      tiles: { grass: { id: 'grass', color: '#3a7d44', passable: true, buildable: true } },
      buildings: { campfire: { id: 'campfire', name: '篝火', size: { x: 1, y: 1 }, color: '#f4a340', passable: true, hp: 100 } },
      items: { wood: { id: 'wood', name: '木头' } },
      tileGrid: ['grass', 'grass', 'grass', 'grass', 'grass', 'water', 'water', 'grass', 'grass', 'grass', 'grass', 'grass'],
    };
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(welcome));
    expect(rs.world.width).toBe(4);
    expect(rs.world.height).toBe(3);
    expect(rs.world.getTile(0, 0)).toBe('grass');
    expect(rs.world.getTile(5, 1)).toBe('water');
    expect(rs.mods.buildings.campfire.name).toBe('篝火');
    expect(rs.mods.items.wood.name).toBe('木头');
  });

  it('RemoteSim: 快照驱动 pawns/资源/建筑 + tile 增量事件更新地面', () => {
    const rs = new RemoteSim('ws://unused');
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify({
      type: 'welcome', you: 1, seed: 42, tickHz: 20, dayLength: 120, tuning: { needs: { foodMoodLow: 30 }, faction: { unitCapChurch: 10, unitCapCampfire: 3 }, env: { dayLength: 120, baseTemp: 18 } },
      world: { width: 4, height: 3 },
      tiles: { grass: { id: 'grass', color: '#3a7d44', passable: true, buildable: true } },
      buildings: {},
      items: {},
      tileGrid: ['grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass'],
    } satisfies WelcomeMsg));

    const snap: SnapshotMsg = {
      type: 'snapshot', t: 42, paused: false, speed: 1, isNight: true, day: 2,
      weather: { raining: true, temperature: 13 },
      stockpile: { wood: 10, food: 5 },
      pawns: [{
        eid: 9, x: 1, y: 1, hp: 80, maxHp: 100, job: 'lumberjack',
        needs: { food: 50, rest: 60, mood: 70, san: 80 }, faith: 30,
        attrs: { str: 10, con: 10, siz: 10, dex: 10, int: 10, pow: 10, app: 10, edu: 10 },
        skills: { work: 3 }, traits: ['强壮'], maxSlots: 2,
        slots: [{ id: 'eat', name: '进食' }], desires: { hunger: 42 },
        lastDecision: { drawn: ['eat', 'rest'], picked: 'eat', time: 40 },
      }],
      hostiles: [], buildings: [], buildQueue: [], buildingVersion: 1,
    };
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(snap));

    expect(rs.time).toBe(42);
    expect(rs.isNight()).toBe(true);
    expect(rs.env).toEqual({ raining: true, temperature: 13, rainLeft: 0 });
    expect(rs.stockpile.wood).toBe(10);
    expect(rs.pawns).toEqual([9]);
    const prof = rs.pawnProfile(9);
    expect(prof?.job).toBe('lumberjack');
    expect(prof?.dna.traits).toEqual(['强壮']);
    expect(prof?.slots[0]?.name).toBe('进食');
    expect(prof?.lastDecision?.picked).toBe('eat');
    expect(rs.healthOf(9)).toEqual({ hp: 80, maxHp: 100 });

    // 采集换地形：server 推 tileChanged → 客户端地面更新
    const ev: EventMsg = { type: 'event', t: 42.5, events: [{ kind: 'tileChanged', x: 2, y: 0, tileId: 'dirt' }] };
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(ev));
    expect(rs.world.getTile(2, 0)).toBe('dirt');

    // 快照更新建筑（server 权威回显）
    snap.buildings = [{ defId: 'campfire', x: 0, y: 0, hp: 100, maxHp: 100, faction: 'A', footprint: [{ x: 0, y: 0 }] }];
    snap.buildingVersion = 2;
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(snap));
    expect(rs.world.buildingVersion).toBe(2);
    expect(rs.buildingAt(0, 0)?.defId).toBe('campfire');
  });
});
