# RW-1 Sprint 实施计划（工作优先级 + 征召战斗）

> 2026-08-15 · 本轮唯一裁决：本项目继续做 RimWorld-like，玩家 = 殖民地管理者，
> 可直接管理工作和战斗；小人的自主抽卡/欲望/社交/违抗保留为底层自治；
> 神谕/信仰/LLM 为进阶特色，不在本轮扩大。

## 1. 现状（基线）

- 可运行原型：`npx tsc --noEmit` 干净；`npm test` = 43 文件 / 394 用例全绿。
- 已有能力：自主小人抽卡决策、需求/SAN、建造/采集/农耕/科技、袭击/社交/医疗/烹饪/
  温度/服装、无限地图、本地存档、server 权威 + delta 同步、24 玩法包完全插件化。
- 关键缺口：**玩家管理感**。玩家很难决定"谁该干什么、谁去战斗"。现有指派职业
  （`assign` → `assignedJob`）只有"一个主职业"的二元粒度，无法像 RimWorld Work Tab
  那样给每项工作设 0~4 优先级；战斗完全由 RaidSystem 自动接敌，玩家不能征召手动指挥。

## 2. 目标（M1 + M2）

- **M1 工作优先级**：玩家可为每个小人给每项工作设优先级 0（禁止）/1（最高）/2/3/4
  （最低），留空 = 自动。抽卡权重按优先级调制；禁止项不抽中。兼容旧 `assignedJob`。
- **M2 征召与战斗指挥**：`drafting` 玩法包默认挂载。征召小人停止自主决策，保持位置、
  仍执行玩家移动命令，可对指定敌人（hostileIndex）下达攻击（位移 + 复用 raidSystem
  战斗公式）。UI：征召/解除按钮、屏幕大小恒定的征召标识、右键敌方攻击。

## 3. 数据模型

- **工作优先级**：`PawnState.extra[K_WORK_PRIORITIES]` = `Record<jobId, 0|1|2|3|4>`。
  jobId 沿用 `JOBS` 表：`lumberjack/miner/farmer/crafter/fisher`。
  - `extra` 是存档扩展点（JSON-safe，随档原样还原），零白名单改动——符合
    DATA_DRIVEN §14 的"extra 扩展点自动随档"纪律。
  - 约定：`undefined` / 缺键 = 未设置 = 自主（0 只出现在显式设为禁止时）。
- **征召状态**：`PawnState.extra[K_DRAFTED]` = `boolean`；`PawnState.extra[K_ATTACK]` =
  `{ hostileIndex: number } | undefined`（攻击目标）。
  - 征召状态**进存档**（extra 随档）；攻击目标也存 extra（防守方"指定目标"希望在
    远程/换档后仍生效，且 JSON-safe 便宜；相较"不进存档"更简单一致）。

## 4. 系统 / 包设计

### 4.1 M1 —— `work-priority` 玩法包（默认挂载）

- 数据模型读写在**包内**（不碰 Sim 内核）：读写 helper 走 `K_WORK_PRIORITIES` 常量。
- **行为接入**：包内 `registerWeightRule(workPriorityRule, before:'job')`——
  规则读取 pawn 的工作优先级，把对应 job 的工作卡权重调制：
  - 0：对应工作卡权重归零（不可抽中）；
  - 1/2/3/4：从强到弱的倍率（倍率放包内 `CFG.WEIGHT_MULS`，不能拍脑袋写死）；
  - 未设置：不调制（保持自主）。
- **紧急需求兼容**：权重规则只调制"常规抽卡权重"；紧急需求（吃/睡/治疗/SAN 崩溃）
  在 BehaviorSystem 里 `handleUrgent` / `san<crazyAt` 分支**先于 decide() 执行**、
  不经过权重合成，天然不会被工作优先级抑制——无需额外改动，测试锁定即可。
