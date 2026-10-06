/**
 * chunked-sync.test.ts —— 分区块同步的**兼容性与合入语义**（line/net 2026-10-06）。
 *
 * 三条红线在这里各有守护：
 *  1. **server 权威**：客户端合入层只是投影，不自己推导逻辑状态；
 *  2. **向后兼容**：不带 scope 的旧消息必须与 v1 行为逐位相同（这是零回归的前提）；
 *  3. **卸载正确**：走远 → droppedChunks → 远端建筑/敌袭真的被卸载。
 */
import { describe, expect, it } from 'vitest';
import { RemoteSim } from '../client/remote';
import { Sim, snapshotOf } from '../sim';
import { ModRegistry } from '../mods';
import type { FullState, DeltaMsg } from '../shared/protocol';
import { chunkKey, chunkKeyToXY, fromChunkCoords, tileChunkKey } from '../shared/chunks';

function simOf(seed = 42): Sim {
  return new Sim({ seed, registry: ModRegistry.default() });
}

/** 与 game-server.fullState() 同源的 FullState 构造（保持两端同形，防漂移） */
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
    techs: snap.techs,
    techFragments: snap.techFragments,
  };
}

function welcomeOf(sim: Sim) {
  return {
    t: 'welcome' as const,
    d: { ...fullStateOf(sim), seed: sim.world.seed, tuning: structuredClone(sim.tuning) },
  };
}

/**
 * 在给定区块里找一格能落篝火的位置。
 *
 * 为什么需要它（首轮 CI 的失败）：addBuilding 会因**地形不可通行**返回 null，
 * 而测试里写死坐标（如 130,70 / 600,600）等于赌那格恰好是草地——
 * 换 seed 或改地形参数就静默变成"没放上"，断言再报一个误导性的数字
 * （expected 1 to be 2）。这里改成"找到能放的格，且校验它确实在目标区块里"，
 * 失败信息直接指向真正的原因。
 */
function placeInChunk(sim: Sim, cx: number, cy: number): { x: number; y: number } {
  for (let y = cy * 64 + 2; y < cy * 64 + 62; y++) {
    for (let x = cx * 64 + 2; x < cx * 64 + 62; x++) {
      if (sim.world.addBuilding('campfire', x, y)) return { x, y };
    }
  }
  throw new Error(`区块 (${cx},${cy}) 内找不到可落篝火的位置`);
}

describe('兼容层：旧消息（无 scope）行为不变', () => {
  it('不带 scope 的 full = v1 全量语义，远端区块数据全部保留', () => {
    const sim = simOf(7);
    const remote = new RemoteSim();
    remote.handleForTest(welcomeOf(sim));
    expect(remote.loadedChunkCount).toBe(-1); // -1 = 未启用裁剪
    // 在远块放一座建筑，再来一份全量 full
    const far = placeInChunk(sim, 7, 7);
    const withFar = fullStateOf(sim);
    withFar.buildings = sim.world.buildingsInChunks([tileChunkKey(far.x, far.y).key]);
    remote.handleForTest({ t: 'full', d: withFar });
    expect(remote.buildings().length).toBeGreaterThan(0);
    expect(remote.loadedChunkCount).toBe(-1);
  });

  it('不带 scope 的 delta：hostiles/buildings 整体替换（v1 逐位行为）', () => {
    const sim = simOf(9);
    const remote = new RemoteSim();
    remote.handleForTest(welcomeOf(sim));
    const d: DeltaMsg = {
      t: 'delta',
      d: {
        time: sim.time + 0.5,
        stockpile: { wood: 12 },
        pawns: [],
        removedPawns: [],
        hostiles: [],
        buildings: sim.world.buildingsInChunks([chunkKey(7, 7)]),
        newEvents: [{ time: sim.time, text: '区块测试' }],
      },
    };
    remote.handleForTest(d);
    expect(remote.stockpile.wood).toBe(12);
    expect(remote.events().at(-1)?.text).toBe('区块测试');
  });
});

