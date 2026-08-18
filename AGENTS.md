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
- **不往内核塞玩法**：采集/狩猎/耕种/科技等玩法应作为 mod 提供；内核只留"需求/决策/社交/建造/敌袭/人口/事件"等社会骨架（10 个）。改内核前先问"能不能做成 mod"。
- **卸载不破坏核心**：任何系统被禁用后 Sim 仍能跑（装配过滤见 `sim.registerSystems`）；依赖被卸载系统的代码要条件化，避免引用已卸载实例。
- **完全插件化**（2026-08-14）：内核 `SYSTEM_DEFS` 只有 10 个社会骨架系统；gather(采集) 也迁出为 `gathering` 玩法包。默认玩法清单外置为数据 `src/mods/packs/playstyle.ts`（`DEFAULT_PLAYSTYLE_PACKS` + 聚合包 `defaultPlaystylePack`，`ModRegistry.default()` 只 registerPack 清单 + mount 聚合包）。mod 统一为 **ModPack 格式** `{ id, requires, apply }`（旧式 `export default (m)=>void` 已废弃，客户端 `?mods=` 加载器仍兼容但告警）。**包依赖显式化 + 自动组 DAG + 第一个插件 = 管理器**（2026-08-15）：每个包必须显式声明 `requires`（无依赖 = 空数组，硬依赖 vs 可选联动写注释）；挂载序由 pack.ts `topoSort`（Kahn 拓扑）从 requires 自动推导，清单顺序不承担图约束（乱序也自动正确）；`playstyleManager` 是第一个插件 = 管理器（清单校验 + 组 DAG 都在它 apply 里），`ModRegistry.default()` 只做数据种子 + mount 管理器，框架不 import 任何玩法包。
- **内核纯引擎**（2026-08-15，Stage1）：内核再迁出 8 系统（needs/san/desire→needs 包、social/build/raid/population/events 各一包），**内核只剩 2 个引擎系统：behavior（决策引擎）+ socialUnit（派系单位契约）**，纯引擎 = 2 系统可跑（不保生存）。**执行序 = `BASE_SYSTEM_ORDER` 全量数据清单**（defs/systems.ts，数组位置即序；内核 2 系统内联 ctor，其余按 id 从玩法包回填；清单外第三方包仍用 before 锚点插位）。`DEFAULT_PLAYSTYLE_PACKS` 扩为 19 包、只决定挂哪些包与 apply 序，与执行序解耦。
- **内核纯引擎**（2026-08-15，Stage B+C+D，终态）：**内核 = 0 系统纯演算框架**——behavior/socialUnit/economy/bootstrap 全部迁出为玩法包，`BASE_SYSTEM_ORDER` 24 系统、**无内联 ctor**（KERNEL_SYSTEM_IDS = []）。**能力让渡**：Sim `provide/getCap`（SimContext 同步），玩法包系统构造时自报能力（behavior/socialUnits/economy/bootstrap），`sim.behavior`/`sim.socialUnits` 变 getter（无包回落 null/NOOP）。**命令路由**：`issueCommand` 路由器——move 引擎内建，其余由玩法包 `registerCommand` 提供。economy 执行位在 behavior 前（优先级当帧生效）、bootstrap 表尾（出生刷人晚于系统 init）。playstyle 清单 23 包。
- **架构一致性重构**（2026-08-15，用户「fix them」「插件/mod 不要有不一致行为」）：**behavior 归内核**（决策引擎=引擎服务，SYSTEM_DEFS 内联 ctor，内核=1 系统；assign/oracle 命令迁回引擎协议面；行为=装配/卸载/锚点规则与其他系统完全一致，无特殊 case）。**执行序 = 类别序 × 组内注册序推导**（CATEGORY_ORDER 7 类 needs→ai→society→production→raid→world→boot，bootstrap category='boot' 恒表尾）：唯一人工语义是类别序，组内序=apply 序（requires 拓扑自动拉齐）——**新增玩法包只改 playstyle 清单一处**；表外第三方系统仍走 before 锚点/表尾；各包 registerSystemDef 的 category 必须与 SYSTEM_DEFS 表一致（脏数据曾被推导暴露）。**跨包契约校验**（contracts.ts，三类契约统一校验）：跨包/跨层字符串键（item.meta.warmth/wearable、pawn.extra.worn）用 key 常量（K_WARMTH/K_WEARABLE/K_WORN）——写方/读方/客户端/服务端一律引用常量（拼错=编译期错误）；登记表+validateContracts 由 playstyleManager apply 末尾严格校验（卸载写方=空真不误伤）；单包自洽键（meta.tailor/heat/cookSpiced/prison/power/charge/captive/wounds 等写读同包）不入表；K_DYE 例外——单包键但被契约表 check 谓词依赖，也定常量；**命令契约**（COMMAND_CONTRACTS：wear 的 args.itemId 等，处理器随包不随系统卸载）与**协议契约**（PROTOCOL_CONTRACTS：pawns.worn/items.w，值语义含染色 id `{dye}_{base}` 前缀约定）同样登记，validateContracts 三类统一检查。**色值=表现层数据**：clothing 包不持色值（只有染料 id + 中文色名），渲染 tint 色值唯一权威在 renderer 本地 DYE_COLORS 表（服务端/客户端单一来源）。
- **制衣玩法包**（2026-08-15）：clothing 包（材质皮/麻 + 染料 + 设计=科技抽卡）——系统 'clothing' 在产出组末尾（cook 后 raid 前，BASE_SYSTEM_ORDER 24→25，playstyle 23→24 包）。**纯插件收敛**（用户二次指摘后）：命令协议开放（Command.type `(string & {})` + `args` 通用位，'wear' 枚举成员删除、处理逻辑全在包）；生成层点缀数据化（`TileDef.sparse` 声明 + World 构造收集，noise.ts 零玩法分支、spice 先例一并迁出）；唯一保留的内核面 = `ItemDef.meta`（对齐 BuildingDef.meta 通用容器，warmth/wearable 放 meta；thermo 跨包契约读它）。穿戴状态走 `PawnState.extra.worn`（存档扩展点零改动）；配方科技门控 = 包内表；协议 pawns.worn + items.w 透传（远程染色/HUD 过滤）。

