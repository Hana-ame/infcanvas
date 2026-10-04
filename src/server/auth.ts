/**
 * server/auth.ts —— 可选 Token 鉴权（R1-2）的**纯函数层**。
 *
 * 为什么要单独成文件：握手鉴权发生在 ws 的 'connection' 事件里，Node 事件回调
 * 难以在 vitest 里稳定复现（要起真实 socket 才能覆盖）。把判定逻辑抽成纯函数后，
 * "没设 token=完全开放" 与 "设了 token=不匹配即拒" 两条分支都能直接单测。
 *
 * 安全约定：
 *  - 未配置 SERVER_TOKEN → 完全开放（本地开发默认，与本文件落地前行为完全一致）；
 *  - 配置了 → 客户端必须带 ?token=，不匹配一律拒绝；
 *  - 比较用定长循环而非 ===：=== 会在首个不同字节处短路返回，逐字节猜 token
 *    成为理论可行（时序侧信道）。定长比较让耗时与内容无关。
 *
 * 拒绝时用 close code 1008（Policy Violation）：RFC6455 为"策略违规"保留的码，
 * 与 1000（正常关闭）区分开，客户端能据此判定"我 token 错了，重连也没用"。
 */

/** 鉴权失败的原因分类：调用方据此决定 close code 与提示文案。 */
export type AuthFailure =
  | 'missing-token'
  | 'token-mismatch'
  | 'admin-token-not-configured';

export interface AuthResult {
  ok: boolean;
  /** ok=false 时的原因码；ok=true 时恒为 undefined（便于测试精确断言分支） */
  reason?: AuthFailure | undefined;
}

/**
 * 定长字符串比较（抗时序侧信道）。
 * 先比长度：长度不同直接判否；相同则逐字符 xor 累积，不提前返回。
 * （JS 层拿不到真常数时间保证，但至少消除 === 的前缀短路信息泄露。）
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 从握手 URL 里取 ?token= 值（取不到返回 null）。
 * 接受相对路径（'/ws?token=x'）与绝对 URL（'ws://h:8080/?token=x'）——
 * ws 库给的是后者，但反向代理常给前者，两种都要吃得下。
 * 用 URLSearchParams 而非手写 split：天然处理编码与重复参数。
 */
export function extractToken(rawUrl: string): string | null {
  const i = rawUrl.indexOf('?');
  if (i < 0) return null;
  return new URLSearchParams(rawUrl.slice(i + 1)).get('token');
}

/**
 * 握手鉴权：没配 token 一律放行（本地开发默认）；配了则要求 ?token= 精确匹配。
 * 返回纯数据，调用方（game-server）负责翻译成 close(1008)。
 */
export function authorizeHandshake(
  configuredToken: string | undefined | null,
  rawUrl: string,
): AuthResult {
  const cfg = configuredToken ?? '';
  if (cfg === '') return { ok: true, reason: undefined };
  const provided = extractToken(rawUrl);
  if (provided === null) return { ok: false, reason: 'missing-token' };
  if (!timingSafeEqualStr(cfg, provided)) return { ok: false, reason: 'token-mismatch' };
  return { ok: true, reason: undefined };
}

/**
 * 管理命令（save/load）鉴权：两种合法来源，任一满足即放行。
 *  1. src === 'system'：服务端内部发起（CLI / 测试），不经网络；
 *  2. 携带与 ADMIN_TOKEN（回退 SERVER_TOKEN）一致的 token。
 *
 * 为什么 player 不能直接存档：load 会整包覆盖权威 Sim，任何连上来的陌生人都能
 * 回滚世界——这正是 R1-2 要堵的口子。放行面收紧到 system + 持 admin token。
 */
export function authorizeAdmin(
  msg: { src?: string | undefined; token?: string | undefined },
  adminToken: string | undefined | null,
): AuthResult {
  if (msg.src === 'system') return { ok: true, reason: undefined };
  const cfg = adminToken ?? '';
  if (cfg === '') return { ok: false, reason: 'admin-token-not-configured' };
  const provided = msg.token ?? '';
  if (provided === '') return { ok: false, reason: 'missing-token' };
  if (!timingSafeEqualStr(cfg, provided)) return { ok: false, reason: 'token-mismatch' };
  return { ok: true, reason: undefined };
}
