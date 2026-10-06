# infcanvas 项目约定

## 文档同步纪律（重要）

**改代码必须同步 docs/**。每次对 src/ 的实质性改动（新功能/行为变更/修复），在同一个会话内完成：
1. `docs/PROGRESS.md`：新功能/修复 → 追加表格行（状态/说明）
2. `docs/PLAYING.md`：玩家可见行为变化 → 追加对应段落
3. `docs/DESIGN.md` / `docs/DATA_DRIVEN.md`：架构/数据模型变化 → 追加对应章节

**铁律：原始 docs/ 是最精确的设计蓝本，历史记录只能保留不能丢。**
- 当前设计文档（DESIGN/DATA_DRIVEN/PLAYING）以当前状态为准；历史实现/数值/审查记录统一移入 `docs/CHANGELOG.md` 或 `docs/PROGRESS.md`。
- 整理文档结构时必须保留历史内容不丢失，并同步更新 `docs/INDEX.md` 与交叉引用。
- 变更尽量追加并标注日期（如 `（2026-08-12 更新：…）`）；若因结构整理需要移动旧段落，必须在 CHANGELOG 留档，禁止无痕迹删除历史事实。

禁止"先改代码、文档以后再说"——文档滞后即缺陷（曾因滞后被核对发现多处过时）。

## 代码注释纪律（重要）

**代码附近必须用注释说明功能和编写背景**：
- 新写的函数/类/关键逻辑：文件头或定义处注释——**做什么**（功能） + **为什么**（编写背景/动机/曾踩过的坑）
- 修复类改动：注明**原缺陷**（现象/根因）与修复思路（如 `// 此前 placeBuilding 返回值被忽略 = 资源蒸发`）
- 数据驱动代码：注释说明数值来源表与语义（如 `// 阈值读 tuning，mod 可覆盖`）
- 设计意图类：注明设计出处（如 `// DESIGN v3：篝火航点中转与建造玩法咬合`）
- 背景信息：能帮后人（含未来的 agent）理解"为什么这么写"，避免重复踩坑或误删关键逻辑
- 禁止只写"改了什么"不写"为什么"；禁止无注释的魔法数字/流程

## 架构要点

- 权威仿真 = `src/sim`（零 DOM，浏览器/Node 双端复用同一份）
- 数据驱动：数值进 tuning.ts 数据表，系统只读数据
- 寻路：A* 二叉堆 + 8 邻域斜角禁切 + z 高度模型（|Δz|≤climb）+ 篝火航点中转
- 一切皆抽卡：决策引擎 behavior 是内核唯一系统，无行为树/任务队列
- 插件化：ModPack { id, requires, apply }，Kahn 拓扑挂载，可装卸可单测
- 跨包契约：SER_*/K_STOCK_*/K_TAG_* 常量化 + validateContracts 挂载即校验
- 存档：版本化 JSON，rng 状态随档，确定性续跑
- 用户裁定：不做"××令"/策略卡/全局干预机制——干预面仅 move 基础指挥

## 命令

> **⚠ 2026-08-21 从零重来 v3**：旧全量实现已归档 `test/`（下述 632 用例/62 文件/50 系统/62 包
> 及 DLC 工具链均为**旧版历史基线，不再适用**；`test/` 仅作灵感参考勿构建勿收集）。
> 当前实际基线见本节末尾「v3 快照」。

- 测试：`npm test`（vitest，632 用例 / 62 文件全绿，覆盖插件装卸/依赖图/无限地图/契约/DLC/网络/性能回归/十万级批处理）；类型：`npx tsc --noEmit`
- 单系统独立测试：`npx vitest run <文件> -t "<用例名>"`（系统只依赖 SimContext，可脱离完整 Sim 单独验证）
- DLC 隔离测试：`npx vitest run src/mods/packs/__tests__/dlc-isolated.test.ts`（不挂完整 playstyle，只测指定 DLC + 依赖）
- 纯逻辑游玩：`npx tsx scripts/play.ts`（CLI：生存循环统计报告）
- 联机 server：`npm run server -- 8080`，客户端 `?remote=ws://127.0.0.1:8080`
- DLC 基线自动更新：`npx tsx scripts/update-baselines.ts`
- DLC 加载器：`npx tsx scripts/loader.ts [目录] [--sim]`（扫描 .mod.json → 依赖拓扑 → 挂载 + 契约校验 → 报告；--sim = 40 pawn 冒烟）
- DLC 隔离测试：`npx vitest run src/mods/packs/__tests__/dlc-isolated.test.ts`（加完 DLC 后运行 → 自动更新 assembly/dlc-stress/dlc-deploy 的系统数基线）
- **当前装配态快照**（2026-08-20 终版）：`npm test` 当前 = **632 用例 / 62 文件**；默认装配 = **50 系统** / **62 包**。
- **DLC 添加指南**：`docs/DLC_GUIDE.md`（6 步流程 + 检查清单 + 模板 + 可注册内容速查表）
- 历史功能演进、性能优化、DLC/玩法包、审查修复记录统一见 `docs/PROGRESS.md` 与 `docs/CHANGELOG.md`。

