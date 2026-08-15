# RW-1 修订计划：神谕卡式工作引导（2026-08-15 第二轮）

> 背景：RW_SPRINT.md（第一轮计划）的 M1 已实现为"Work Tab 数字优先级"（39dfe29）。
> 用户裁决（2026-08-15）：每个小人 1–4 优先级 = 玩家**直接管理意图进入行为选择链**，
> 与"一切皆抽卡 / 神谕不碰选择链"核心设计冲突，属任务方错误，**全部撤回**。
> 本文档 = 修订后的完整计划（RW_SPRINT.md §1–§9 的 M1 部分作废，M2 保留）。
> 文档铁律：只增不减——本轮撤回不删除旧文档行，以本文件 + PROGRESS 追加记录纠偏。

## 1. 现状（代码已核实）

- 神谕三层分离已就位：`SimContext.setOracleGoal({workType,label,duration})` 只设
  `sim.oracleGoal`（单槽，到期自动清），decide 时 `ruleOracleGoal`（weightRules.ts）
  把**工作类型匹配的卡权重 ×tuning.card.oracleGoalMul(=3)**——不插小人卡槽、不碰选择链。
- 策略卡表 = `defs/strategyCards.ts`（垦田令→farm、拓荒令→campfire 蓝图副作用，
  条件/权重/降旨文本全声明式；mod 可 `registerStrategyCard`）；随机神谕（dummyLlm）
  每 90s 采样一张 → `applyBlueprint` + `setOracleGoal(duration:120s)`。
- `printCard(def,{target})`（Sim 公开方法）：策略卡插入小人槽位（空槽优先，满则顶掉
  weight 最低卡）；槽位 = 抽 3 选 1 的候选池（drawCards 从 slots 抽）——插入后仍走抽卡。
- 违抗机制已存在（defy roll：工作卡被选且存在未选本我卡 + 懒惰/心情差 → 改选本我卡）。
- 蓝图副作用幂等：queue 里已有同 defId 蓝图 → 跳过（dummyLlm.applyBlueprint 已实现）。

## 2. 目标

把"玩家影响工作方向"从 M1 的数字优先级表，改造成**策略卡/神谕指引面板**，
一切效果经 `setOracleGoal`（目标层）+ 蓝图副作用 + 可选插卡（卡池），
**不新增任何 pawn 状态键、不新增协议字段、不新增数字优先级**。

## 3. 数据模型

- 新玩法包 `oracle-guidance`（默认挂载，requires: []）：
  - 注册 `strategy` 命令 `{ pawnId?, args:{ cardId } }`（走 COMMAND_CONTRACTS 登记）。
  - 每 sim 一个瞬态冷却（`WeakMap<SimContext, number>`，防模块级跨实例串扰；
    与 commandCooldown 同设计：冷却不随档 = 有意轻量存档，见 DATA_DRIVEN §14）。
  - 蓝图副作用：策略卡带 `blueprint` → 复用"build 命令入队"路径（与 dummyLlm 同构，
    落点扫描在包内实现，不改 dummyLlm = 任务 §8 禁改 LLM 层）。
  - 可选插卡：有选中小人时，策略卡 → BehaviorCardDef（id 前缀 `strategy:`）经
    `printCard` 插入每个选中小人槽位（插入后仍走抽卡池）——这是"目标卡/习惯卡"雏形。
  - 新策略卡 2 张（registerStrategyCard，数据驱动）：伐木令（oracle:chop，
    stockLow wood）、采矿令（oracle:mine，stockLow ore）——2026-08-13 定案的
    "可选神谕目标"落库；垦田令/拓荒令等 7 张内置卡已在表内，面板直接列出。
- 冷却/持续（包内 CFG，DATA_DRIVEN §13）：cooldownSeconds = 45（防遥控器）、
  defaultDuration = 120（与随机神谕目标周期一致）。

## 4. 包/系统设计

- 无新系统（冷却走 WeakMap；目标自动过期由引擎 step 处理）→ SYSTEM_DEFS 不变（26）。
- `oracle-guidance` 包 apply：
  1. `m.registerCommand('strategy', ...)`：找卡 → 冷却闸（未到可发 → logEvent 拒绝）→
     蓝图副作用 → `ctx.setOracleGoal` → 有选中则逐人 `printCard`（策略卡式习惯卡）。
  2. `m.registerStrategyCard(伐木令/采矿令)`（条件读 tuning 阈值，无魔法数字）。
- 契约：COMMAND_CONTRACTS 加 `strategy {cardId}` 条目（check = 包在场必须有处理器）。
  无 pawn 状态契约、无协议契约（零新增字段）。
