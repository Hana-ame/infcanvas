# infcanvas

RimWorld-like 鼠鼠殖民地模拟 · **一切皆抽卡**的 0 操作自主生存。

> **2026-08-21 从零重来 v3**：旧全量实现（632 测试/66 包）已归档 `test/`（仅作历史参考）。
> 当前代码按 `docs/REIMPLEMENT_PROMPT.md` 的 8 条原则重建，完成阶段①+②；
> 架构详见 [docs/DESIGN.md](docs/DESIGN.md) 文末「从零重来 v3 架构」章节。

## 当前状态（阶段①②④ ✅ / ③ ⬜）

- **sim 内核**：零 DOM 权威模拟——抽卡决策引擎（无行为树/任务队列）、无限确定性地图、
  A* 寻路、命令路由、事件 feed。浏览器/Node 双端同一份代码。
- **玩法包 ×6**：needs / gathering / building / social / raid / bootstrap，
  ModPack 显式依赖 + 拓扑挂载，可单独装卸、单独测试；卸载不破坏核心。
- **0 操作生存闭环**：4 鼠出生 → 采集/吃饭/睡觉/建造/社交 → 敌袭战或逃，全程自主。
- **玩家干预只有基础指挥**：move 命令移动鼠鼠；没有任何"××令"/全局干预机制。
- **PixiJS 客户端 + 存档**：正交俯视渲染、点选指挥、localStorage 存读档（版本化 JSON，确定性续跑）。
- **WSS 联机**：服务器权威模拟，增量快照同步，多端同观一局。

## 快速体验

```bash
npm test                                   # vitest 用例（内核/各包独立/装配卸载/契约/存档续跑/协议）
npm run typecheck                          # tsc --noEmit
npm run build                              # 生产构建（PixiJS 分包，产物 dist/ 是纯前端）
npm run check:frontend                     # 验证 dist/ 无 ws / node: 依赖（纯前端承诺）

# ① 本地模式（纯前端，无 ws，无服务器）—— 默认
npm run dev                                # → http://localhost:5173 （?seed=42 开局；?save=1 读最近存档）
#   或生产构建直接丢到静态服务器：
npm run build && python -m http.server 8080 -d dist   # → http://localhost:8080
#   生产构建部署到 nginx / gh-pages / 任意静态托管：整份 dist/ 上传即可。
#   本地模式的整条链路（main.ts → Sim → Renderer → HUD）**不触 WebSocket 全局构造器**。

# ② 本地连远程模式（ws）—— 浏览器 → 权威服务器
npm run server -- 8080 42                  # 权威服务器（node 进程，独立于客户端）
#   浏览器开 http://localhost:5173/?mode=remote&server=ws://127.0.0.1:8080
#   或历史兼容：http://localhost:5173/?remote=ws://127.0.0.1:8080

npx tsx scripts/play.ts 600 42            # 纯逻辑 CLI：600s 生存循环统计报告
```

### 三种运行形态

| 形态 | 命令 | 客户端是否用 ws | 需要的进程 |
|---|---|---|---|
| **① 本地模式** | `npm run dev`（或 `npm run build` + 静态服务器） | ❌ 纯前端 | 仅浏览器 |
| **② 本地连远程** | 浏览器加 `?mode=remote&server=ws://...` | ✅ ws | 浏览器 + node 服务器 |
| **③ server 模式** | `npm run server -- [端口] [seed]` | — | 仅 node 进程（不启动浏览器客户端） |

URL 参数（`src/client/mode.ts` 的 `parseClientMode` 解析，测试见 `src/__tests__/mode.test.ts`）：

- `?mode=local` → 本地模式（显式，最高优先；同时带 `?remote=` 也仍走本地）
- `?mode=remote&server=ws://...` → 本地连远程模式（缺 `server=` 时降级 local）
- `?remote=ws://...` → 本地连远程模式（历史兼容）
- 无参数 → 本地模式（默认）

**硬不变量：本地模式不使用 ws。** 这条由 `src/__tests__/mode.test.ts` 锁死，由 `npm run check:frontend` 在发布前二次验证。

## 文档导航

- [docs/DESIGN.md](docs/DESIGN.md) —— 设计灵魂与架构（文末 v3 章节为当前态）
- [docs/DATA_DRIVEN.md](docs/DATA_DRIVEN.md) —— 数值表/注册面/契约（文末 v3 章节）
- [docs/PLAYING.md](docs/PLAYING.md) —— 玩法说明（文末 v3 节为当前可玩内容）
- [docs/PROGRESS.md](docs/PROGRESS.md) —— 进度与演进史（append-only）
- [docs/REIMPLEMENT_PROMPT.md](docs/REIMPLEMENT_PROMPT.md) —— 从零实现规格书（本轮蓝本）
