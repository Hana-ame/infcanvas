/**
 * 测试全局 setup —— 给缺少内建 WebSocket 的运行环境补一个。
 *
 * 背景（2026-10-06，CI 矩阵 node 20 跑挂时查出来的）：
 * 浏览器与 **node ≥22** 都有全局 WebSocket（node 22 起开放 undici 的实现），
 * 但 **node 20 没有**。项目里 server.test.ts / server-save.test.ts / auth-e2e.test.ts
 * 直接 `new WebSocket(url)`，client/remote.ts 也走 `globalThis.WebSocket`——
 * 在 node 20 上这些联机用例会一律失败/静默不重连。
 *
 * 为什么放在 setup 而不是每个测试文件里 import：
 * 联机链路横跨多个测试文件，逐个复制注入逻辑只会漏。ws 本来就是服务端依赖
 * （src/server 用它起 WebSocketServer），这里只是把同一个实现挂到全局，
 * 不引入新依赖、不改变被测语义。
 *
 * 已存在时不覆盖：node 22+ / 浏览器用自己的内建实现，避免测的不是真实运行时。
 */
import WebSocketImpl from 'ws';

const g = globalThis as { WebSocket?: unknown };
if (typeof g.WebSocket !== 'function') {
  g.WebSocket = WebSocketImpl as unknown as typeof WebSocket;
}