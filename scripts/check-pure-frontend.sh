#!/usr/bin/env bash
# scripts/check-pure-frontend.sh —— 验证 dist/ 是纯前端产物（浏览器可直接加载）。
#
# 检查项：
#   1. dist/ 存在（先跑 `npm run build`）
#   2. dist/assets/*.js 里没有 `require('ws')` / `require("ws")`
#   3. dist/assets/*.js 里没有 `node:` 协议 import（node:http / node:fs / node:crypto 等）
#   4. dist/assets/*.js 里没有 `process.env` / `process.argv` 直接读取
#
# 为什么需要这个检查：src/server/ 里有 ws、node:http 等 Node-only 依赖，但它们**只应被
# src/server/index.ts 的 tsx 路径消费**。一旦这些依赖意外进入了 dist/（例如 client 里
# 有人 import 了 src/server/*，或者某处漏写 dynamic import），产物就不再是纯前端：
#   - 本地模式会报 "Unknown file extension" 或 "Cannot find module 'ws'"
#   - 静态服务器加载 index.html 直接白屏
#
# 这个脚本不是 CI 门禁（CI 里跑 vitest + tsc 已足够），但作为发布前的最后一道保险，
# 跑一次 `npm run build && ./scripts/check-pure-frontend.sh` 就能确认「纯前端」承诺。
#
# 用法：
#   npm run build
#   ./scripts/check-pure-frontend.sh
#
# 退出码：0 = 纯前端 OK；1 = 发现违规依赖。

set -euo pipefail

DIST=${1:-dist}
if [[ ! -d "$DIST" ]]; then
  echo "❌ $DIST 不存在。先跑：npm run build" >&2
  exit 1
fi

failures=0
check() {
  local label="$1"
  local pattern="$2"
  if grep -rEl "$pattern" "$DIST/assets/" >/dev/null 2>&1; then
    echo "❌ $label" >&2
    grep -rEn "$pattern" "$DIST/assets/" | head -3 >&2
    failures=$((failures+1))
  else
    echo "✓ $label"
  fi
}

echo "检查 $DIST/ 是否为纯前端产物（无 ws / node: 依赖）..."
check "无 require('ws')"        "require\(['\"]ws['\"]"
check "无 from 'ws' / from \"ws\""   "from ['\"]ws['\"]"
check "无 node: 协议 import"    "(from|import\(|require\()['\"]node:[^'\"]+['\"]"
check "无 process.env 直接读"   "process\.env\."
check "无 process.argv 直接读"  "process\.argv"

echo ""
if [[ $failures -gt 0 ]]; then
  echo "❌ $failures 项检查失败。dist/ 不满足「纯前端」承诺。" >&2
  echo "   排查方向：src/client/ 或 src/sim/ 是否意外 import 了 src/server/*" >&2
  echo "   或者检查是否有 Node-only 依赖（ws / node:http / node:fs 等）被拉进 bundle。" >&2
  exit 1
fi

echo "✅ dist/ 满足纯前端约束。可以放到任意静态服务器（nginx / gh-pages / python http.server）直接跑。"
