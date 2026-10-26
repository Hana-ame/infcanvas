/**
 * HeroControl（P3 无感）纯逻辑测试
 *
 * 覆盖矩阵：两条传输路径 × 三种意图 × 有/无角色 × 节流。
 *
 * 为什么这里测纯逻辑而不是测 DOM/WS：HeroControl 是 main.ts 与传输层之间的
 * 唯一接缝，"无感"的全部语义都在这 ~60 行里。把接缝测死，上层按键处理和
 * 下层传输实现各自改都不会破坏"同键同义"。
 *
 * 传输端用最小假实现：Sim 只暴露 HeroControl 真正调的四个成员，
 * RemoteSim 只暴露 sendInput。避免为了测试去起真服务器/真 Sim。
 */
import { describe, expect, it } from 'vitest';
import type { Sim } from '../sim';
import type { PawnState } from '../sim/types';
import type { RemoteSim } from '../client/remote';
import { makeHeroControl, REMOTE_INPUT_MIN_INTERVAL_MS } from '../client/hero-control';

type Dir = { dx: number; dy: number; dt: number };
type Input = { vx: number; vy: number; act?: 'attack' | 'interact' };

/** 假 Sim：只实现 HeroControl 真正调的成员，并记录调用 */
function fakeSim() {
  const pawns = new Map<number, PawnState>();
  const moves: (Dir & { p: PawnState })[] = [];
  const attacks: number[] = [];
  const interacts: number[] = [];
  const add = (eid: number, pos = { x: 0, y: 0 }): PawnState => {
    const p = { eid, pos } as PawnState;
    pawns.set(eid, p);
    return p;
  };
  const sim = {
    pawn: (eid: number) => pawns.get(eid),
    moveDir: (p: PawnState, dx: number, dy: number, dt: number) => {
      p.pos.x += dx * dt * 4.5; // 与 tuning.hero.speed 对齐，方便断言位移
      p.pos.y += dy * dt * 4.5;
      moves.push({ p, dx, dy, dt });
      return true;
    },
    directAttack: (eid: number) => {
      attacks.push(eid);
      return true;
    },
    interact: (eid: number) => {
      interacts.push(eid);
      return null;
    },
  };
  return { ...sim, add, moves, attacks, interacts };
}

/** 假 RemoteSim：只记录 sendInput 上行 */
function fakeRemote() {
  const sent: Input[] = [];
  const remote = { sendInput: (vx: number, vy: number, act?: 'attack' | 'interact') => sent.push({ vx, vy, act }) };
  return { ...remote, sent };
}

const castSim = (s: ReturnType<typeof fakeSim>) => s as unknown as Sim;
const castRemote = (r: ReturnType<typeof fakeRemote>) => r as unknown as RemoteSim;

describe('HeroControl · 本地路径', () => {
  it('move → 调 sim.moveDir 并真的移动', () => {
    const sim = fakeSim();
    const p = sim.add(7, { x: 0, y: 0 });
    const c = makeHeroControl({ sim: castSim(sim), remote: null });
    c.setEid(7);

    c.move(1, 0, 0.1);
    expect(sim.moves).toHaveLength(1);
    expect(sim.moves[0]).toMatchObject({ p, dx: 1, dy: 0, dt: 0.1 });
    expect(p.pos.x).toBeGreaterThan(0);
    expect(p.pos.y).toBe(0);
  });

  it('act(attack) → directAttack；act(interact) → interact', () => {
    const sim = fakeSim();
    sim.add(7);
    const c = makeHeroControl({ sim: castSim(sim), remote: null });
    c.setEid(7);

    c.act('attack');
    c.act('interact');
    expect(sim.attacks).toEqual([7]);
    expect(sim.interacts).toEqual([7]);
  });

  it('eid 为 null（未认领）→ 所有意图都是 no-op', () => {
    const sim = fakeSim();
    const c = makeHeroControl({ sim: castSim(sim), remote: null });
    expect(c.eid).toBeNull();

    c.move(1, 0, 0.1);
    c.act('attack');
    expect(sim.moves).toHaveLength(0);
    expect(sim.attacks).toHaveLength(0);
    expect(sim.interacts).toHaveLength(0);
  });

  it('认领的鼠不存在（已死/被移除）→ move 静默跳过，不抛错', () => {
    const sim = fakeSim();
    const c = makeHeroControl({ sim: castSim(sim), remote: null });
    c.setEid(999); // 没 add 过
    expect(() => c.move(1, 0, 0.1)).not.toThrow();
    expect(sim.moves).toHaveLength(0);
  });

  it('松键 move(0,0) → moveDir 收到零向量（本地天然不动，与服务端清 lastInput 对齐）', () => {
    const sim = fakeSim();
    sim.add(7);
    const c = makeHeroControl({ sim: castSim(sim), remote: null });
    c.setEid(7);

    c.move(1, 0, 0.1);
    c.move(0, 0, 0.1);
    expect(sim.moves.map((m) => [m.dx, m.dy])).toEqual([
      [1, 0],
      [0, 0],
    ]);
  });
});