- 引擎最小扩展（注释说明为何非纯插件）：`SimContext.printCard` 加入接口
  （Sim 已有实现）——插入小人槽位是引擎所有权（doc'd LLM 印卡通道），纯插件不可达。

## 5. UI（hud.ts）

- 底部新按钮「⛪ 神谕/策略」（oracle 图标），面板：
  - 生效目标行：`sim.oracleGoal`（本地 Sim 直读）→ 目标名 + 剩余秒；无 → "当前无目标"。
  - 冷却行：本地估算（面板内存最近下发时刻；权威闸在服务端命令，冷却中点击被拒绝并反馈）。
  - 策略卡列表（`sim.mods.strategyCards` 本地读取）：每卡 = 降旨文本 + 降旨原因 +
    效果说明（工作卡：对应工作权重 ×3；蓝图卡：将建造 X；无加成卡：仅叙事）+ 条件
    可用态（灰显不可发，条件 = evalStrategyCondition 用 SimView 字段组装的 slim ctx）。
  - 点击卡 → `issueCommand({type:'strategy', pawnId?, args:{cardId}})`。
- 选中面板：**删优先级摘要**，改显"身上策略卡"（slots 中 id 以 `strategy:` 开头者）。
- 删除 Work Tab 面板/CSS/button/委托点击与 JOBS 表格渲染。
- 远程模式（SimView 无 strategyCards/oracleGoal）：隐藏神谕按钮（观看模式只读，文档注明）。

## 6. 协议变化

- **零协议变化**。撤回 workPriorities 字段（SnapshotMsg/DeltaMsg/SimViewPawn），
  drafted 字段保留（M2）。server/diff/remote 同步清理。

## 7. 测试矩阵

| 用例 | 断言 |
|---|---|
| 1. 激活策略卡设置 oracleGoal | goal.label/workType/until 正确（真实 sim） |
| 2. 权重提高但抽卡非必然 | ruleOracleGoal ×3（规则级）+ 定种子长跑中目标卡未被强制全选 |
| 3. 小人仍可能违抗 | 懒惰 + 低心情 + 0 信仰定种子 → 出现"违抗安排"事件/非工作选择 |
| 4. 蓝图副作用只入队一次 | queueBlueprint 连续两次 → buildQueue 同 defId 仅 1 条 |
| 5. 冷却/持续限制 | 冷却中再次激活 → 拒绝 + oracleGoal 不变；目标到时自动清 |
| 6. 存档无 workPriorities | save() JSON 全文不含 'workPriorities'；extra 无该键 |
| 7. 远程协议无需新字段 | buildDelta/snapshot JSON 不含 'workPriorities'；'strategy' 命令过 cmdValidate |
| 8.（附加）插卡 | 选中 → slots 得 strategy:* 卡；未选中 → 不插 |

drafting.test 的 buildSnapshotLike 移除 workPriorities 字段（类型连带修正）；
work-priority.test.ts（11 例）删除。原 394 用例不回退。

## 8. M2（征召战斗）：保留第一轮实现

drafting 包（df4ab13）：draft/attack 命令、extra[K_DRAFTED/K_ATTACK]、behavior 征召门、
raidSystem 指定者优先、UI/渲染/协议/校验 —— 全部保留。位置说明：征召 = 玩家命令面
的"紧急指挥例外"（与 move/mine 同先例），不是"工作优先级"系统，不违背 §1.2 禁令。

## 9. 完成定义（对齐任务 §7）

- [x] typecheck / tests 全绿（原 394 不回退）
- [x] 代码零 workPriorities / 数字优先级表
- [x] 玩家工作影响 = 策略卡/神谕目标/插卡/权重
- [x] oracle-guidance 包卸载 Sim 不崩（命令/卡随包走，无内核残留）
- [x] 旧存档可加载（extra 透传，无迁移钩子）
- [x] 30 分钟长跑（默认 + hunter-gatherer）+ WSS 冒烟（drafted 同步仍验）
- [x] 文档：PROGRESS/PLAYING/DESIGN/DATA_DRIVEN 追加（只增不减）

## 10. 风险

- 面板内卡条件判定用 SimView 字段组装 slim ctx——远程无 defs 数据 → 面板仅本地（已定）。
- 插卡会顶掉低 weight 基础卡（printCard 既有语义，含随机神谕）——文档注明属设计内。
- 撤回 11 个优先级测试 → 总用例数下降（394 基线保留，回补 8+ 新测试）。