## 命令

- 测试：`npm test`（vitest，394 用例：54 个最小 ctx 独立系统测试、31 个插件化装配/卸载测试、9 个玩法包依赖图/远程加载测试、9 个科技锁/碎片制测试、8 个无限地图双图层 chunk/负坐标/旧档兼容测试、10 个制衣玩法包测试、8 个跨包契约校验测试、1 个协议建筑 key 往返回归、1 个 delta worn 合并回归）；类型：`npx tsc --noEmit`
- 单系统独立测试：`npx vitest run <文件> -t "<用例名>"`（系统只依赖 SimContext，可脱离完整 Sim 单独验证）
- 纯逻辑游玩：`npx tsx scripts/play.ts`（CLI：state/pawns/sel/move/build/job/oracle/map/f）
- 联机 server：`npm run server -- 8080`，客户端 `?remote=ws://127.0.0.1:8080`（神谕抽卡默认启用，LLM_ENDPOINT 仅可选增强）
- **当前装配态快照**（2026-08-16 追加，前列数字为历史演进记录请勿改动——以本条为最新）：`npm test` 当前 = **451 用例 / 49 文件**（自 394 起每轮修复均带回归，用例数随修复递增）；`SYSTEM_DEFS` = **26 系统**（内核 1 = behavior 决策引擎，余 25 由玩法包 registerSystemDef 回填）；`DEFAULT_PLAYSTYLE_PACKS` = **25 包**；契约校验入口 = playstyleManager.apply（ModRegistry.default() 内部）+ **server 端 loadModsFromDir 后补跑**（2026-08-16 修复：DLC 经 mods/*.mod.json 挂载同样进契约表）；DLC 跨文件依赖 = `manifest.requires.mods: string[]`（loader 声明 + modManager 拓扑喂序挂载）。
- **当前装配态快照**（2026-08-16 架构优化轮追加，前列数字为历史演进记录请勿改动——以本条为最新）：`npm test` 当前 = **464 用例 / 51 文件**；`SYSTEM_DEFS` = **26 系统**（内核 1 = behavior 决策引擎）；`DEFAULT_PLAYSTYLE_PACKS` = **25 包**；**执行器装配 = 声明表 × 实现表双表**（defs/executors.ts 的 BUILTIN_INTENTS/BUILTIN_WORKS 声明 handler 键，systems/executors.ts 的 INTENT_IMPL/WORK_IMPL 纯函数实现——不再反射类方法名，mod registerIntent/registerWork 覆盖面不变）；**引擎类型权威在 `src/sim/types.ts`**（sim.ts re-export 保 `'../sim'` import 路径）；**存档版本化**：`SAVE_VERSION = 1` + `SAVE_MIGRATIONS` 迁移注册表（[0] = v0→v1 显式 no-op，兼容全为缺省语义），load 拒载更高版本；**契约字段级登记**：顶层强类型跨包字段（pawn.healTarget/healing）登记进 CONTRACTS 跨界读写清单；**拥挤格表**：walk 拥挤/占位检查用取整格聚合表（帧初构建 + 帧内增量更新），O(n²) → O(n)+O(1)；**双疗伤路径收敛**：cardSystem execHeal 与 medicine treat 共用 systems/heal.ts `beginHeal`；热路径 profile 第二轮 tool = `scripts/profile-long-run.ts`（总 step 耗时较首轮实测 -42%）。
- **战场指挥 DLC**（2026-08-16，用户「训练编排战术动作→指挥官→小队→多层指挥→大兵团」）：`field-command` 玩法包（默认挂载，requires ['drafting']）：`npm test` 当前 = **481 用例 / 52 文件**；`SYSTEM_DEFS` = **27 系统**；`DEFAULT_PLAYSTYLE_PACKS` = **26 包**。机制四层：① **训练编排** = train 命令（战术学习入 `pawn.extra[K_TACTICS].learned`，个人冷却 15s——训练是培养仪式，零资源面）；② **指挥官册封** = commander 命令（`pawn.extra[K_COMMANDER] = {role, subordinates}`，role 自动推导：辖下有队长 → 军团长 general，否则队长 officer——多层指挥零配置）；③ **战术下达** = dispatch 命令（`{tactic|'none', hostileIndex?}`，级联递归整树设置 underOrder + 征召，'none' = 收兵全解除）；④ **多层指挥** = general → officer → 兵树（指挥官死亡经系统上帧树快照级联解除——killPawn 同步删 extra，死后读不到编制表）。编排位 active = commander 命令 `args.active`（持久预设：无临战命令时按编排执行、收兵后回落、随档；'none'=清）。战术 5 项：冲锋（接敌半径 20 > 自动 14 = 先敌接战）、固守（drafting 追击跳过，战术优先级 > 自动索敌）、集火（须带 hostileIndex，目标消失自动解除）、撤退（远离最近敌，0.5s 节流重算）、集结（向指挥官，八方向散布落位）。受命 = 征召（复用 K_DRAFTED）；集火/冲锋 = 批量 setAttackTarget（复用 K_ATTACK）——零新引擎挂钩；玩家解除征召 = 战术失效（尊重玩家）；被动衰减不豁免。状态全走 pawn.extra 随档透传；命令契约 commander/train/dispatch + 协议契约 pawns.commander/pawns.tactic 已登记。

- **审计待办批量修复**（2026-08-16，H1/M1/M2/玩法包中①→④ + 低项 L5 顺带）：`npm test` 当前 = **491 用例 / 52 文件**；系统/包数不变（27 系统 / 26 包——无新注册面）。**H1 播放控制命令面**：pause/speed 引擎内建命令（issueCommand 硬编码分支,与 move 同层;args.paused 缺省 true / speed 值域 {1,2,3}）——main.ts/hud.ts 停止直改 sim.paused/speed（远程模式改本地壳 → HUD 谎报暂停/时钟漂移）,cmdValidate 白名单+形状校验,COMMAND_CONTRACTS 登记 2 条;本地/远程/服务器同一条通道。**M1 看门狗**：根修 lastMessageAt 只在连接时刷新（静默期有消息也断线）+ 服务器 2s 显式 PingMsg 心跳（暂停也发）+ 窗口 5000→15000（原值与全量对账 5s 等长=零抖动余量）。**M2 applyDelta**：不再整对象 spread 半残增量进 this.snap——delta.pawns 是逐条目部分字段,整体替换 = 其余 pawn 从快照蒸发;改逐 eid 字段合入（与 pawnCache 同源）+ 顶层单点赋值 + 建筑 key 解码补 x/y,对账仍为收敛点。**中① thermo 烧木**：暖炉每 10s 烧 1 木维持热度（只在 heater 结算,篝火/教堂免费语义不动;无木 → 断电不出热,补木恢复;烧木记 recordSpend）+ 顺手修 L5 无热源早退使极端温差惩罚失效;数值全在 CFG（fuelInterval/fuelPerEval/fuelItem）。**中② demo-berry** requires `['gathering'] → ['gathering','farming']`（浆果摊 passive 配方由 farm 系统结算,缺装=静默不产出）+ ctor 闭包 sim→ctx。**中③ 记账 3 处**：prison 喂食 / hg 猎杀掉肉（recordEarn,个人口袋记猎人 eid）/ hg 重建+添篝火（recordSpend wood 10）。**中④ hg 三系统 ctor**（huntWildSpawn/huntCombat/campRebuild）闭包 sim.→ctx. 清零,可最小 ctx 单测。

- **低严重度待办批量修复**（2026-08-16，L1-L8）：`npm test` 当前 = **501 用例 / 55 文件**（491/52 基线 +10 用例 +3 文件：auth/bootstrap/hostiles 测试）；系统/包数不变（27 系统 / 26 包）。**L1 可选鉴权**：`SERVER_TOKEN` 环境变量 → 连接须带 ?token=（纯函数 wsTokenOk 校验,不符 close 1008；未设 = 开放,dev 默认向后兼容；弱鉴权,公网需 TLS+更强认证）。**L2 RemoteWorld 边界**：canBuildAt 弃 width/height+负坐标全拒,对齐 sim.world.inBounds 同款 ±MAX_TILE。**L3 remote pawns 权威序**：无 pawnList 增量跟随 snap 权威序（不再按 pawnCache 插入序）；顺带修 M2 新 pawn merge 漏 eid 字段。**L4 bootstrap 出生篝火**：根因 = 手动 onCampfireBuilt + 事件监听双路,且监听注册晚于出生（出生事件丢失）；统一事件单入口 + 订阅先于出生。**L5 技能成长数据化**：growSkill COC 参数导出 `tuning.combat.skillGrowth`（base/cap/gainMin/gainMax 可覆盖）,skillOf 默认同源。**L6 敌人生成单入口**：pushHostile（sim/systems/hostiles.ts 纯函数,整体 spread EnemyDef 自动透传新字段 + hpMul/target 换算）收口 raid/wildmouse/hg 三处手工快照。**L7 死锚点清理**：表内系统 before 锚点仅第三方表外专用——8 包冗余 before:'raid' 清除（装配序断言绿）。**L8 wildmouse 头部依赖注释**如实化（requires=[] 无硬前置）。

- **驯兽守卫 DLC**（2026-08-16，用户「继续开发」，自主设计战斗主线延续）：`beast-taming` 玩法包（默认挂载，requires []）：`npm test` 当前 = **510 用例 / 56 文件**；`SYSTEM_DEFS` = **28 系统**（+1 beastTaming）；`DEFAULT_PLAYSTYLE_PACKS` = **27 包**（+1 beast-taming）。机制：**tame 命令**（hostileIndex 定位，仅 hp/maxHp ≤ 0.25 的重伤 cat 可驯；依 hpRatio 凄惨才臣服）→ **驯化进程**（投喂消耗 food 节流 feedPerSec 0.5，缺粮停滞不倒退；tamer 死亡中止；累计 20s 转正）→ **驯服成功**（faction='player' 营地守卫，owner=tamer；随局不随档——hostiles 运行时状态，存档天然不含，读档后守卫野生化；同 carried 先例）→ **守卫行为**（系统驱动：敌对 cat 在 guardEngage 8 内 → 扑咬 guardDps 6/s；无战 → 跟随驯养人至 2.5 格停；主人逝去就地游荡）→ **release 命令**（中止驯化/清除 owner 复原 faction）。**HUD**：右键敌人设 targetHostileIdx（main.ts 维护），选中面板 #selBeast 显示敌人 hp/状态 + 驯化/放归按钮（可训条件：cat + 重伤 + 未 taming + 未 tamed）。**契约**：COMMAND_CONTRACTS tame/release + cmdValidate 形状校验（hostileIndex 范围；pawnId 存在性）。**Hostile 扩展**：taming?（驯化进程） + owner?（守卫驯养人）——diff 整体覆盖自动透传；SimViewHostile 同扩展。raidSystem 移动/结算两循环跳过 player 阵营与 taming 态（驯化中趴伏不追鼠不被砍）。**装配**：28 默认系统（+1 系统），DLC 框架基线同步（27→28 系统、29→30 装配、28+1→29+1）。+8 回归（新 beastTaming.test.ts）。

- **性能优化第三轮 + 文件结构拆分**（2026-08-16，用户「继续性能优化，继续文件结构优化」）：`npm test` 当前 = **510 用例 / 56 文件**（不变，零回归）；系统/包数不变。**CardView 复用**：behavior 系统 decide 内 CardView 构造（20+ 闭包函数/pawn/tick）提升为 `makeView()` 类方法，每 tick 一次构造 + 循环内刷新 per-pawn 字段（lastSeries/assignedJob）。**sim.ts 拆出 sim-save**：save/load 逻辑（~140 行）独立为 `src/sim/sim-save.ts`，含版本化（SAVE_VERSION/SAVE_MIGRATIONS）、救援安置（spawnPawn 返 -1 时 findNearest 就近落位 + 告警兜底）、fireMemory 重建。sim.ts 909 行（原 1034）。
- **战斗平衡再调**（2026-08-16，试玩反馈第二轮）：`tuning.combat.predatorReactionMul` 0.5 → **0.25**（非征召自动近身反击 ×0.25；征召鼠全伤——指挥/驯化有充足介入窗口）；连带数值：`pawnDmg` 8→**5**、`meleeRange` 5→**3**、`captureRange` 1.2→**1.5**；野猫本体同步加强：hp 90→**110**、speed 6.5→**8**（更扛揍/突围更快/更易叼人）。顺带修 RepairSystem 征召中不自动修理（否则站桩敌拆营地会把征召兵拉去修篝火，覆盖战术命令）。代码注释/PLAYING 同步为准确术语「近身反击」与当前数值。`npm test` 当前 = **511 用例 / 56 文件**；系统/包数不变（28 系统 / 27 包）。+1 回归（raidSystem.test：自动减伤 vs 征召全伤伤害差异断言）。