describe('HeroControl · 联机路径', () => {
  it('move → sendInput 上行方向（dt 不上行：服务端用自己的 tick dt）', () => {
    const remote = fakeRemote();
    const c = makeHeroControl({ sim: null, remote: castRemote(remote) });
    c.setEid(3);

    c.move(0, -1, 0.05);
    expect(remote.sent).toEqual([{ vx: 0, vy: -1 }]);
  });

  it('act → sendInput(0,0,act)：动作是一次性脉冲，方向归零', () => {
    const remote = fakeRemote();
    const c = makeHeroControl({ sim: null, remote: castRemote(remote) });
    c.setEid(3);

    c.act('attack');
    expect(remote.sent).toEqual([{ vx: 0, vy: 0, act: 'attack' }]);
    remote.sent.length = 0;
    c.act('interact');
    expect(remote.sent).toEqual([{ vx: 0, vy: 0, act: 'interact' }]);
  });

  it('节流：不足最小间隔不上行（默认 33ms ≈ 30Hz，快于服务端 20Hz tick）', () => {
    let now = 1000;
    const remote = fakeRemote();
    const c = makeHeroControl({
      sim: null,
      remote: castRemote(remote),
      clock: () => now,
    });
    c.setEid(3);

    c.move(1, 0, 0.05);
    expect(remote.sent).toHaveLength(1);

    now += REMOTE_INPUT_MIN_INTERVAL_MS - 1; // 32ms：不足
    c.move(1, 0, 0.05);
    expect(remote.sent).toHaveLength(1);

    now += 1; // 恰好到 33ms
    c.move(1, 0, 0.05);
    expect(remote.sent).toHaveLength(2);
  });

  it('动作不受移动节流影响（J 必须立刻响应，不能等上一帧移动放行）', () => {
    let now = 1000;
    const remote = fakeRemote();
    const c = makeHeroControl({
      sim: null,
      remote: castRemote(remote),
      clock: () => now,
    });
    c.setEid(3);

    c.move(1, 0, 0.05);
    c.act('attack'); // 同一时刻
    expect(remote.sent).toHaveLength(2);
    expect(remote.sent[1]).toEqual({ vx: 0, vy: 0, act: 'attack' });
  });

  it('未认领 → no-op（不偷偷上行输入）', () => {
    const remote = fakeRemote();
    const c = makeHeroControl({ sim: null, remote: castRemote(remote) });
    c.move(1, 0, 0.05);
    c.act('attack');
    expect(remote.sent).toHaveLength(0);
  });
});

describe('HeroControl · 传输选择', () => {
  it('sim 优先：两个都传时走本地，不误走网络', () => {
    const sim = fakeSim();
    const remote = fakeRemote();
    sim.add(7);
    const c = makeHeroControl({ sim: castSim(sim), remote: castRemote(remote) });
    c.setEid(7);

    c.move(1, 0, 0.1);
    c.act('attack');
    expect(sim.moves).toHaveLength(1);
    expect(sim.attacks).toEqual([7]);
    expect(remote.sent).toHaveLength(0);
  });

  it('setEid 可热切换（联机模式下 claimAck 异步到达）', () => {
    const sim = fakeSim();
    sim.add(1);
    sim.add(2);
    const c = makeHeroControl({ sim: castSim(sim), remote: null });

    c.setEid(1);
    c.move(1, 0, 0.1);
    c.setEid(2); // 换角色
    c.move(1, 0, 0.1);
    expect(sim.moves.map((m) => m.p.eid)).toEqual([1, 2]);
  });

  it('minIntervalMs=0 → 不节流（测试/调试用）', () => {
    const remote = fakeRemote();
    const c = makeHeroControl({
      sim: null,
      remote: castRemote(remote),
      minIntervalMs: 0,
    });
    c.setEid(3);
    c.move(1, 0, 0.05);
    c.move(1, 0, 0.05);
    expect(remote.sent).toHaveLength(2);
  });
});
