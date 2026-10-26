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
npm test                                   # vitest 56 用例（内核/各包独立/装配卸载/契约/存档续跑/协议）
npm run typecheck                          # tsc --noEmit
npm run build                              # 生产构建（PixiJS 分包）

# 本地游玩（PixiJS 渲染 + 存档读档）
npm run dev                                # → http://localhost:5173 （?seed=42 开局；?save=1 读最近存档）

# 联机（WSS 权威模拟 + 增量同步）
npm run server -- 8080 42                  # 权威服务器
#   浏览器开 http://localhost:5173/?remote=ws://127.0.0.1:8080

npx tsx scripts/play.ts 600 42            # 纯逻辑 CLI：600s 生存循环统计报告
```

## 文档导航

- [docs/DESIGN.md](docs/DESIGN.md) —— 设计灵魂与架构（文末 v3 章节为当前态）
- [docs/DATA_DRIVEN.md](docs/DATA_DRIVEN.md) —— 数值表/注册面/契约（文末 v3 章节）
- [docs/PLAYING.md](docs/PLAYING.md) —— 玩法说明（文末 v3 节为当前可玩内容）
- [docs/PROGRESS.md](docs/PROGRESS.md) —— 进度与演进史（append-only）
- [docs/REIMPLEMENT_PROMPT.md](docs/REIMPLEMENT_PROMPT.md) —— 从零实现规格书（本轮蓝本）
