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
import { chunkBoundsOfList, chunkKey, chunkKeyToXY, chunksForInterest, fromChunkCoords, tileChunkKey } from '../shared/chunks';

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
    // hudScratch 是 R3-HUD 的必填字段：写死空表即可，本文件不测 HUD 那条线。
    // 踩过：rebase 合入 R3-HUD 后这里漏了它，tsc 报 TS2741「缺 hudScratch」——
    // 说明"必填字段"确实拦得住忘配，而不是等到运行时静默 undefined。
    events: snap.events,
    world: snap.world,
    techs: snap.techs,
    techFragments: snap.techFragments,
    hudScratch: {},
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

/**
 * 视口上报的**覆盖性**回归（2026-10-06 接线收尾）。
 *
 * 背景：setInterest 一直有测试，但**没有任何调用方** —— 渲染循环从不调它，
 * 于是 −76% 的带宽收益只能靠服务端「出生点默认视口」兜底，镜头一走远就失效。
 * 接线之后，真正的风险从「没人调」变成「半径调错导致漏块」：
 * 漏块不像带宽超标那样有数字报警，它表现为**画面周期性闪空**，极难从日志看出来。
 *
 * 断言的性质是「订阅范围 ⊇ 实际渲染范围」。不等号方向是刻意选的：
 * 宁可多订阅（多花一点带宽），绝不能少订阅（漏块）。
 *
 * ⚠️ **判据必须是 tile 级，不是区块边界级**（2026-10-06 实测踩到的坑）：
 * 第一版断言写的是「订阅的区块包围盒 ⊇ 渲染包围盒」，结果把半径从外接圆
 * 换成内切圆（明显更小）**测试照样全绿** —— 因为区块边长 64 格，
 * 包围盒对齐到块边界后把半径误差整个吞掉了，最小余量实测还有 3 格。
 * 也就是说那条断言根本没有区分力，是个假测试。
 * 现在改成逐 tile 验证「渲染范围内的每一格所属区块都在订阅集合里」，
 * 这才是漏块真正会发生的地方；内切圆在 21:9 这类宽扁视口下会真的漏（已验）。
 *
 * 这里**不复刻** Renderer 的私有状态（TILE/cam 拿不到），而是把「渲染范围」
 * 直接作为参数喂进去 —— 被测的是**覆盖性不等式**这个性质本身，
 * 而不是某个具体视口的数值。具体调用点由 main.ts 的渲染循环承担。
 */
describe('视口上报：订阅范围必须覆盖渲染范围', () => {
  /** 渲染范围内每一格所属的区块键（漏块就发生在这里 —— 某格的块没被订阅） */
  const renderedChunkKeys = (cx: number, cy: number, halfW: number, halfH: number): number[] => {
    const out = new Set<number>();
    for (let y = Math.round(cy) - halfH; y <= Math.round(cy) + halfH; y++) {
      for (let x = Math.round(cx) - halfW; x <= Math.round(cx) + halfW; x++) {
        out.add(tileChunkKey(x, y).key);
      }
    }
    return [...out];
  };

  it('外接圆订阅覆盖住渲染范围内的每一格（各种窗口比例/缩放/负坐标）', () => {
    const remote = new RemoteSim();
    const sent: { x: number; y: number; r: number }[] = [];
    (remote as unknown as { ws: { send(d: string): void } | null }).ws = {
      send: (d) => sent.push(JSON.parse(d).d as { x: number; y: number; r: number }),
    };

    // halfW/halfH 取自 drawTerrain 同一公式在不同窗口 + 缩放下的取值；
    // cams 含负坐标与偏移，用来压区块偏置编码的边界侧。
    const cases: { cx: number; cy: number; halfW: number; halfH: number; label: string }[] = [];
    for (const [w, h] of [
      [1920, 1080],
      [1280, 720],
      [800, 600],
      [3440, 1440],
    ] as [number, number][]) {
      for (const tile of [8, 20, 44]) {
        for (const [cx, cy] of [
          [0, 0],
          [1000, -750],
          [-2000, 2000],
        ] as [number, number][]) {
          cases.push({
            cx,
            cy,
            halfW: Math.ceil(w / 2 / tile) + 2,
            halfH: Math.ceil(h / 2 / tile) + 2,
            label: `${w}x${h} tile=${tile} cam=${cx},${cy}`,
          });
        }
      }
    }
    expect(cases.length).toBe(36);

    for (const c of cases) {
      sent.length = 0;
      // 复刻 main.ts 渲染循环的实际调用方式（外接圆半径）
      remote.setInterest(c.cx, c.cy, Math.hypot(c.halfW, c.halfH));
      expect(sent.length, `${c.label}: 未发出 interest`).toBe(1);

      const subscribed = new Set(chunksForInterest(sent[0]!));
      const need = renderedChunkKeys(c.cx, c.cy, c.halfW, c.halfH);
      for (const k of need) {
        const { cx: bx, cy: by } = chunkKeyToXY(k);
        expect(
          subscribed.has(k),
          `${c.label}: 渲染区内的区块 (${bx},${by}) 不在订阅集合里 —— 该处会漏块闪空`,
        ).toBe(true);
      }
      expect(subscribed.size).toBeGreaterThanOrEqual(need.length);
    }
  });
});