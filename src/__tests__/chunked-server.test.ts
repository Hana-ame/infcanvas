/**
 * chunked-server.test.ts —— 分区块同步的**服务端集成**测试（line/net 2026-10-06）。
 *
 * 覆盖纯函数测不到的那一半：interest 真的被服务器接收并改变了下发内容。
 * 这里用真实 WebSocket（node 20/22 都跑同一套，靠 src/__tests__/setup.ts 补 WebSocket）。
 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer } from '../server/game-server';
import { ModRegistry } from '../mods';
import { chunkKeyToXY } from '../shared/chunks';

/** 构造即挂缓冲——服务器 open 后立刻发 welcome，等 open 再挂会丢首包（真实竞态踩坑） */
function makeClient(url: string) {
  return new Promise<{
    ws: WebSocket;
    next<T>(t: string, timeoutMs?: number): Promise<T>;
    bytes: number;
    msgs: number;
    close(): void;
  }>((resolve, reject) => {
    const ws = new WebSocket(url);
    const buffer: { t: string; d?: unknown }[] = [];
    const waiters: { t: string; resolve: (m: unknown) => void; timer: NodeJS.Timeout }[] = [];
    let bytes = 0;
    let msgs = 0;
    ws.on('message', (d) => {
      const s = String(d);
      bytes += s.length;
      msgs++;
      const m = JSON.parse(s) as { t: string };
      const i = waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) {
        clearTimeout(waiters[i]!.timer);
        waiters.splice(i, 1)[0]!.resolve(m);
      } else {
        buffer.push(m as { t: string; d?: unknown });
      }
    });
    ws.on('open', () =>
      resolve({
        close: () => ws.close(),
        ws,
        bytes: () => bytes,
        msgs: () => msgs,
        next<T>(t: string, timeoutMs = 8000): Promise<T> {
          const bi = buffer.findIndex((m) => m.t === t);
          if (bi >= 0) return Promise.resolve(buffer.splice(bi, 1)[0] as T);
          return new Promise<T>((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`等 ${t} 超时`)), timeoutMs);
            waiters.push({ t, resolve: res as (m: unknown) => void, timer });
          });
        },
      }),
    );
    ws.on('error', reject);
  });
}

/** 连接并等 welcome 就绪 */
async function connect(port: number) {
  const c = await makeClient(`ws://127.0.0.1:${port}`);
  await c.next('welcome');
  return c;
}

