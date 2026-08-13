# infcanvas 项目约定

## 文档同步纪律（重要）

**改代码必须同步 docs/**。每次对 src/ 的实质性改动（新功能/行为变更/修复），在同一个会话内完成：
1. `docs/PROGRESS.md`：新功能/修复 → 追加表格行（状态/说明）
2. `docs/PLAYING.md`：玩家可见行为变化 → 追加对应段落
3. `docs/DESIGN.md` / `docs/DATA_DRIVEN.md`：架构/数据模型变化 → 追加对应章节

**铁律：原始 docs/ 是最精确的设计蓝本，只能加不能减。**
- 禁止修改/替换/删除任何原始文档行（含过时的数值、旧架构描述、历史记录）
- 变更一律**追加**：新增行/段落/表格，标注日期（如 `（2026-08-12 更新：…）`）
- 代码与文档冲突时，以原始文档为基准补记，不篡改原行
- 若改动发生在有 git commit 的版本之后，用 `git show HEAD:docs/<file>` 追溯原文，恢复被改行后再追加

禁止"先改代码、文档以后再说"——文档滞后即缺陷（曾因滞后被核对发现多处过时）。

## 代码注释纪律（重要）

**代码附近必须用注释说明功能和编写背景**：
- 新写的函数/类/关键逻辑：文件头或定义处注释——**做什么**（功能） + **为什么**（编写背景/动机/曾踩过的坑）
- 修复类改动：注明**原缺陷**（现象/根因）与修复思路（如 `// 此前 placeBuilding 返回值被忽略 = 资源蒸发`）
- 数据驱动代码：注释说明数值来源表与语义（如 `// 阈值读 tuning，mod 可覆盖`）
- 设计意图类：注明设计出处（如 `// DESIGN §6：神谕不碰选择链`）
- 背景信息：能帮后人（含未来的 agent）理解"为什么这么写"，避免重复踩坑或误删关键逻辑
- 禁止只写"改了什么"不写"为什么"；禁止无注释的魔法数字/流程

## 架构要点

- 权威仿真 = `src/sim`（零 DOM，浏览器/Node 双端复用同一份）
- 数据驱动：数值进 `defs/tuning.ts` 与 defs 表（tile/building/recipe/enemy/event…），系统只读数据
- 神谕（慢决策层）三层分离：
  - **策略卡 = 神谕目标**：`sim.setOracleGoal` 设定目标（对应工作系列权重 ×oracleGoalMul），**不插小人卡槽、不碰选择链**；蓝图副作用走 applyBlueprint（垦田令→农田、拓荒令→营地）
  - **科技 = 独立抽卡池**：`makeDummyCardPlanner` 的 `techInterval` 独立计时器，`TECH_ORDER` 顺序解锁，`BuildingDef.tech` 门控建造
  - **printCard**：底层 API，保留（未来 LLM 叙事用），策略卡不再走它
- 寻路：A* 二叉堆 + 篝火航点中转（锚点对段缓存）+ 迭代上限双档（无火 15000 / 有火 40000，显式 maxIter 尊重钳制）
- 小人卡实例必须按人克隆（initSlots），mastery/熟练度不串

## 插件化纪律（重要，2026-08-14）

**一切皆插件，系统必须可单独装卸与单独测试。**

- **每个系统都应可独立测试**：系统（`GameSystem`）只依赖 `SimContext` 接口、不碰 Sim 本体，单测可直接构造最小 ctx 注入验证；新增系统必须能脱离完整 Sim 单独跑。
- **系统可装卸**：新增功能优先做成 mod（`registerSystemDef`/`disableSystem`/`registerCardDef`/`registerWork`/`registerEnemy`/`overrideTuning`…），而非写死进 `SYSTEM_DEFS`/`BASE_CARD_DEFS`。玩法包通过 `disableSystem(id)` 卸载默认系统。
- **不往内核塞玩法**：采集/狩猎/耕种/科技等玩法应作为 mod 提供；内核只留"需求/决策/采集/社交"等基础系统。改内核前先问"能不能做成 mod"。
- **卸载不破坏核心**：任何系统被禁用后 Sim 仍能跑（装配过滤见 `sim.registerSystems`）；依赖被卸载系统的代码要条件化，避免引用已卸载实例。

## 命令

- 测试：`npm test`（vitest，276+ 用例，其中 52 个为最小 ctx 独立系统测试）；类型：`npx tsc --noEmit`
- 单系统独立测试：`npx vitest run <文件> -t "<用例名>"`（系统只依赖 SimContext，可脱离完整 Sim 单独验证）
- 纯逻辑游玩：`npx tsx scripts/play.ts`（CLI：state/pawns/sel/move/build/job/oracle/map/f）
- 联机 server：`npm run server -- 8080`，客户端 `?remote=ws://127.0.0.1:8080`（神谕抽卡默认启用，LLM_ENDPOINT 仅可选增强）
