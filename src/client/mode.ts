/**
 * client/mode.ts —— 客户端模式解析（本地 vs 本地连远程）。
 *
 * infcanvas 有三种运行形态（README「快速体验」一一对应）：
 *   1. **本地模式**（纯前端，无 ws）：浏览器里直接 `new Sim(...)`，
 *      不需要任何服务器。整份 dist/ 丢到任意静态服务器（nginx / gh-pages /
 *      `python -m http.server`）就能玩。
 *   2. **本地连远程模式**（ws）：浏览器 → WebSocket → 权威服务器，
 *      多端同观一局；客户端本身仍是纯前端。
 *   3. **server 模式**（node 进程）：`npm run server`，与客户端无关，
 *      只是权威模拟 + ws 传输的一端。
 *
 * 「本地模式不使用 ws」是一条**硬不变量**：本地模式的整条调用链
 * （main.ts → Sim → Renderer → HUD）不能触到 `WebSocket` 全局构造器。
 * 这个文件把「选择哪种模式」这件事从 main.ts 里抽出来成为纯函数，
 * 就是为了让这个不变量可以被单测锁死——如果哪天有人把 `?mode=local`
 * 的路径误接了 ws，`src/__tests__/mode.test.ts` 会当场红。
 *
 * URL 参数（三选一，显式 > 隐式）：
 *   `?mode=local`                    → 本地模式（显式，最高优先）
 *   `?mode=remote&server=ws://...`   → 本地连远程模式（显式；缺 server 时降级 local）
 *   `?remote=ws://...`               → 本地连远程模式（历史兼容，保留）
 *   无参数                            → 本地模式（默认）
 *
 * 冲突取舍：**显式 `?mode=local` 赢**。写 `?mode=local&remote=ws://x` 会走本地
 * ——「我就想跑本地别给我连网」的意图必须明确生效，不能被遗留参数偷换。
 */

export type ClientMode =
  | { kind: 'local' }
  | { kind: 'remote'; url: string };

export function parseClientMode(search: string): ClientMode {
  const q = new URLSearchParams(search);
  const explicitMode = q.get('mode');

  // 显式 mode=local：无条件本地，忽略任何 remote= 遗留参数
  if (explicitMode === 'local') return { kind: 'local' };

  if (explicitMode === 'remote') {
    // mode=remote 时必须有 server 提供地址；缺失时降级 local 而不是抛错——
    // 「?mode=remote」是一个常见笔误（忘了带 server），静默降级 + console.warn
    // 比硬失败好；上层（main.ts）在拿到 local 时可以打印提示。
    const server = q.get('server');
    if (server) return { kind: 'remote', url: server };
    return { kind: 'local' };
  }

  // 未知 mode 值（拼错 / 空值）不作为信号：继续往下看 remote= 历史参数。
  // 这样 `?mode=remot` 拼错时至少不会因为 mode 字段被吃掉而丢失 remote 兜底。

  const legacy = q.get('remote');
  if (legacy) return { kind: 'remote', url: legacy };

  return { kind: 'local' };
}
