/**
 * remote-client.test.ts —— 联机客户端合入层：welcome/full/delta 语义（不经网络，
 * 直接喂消息——消息形状由真实 Sim 的 snapshot 构造，防止两端漂移）。
 */
import { describe, expect, it } from 'vitest';
import { RemoteSim } from '../client/remote';
import { Sim, snapshotOf } from '../sim';
import { ModRegistry } from '../mods';
import type { FullState } from '../shared/protocol';

function feed(remote: RemoteSim, msg: Parameters<RemoteSim['handleForTest']>[0]): void {
  remote.handleForTest(msg);
}

function fullStateOf(sim: Sim): FullState {
  const snap = snapshotOf(sim);
  return {
    time: snap.time,
    stockpile: snap.stockpile,
    pawns: snap.pawns,
    hostiles: snap.hostiles,
    buildings: snap.world.buildings,
    events: snap.events,
    world: snap.world,
    // 科技抽卡池状态（R2-1）：与 game-server 的 fullState() 同源同字段
    techs: snap.techs,
    techFragments: snap.techFragments,
  };
}

describe('RemoteSim 合入层', () => {
  it('welcome：建地形推导器 + 全量状态就位；tile/feature 与真实世界一致', () => {
    const real = new Sim({ seed: 42, registry: ModRegistry.default() });
    const remote = new RemoteSim();
    feed(remote, { t: 'welcome', d: { ...makeWelcome(real), seed: real.world.seed, tuning: structuredClone(real.tuning) } });
    const p0 = [...real.pawns()][0];
    expect([...remote.pawns()]).toHaveLength(4);
    // 无限地图零流量：客户端本地推导与服务器一致
    expect(remote.tileAt(3, 4)).toBe(real.world.tileAt(3, 4));
    expect(remote.featureAt(p0.pos.x, p0.pos.y)).toEqual(real.world.featureAt(p0.pos.x, p0.pos.y));
    expect(remote.buildingDef('campfire')?.tags).toContain('fire');
    expect(remote.traitName('lazy')).toBe('懒散');
  });

  it('delta 合入：变更生效、删除生效、事件追加不重复', () => {
    const real = new Sim({ seed: 5, registry: ModRegistry.default() });
    const remote = new RemoteSim();
    feed(remote, { t: 'welcome', d: { ...makeWelcome(real), seed: real.world.seed, tuning: structuredClone(real.tuning) } });
    const eids = [...real.pawns()].map((p) => p.eid);
    const changed = eids[0];
    const removed = eids[eids.length - 1];
    // 服务器侧世界变化
    real.pawn(changed)!.pos = { x: -3, y: 7 };
    real.killPawn(removed, '测试');
    real.log('测试事件一条');
    const snap = snapshotOf(real);
    feed(remote, {
      t: 'delta',
      d: {
        time: sim_time(real),
        stockpile: { ...real.stockpile },
        pawns: snap.pawns.filter((p) => p.eid === changed),
        removedPawns: [removed],
        hostiles: [],
        buildings: snap.world.buildings,
        newEvents: [{ time: real.time, text: '测试事件一条' }],
      },
    });
    expect(remote.pawn(changed)!.pos).toEqual({ x: -3, y: 7 });
    expect(remote.pawn(removed)).toBeUndefined();
    expect([...remote.pawns()].length).toBe(3);
    expect(remote.events().at(-1)?.text).toBe('测试事件一条');
  });

  it('full 对账：完全覆盖本地投影（自愈任何漂移）', () => {
    const real = new Sim({ seed: 6, registry: ModRegistry.default() });
    const remote = new RemoteSim();
    feed(remote, { t: 'welcome', d: { ...makeWelcome(real), seed: real.world.seed, tuning: structuredClone(real.tuning) } });
    for (const p of remote.pawns()) p.needs.food = 1; // 本地被污染
    feed(remote, { t: 'full', d: fullStateOf(real) });
    for (const p of real.pawns()) {
      expect(remote.pawn(p.eid)!.needs.food).toBe(p.needs.food); // 漂移被纠正
    }
  });

  it('sendCommand 上行 JSON 形状正确（cmd 信封）', () => {
    const remote = new RemoteSim();
    let up: unknown;
    remote.onCmdUp = (c) => {
      up = c;
    };
    (remote as unknown as { ws: { send(data: string): void } | null }).ws = {
      send(data: string) {
        up = JSON.parse(data);
      },
    };
    remote.sendCommand('move', { x: 1, y: 2 });
    expect(up).toEqual({ t: 'cmd', c: { type: 'move', args: { x: 1, y: 2 } } });
  });
});

// ---- 工具：用真实 Sim 的快照构造 welcome 状态体（保证与服务器输出同源）----
interface WelcomeBody extends FullState {
  seed: number;
  tuning: import('../sim/tuning').Tuning;
}
function makeWelcome(sim: Sim): Omit<WelcomeBody, 'seed' | 'tuning'> {
  return fullStateOf(sim);
}
function sim_time(sim: Sim): number {
  return sim.time;
}