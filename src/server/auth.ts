// 联机可选鉴权（2026-08-20 审计低项 L1：原 WSS 无鉴权——任何人可连上权威模拟器
// 发命令/看全场）。设计：SERVER_TOKEN 环境变量可选——未设置 = 完全开放（向后兼容，dev
// 首选）；设置后，客户端须在 remote URL 查询参数带 token：
//   ?remote=ws://127.0.0.1:8080?token=xxx
// token 校验独立成纯函数（无 ws 依赖）以便单测；连接层只负责"校验失败立即 close 1008"。
// 注意：query token 是"弱鉴权"（URL 可被日志/历史记录泄漏），仅用于挡住随口连接；
// 公网部署应前置 TLS + 更严格认证（超范围，注释留档）。
export function wsTokenOk(reqUrl: string, expected: string | undefined): boolean {
  if (!expected) return true; // 未配置 token → 不鉴权（向后兼容）
  const q = reqUrl.split('?')[1];
  if (!q) return false;
  const params = new URLSearchParams(q);
  const got = params.get('token');
  return typeof got === 'string' && got.length > 0 && got === expected;
}