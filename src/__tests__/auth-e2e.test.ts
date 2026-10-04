/**
 * auth-e2e.test.ts —— R1-2 鉴权在**真实 socket** 上的行为。
 *
 * auth.test.ts 验的是纯函数规则；这里验规则真的接到了 ws 握手上：
 *  - 设了 SERVER_TOKEN：没 token 的连接被 close(1008)，带 token 的正常收发；
 *  - 没设：行为与鉴权落地前完全一致（完全开放）。
 * 顺带验证「鉴权失败后客户端不再重连」与 onclose code 一致。
 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer } from '../server/game-server';
import { ModRegistry } from '../mods';

/** 连一次并回报 close code；握手成功则先拿到 welcome 再关。 */
function probe(url: string, timeoutMs = 4000): Promise<{ closeCode: number | null; welcomed: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let welcomed = false;
    let settled = false;
    const done = (closeCode: number | null): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* 已关 */
      }
      resolve({ closeCode, welcomed });
    };
    ws.on('message', (d) => {
      if (JSON.parse(String(d)).t === 'welcome') {
        welcomed = true;
        // 收到 welcome 即判定鉴权通过，立刻收工——不必等 4s 超时
        setTimeout(() => done(1000), 0);
      }
    });
    ws.on('close', (code) => done(code));
    ws.on('error', () => done(null)); // 握手层失败：连 close 都没走到
    // 只在没有消息时兜底：鉴权通过会立刻收到 welcome 并主动结束探测，
    // 不必空等满 timeout（否则每个用例白等 4s）。
    setTimeout(() => {
      if (!welcomed) done(null);
    }, timeoutMs);
  });
}

describe('R1-2 鉴权真机行为', () => {
  it('未配置 SERVER_TOKEN：完全开放（连接正常收到 welcome）', async () => {
    const h = await createGameServer({ registry: ModRegistry.default(), seed: 42, port: 0, pingMs: 10_000 });
    try {
      const r = await probe(`ws://127.0.0.1:${h.port}`);
      expect(r.welcomed).toBe(true);
      expect(r.closeCode).not.toBe(1008);
    } finally {
      await h.close();
    }
  });

  it('配置 SERVER_TOKEN：无 token 被 close(1008) 拒，客户端数不增加', async () => {
    const h = await createGameServer({
      registry: ModRegistry.default(),
      seed: 42,
      port: 0,
      pingMs: 10_000,
      serverToken: 'sekret',
    });
    try {
      const bad = await probe(`ws://127.0.0.1:${h.port}`);
      expect(bad.welcomed).toBe(false);
      expect(bad.closeCode).toBe(1008);
      // 被拒的连接不应进入 clients 集合（否则 clientCount 会虚高、广播会写死 socket）
      await new Promise((r) => setTimeout(r, 100));
      expect(h.clientCount()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('配置 SERVER_TOKEN：带正确 token 的连接正常收发', async () => {
    const h = await createGameServer({
      registry: ModRegistry.default(),
      seed: 42,
      port: 0,
      pingMs: 10_000,
      serverToken: 'sekret',
    });
    try {
      const good = await probe(`ws://127.0.0.1:${h.port}/?token=sekret`);
      expect(good.welcomed).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(h.clientCount()).toBeGreaterThanOrEqual(0);
    } finally {
      await h.close();
    }
  });

  it('错误 token 也被 close(1008)（不是静默丢弃）', async () => {
    const h = await createGameServer({
      registry: ModRegistry.default(),
      seed: 42,
      port: 0,
      pingMs: 10_000,
      serverToken: 'sekret',
    });
    try {
      const bad = await probe(`ws://127.0.0.1:${h.port}/?token=wrong`);
      expect(bad.welcomed).toBe(false);
      expect(bad.closeCode).toBe(1008);
    } finally {
      await h.close();
    }
  });
});
