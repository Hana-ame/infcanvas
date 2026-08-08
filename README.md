# infcanvas

RimWorld-like 殖民地游戏 · web / infinite canvas · 可联机 · 支持 LLM 与插件 mod。

- **sim**：纯逻辑仿真核心，零渲染依赖，双端（server/client）共用（Node 直跑已验证）
- **client**：Pixi 渲染 + DOM UI（本地单机 / `?remote=` 连 server 两种模式）
- **server**：WSS + 权威模拟 + tick 循环（P1 骨架已落地，见 docs/DESIGN.md §9）

详见 [docs/DESIGN.md](docs/DESIGN.md)。

**快速体验**

```bash
npm install
npm run server -- 8080        # 权威模拟 server（可加参数: 端口 [seed] [pawn数]）
npm run dev                    # 客户端 dev server
```

- 单机模式：打开 dev server 首页
- 联机观察模式：打开 `http://localhost:5173/?remote=ws://127.0.0.1:8080`（server 权威，本页只读观察 + 下命令）

**测试**：`npm test`（vitest 95）+ `node scripts/e2e/run-e2e.mjs scripts/e2e/remote-viewer.mjs`（P1 链路 e2e）

**想玩/看效果**：[docs/PLAYING.md](docs/PLAYING.md)（当前版本玩法说明，面向玩家）。
