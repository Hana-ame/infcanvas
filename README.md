# infcanvas

RimWorld-like 殖民地游戏 · web / infinite canvas · 可联机 · 支持 LLM 与插件 mod。

- **sim**：纯逻辑仿真核心，零渲染依赖，双端（server/client）共用（Node 直跑已验证）
- **client**：Pixi 渲染 + DOM UI（本地单机 / `?remote=` 连 server 两种模式）
- **server**：WSS + 权威模拟 + tick 循环（P1 骨架已落地，tick delta/断线重连/可选鉴权已提前落地，见 docs/DESIGN.md §9）

详见 [docs/DESIGN.md](docs/DESIGN.md)。

**快速体验**

```bash
npm install
npm run server -- 8080        # 权威模拟 server（可加参数: 端口 [seed] [pawn数]）
npm run dev                    # 客户端 dev server
```

- 单机模式：打开 dev server 首页
- 联机观察模式：打开 `http://localhost:5173/?remote=ws://127.0.0.1:8080`（server 权威，本页只读观察 + 下命令；**断线自动重连**，server 重启后页面自行恢复）
- **LLM 事件导演**（可选）：设 `LLM_ENDPOINT`（OpenAI 兼容）/ `LLM_API_KEY` / `LLM_MODEL` 环境变量再启动 server，世界事件改由 LLM 生成（预取+白名单效果+失败自动降级确定性）；不设则纯确定性

**测试**：`npm test`（vitest 536 例全过，含插件化装配/卸载、玩法包依赖图/远程加载、无限地图双图层）+ e2e：`node scripts/e2e/run-e2e.mjs scripts/e2e/remote-viewer.mjs`（9 断言：连接/快照/命令上行/build 回显/时间流动/move 指挥）、`scripts/e2e/remote-delta.mjs`（tick delta 增量帧构成）、`scripts/e2e/remote-interp.mjs`（渲染插值平滑）、`scripts/e2e/reconnect.mjs`（断线重连，自起 vite+server）

**想玩/看效果**：[docs/PLAYING.md](docs/PLAYING.md)（当前版本玩法说明，面向玩家）。
