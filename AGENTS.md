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
- 设计意图类：注明设计出处（如 `// DESIGN §6：神谕不碰选择链`）
- 背景信息：能帮后人（含未来的 agent）理解"为什么这么写"，避免重复踩坑或误删关键逻辑
- 禁止只写"改了什么"不写"为什么"；禁止无注释的魔法数字/流程

## 架构要点

- 权威仿真 = `src/sim`（零 DOM，浏览器/Node 双端复用同一份）
- 数据驱动：数值进 `defs/tuning.ts` 与 defs 表（tile/building/recipe/enemy/event…），系统只读数据
- 神谕（慢决策层）三层分离：
  - **策略卡 = 神谕目标**：`sim.setOracleGoal` 设定目标（对应工作系列权重 ×oracleGoalMul），**不插小人卡槽、不碰选择链**；蓝图副作用走 applyBlueprint（垦田令→农田、拓荒令→营地）
  - **科技 = 独立抽卡池**：`tech-pool` 玩法包按间隔发科技碎片，攒齐解锁；`BuildingDef.tech` 门控建造
  - **printCard**：底层 API，保留（未来 LLM 叙事用），策略卡不再走它
- 寻路：A* 二叉堆 + 篝火航点中转（锚点对段缓存）+ 迭代上限双档（无火 15000 / 有火 40000，显式 maxIter 尊重钳制）
- 小人卡实例必须按人克隆（initSlots），mastery/熟练度不串

## 插件化纪律（重要，2026-08-14）

**一切皆插件，系统必须可单独装卸与单独测试。**