describe('分区块同步（服务端集成）', () => {
  it('上行 interest 后 delta 带 scope；不上行则不裁剪（默认视口有限 scope）', async () => {
    const h = await createGameServer({
      registry: ModRegistry.default(),
      seed: 42,
      port: 0,
      deltaMs: 120, // 加速：测试不必等 500ms
      fullMs: 60_000, // 关掉周期 full，避免与 delta 交错让断言不稳
      pingMs: 60_000,
    });
    try {
      const c = await connect(h.port);
      // 上报一个**很窄**的视口（r=0 → 只要一块）
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 0, y: 0, r: 0 } }));
      const d = await c.next<{ t: string; d: { scope?: unknown[]; droppedChunks?: unknown[] } }>('delta');
      expect(d.d.scope).toBeDefined();
      expect(Array.isArray(d.d.scope)).toBe(true);
      // r=0 只要 1 块
      expect((d.d.scope as unknown[]).length).toBe(1);
      // 校验 scope 里的坐标能解码回 1 个块（协议坐标与 chunks.ts 一致）
      const s0 = (d.d.scope as { cx: number; cy: number }[])[0]!;
      expect(chunkKeyToXY((s0.cx + 32768) + (s0.cy + 32768) * 65536)).toEqual({ cx: s0.cx, cy: s0.cy });
      c.close();
    } finally {
      await h.close();
    }
  });

  it('vision 裁剪生效：订阅远处的窄视口，收到的建筑数 ≤ 全世界建筑数', async () => {
    const h = await createGameServer({
      registry: ModRegistry.default(),
      seed: 42,
      port: 0,
      deltaMs: 120,
      fullMs: 60_000,
      pingMs: 60_000,
    });
    try {
      const c = await connect(h.port);
      // 在"远方"手工放一些建筑（模拟规模），再订阅出生点窄视口
      const world = h.sim.world;
      for (let i = 0; i < 20; i++) world.addBuilding('campfire', 900 + i * 70, 900);
      const total = world.buildings.size;
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 0, y: 0, r: 0 } }));
      const d = await c.next<{ t: string; d: { buildings: unknown[] } }>('delta');
      expect(d.d.buildings.length).toBeLessThan(total); // 远处建筑未下发
      c.close();
    } finally {
      await h.close();
    }
  });

  it('chunked:false 关闭裁剪：delta 不带 scope（基准对照用，行为=旧版）', async () => {
    const h = await createGameServer({
      registry: ModRegistry.default(),
      seed: 42,
      port: 0,
      chunked: false,
      deltaMs: 120,
      fullMs: 60_000,
      pingMs: 60_000,
    });
    try {
      const c = await connect(h.port);
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 0, y: 0, r: 0 } }));
      const d = await c.next<{ t: string; d: { scope?: unknown } }>('delta');
      expect(d.d.scope).toBeUndefined(); // 关闭 = 不裁剪 = 旧行为
      c.close();
    } finally {
      await h.close();
    }
  });

  it('坏 interest 被忽略且不影响后续合法 interest 自愈（不算 rejectedCommands）', async () => {
    const h = await createGameServer({
      registry: ModRegistry.default(),
      seed: 42,
      port: 0,
      deltaMs: 120,
      fullMs: 60_000,
      pingMs: 60_000,
    });
    try {
      const c = await connect(h.port);
      const before = h.rejectedCommands();
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 0, y: 0, r: 99999 } })); // 半径超限
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 'a', y: 0, r: 0 } })); // 形状坏
      c.ws.send(JSON.stringify({ t: 'interest' })); // 缺 d
      await new Promise((r) => setTimeout(r, 200));
      // 坏 interest 不计入"命令拒绝"（那是另一个语义计数器）
      expect(h.rejectedCommands()).toBe(before);
      // 合法 interest 仍被接受
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 5, y: 5, r: 64 } }));
      const d = await c.next<{ t: string; d: { scope?: unknown[] } }>('delta');
      expect(d.d.scope).toBeDefined();
      c.close();
    } finally {
      await h.close();
    }
  });

  it('未选中的远端 pawn 不下发，但被选中的远端 pawn 必须下发（框选指挥不能发给空气）', async () => {
    const h = await createGameServer({
      registry: ModRegistry.default(),
      seed: 42,
      port: 0,
      deltaMs: 120,
      fullMs: 60_000,
      pingMs: 60_000,
    });
    try {
      const c = await connect(h.port);
      // 把一只鼠挪到很远的块
      const pawn = [...h.sim.pawns()][0]!;
      pawn.pos = { x: 5000, y: 5000 };
      // 订阅出生点窄视口（那只鼠在 scope 外）
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 0, y: 0, r: 0 } }));
      let sawFarPawn = false;
      for (let i = 0; i < 5; i++) {
        const d = await c.next<{ t: string; d: { pawns: { eid: number; pos: { x: number; y: number } }[] } }>('delta');
        if (d.d.pawns.some((p) => p.eid === pawn.eid)) sawFarPawn = true;
      }
      expect(sawFarPawn).toBe(false); // 出 scope 且未选中 → 不发

      // 选中它 → 即使出 scope 也必须持续下发
      h.sim.selected = [pawn.eid];
      let sawAfterSelect = false;
      for (let i = 0; i < 5; i++) {
        const d = await c.next<{ t: string; d: { pawns: { eid: number }[] } }>('delta');
        if (d.d.pawns.some((p) => p.eid === pawn.eid)) sawAfterSelect = true;
      }
      expect(sawAfterSelect).toBe(true);
      c.close();
    } finally {
      await h.close();
    }
  });

  it('出 scope 的 pawn 回视野时会重新全量发（基线被清，不是被当"没变化"漏发）', async () => {
    const h = await createGameServer({
      registry: ModRegistry.default(),
      seed: 42,
      port: 0,
      deltaMs: 120,
      fullMs: 60_000,
      pingMs: 60_000,
    });
    try {
      const c = await connect(h.port);
      const pawn = [...h.sim.pawns()][0]!;
      // 先让它在出生点 scope 内（r=192 覆盖原点）
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 0, y: 0, r: 192 } }));
      await c.next('delta');
      // 移到远块并订阅远处 → 它出 scope
      pawn.pos = { x: 5000, y: 5000 };
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 5000, y: 5000, r: 0 } }));
      await c.next('delta');
      // 移回并订阅原点 → 必须重新收到它（哪怕位置没变）
      pawn.pos = { x: 0, y: 0 };
      c.ws.send(JSON.stringify({ t: 'interest', d: { x: 0, y: 0, r: 192 } }));
      let seen = false;
      for (let i = 0; i < 5; i++) {
        const d = await c.next<{ t: string; d: { pawns: { eid: number }[] } }>('delta');
        if (d.d.pawns.some((p) => p.eid === pawn.eid)) seen = true;
      }
      expect(seen).toBe(true);
      c.close();
    } finally {
      await h.close();
    }
  });
});

describe('分区块 tick（模拟侧）', () => {
  it('admitted=全集时 stepChunked ≡ step（逐位同，不引入分叉）', async () => {
    const { Sim: S } = await import('../sim');
    const reg = ModRegistry.default();
    const a = new S({ seed: 99, registry: reg });
    const b = new S({ seed: 99, registry: reg });
    const all = new Set<number>();
    for (let cy = -8; cy <= 8; cy++) for (let cx = -8; cx <= 8; cx++) all.add((cx + 32768) + (cy + 32768) * 65536);
    for (let i = 0; i < 200; i++) {
      a.step(0.1);
      b.stepChunked(0.1, all); // 全集 admit = 不跳任何鼠
    }
    expect(b.time).toBe(a.time);
    expect([...b.pawns()].length).toBe([...a.pawns()].length);
    for (const p of a.pawns()) {
      const q = b.pawn(p.eid)!;
      expect(q.pos).toEqual(p.pos);
      expect(q.uses).toEqual(p.uses); // 抽卡序列一致 = 确定性一致
    }
  });

  it('admitted=null 时 stepChunked ≡ step（服务器无人订阅时的路径）', async () => {
    const { Sim: S } = await import('../sim');
    const reg = ModRegistry.default();
    const a = new S({ seed: 100, registry: reg });
    const b = new S({ seed: 100, registry: reg });
    for (let i = 0; i < 100; i++) {
      a.step(0.1);
      b.stepChunked(0.1, null);
    }
    for (const p of a.pawns()) expect(b.pawn(p.eid)!.pos).toEqual(p.pos);
  });
});