describe('区块化合入：scope 内替换、scope 外卸载', () => {
  it('delta 带 scope：只保留 scope 内的建筑，droppedChunks 的区块被卸载', () => {
    const sim = simOf(11);
    const remote = new RemoteSim();
    remote.handleForTest(welcomeOf(sim));

    // 两块分别放一座建筑：A 块在本地，B 块在"远方"
    const aPos = placeInChunk(sim, 2, 1);
    const bPos = placeInChunk(sim, 9, 9);
    const aKey = tileChunkKey(aPos.x, aPos.y).key;

    // 第一帧：订阅两块
    const scopeA = [{ cx: 2, cy: 1 }, { cx: 9, cy: 9 }];
    remote.handleForTest({
      t: 'delta',
      d: {
        time: sim.time,
        stockpile: {},
        pawns: [],
        removedPawns: [],
        hostiles: [],
        buildings: sim.world.buildingsInChunks(fromChunkCoords(scopeA)),
        newEvents: [],
        scope: scopeA,
        droppedChunks: [],
      },
    });
    expect(remote.buildings().length).toBe(2);
    expect(remote.loadedChunkCount).toBe(2);

    // 第二帧：玩家走远 → 退订 B 块，订阅变成只剩 A
    const scopeB = [{ cx: 2, cy: 1 }];
    remote.handleForTest({
      t: 'delta',
      d: {
        time: sim.time + 0.5,
        stockpile: {},
        pawns: [],
        removedPawns: [],
        hostiles: [],
        buildings: sim.world.buildingsInChunks(fromChunkCoords(scopeB)),
        newEvents: [],
        scope: scopeB,
        droppedChunks: [{ cx: 9, cy: 9 }],
      },
    });
    const left = remote.buildings();
    expect(left.length).toBe(1);
    expect(tileChunkKey(left[0]!.pos.x, left[0]!.pos.y).key).toBe(aKey);
    expect(remote.loadedChunkCount).toBe(1);
  });

  it('卸载是按区块的：同块其他实体不受影响（不能整块清空）', () => {
    const sim = simOf(12);
    const remote = new RemoteSim();
    remote.handleForTest(welcomeOf(sim));
    const p1 = placeInChunk(sim, 2, 1);
    // 同块第二座：**必须隔开 ≥ minSpacing（出厂 5）**。同款篝火的间距判定把既有
    // 矩形外扩 pad=minSpacing-1 格再判交，所以 p1+3 必然放不下。
    // 踩过：这行原本写 p1.x+3，CI 报的是"第二座篝火放不下"——报错完全指不到真因
    // （真因是间距规则，与区块逻辑无关），改成 +8 后一眼可辨。
    const p2 = { x: p1.x + 8, y: p1.y + 8 };
    if (tileChunkKey(p2.x, p2.y).key !== tileChunkKey(p1.x, p1.y).key) {
      throw new Error('p2 应与 p1 同块（+8 不跨 64 边界）');
    }
    if (!sim.world.addBuilding('campfire', p2.x, p2.y)) throw new Error('第二座篝火放不下');
    const p3 = placeInChunk(sim, 9, 9);
    void p3;
    const localScope = [{ cx: 2, cy: 1 }];
    const farScope = [{ cx: 9, cy: 9 }];
    remote.handleForTest({
      t: 'delta',
      d: {
        time: sim.time,
        stockpile: {},
        pawns: [],
        removedPawns: [],
        hostiles: [],
        buildings: sim.world.buildingsInChunks(fromChunkCoords([...localScope, ...farScope])),
        newEvents: [],
        scope: [...localScope, ...farScope],
      },
    });
    expect(remote.buildings().length).toBe(3);
    // 退订远块
    remote.handleForTest({
      t: 'delta',
      d: {
        time: sim.time + 0.5,
        stockpile: {},
        pawns: [],
        removedPawns: [],
        hostiles: [],
        buildings: sim.world.buildingsInChunks(fromChunkCoords(localScope)),
        newEvents: [],
        scope: localScope,
        droppedChunks: farScope,
      },
    });
    expect(remote.buildings().length).toBe(2); // 本块两座都还在
  });

  it('敌袭也随区块卸载（否则走过界的猫会一直画在屏幕上）', () => {
    const sim = simOf(13);
    const remote = new RemoteSim();
    remote.handleForTest(welcomeOf(sim));
    const nearPos = placeInChunk(sim, 2, 1);
    const farPos = placeInChunk(sim, 9, 9);
    const near = sim.spawnHostile('cat', nearPos.x, nearPos.y);
    const far = sim.spawnHostile('cat', farPos.x, farPos.y);
    const localScope = [{ cx: 2, cy: 1 }];
    const bothScope = [...localScope, { cx: 9, cy: 9 }];
    remote.handleForTest({
      t: 'delta',
      d: {
        time: sim.time,
        stockpile: {},
        pawns: [],
        removedPawns: [],
        hostiles: [...sim.hostiles()],
        buildings: [],
        newEvents: [],
        scope: bothScope,
      },
    });
    expect(remote.hostiles().length).toBe(2);
    remote.handleForTest({
      t: 'delta',
      d: {
        time: sim.time + 0.5,
        stockpile: {},
        pawns: [],
        removedPawns: [],
        hostiles: sim.hostiles().filter((h) => h.id !== far.id),
        buildings: [],
        newEvents: [],
        scope: localScope,
        droppedChunks: [{ cx: 9, cy: 9 }],
      },
    });
    expect(remote.hostiles().map((h) => h.id)).toEqual([near.id]);
  });

  it('full 带 scope：scope 外的 pawn 投影被清除，scope 内的被对账', () => {
    const sim = simOf(14);
    const remote = new RemoteSim();
    remote.handleForTest(welcomeOf(sim));
    // 把一只鼠挪到远块
    const eid = [...sim.pawns()][0]!.eid;
    sim.pawn(eid)!.pos = { x: 600, y: 600 };
    const localScope = [{ cx: 0, cy: 0 }];
    const fs = fullStateOf(sim);
    remote.handleForTest({
      t: 'full',
      d: {
        ...fs,
        pawns: fs.pawns.filter((p) => tileChunkKey(p.pos.x, p.pos.y).key === tileChunkKey(0, 0).key),
        scope: localScope,
      },
    });
    // 远块的鼠被 scope 排除 → 客户端不应再投影它
    expect(remote.pawn(eid)).toBeUndefined();
  });
});