- **兼容旧机制**：`assign` 命令改为写入工作优先级的快捷方式（主职业 = 1，其他工作 = 0）；
  旧档 `assignedJob` 在 `load` 时迁移为 `workPriorities` 并保留原主职业语义。
  - 迁移点：`Sim.load()`（引擎）或 workPriority 包 hook。倾向引擎 load 处做一次性迁移
    （不丢玩家设置是硬性要求，且引擎 load 已显式写 `assignedJob`），迁移逻辑读
    `K_WORK_PRIORITIES` 常量，保持字符串键单一来源。
- **命令**：`set-work-priority` 经 `registerCommand` 注册；参数
  `{ pawnId?, job, priority }`（`priority` = 0..4 或 `undefined` 表示取消为未设置）。
  服务端 `cmdValidate` 校验 job ∈ JOBS、priority ∈ 0..4。
- **UI**（见 §7）。

### 4.2 M2 —— `drafting` 玩法包（默认挂载） + RaidSystem 最小扩展

- `drafting` 包注册一个 `DraftSystem`（`registerSystemDef`，category 归 `ai`，锚点
  before `raid`，保证在战斗结算前处理征召推进）：
  - `update`：对征召小人——**跳过自主决策**（不调用 decide），推进已下发的移动/寻路
    （复用 BehaviorSystem 的 `walk` 逻辑；征召小人仍可被 `move` 命令移动）；
    - 推进攻击逻辑：若征召且有指定/附近敌人，在目标半径内产生伤害。
  - 解除征召：清除征召标志 + 攻击目标，恢复自主（下帧走 decide）。
  - 被动衰减（饥饿/疲劳/理智）不豁免：needs/san 系统照常更新，DraftSystem 不干预。
- **战斗复用**：RaidSystem 是唯一伤害结算权威（`hostiles[i].hp -= dmg*dt`、DEX 闪避、
  击杀掉落）。为避免复制战斗公式，两种方案：
  1. 打通 RaidSystem 的"玩家方"伤害：在 hostiles 上记录"最近攻击方"，RaidSystem
     `updateCombat` 结算时把征召小人造成的伤害并入同一个伤害/闪避/掉落管道。改造最小、
     复用率最高。**选此方案**。
  2. DraftSystem 自算伤害 → 复制公式。违反"不复制战斗公式"纪律，否决。
- 接入点（最小内核面）：
  - `Hostile` 增加 `pressedBy?: number`（最近对它的攻击 eid，raidSystem 结算用——
    供"被指定目标优先接战"与击杀掉落归属）；
  - RaidSystem 识别征召攻击（经 drafting 包在 `ctx.extra`/capability 让渡提供攻击判定），
    在 `updateCombat` 里消费征召小人产出的 `attackRequest`（{eid→hostileIndex}）与
    自动接战半径内的目标，统一走原伤害管道。这一处是"为什么不能纯插件"的最小协议面：
    伤害/闪避/击杀掉落结算在 raidSystem 内，玩家方也要进水——要么包外复制公式（禁），
    要么给 raid 一处能力口。
- **命令**：`draft`（`{ pawnId?, drafted: boolean }`，支持批量 = pawnId 缺省用 selected）；
  `attack`（`{ pawnId, hostileIndex }`）。均经 `registerCommand`。cmdValidate 校验
  pawnId 存在、hostileIndex 在 hostiles 范围内。

## 5. 协议变化

- `shared/protocol.ts`：
  - `SnapshotMsg.pawns[]` / `DeltaMsg.pawns[]` 增加 `workPriorities?` 与 `drafted?`。
  - 值语义：
    - `workPriorities` = `Record<jobId, number>`（缺省不下发/`undefined` = 全自动）；
    - `drafted` = boolean（true = 征召）。
- `server/index.ts` `buildSnapshot` 填这两个字段（从 `extra[K_WORK_PRIORITIES]` /
  `extra[K_DRAFTED]` 读取）。
- `server/diff.ts`：逐 pawn diff 这两个字段（标量 drafted、小对象 workPriorities）。
- `client/remote.ts`：`SimViewPawn` 增加 `workPriorities?` / `drafted?`；`applyDelta` 合并
  新增字段；HUD 读它渲染 Work Tab / 征召按钮。
