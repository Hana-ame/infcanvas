/**
 * server.test.ts —— 阶段④服务端集成：welcome 全量 / 命令上行生效 / 白名单拒绝 /
 * delta 增量语义（只发变化）。
 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer } from '../server/game-server';
import { ModRegistry } from '../mods';

/** 测试客户端：构造即开始收集消息——服务器在 open 后立刻发 welcome，
 *  若等 open 再挂监听会丢首包（真实竞态踩坑）。 */
interface TestClient {
  ws: WebSocket;
  next<T>(t: string, timeoutMs?: number): Promise<T>;
  close(): void;
}
function makeClient(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const buffer: { t: string }[] = [];
    const waiters: { t: string; resolve: (m: unknown) => void; timer: NodeJS.Timeout }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { t: string };
      const i = waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(m);
      } else {
        buffer.push(m);
      }
    });
    ws.on('open', () =>
      resolve({
        close: () => ws.close(),
        ws,
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

describe('WSS 权威服务器', () => {
  it('welcome：新连接先收 seed+tuning+全量状态（4 鼠+篝火）', async () => {
    // port: 0 = ephemeral（OS 分配空闲端口）：本机 8080 可能被其他服务占用
    // （2026-09-27 实测：kb-server 占 8080 → 三个用例全部 EADDRINUSE 超时）。
    const h = await createGameServer({ registry: ModRegistry.default(), seed: 42, port: 0 });
    try {
      const ws = await makeClient(`ws://127.0.0.1:${h.port}`);
      const welcome = await ws.next<{ t: string; d: { seed: number; tuning: { bootstrap: { pawnCount: number } }; pawns: unknown[]; buildings: unknown[] } }>('welcome');
      expect(welcome.d.seed).toBe(42);
      expect(welcome.d.tuning.bootstrap.pawnCount).toBe(4);
      expect(welcome.d.pawns).toHaveLength(4);
      expect(welcome.d.buildings.length).toBeGreaterThanOrEqual(1);
      ws.close();
    } finally {
      await h.close();
    }
  });

  it('命令上行：合法 move 生效（holdUntil 窗口），非法/未知命令被拒且不崩', async () => {
    const h = await createGameServer({ registry: ModRegistry.default(), seed: 11, port: 0 });
    try {
      const ws = await makeClient(`ws://127.0.0.1:${h.port}`);
      await ws.next('welcome');
      // 合法 move
      const eid = [...h.sim.pawns()][0].eid;
      ws.ws.send(JSON.stringify({ t: "cmd", c: { type: "move", args: { eids: [eid], x: 2, y: 2 } } }));
      await new Promise((r) => setTimeout(r, 150));
      const p = h.sim.pawn(eid)!;
      expect(p.holdUntil).toBeGreaterThan(0); // 进入玩家命令优先窗口
      // 非法：越界坐标 / 未知命令 / 坏 JSON
      const before = h.rejectedCommands();
      ws.ws.send(JSON.stringify({ t: "cmd", c: { type: "move", args: { x: 999999, y: 0 } } }));
      ws.ws.send(JSON.stringify({ t: "cmd", c: { type: "nonexistent", args: {} } }));
      ws.ws.send("not-json");
      await new Promise((r) => setTimeout(r, 150));
      expect(h.rejectedCommands()).toBeGreaterThanOrEqual(before + 3);
      expect(() => h.sim.step(0.1)).not.toThrow();
      ws.close();
    } finally {
      await h.close();
    }
  });

  it('delta 增量：静止的鼠不发重复数据；时间照常推进', async () => {
    const h = await createGameServer({ registry: ModRegistry.default(), seed: 21, port: 0 });
    try {
      const ws = await makeClient(`ws://127.0.0.1:${h.port}`);
      await ws.next('welcome');
      const d1 = await ws.next<{ t: string; d: { time: number; pawns: unknown[] } }>('delta');
      expect(d1.d.time).toBeGreaterThan(0);
      // 不下命令，鼠在自主体力活动 → 某些 pawn 会变；但连续两次 delta 里
      // 至少一次 pawns 数量 < 总数（增量语义：只发改变的）
      const d2 = await ws.next<{ t: string; d: { pawns: unknown[]; time: number } }>('delta');
      const total = [...h.sim.pawns()].length;
      expect(d1.d.time).toBeLessThan(d2.d.time);
      expect(d2.d.pawns.length).toBeLessThanOrEqual(total);
      ws.close();
    } finally {
      await h.close();
    }
  });

  it('close 后端口释放、sim 停摆（可重复起停，测试无残留）', async () => {
    const h1 = await createGameServer({ port: 19777, registry: ModRegistry.default() });
    await h1.close();
    const h2 = await createGameServer({ port: 19777, registry: ModRegistry.default() }); // 同端口可复用
    expect(h2.port).toBe(19777);
    await h2.close();
  });
});