describe('interest 上行', () => {
  it('setInterest 上行 interest 信封（{t,d:{x,y,r}}）且未变不重复发', () => {
    const remote = new RemoteSim();
    const sent: string[] = [];
    (remote as unknown as { ws: { send(d: string): void } | null }).ws = {
      send(d: string) {
        sent.push(d);
      },
    };
    remote.setInterest(100, 100, 192);
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0]!)).toEqual({ t: 'interest', d: { x: 100, y: 100, r: 192 } });
    // 同一视口再设一次 → 指纹相同 → 不重发（否则渲染层 60Hz 会打爆上行）
    remote.setInterest(100, 100, 192);
    expect(sent.length).toBe(1);
    // 视口大挪 → 指纹变 → 重新上行
    remote.setInterest(5000, 5000, 192);
    expect(sent.length).toBe(2);
  });

  it('非法参数不上行（NaN/Infinity/非正半径）', () => {
    const remote = new RemoteSim();
    const sent: string[] = [];
    (remote as unknown as { ws: { send(d: string): void } | null }).ws = {
      send(d: string) {
        sent.push(d);
      },
    };
    remote.setInterest(Number.NaN, 0, 192);
    remote.setInterest(0, Number.POSITIVE_INFINITY, 192);
    remote.setInterest(0, 0, 0);
    remote.setInterest(0, 0, -5);
    expect(sent.length).toBe(0);
  });
});

describe('server 权威性回归：客户端不得自己决定逻辑状态', () => {
  it('区块化只改变"收到什么"，不改变命令的上行入口', () => {
    const sim = simOf(15);
    const remote = new RemoteSim();
    remote.handleForTest(welcomeOf(sim));
    let up: { type: string; args?: Record<string, unknown> } | null = null;
    remote.onCmdUp = (c) => {
      up = c;
    };
    (remote as unknown as { ws: { send(d: string): void } | null }).ws = { send: () => {} };
    // 即便有 loadedChunks，客户端仍然只发命令，不发"我认为的世界状态"
    remote.setInterest(100, 100, 192);
    remote.sendCommand('move', { x: 5, y: 5 });
    expect(up).toEqual({ type: 'move', args: { x: 5, y: 5 } });
  });

  it('地形永远由本地 seed 推导（区块化没有把地形改成下发）', () => {
    const sim = simOf(16);
    const remote = new RemoteSim();
    remote.handleForTest(welcomeOf(sim));
    // 零流量地形：随机取若干格，客户端自推结果必须与服务器一致
    for (const [x, y] of [[0, 0], [37, 91], [-128, 256], [1000, -1000]] as [number, number][]) {
      expect(remote.tileAt(x, y)).toBe(sim.world.tileAt(x, y));
    }
  });
});