- 旧客户端/旧协议兼容：新增字段在 Delta 里可选（`undefined` = 不发），旧客户端收到
  未知字段忽略、不崩；新客户端连旧 server（无这些字段）缺省 = 全自动 + 未征召，仍可跑。

## 6. 测试矩阵

### M1（work-priority.test.ts）
1. 优先级 0 完全禁止对应工作（某 job 卡永不抽中）；
2. 1 与 4 的权重排序（1 级工作更常被抽中）；
3. 未设置 = 自主行为不回退（与无优先级基线一致）；
4. 紧急需求（饿/困/治疗/SAN 崩溃）不受工作优先级抑制；
5. 旧 `assignedJob` 存档迁移为 `workPriorities`（主职业=1、其他=0，不丢设置）；
6. 命令校验：非法 job / 非法 priority 被 cmdValidate 拒绝；
7. 存档往返（set → save → load → 优先级保留）；
8. 远程 delta 同步（buildSnapshot → diff → applyDelta 后 workPriorities 正确）。

### M2（drafting.test.ts）
1. 征召后不自主决策（job 不变化、不抽工作卡）；
2. 解除征召恢复自主；
3. attack 命令产生位移 + 伤害（复用 raid 结算）；
4. 指定目标（hostileIndex）优先于自动接战；
5. 征召/攻击状态存档往返；
6. 远程 snapshot/delta 同步；
7. cmdValidate 拒绝非法 pawnId / 非法 hostileIndex。

### 回归
- 全量原 394 用例不回退；assembly 装配序、uninstall 全量遍历、契约校验自动跟随新包。

## 7. UI（hud.ts / renderer.ts，低成本，不引依赖）

- 底部新增"工作"按钮 → 打开 Work Tab：行 = 小人，列 = 工作类型（列名遍历 `JOBS` 表，
  不硬编码）；点击格子循环 空白→1→2→3→4→0→空白，点后发 `set-work-priority`。
- 选中 pawn 面板显示工作优先级摘要（遍历 JOBS 非 0 项）。
- 选中 pawn 面板新增"征召 / 解除征召"按钮 → 发 `draft`。
- 征召小人渲染标识：描边/图标，随缩放反比保持屏幕大小（对齐已有 zoom-constant overlay）。
- 右键敌方单位 → 对选中征召小人发 `attack`；不可攻击（未征召/无敌对）给反馈。

## 8. 风险

- **紧急需求与优先级耦合**：权重规则改的是常规抽卡，紧急分支先于抽卡，风险低；测试锁定。
- **战斗公式复用 vs 纯插件**：raidSystem 需要一处玩家方攻击入口。若做成纯插件复制公式，
  违反纪律；选"给 raid 最小能力口"，契约注释说明为什么不能纯插件。
- **farmer/crafter 同映射 build**：JOBS 里 farmer 与 crafter 都主导 `build` 卡。工作优先级
  若按"jobId → 卡片"会冲突（两列同时影响 build 卡）。处理：workPriority 规则按**卡**聚合
  （同卡的所有 job 优先级取最严格/叠加），并在 M1 测试中明确该语义。实际上 RimWorld 的
  Work Tab 列是"工作类型"而非"职业"——本轮 jobId 用 JOBS 表但权重调制按卡，故 farmer=0
  与 crafter=1 共存时 build 卡按 crafter 的 1 级算（最有利）。
- **旧客户端不崩**：新增协议字段全可选，旧客户端忽略未知字段。

## 9. 完成定义（对齐 task §8）

- [x] typecheck 干净、394 原用例无回退、新增测试全过。
- [x] M1/M2 以 ModPack 存在，disableSystem / 卸载不崩 Sim。
- [x] 快照/delta 回归测试覆盖新状态。
- [x] 旧档迁移不丢 assignedJob。
- [x] 默认清单 / DATA_DRIVEN 记新包/系统/键；PROGRESS/PLAYING/DESIGN 追加。
- [x] 30 分钟无 UI 长跑（默认 + hunter-gatherer）。
- [x] server 冒烟：新状态经 WSS 同步到远程客户端。
- [x] 至少 4 次提交：docs plan / feat work priorities / feat draft combat / docs sync。