- **每个系统都应可独立测试**：系统（`GameSystem`）只依赖 `SimContext` 接口、不碰 Sim 本体，单测可直接构造最小 ctx 注入验证；新增系统必须能脱离完整 Sim 单独跑。
- **系统可装卸**：新增功能优先做成 mod（`registerSystemDef`/`disableSystem`/`registerCardDef`/`registerWork`/`registerEnemy`/`overrideTuning`…），而非写死进 `SYSTEM_DEFS`/`BASE_CARD_DEFS`。玩法包通过 `disableSystem(id)` 卸载默认系统。
- **不往内核塞玩法**：采集/狩猎/耕种/科技等玩法应作为 mod 提供；内核只留"需求/决策/社交/建造/敌袭/人口/事件"等社会骨架（10 个）。改内核前先问"能不能做成 mod"。
- **卸载不破坏核心**：任何系统被禁用后 Sim 仍能跑（装配过滤见 `sim.registerSystems`）；依赖被卸载系统的代码要条件化，避免引用已卸载实例。
- **完全插件化**（2026-08-14）：内核 `SYSTEM_DEFS` 只有 10 个社会骨架系统；gather(采集) 也迁出为 `gathering` 玩法包。默认玩法清单外置为数据 `src/mods/packs/playstyle.ts`（`DEFAULT_PLAYSTYLE_PACKS` + 聚合包 `defaultPlaystylePack`，`ModRegistry.default()` 只 registerPack 清单 + mount 聚合包）。mod 统一为 **ModPack 格式** `{ id, requires, apply }`（旧式 `export default (m)=>void` 已废弃，客户端 `?mods=` 加载器仍兼容但告警）。**包依赖显式化 + 自动组 DAG + 第一个插件 = 管理器**（2026-08-15）：每个包必须显式声明 `requires`（无依赖 = 空数组，硬依赖 vs 可选联动写注释）；挂载序由 pack.ts `topoSort`（Kahn 拓扑）从 requires 自动推导，清单顺序不承担图约束（乱序也自动正确）；`playstyleManager` 是第一个插件 = 管理器（清单校验 + 组 DAG 都在它 apply 里），`ModRegistry.default()` 只做数据种子 + mount 管理器，框架不 import 任何玩法包。
- **内核纯引擎**（2026-08-15，Stage1）：内核再迁出 8 系统（needs/san/desire→needs 包、social/build/raid/population/events 各一包），**内核只剩 2 个引擎系统：behavior（决策引擎）+ socialUnit（派系单位契约）**，纯引擎 = 2 系统可跑（不保生存）。**执行序 = `BASE_SYSTEM_ORDER` 全量数据清单**（defs/systems.ts，数组位置即序；内核 2 系统内联 ctor，其余按 id 从玩法包回填；清单外第三方包仍用 before 锚点插位）。`DEFAULT_PLAYSTYLE_PACKS` 扩为 19 包、只决定挂哪些包与 apply 序，与执行序解耦。
- **内核纯引擎**（2026-08-15，Stage B+C+D，终态）：**内核 = 0 系统纯演算框架**——behavior/socialUnit/economy/bootstrap 全部迁出为玩法包，`BASE_SYSTEM_ORDER` 24 系统、**无内联 ctor**（KERNEL_SYSTEM_IDS = []）。**能力让渡**：Sim `provide/getCap`（SimContext 同步），玩法包系统构造时自报能力（behavior/socialUnits/economy/bootstrap），`sim.behavior`/`sim.socialUnits` 变 getter（无包回落 null/NOOP）。**命令路由**：`issueCommand` 路由器——move 引擎内建，其余由玩法包 `registerCommand` 提供。economy 执行位在 behavior 前（优先级当帧生效）、bootstrap 表尾（出生刷人晚于系统 init）。playstyle 清单 23 包。
- **架构一致性重构**（2026-08-15，用户「fix them」「插件/mod 不要有不一致行为」）：**behavior 归内核**（决策引擎=引擎服务，SYSTEM_DEFS 内联 ctor，内核=1 系统；assign/oracle 命令迁回引擎协议面；行为=装配/卸载/锚点规则与其他系统完全一致，无特殊 case）。**执行序 = 类别序 × 组内注册序推导**（CATEGORY_ORDER 7 类 needs→ai→society→production→raid→world→boot，bootstrap category='boot' 恒表尾）：唯一人工语义是类别序，组内序=apply 序（requires 拓扑自动拉齐）——**新增玩法包只改 playstyle 清单一处**；表外第三方系统仍走 before 锚点/表尾；各包 registerSystemDef 的 category 必须与 SYSTEM_DEFS 表一致（脏数据曾被推导暴露）。**跨包契约校验**（contracts.ts，三类契约统一校验）：跨包/跨层字符串键（item.meta.warmth/wearable、pawn.extra.worn）用 key 常量（K_WARMTH/K_WEARABLE/K_WORN）——写方/读方/客户端/服务端一律引用常量（拼错=编译期错误）；登记表+validateContracts 由 playstyleManager apply 末尾严格校验（卸载写方=空真不误伤）；单包自洽键（meta.tailor/heat/cookSpiced/prison/power/charge/captive/wounds 等写读同包）不入表；K_DYE 例外——单包键但被契约表 check 谓词依赖，也定常量；**命令契约**（COMMAND_CONTRACTS：wear 的 args.itemId 等，处理器随包不随系统卸载）与**协议契约**（PROTOCOL_CONTRACTS：pawns.worn/items.w，值语义含染色 id `{dye}_{base}` 前缀约定）同样登记，validateContracts 三类统一检查。**色值=表现层数据**：clothing 包不持色值（只有染料 id + 中文色名），渲染 tint 色值唯一权威在 renderer 本地 DYE_COLORS 表（服务端/客户端单一来源）。
- **制衣玩法包**（2026-08-15）：clothing 包（材质皮/麻 + 染料 + 设计=科技抽卡）——系统 'clothing' 在产出组末尾（cook 后 raid 前，BASE_SYSTEM_ORDER 24→25，playstyle 23→24 包）。**纯插件收敛**（用户二次指摘后）：命令协议开放（Command.type `(string & {})` + `args` 通用位，'wear' 枚举成员删除、处理逻辑全在包）；生成层点缀数据化（`TileDef.sparse` 声明 + World 构造收集，noise.ts 零玩法分支、spice 先例一并迁出）；唯一保留的内核面 = `ItemDef.meta`（对齐 BuildingDef.meta 通用容器，warmth/wearable 放 meta；thermo 跨包契约读它）。穿戴状态走 `PawnState.extra.worn`（存档扩展点零改动）；配方科技门控 = 包内表；协议 pawns.worn + items.w 透传（远程染色/HUD 过滤）。

## 命令

- 测试：`npm test`（vitest，536 用例 / 57 文件全绿，覆盖插件装卸/依赖图/无限地图/契约/DLC/网络/性能回归）；类型：`npx tsc --noEmit`
- 单系统独立测试：`npx vitest run <文件> -t "<用例名>"`（系统只依赖 SimContext，可脱离完整 Sim 单独验证）
- 纯逻辑游玩：`npx tsx scripts/play.ts`（CLI：state/pawns/sel/move/build/job/oracle/map/f）
- 联机 server：`npm run server -- 8080`，客户端 `?remote=ws://127.0.0.1:8080`（神谕抽卡默认启用，LLM_ENDPOINT 仅可选增强）
- **当前装配态快照**（2026-08-16 终版）：`npm test` 当前 = **536 用例 / 57 文件**；默认装配 = **28 系统**（SYSTEM_DEFS 27 + beastTaming）/ **27 包**。
- 历史功能演进、性能优化、DLC/玩法包、审查修复记录统一见 `docs/PROGRESS.md` 与 `docs/CHANGELOG.md`。
