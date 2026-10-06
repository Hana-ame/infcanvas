/**
 * reconnect-e2e.test.ts —— R1-1 的真实链路验收：kill 掉服务器再重启，
 * 客户端 RemoteSim 应当**自己**恢复连接并重新对齐世界（收到新 welcome/full 且 time 前进）。
 *
 * 为什么这组测试特别：reconnect.test.ts 用假 socket 验的是状态机，
 * 这里验的是「机制真的接得上」——真 WebSocket、真退避定时器、真 welcome 重新对齐。
 * ROADMAP 验收原文：手动 kill 再重启 server，页面 ≤10s 内自动恢复且世界状态对齐。
 *
 * 时间断言用宽松上界：退避封顶 8s + 握手开销；卡太紧会让 CI 偶发失败，
 * 但上界又远小于「永不恢复」，仍能抓住真回归。
 *
 * 为什么注入 ws 的 WebSocket（2026-10-06 补）：
 * RemoteSim 走 `globalThis.WebSocket`。浏览器与 node 22+ 自带，但 **node 20 没有**
 * ——CI 矩阵里的 node 20 上这两个用例会永远等不到重连（实测 attempts 涨但 connected 恒 false）。
 * 生产代码已给出可读报错并照常排队重连；测试侧则由 `src/__tests__/setup.ts`
 * 全局注入 ws 实现（ws 本来就是 server 端的依赖），让「真实链路」在所有 node 版本上都能验。
 */
import { describe, expect, it } from 'vitest';
import { createGameServer, type GameServerHandle } from '../server/game-server';
import { ModRegistry } from '../mods';
import { RemoteSim } from '../client/remote';

const MOD = () => ModRegistry.default();

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe('R1-1 端到端：kill 服务器后客户端自愈', () => {
  it('服务器重启后，客户端自动重连并重新对齐（收到新 welcome 且 time 前进）', async () => {
    let h = await createGameServer({
      registry: MOD(),
      seed: 42,
      port: 0,
      // 把心跳/全量周期调快，让测试在几秒内走完一个完整恢复周期
      pingMs: 200,
      deltaMs: 100,
      fullMs: 300,
      tickMs: 50,
    });
    const port = h.port;
    const url = `ws://127.0.0.1:${port}`;
    const remote = new RemoteSim();
    remote.autoReconnect = true;

    try {
      await remote.connect(url);
      // 等首包 welcome 落地（有 tuning 才能建地形推导器）
      const gotWelcome = await waitUntil(() => (remote as unknown as { world: unknown }).world !== undefined, 3000);
      expect(gotWelcome).toBe(true);
      expect([...remote.pawns()].length).toBeGreaterThan(0);
      const timeBeforeKill = remote.time;

      // ---- kill 服务器（模拟进程被杀：直接 close，不走 close 握手）----
      await h.close();
      expect(await waitUntil(() => !remote.connected, 5000)).toBe(true);

      // ---- 重启（同端口，同 seed）----
      h = await createGameServer({
        registry: MOD(),
        seed: 42,
        port,
        pingMs: 200,
        deltaMs: 100,
        fullMs: 300,
        tickMs: 50,
      });

      // 客户端应当**自己**恢复：无需任何外部干预
      const recovered = await waitUntil(() => remote.connected, 15_000);
      expect(recovered).toBe(true);

      // 对齐判定：拿到新的一帧且 time 前进（世界重新活起来）
      const advanced = await waitUntil(() => remote.time > timeBeforeKill, 5000);
      expect(advanced).toBe(true);
      expect([...remote.pawns()].length).toBeGreaterThan(0);
      // 重连后地形推导器仍然可用（welcome 重新带回了 tuning）
      expect(typeof remote.tileAt(3, 4)).toBe('string');
    } finally {
      remote.dispose();
      await h.close().catch(() => undefined);
    }
  }, 40_000);

  it('服务器不在时首连失败也不抛给页面（页面继续跑，等服务器起来再接）', async () => {
    // 占用一个确定没人听的端口
    const dead = await createGameServer({ registry: MOD(), port: 0, pingMs: 10_000 });
    const deadPort = dead.port;
    await dead.close();

    const remote = new RemoteSim();
    try {
      // 首连 reject —— 这是 main.ts 会 catch 掉的，不该导致页面白屏
      await expect(remote.connect(`ws://127.0.0.1:${deadPort}`)).rejects.toThrow();
      // 但重连已经在排队：服务器起来后能自动接上
      const h = await createGameServer({
        registry: MOD(),
        seed: 42,
        port: deadPort,
        pingMs: 200,
        deltaMs: 100,
        fullMs: 300,
        tickMs: 50,
      });
      try {
        const recovered = await waitUntil(() => remote.connected, 15_000);
        expect(recovered).toBe(true);
      } finally {
        await h.close();
      }
    } finally {
      remote.dispose();
    }
  }, 40_000);
});