### v3 快照（2026-08-21，当前唯一有效基线）

- 测试：`npm test` = **70 用例 / 13 文件**全绿；类型：`npm run typecheck` 干净；`npm run build` 过。
- 本地游玩：`npm run dev` → :5173（PixiJS）；联机：`npm run server -- 8080 [seed]` + 客户端 `?remote=`。
- 纯逻辑游玩：`npx tsx scripts/play.ts [秒] [seed]`（0 操作生存循环 + 统计报告）。
- **用户裁定（2026-08-21）**：不做任何"××令"/策略卡/全局干预机制——玩家干预面仅 move 基础指挥。
- 默认装配 = 内核 behavior + 玩法系统 needs/raid/bootstrap（6 玩法包：needs/gathering/building/social/raid/bootstrap）。
- 阶段④已落地：存档（版本化/确定性续跑/scratch 运行态随档）、PixiJS 客户端（WorldView 双模复用）、
  WSS 服务器（welcome/full/delta 三段节奏 + 命令白名单）。协议与存档格式见 DATA_DRIVEN v3 章节。
- 架构与数据表见 `docs/DESIGN.md` / `docs/DATA_DRIVEN.md` 文末「从零重来 v3」章节。
- **后续排期**见 `docs/ROADMAP.md`（R1 联机还账 → R2 补阶段③ 科技池/.mod.json → R3+ 玩法种子），
  接到「继续」类指令时按该文档顺序推进并逐项走完成定义。

### R2 阶段③补全快照（2026-08-21，当前基线）

- 测试：`npm test` = **98 用例 / 17 文件**全绿；类型：`npx tsc --noEmit` 干净。
- **科技 = 独立抽卡池（碎片制）**：数据表 `tuning.techs` + `tuning.techPool`（出厂空表，科技是玩法包种子）；
  注册面 `registerTech`（重复 id 抛错）+ `techOrder()`（动态算，**不用 Object.keys 快照**——旧项目致命 bug：
  DLC 后注册的科技永远进不了抽卡池）。包 `mods/packs/tech-pool.ts`：候选含已解锁、权重按 TECH_ORDER 线性递减、
  重复卡不累计（用户 2026-08-15 裁决）。计时器走 `ctx.scratch['tech-pool.acc']` 随档。
- **门控**：`BuildingTuningEntry.tech` + `SimContext.techSatisfied()`，判定写在**卡谓词**里（与材料门同款）。
  空表/表外引用一律放行 → 卸载 tech-pool = 永无科技但核心照跑。
- **存档**：`SAVE_VERSION 3`（`SAVE_MIGRATIONS[2→3]` 把缺字段回填为**空进度**，不硬塞出厂表）。
  **协议**：`FullState.techs/techFragments`，只随 welcome/full 走，delta 不带（低频状态走低频通道）。
- **.mod.json 数据化部署**：格式 `shared/mod-schema.ts`；加载器 `server/mod-loader.ts`（扫描→解析→Kahn 拓扑→
  注册面→契约校验，**拓扑在 apply 之前**，绝不半挂载）；CLI `npm run mods -- [目录] [--dry]`。
  卡的 JSON 化边界：v1 支持无谓词卡或 `{predicate:"已登记名"}`；**action v1 不支持**（JSON 无法表达函数）。
- **同一内容两种形态**：`mods/sample-berry.mod.json` ↔ `src/mods/packs/sample-berry.ts`，
  两条输入经 `modPackageToPack` 合流到同一个 `ModPack` 装配器（`dlc-twin.test.ts` 逐字段对拍）。