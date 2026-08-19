# infcanvas 实现/演进记录（CHANGELOG）

> 从 DESIGN / DATA_DRIVEN 中拆出的历史实现记录、数值追加、审查修复与玩法包演进。
> 当前设计/数据参考请读 `docs/DESIGN.md` 与 `docs/DATA_DRIVEN.md`；
> 分阶段进度与待办请读 `docs/PROGRESS.md`。

---

## 设计实现记录（原 DESIGN §11+）

## 11. P0 落地实现记录（与代码对应）

> 2026-08-04 更新：P0 单机 MVP 确定性系统已全部落地，见 `docs/PROGRESS.md`。这里记录与本节决策的偏差。

**需求模型（§3 简化）**：饥饿/精力/心情 + **SAN 理智**（实际是四维，比 §3 草案多出 SAN 已实现）。数值 0-100，`tickNeeds` 每帧衰减，紧急需求（饿<30 吃、困<20 睡）抢占。

**生产（§3 咬合）**：伐木/采矿 = 进度 + 骰子产出（`GatherSystem`）；矿洞 = 持续产矿（饥荒式矿场，40s 一轮）；农田 = 自动产粮；工作台 = 木→工具（采集 ×1.3）。产出受 STR 力量加成、工具加成。

**卡系统（§6）**：抽 3 选 1（种子化不放回）+ 收益择优；权重调制 = 天赋卡（工作兴趣/懒惰）× 欲望驱动（匮乏欲望升权）× 环境调制（雨/极端气温）× 马尔可夫偏置（上一系列）。违抗 roll 仅工作卡被选且有未选本我卡时触发，30s 冷却防刷屏。

**COC 骰子（§3）**：八属性全量；事件骰 = `roll ≤ dc + INT 加成`；技能检定 `rollEventSkill` = `dc + 技能/10`；技能成长 = 用后掷 d100 > 当前 → +1d10。

**七宗罪（§3）**：P0 版满足度 + 先天倾向（DNA.sins）；吃→暴食、休息→懒惰、工作→贪婪、祈祷→傲慢；恶意槽 = 长期匮乏 → 偷窃/砸建筑/暴躁。

**环境（§6）**：气温随昼夜波动 + 雨-晴循环；调制卡权重（下雨户外工作 ×0.5、娱乐 ×1.6；酷暑/严寒户外工作 ×0.6、生理 ×1.3）。

**叙事压力（§6）**：和平越久袭击越猛（间隔缩短 + 规模/血量放大），和平→压力→冲突闭环。

**社交（§6 微互动）**：相遇 → 打招呼/抱怨/表情，心情 + 好感度双向变化，话题抽自结构化历史（狗屁倒灶）。

**历史（§3）**：所有 GameEvent → 结构化条目（时间/类型/实体/地点/原因/事实），可查询可导出；LLM 只润色原则就位。

**mod（§7）**：ModRegistry 运行时注册 tile/building/item/enemy/card/recipe/event/expansionPlan/intent/work/system/hook + overrideDef/overrideTuning，冲突检测；`SimOptions.mods` 构造期挂载。**客户端 mod 表现**：UI 全部走 defs（建造菜单/tile 渲染/建筑图标/sprite 声明/敌人散列色），`?mods=url` 运行时加载 ESM mod（demo: src/mods/demo-berry.ts，e2e: scripts/e2e/mod-ui.mjs）。

**存档**：IndexedDB（异步、大容量），30s 自动存档；含社会单位（派系/记忆/看法/库存/玩家所属/成员归属）持久化。

**指派职业/生产线（用户 Q10）**：HUD 选中小人 → 指派"伐木工/矿工/农民/工匠/自由"；指派后对应工作卡权重 6x、其他 0.1x，自动补卡进池——形成"基础支持（食/木/矿）→高级支持（工具）→奇观"的分工。

**奇观（用户 Q10）**：纪念碑（木60+矿25，buildTime 40s），建成后全营地心情光环（敬畏）。

**社会单位/篝火派系（用户 Q9 + 即时指令）**：有篝火 = 独立派系。篝火维护部落记忆 + 对其他单位的看法（容量：篝火 2-3、教堂 5-10）。**教堂 = 篝火升级**。篝火间信任机制：成员协作→看法↑；双向友好→贸易（供需汇率 + 逆差记账）；双向敌对→派掠夺者攻打；中性→传话（只有传话，不直接控制）。**逆差→怨恨→战争**联动；征服（摧毁核心→吞并）；**派系 = 单位间的看法关系**（友好→贸易/伙伴、敌对→战争，无抽象联盟层）；野生篝火事件刷新新势力。

**团灭附身（用户 Q3）**：玩家单位成员清零或被征服 → 神谕自动附身最近存活单位。

**渲染**：PixiJS v8 + SVG（data-uri → GraphicsContext，矢量不糊）；**2D 俯视 ↔ 2.5D 同轴可切换**（2.5D 按世界 y 排序前后遮挡）。

**与 §1 的偏差**：§1 写"纯即时不可暂停"，实际 P0 有 ⏸ 暂停键（见 COLAB.md Q7，待定）。

### 12. 玩家 = 模拟循环之外（2026-08-13 架构裁决）

- **裁决**：模拟以数据为主，玩家根本不存在于模拟循环中。玩家只是外部干预源，提供**卡片**（神谕降旨/策略卡/printCard）或**指令**（issueCommand）。
- **实现**：删除 `playerUnitId`（玩家派系单位实体）、`checkPossession`（团灭附身）、`allocateResources` 玩家镜像、贸易 `isPlayer` 特判。
- **全局仓库 stockpile**：即玩家资源池，`faction='player'` 建筑（玩家/探索/神谕蓝图）产出直接进全局；各派系单位按成员数被动自给独立库存，派系间贸易/战争/传话只发生在单位之间，玩家不参与。
- **视角**：玩家是纯观察者 + 干预者，无派系身份、无附身、无库存镜像。

### 13. 篝火 = 区域历史载体（B 方案，2026-08-14）

- **用户设计**：每个人都保存一个篝火，在篝火周围生存；不舒适环境可另起篝火；篝火记载区域生活情况/历史事件；只有同 chunk 距离相近时才能交流篝火情况；pawn 据此判断伙伴或敌人；pawn 记得个体间的社会关系。
- **数据结构**：`pawn.fireId`（归属篝火，null=游牧）+ `pawn.knownFires: {fireId → {stance, basis, at}}`；篝火 `SocialUnit.memory` 即区域历史（bus 订阅 building_built/raid_started/building_destroyed/pawn_died 写入）。
- **交流机制**（`SocialSystem.exchangeFireStory`）：同 chunk 相遇 + 冷却内不重复 → A 讲所属篝火历史 → B 按关键词推断 stance（敌意信号=袭击/摧毁/战死 → enemy；友善信号=建筑/贸易 → friend）→ 写 B.knownFires + 调 B 对 A 的关系。
- **伙伴/敌人判定**（`relationEffects`）：heard stance 优先（enemy → 关系压到敌对区走动手路径；friend → 协作心情加成），未知才回退数值阈值。**判断基于听到的事实，不是数值**。
- **另起篝火**（`SocialUnitSystem.migrateIfUncomfortable`）：篝火遭袭计数 `raidCount`（hostiles 落在营地半径内每检查周期 +1）达 `migrateRaidThreshold` 才迁出 1 人另起新篝火。**设计教训**：首版仅凭"敌人离小人近"触发 → 狼群驱散整个文明（12 次迁徙、15 个空壳派系连锁分裂）；改按"篝火持续遭袭"判定后收敛（4 次迁徙、7 派系）。

### 13.1 迁徙判据与归属收敛（2026-08-14 试玩修复）

- **迁徙 = 真实损失**（`migrateIfUncomfortable` 三修）：仅当篝火历史出现"💥 建筑被摧毁"且当前有威胁在场，raidCount 才 +1；达 `migrateRaidThreshold` 迁出 1 人。狼路过/仅喊打喊杀不计数。
  - 踩坑链：①"敌人离小人近" → 狼驱散文明（12 次/15 空壳）；②"敌人在营地半径内计数" → 狼扫过一遍 raidCount 疯涨（90 分钟 40 次、41 单位 34 空壳连锁雪崩）；③ 终版真实损失判据 + 新篝火离旧营地 ≥`migrateMinDist`。
- **归属持续收敛**（`reassignInterval`）：归属在"建 campfire/出生/迁徙"是时点快照，小人走到营地旁不重算 → 游牧幽灵。加低频全量 reassign（默认 20s）让个体自然划入最近单位。
- **营地被毁清 fireId**：`building_destroyed` 解散派系时同步清空成员 fireId（曾踩坑：只删 membership 留 fireId → 幽灵归属）。

### 14. 私有食物 + 互助（2026-08-14）

- **私有物品（克制版）**：`pawn.inventory` 仅装食物。主动采集（caveWork 渔获等 `item==='food'`）进个人口袋；进食 `consumeFood` 优先个人、全局粮仓兜底。木材/矿石仍全局（避免牵动建造）。**决策**：用户确认"仅食物私有化"，支撑"好感高送食/集市换粮"核心诉求。
- **互助卡**（`help`，base 卡常驻槽位）：condition = 附近有弱势邻人（缺食/受伤/低落）+ 我对 TA 好感 ≥ `helpFriendAt` + 自身不危急（先自救）。utility 随弱势程度放大（濒死邻人 > 工作）。execHelp 送食（个人口袋转移）/疗伤/陪伴；受助方好感 +`helpGiveRel`（互惠）。
- **需求写篝火历史**（`needsSystem.recordNeed`）：濒死/低落 → 记入附近 campfire 记忆（节流：跨越危急等级才写），交流传播（exchangeFireStory 读取）。
- **解耦**：互助完全走卡系统（condition/utility/action 声明式），mod 可禁用/覆盖 `help` 卡或注册新互助意图。

### 15. 世界观：鼠鼠 vs 野猫（2026-08-14）

- 小人是**鼠鼠**（渲染/SVG 本来就是"正面鼠"，与 HUD 共用映射），天敌是**野猫**。
- 早期实现的"野狼"是设定幻觉（`enemies.ts` 拍脑袋写的默认敌人），用户指出后全部替换为 `cat`（野猫）。
- 敌人表数据驱动不变：`registerEnemy`/`overrideTuning({combat:{raidEnemy:'cat'}})` 可换袭击类型；`raider`（鼠族掠夺者）保留为鼠族内部冲突。

### 16. 插件卸载 + 采集狩猎（2026-08-14）

- **`disableSystem(id)`**（ModRegistry）：声明禁用某系统（内置或扩展），`sim.registerSystems` 装配时跳过。补全"一切皆插件"——此前插件只能 `insertBefore` 加系统、不能撤默认玩法。
- **击杀掉落私有化**：raidSystem 猫死掉落 `item==='food'` → 击杀者个人 inventory（私有），其余仍全局。与 gather 私有食物一致。
- **hunter-gatherer mod**：
  - 卸载 farm/craft/techPool/autobuild/repair → 纯采集+狩猎
  - `overrideDef('enemy','cat',{loot:{item:'food',amount:4}})` 猫掉肉
  - `huntWildSpawn`：营地外环带刷常驻游荡猫（非袭击波）
  - `huntCombat`：huntTarget 到近旁后推进攻击（fight 技能加成伤害），猫死掉肉
  - `campRebuild`：营火被拆后 60s 轮询重建（无 autobuild 时营地是命根子）
  - 狩猎卡 `when:['huntNearby']`（谓词先于卡注册，卡工厂构建时即解析）

### 17. 单系统独立测试（2026-08-14）

- **minCtx helper**（`src/sim/__tests__/helpers/minCtx.ts`）：构造最小 SimContext（真实 World/EventBus/SimRng/ModRegistry/TUNING + 桩方法），`attach(ctx, sys)` 注入系统、直接 `update()`/发 bus 事件验证。桩方法用 `_` 前缀字段暴露观测（`_log/_spawned/_killed/_moodAdj/_unlockedTechs…`），测试可 override 任意成员（如 `isNight: () => true`、固定 rng）。
- **16 系统独立测试文件**：`src/sim/__tests__/systems/*.test.ts` 每系统一文件，覆盖各自核心行为（衰减/归属/招募/产出/袭击/决策…）。
- **依赖解环**：`mods/query.ts` 独立承载跨实例共享表（predicateStore/weightRuleStore/socialLinesStore）+ 查询函数；registry/pawn/socialSystem 单向依赖，消除 registry↔pawn 循环 import。

### 18. 卸载不破坏核心（2026-08-14 插件化加固）

审阅 `sim.registerSystems` 装配面发现"插件可卸载"只做了一半——系统装配表能过滤，但 Sim 本体的硬引用在卸载时会崩：

- **双重实例化（删除）**：sim 构造器在 `registerSystems` 之外又 `new BehaviorSystem/SocialUnitSystem`。禁用 behavior 时这俩孤儿实例仍被创建，`mods.intents/works` 挂到死实例上（行为层"幽灵运行"）。修复：构造器不再预建，`registerSystems` 是唯一实例化点。
- **socialUnits no-op 回落**：`SimContext.socialUnits` 是契约字段，needsSystem 记需求 / socialSystem 交流历史 / sim 自身 bus 回调（建篝火→记忆、归属、unitAt 展示）都无条件调用。卸载 socialUnit 后置 null 会空引用崩溃。修复：字段默认 `NOOP_SOCIAL_UNITS` 空实现（调用即无操作），启用时回填真实例——消费方契约不变，卸载无感。
- **intents/works 挂接条件化**：`this.behavior` 判空后挂接（behavior 卸载时跳过）。
- **回归保护**：`src/sim/__tests__/uninstall.test.ts` 20 用例——16 系统逐个卸载（构造+步进 120s 不崩、装配表不含该 id）、socialUnit no-op 契约、behavior 卸载、采集狩猎组合卸载（farm/craft/techPool/autobuild/repair 长跑 600s）、全量卸载（空壳稳定）。全量 296 测试通过。

**已知差距（未做，待用户裁决）**：纪律"玩法应作为 mod 提供、内核只留需求/决策/采集/社交"尚未完全达成——farm/craft/techPool/autobuild/repair 仍内置在 `SYSTEM_DEFS` 内核，玩法包目前靠 `disableSystem` 卸载达成"可撤"，未迁移为"默认玩法 mod"装配。迁移成本：系统拆包 + 默认装配表 + 双端加载顺序，属独立重构。

### 19. 玩法包化：最终模拟器 = 内核 + 玩法包叠加（2026-08-14）

用户裁决："最终通过 mod/插件一个个添加玩法最终变成最终模拟器"——架构从"玩法内置 + 反向卸载"改为**正向组装**：

- **内核收窄**：`SYSTEM_DEFS` 只剩 11 个基础系统（needs/san/desire/behavior/socialUnit/social/gather/build/raid/population/events）——需求/决策/社交/采集/建造/敌袭/人口/事件，零玩法。
- **玩法系统迁出为 5 个独立玩法包**（`src/mods/packs/`）：
  - `farming.ts`（farm 耕种）/ `crafting.ts`（craft 手作）/ `repair.ts`（repair 修缮）→ `before: 'raid'` 插回产出位
  - `tech-pool.ts`（techPool 科技）/ `autobuild.ts`（autobuild 自主扩张）→ 表尾追加
- **默认装配全部**：`ModRegistry.default()` 挂载 5 玩法包 = 原 16 系统完整模拟器（体验不变）；玩法包可 `disableSystem` 撤换（hunter-gatherer 仍为换装玩法包）。
- **同锚点保序**：多个 mod 项声明同一 `before` 时按注册序排列（原 splice 连续前插会逆序——farming/crafting/repair 同锚 'raid' 暴露，产出序必须 farm→craft→repair）。
- **验证**：`assembly.test.ts` 5 用例（内核 11 无玩法 / 默认 16 且序正确 / 玩法包独立加减 / 注册来源 mod 面 / 纯内核可运行）；卸载测试改为遍历完整装配集。全量 301 测试。
- §18"已知差距"已消除：玩法系统已全部迁出内核，玩法包 = 最小"添加玩法"单位。

### 20. 内核终态：0 系统纯演算 → 1 系统决策引擎 → 契约表（2026-08-15 追加，与 §19 演进衔接）

- **§19 之后又推进了三个阶段**（详见 PROGRESS.md 2026-08-15 各轮）：
  - Stage1：内核迁出 8 系统（needs/san/desire→needs 包、social/build/raid/population/events 各一包），内核 2 系统（behavior+socialUnit）；
  - Stage B+C+D：behavior/socialUnit/economy/bootstrap 全部迁出，内核 = **0 系统纯演算框架**（BASE_SYSTEM_ORDER 24 系统无内联 ctor）；
  - 一致性重构（用户「fix them」「插件/mod 不要有不一致行为」）：**behavior 归内核**——决策引擎 = 引擎服务，SYSTEM_DEFS 内联 ctor，**内核 = 1 系统**；assign/oracle 命令迁回引擎协议面。
- **执行序 = 类别语义序 × 组内注册序推导**（CATEGORY_ORDER 7 类 needs→ai→society→production→raid→world→boot，bootstrap category='boot' 恒表尾）：唯一人工语义是类别序；新增玩法包只改 playstyle 清单一处。§19 的"同锚点保序"语义保留给表外第三方系统（before 锚点/表尾兜底）。
- **能力让渡**（provide/getCap）：玩法包系统构造时自报能力（behavior/socialUnits/economy/bootstrap），sim.behavior 变 getter（无包回落 null/NOOP）；命令路由 issueCommand（move 引擎内建，其余 registerCommand 提供）。
- **跨包契约校验**（contracts.ts 三类契约：meta/extra 键 + 命令参数 + 协议字段，详见 DATA_DRIVEN §12/§13）：写方/读方/客户端/服务端一律引用 K_* 常量（拼错=编译期错误），validateContracts 由 playstyleManager apply 末尾严格校验。
- 本段为 §18/§19"已知差距/内核收窄"描述的**演进注记**：上述描述为当时快照，当前内核形态以本段 + PROGRESS.md 为准。

### 21. RW-1 玩家管理层：工作优先级 + 征召战斗（2026-08-15 追加）

**本轮设计裁决（RW_SPRINT.md）**：本项目继续做 RimWorld-like，**玩家 = 殖民地管理者，可直接管理工作和战斗**；小人的自主抽卡/欲望/社交/违抗保留为底层自治（神谕/信仰/LLM 为进阶特色，不在本轮扩大）。此前文档中"玩家只下达神谕、不直接指挥小人"的描述为早期快照，本轮起**直接指挥（Work Tab + 征召/攻击）是正式玩法**——自主决策仍是底层：玩家设的是**约束/目标**（优先级、征召开关、攻击目标），不放逐自主机制。

- **M1 工作优先级（work-priority 包）**：抽卡权重调制层 = weightRule（`ruleWorkPriority` 挂在 `before:'job'`，贴职业卡前；未设置不调制、0=清权重、1~4=乘 CFG 档位）。语义定位：**优先级只调"这张卡被抽中的相对权重"**，不绕过 urgent 分支（紧急需求必定优先，玩家设 4 也压不住快饿死）——玩家管"工作分配"，生命力机制仍自治。
- **M2 征召战斗（drafting 包）**：两种新玩法权限——**征召 = 暂停该小人的自治**（behavior 决策门，K_DRAFTED 契约键；门在理智分支前 = 连精神崩溃的自主乱跑也不执行，完全听指挥，但崩溃风险照常累积、解除后立即恢复）；**攻击 = 指定战斗目标**（K_ATTACK，raidSystem 的"谁接敌"picks 指定者优先）。
- **架构形态**：两包都是标准 ModPack（`{id, requires, apply}`），协议面只动三处最小点——① behavior 决策门（为什么动内核：抽卡决策是引擎内部循环，纯插件无法在不改引擎的前提下阻止它；只读一个契约键）；② raidSystem 接敌者的选择（含 `attackDesignatorOf`，**不复制**伤害/闪避/掉落公式——战斗数字唯一权威仍在 raidSystem）；③ 协议 pawns.drafted 字段（snapshot/delta 全链路）。追击移动完全复用 engine moveTo（不复制移动/寻路）。
- **战斗身份**：敌对单位无持久 uid，hostileIndex 是数组下标（协议 `hostiles.i`）；击杀会 splice 错位 → 指定者的目标解析（resolveTarget）按**位置快照就近找回**（targetLostRadius）并回写下标；找不到 = 目标已死 → 清指定回自动接敌。攻防左右手：征召小人原地待命时若敌人进入 meleeRange，raidSystem 同样会结算（无指定的自动接敌受 autoEngageRadius=14 限制，但"敌人走到脸上"的贴脸互殴不受半径限制）。
- **玩家反馈教育**：右键敌人的攻击命令要求小人已征召（未征召 → 事件 feed「⚠ 攻击需要先征召小人」）——首轮体验把"先征召再指挥"教给玩家；征召圈环（反缩放恒定大小）是"听我指挥"的命令标识，与血条（被动状态）视觉分离。

### 22. RW-1 修订：神谕双通道裁决（2026-08-15 追加，§21 局部撤回）

**用户裁决（并发起人自认错误）**：§21 的 M1（Work Tab 1-4 数字优先级 = 玩家逐小人设定行为优先级表）是**发起人写进 sprint 的设计错误**——"直接管理意图进入行为选择链"，与项目核心设计 **一切皆抽卡**（抽卡 = 选择链权威）和 **神谕不碰选择链**（神谕/策略卡只设目标/权重/蓝图，绝不越下到具体小人决策）冲突。**M1 全部撤回**：无 `workPriorities` 键、无 Work Tab 网格、无逐小人 forbid/force；`assign` 命令原样保留（不删）。§21 中 M1 相关描述（work-priority 包部分）**作废**；M2（drafting 征召战斗）与 §21 其余部分**继续有效**——征召作为"紧急指挥命令"属于玩家命令表面（与 move/mine 同类的直接指挥层），不是优先级系统，是两通道裁决中"指挥通道"的明确例外。

**双通道裁决（本节为 DESIGN 现行语义）**：玩家有两个互不侵犯的工作影响通道——
1. **神谕引导通道（工作方向，软约束）**：神谕/策略面板降下策略卡 → `setOracleGoal`（仅对应工作类型抽卡权重 ×`tuning.card.oracleGoalMul`=3，目标层）、蓝图副作用（build 命令入队，队列去重）、可选 `printCard` 插入"目标卡/习惯卡"到选中小人槽位（insert 后仍走抽 3 选 1 卡池）。**不保证**：小人可能不抽到目标卡、可能被欲望/收益/违抗 roll 顶掉。冷却（45s）+ 持续时间（120s）闸防遥控。
2. **指挥命令通道（直接指挥，硬约束、独立文档层）**：move/mine/assign/draft/attack 等命令（引擎内建 + 玩法包注册）——**逐小人即时指令**，不写任何优先级/约束状态。M2 征召 = 本通道的紧急例外（暂停自治，不是优先级系统）。

**实现形态（oracle-guidance 玩法包）**：零新增 pawn 状态键、零协议字段、零新系统（SYSTEM_DEFS 保持 26）；唯一内核扩展 = `SimContext.printCard`（Sim 早已实现的 LLM 印卡通道，纯插件不可达小人槽位）；冷却为 `WeakMap<SimContext, number>` 瞬态（不随档，与 commandCooldown 同设计）。新增策略卡 2 张：伐木令（oracle:chop）/ 采矿令（oracle:mine），条件读 tuning 路径（2026-08-13 定案"伐木令退位为可选神谕目标"落库），随机神谕同样会采样——引导而非经济平衡。噪声面：随机神谕不变（dummyLlm 冻结禁改，包自带 spot 扫描 + 队列去重的蓝图落点）。

## 命令接口与实现同宽 / 升级落点校验 / 摧毁回调（2026-08-16 审查修复追加）

- **`SimContext.issueCommand(cmd: Command)`**：系统侧接口从窄联合（`{type:'build'...}`）放宽为与 `Sim.issueCommand` 相同的开放 `Command`（`type` 含 `(string & {})` + `args` 通用位）——玩法包注册的新命令（wear/draft/attack/strategy…）在系统侧直接可发,不再被迫 cast。协议面（shared/protocol.ts + cmdValidate 白名单 = mods.commandHandlers）不变。
- **升级 = 扩展 footprint 的落点校验**（World.canUpgradeAt）:升级路径此前跳过 footprint 校验（buildSystem 只对新建做 canBuildFootprint）,`upgradeBuilding` 无条件覆盖 gridToBuilding——两座相邻篝火各自升 2×2 教堂时,后升级者的格子归属顶掉前者。现在升级同样走"新格必须可建且不被占"校验（旧 footprint 格豁免）,fail = 放弃蓝图不扣资源。
- **建筑摧毁回调**（World.onBuildingDestroyed → sim.clearTrailCache）:摧毁路径（raids 拆家/怒砸/清剿）此前不触发缓存失效,被拆篝火/教堂的锚点段仍被寻路复用。与既有"建成/地形变更"两个失效点补齐为三。
- **执行器装配 = 声明表 × 实现表双表**（2026-08-16 拆分轮）：内置意图/工作执行器迁出 `src/sim/systems/executors.ts`——`defs/executors.ts` 只声明（BUILTIN_INTENTS/BUILTIN_WORKS 的 handler 字段 = 全名字符串 `execWalkAndWork`/`workChop`…），`systems/executors.ts` 只实现（INTENT_IMPL/WORK_IMPL 键 = handler 全名，纯函数 `(c, eid, st, intent, deps)`）。BehaviorSystem 构造经 `intentImplOf(handler)`/`workImplOf(handler)` 装表，**不再反射类方法名**（类方法名可被混淆/重命名而字符串 handler 不失控）；mod 运行期 `registerWork` 的新 handler 在执行时经 `deps.workExecutors` 引用实时解析（构造快照会漏掉晚注册的工作）。装配回归锁定：声明表 × 实现表一一对应、无孤儿键（assembly.test）。两表同文件对读即"数据驱动"的意图/工作维。
- **引擎类型权威迁出 `src/sim/types.ts`**（2026-08-16 拆分轮）：BehaviorCap/PositionData/NeedsData/SpeedData/HealthData/PawnState/SimOptions/Command/SaveData 自 sim.ts 迁出为零运行时依赖类型模块（仅 type-only import，杜绝循环引用），sim.ts import + re-export 保 `'../sim'` 既有路径不动。registry.ts 有意不拆：30+ 注册/覆盖/查询方法高度内聚的单一职责注册中心，拆出 = 薄层转发负收益。
- **存档版本化**（2026-08-16）：SaveData.saveVersion 顶层字段（缺省 0 = 旧档）；`SAVE_VERSION` 常量 + `SAVE_MIGRATIONS` 迁移注册表（下标 = 目标版本，load 顺序执行 < saveVersion 的全部迁移）；v0→v1 = 显式 no-op——既有兼容点全为缺省语义（旧档 tiles 双格式识别、slots 双形态、缺省字段回归默认值、惰性迁移），未来破坏性格式变更 = 追加迁移函数 + 升版本号，load 拒载 `saveVersion > SAVE_VERSION` 防新档被旧版读坏。
- **颈部热路径收敛（profile 第二轮，2026-08-16）**：① history.record 容量裁剪改批量（原每超限 splice 整表 = 事件持续流入时每 tick 复制 5000 条；改超限裁到 cap×3/4 留缓冲，cap 语义变软上限）；② findNearest 环剪枝（`r² > bestDist` 断环，命中后不再扫外圈）；③ World.nearestBuildingWithTag 专用查询（决策谓词免数组分配 + tag 过滤 + keyToXY 内联解码）；④ walk 拥挤/占位检查 = 取整格聚合表（帧初 O(n) 构建，帧内增量更新维持顺序可见性）。总 step 耗时 -42%（3465→1995ms，40 人 1500 tick）。
---

## 战场指挥体系（field-command 玩法包，2026-08-16）

**需求**：训练编排战术动作 → 控制指挥官 → 小队作战 → 多层指挥（军团长→队长→兵）→ 大兵团作战。

**层次**：本包是"指挥官层"，建立在征召包（drafting）之上（requires ['drafting']）——战术命令的执行体 = 征召小人（K_DRAFTED 门），集火/冲锋的接敌拖动 = 指定攻击（K_ATTACK）通道。零新引擎挂钩；战术不动伤害数值（raidSystem 不碰），只动移动与接敌选择。

**数据**（PawnState.extra，随档透传，契约登记 K_COMMANDER/K_TACTICS）：
- `extra[K_COMMANDER] = { role: 'officer'|'general', subordinates: number[] }`——指挥官身份与编制树；role 自动推导（辖下有队长 = general），玩家只描述"谁归谁管"。
- `extra[K_TACTICS] = { learned, active, underOrder: {tactic, from, target?} }`——训练掌握/编排位/临战下达；生效战术 = underOrder ?? active（指挥官指令 > 玩家预设）。

**命令面**：commander（册封/编队/解编）、train（学习 + 冷却）、dispatch（级联整树下发 / 'none' 收兵；focus 须带 hostileIndex）。均登记 COMMAND_CONTRACTS + cmdValidate 形状校验。

**执行序**：'field-command' 注册在 drafting 之后（raid 组注册序），drafting 追击对 hold/retreat/regroup 跳过（战术优先级 > 自动索敌），charge/focus 交给 drafting 追击拖动——"先到者驱动后到者清"的帧序一致性。

**死亡语义**：killPawn 同步删除 pawnStates（extra 编制表随之消失）→ 死后无树可读；FieldCommandSystem 每帧维护指挥官树快照（仅瞬态缓存），死亡检测以快照为准级联解除整树。玩家解除征召 = 战术失效（玩家优先，不拉回）；被动衰减不豁免。

**协议**：Snapshot/Delta 增 `pawns.commander`（对象）与 `pawns.tactic`（生效战术 id 字符串），diff 用 JSON 比较（低频字段），server 从 extra 序列化；PROTOCOL_CONTRACTS 登记值语义。

## 播放控制命令面与心跳保活（2026-08-16 审计 H1/M1）

**播放控制 = 引擎内建命令面**（H1）：pause/speed 与 move 同层（issueCommand 硬编码分支，不随玩法包装卸）。唯一写入口 = `issueCommand({type:'pause', args:{paused}})` / `{type:'speed', args:{speed}}`——本地/远程/服务器同一条通道。**动机**：此前 main.ts/hud.ts 直改 sim.paused/speed 字段，远程模式下改的是本地壳（服务器权威不知情 → HUD 谎报暂停、时钟漂移）。命令契约登记（COMMAND_CONTRACTS）+ cmdValidate 形状校验（非法值服务器拒收）；客户端显式传目标态（读权威值取反，命令侧不翻转）；HUD 高亮每帧读权威字段。

**心跳 = 显式 PingMsg**（M1）：服务器每 2s 广播 `{type:'ping', t}`（即使模拟暂停也发）；客户端任何消息都刷新看门狗心跳戳（此前只在连接时更新——静默期"有消息也断线"）。超时窗 15s（原 5s 与服务器全量对账间隔等长 = 零抖动余量，网络一抖即误断重连）。PingMsg 不进快照/增量管线，仅 t 锚定顺带刷新（暂停时 t 不变，无损）。

**增量合入原则**（M2）：客户端权威快照 this.snap 只接受"全量形状"的局部合入——delta 是增量形状（pawns 逐条目部分字段、建筑无 x/y），整对象 spread 会把它变成半残快照（其余 pawn 蒸发、字段缺失误读）。合入规则：pawn 逐 eid 字段合并（与 pawnCache 同源）、removed 过滤、pawnList 权威重排、建筑 key 解码补 x/y、顶层字段单点赋值；全量对账（applySnapshot）始终是最终收敛点。

## 低项一致性收口（2026-08-16 审计 L1-L8）

- **可选鉴权（L1）**：`SERVER_TOKEN` 环境变量 → 连接层校验 `req.url` 的 ?token=（纯函数 `wsTokenOk` 可单测）；未设 = 开放（dev 默认）。query token 是弱鉴权（挡随口连接），公网部署应前置 TLS + 更强认证（注释留档）。
- **敌人生成单入口（L6）**：`src/sim/systems/hostiles.ts pushHostile(ctx, enemy, x, y, {targetX,targetY,hpMul})`——整体 spread EnemyDef（新字段自动透传）+ 命中字段换算覆盖；raid（含压力 hpMul）/wildmouse/hg 三处收口。EnemyDef 增字段只改这一处。
- **技能成长数据化（L5）**：COC 规则数值进 `tuning.combat.skillGrowth`（base/cap/gainMin/gainMax，mod 可覆盖），`growSkill` 与 `skillOf` 默认值同源读 base。
- **执行序锚点语义钉死（L7）**：before 锚点只对 SYSTEM_DEFS 表外第三方系统生效（sim.registerSystems 兜底循环）；表内系统 8 处冗余 `before:'raid'` 清理——执行序注释从"靠锚点"修正为"类别序 × 组内注册序推导"。

## 驯兽守卫体系（beast-taming 玩法包，2026-08-16）

**需求**：用户「继续开发」，自主设计战斗主线延续战场指挥——把重伤的捕食者猫驯化成营地守卫（"以鼠之矛守鼠之城"）。

**机制**：tame 命令（hostileIndex 定位，同 attack/focus 模式）→ 重伤过滤（hp/maxHp ≤ 0.25）→ 臣服态（taming 标记，raidSystem 跳过：移动/结算均 continue，趴伏假死免疫）→ 投喂推进（消耗 food，缺粮停滞，tamer 死亡中止）→ 转正（faction='player' + owner=tamer）→ 守卫行为（本系统驱动：扑咬敌对 cat / 跟随驯养人）→ release 复原（清除 taming/owner 与 faction）。

**恶意状态处理**：HUD 读 targetHostileIdx（右键敌人设）从 sim.hostiles 取实时 taming 对象。系统为表外第三方，before:'raid' 锚点插在 raid 前（结算先于袭击战斗）。契约登记 tame/release 2 条（COMMAND_CONTRACTS）。

**Hostile 扩展**：新增 `taming?`（驯化中）、`owner?`（守卫驯养人 eid）两可选字段——hostiles 经 diff 整体覆盖/taming 自动透传。SimViewHostile 同扩展。

---

## 数据驱动/数值演进记录（原 DATA_DRIVEN 追加段）

## 采集狩猎玩法包数值（2026-08-14 试玩调优）

- hg `overrideTuning`：`san.nightDrain 0.02`（游牧夜宿，约 1.2 点/夜）、`san.crazyFleeAfter 15`（崩溃 15s 后本能逃火，白天 60s 窗口内回火恢复）、`san.fireComfortRadius 9`、`needs.sanTraumaDrain 0.01`（断食创伤减半）。
- hg 卸载：`farm/craft/techPool/autobuild/repair/raid/medicine`（medicine 的 bleed 伤口 san 流失与崩溃死锁冲突，见 PROGRESS 2026-08-14 行）。
- 狩猎参数：hunt 卡 weight 7 + `huntIsDay`（白天谓词）+ `huntNearby`（索敌 40 格）；追猫超时 45s；猫环带 15-40 格静止猎物；击杀 food×4 私有化。
- 夜归卡：`camp` weight 80 + `nightAway` 谓词（isNight 且离最近 campfire >3 格）；`CardView.campfireDist` 为通用谓词钩子（-1=全图无火）。

## medicine 玩法包数值（2026-08-14 封顶修复）

- 伤口封顶：`maxBruise 3 / maxBleed 3 / maxInfection 1`（同类型超上限不再新增；感染转化也封顶）。
- 封顶后最大 SAN 流失 = 3 条 bleed × 0.6/s = 1.8/s < 篝火恢复 2.5/s → 崩溃者在火旁必定恢复（不再 SAN 恒 0 锁死）。
- 治疗：treat 卡 weight 5、每 4s 检定 DC 50（craft 技能百分制 bonus）、一次移除 1 条（感染优先）。

## medicine 玩法包数值（2026-08-14 RimWorld 式重构）

- 伤口实体：`{kind, part, severity(0-1), bleeding, infection(0-1)}`，存 `st.extra.wounds`（JSON-safe，旧字符串档自动迁移）。
- 部位命中权重：`limb 0.6 / torso 0.3 / head 0.1`；部位修正失血 `head×2 / torso×1.5 / limb×1`、疼痛 `head×1.5 / torso×1.2 / limb×0.7`。
- 自然愈合：`cut 60s / bruise 90s / burn 120s`（severity 满 1 痊愈移除；感染中不愈合）。
- 出血：cut 新伤 `bleedHp 0.5/s`（×部位）+ `bleedSan 0.4/s`；`autoClotAt 0.5` 愈合过半自然凝血。
- 感染：60s 检定 `infectChance 0.02`/伤口（head ×2），触发起 `infection = 0.3`；赛跑增速 `head 0.02 / torso 0.01 / limb 0.005`（burn ×2），到 1 坏疽；惩罚 `hp 0.15/s + mood 0.5/s + san 0.1/s`。
- 治疗：4s 检定 DC 50（craft bonus）、triage（感染 > 出血 > 新伤）；成功 `止血 + infection-0.5 + severity+0.3`。
- 封顶：`maxCut 4 / maxBruise 3 / maxBurn 2`（瞬间爆发兜底；愈合使数量自然收敛）。

## tunnel 地道（2026-08-14）

- def：`{ size 1×1, hp 150, passable true, buildTime 4, costWood 4, onTunnel true, tags ['tunnel'] }`——无科技，普通指令可建。
- `onTunnel` 建造特判（world.canBuildFootprint）：footprint 全为 water/mountain/可建地形（树格不可，先伐木），格上无建筑。
- 通行：`isPassable` 对 `tags.includes('tunnel')` 建筑特判恒 true（覆盖地形不可通行）；寻路代价 = 地形 moveCost（默认 1，速度无加成）。
- 限制：地道格不可建任何其他建筑（窄道，大宗物品限制的落地）。

## 地形 z 值 + 通过能力（2026-08-14 维度化重设计）

- 地形 z（高度）：`grass/dirt/sand/desert 0、water 0、stone/ore/tree 1、mountain 2、bridge 1、cave 0`。
- 高差判定：`isPassable(x, y, fromZ?, climb?)`——`|Δz| > climb → 不通`；`fromZ` 缺省 = 不判高差（旧调用面不变）。寻路邻居判定带当前格 z 与单位 climb。
- 单位通过能力：`PawnTuning.climb = 1`（鼠人，PawnState.climb 存档随档）；`enemyDef.climb`（cat 2 / raider 1）——数据驱动，mod 可 overrideTuning/registerEnemy 差异化。
- 道路豁免：目标格是 road 建筑 → 跳过高差判定（坡道垫平，任何 climb 可上下）。

## tunnel 地道入口（2026-08-14 维度化重设计，旧"穿水/穿山通道"数值作废）

- 建造：`onTunnel` 特判——入口只可在**可通行地表格**挖（grass/dirt/sand/desert/stone/cave/ore），水上/树上/山上拒（人得先走到洞口）；格上无建筑。
- 通行：入口格 isPassable true；**入口之间虚拟边**（pathfinding：pop 到入口格时向所有其他入口展开，成本 = 欧氏距离 = 速度无加成；无视地表地形/高差/建筑）。
- 渲染：客户端跳过 tunnel 建筑（不出现在地形上）。
- def：`{ size 1×1, hp 150, passable true, buildTime 4, costWood 4, onTunnel true, tags ['tunnel'] }`。

## road 道路（2026-08-14）

- def：`{ size 1×1, hp 60, passable true, buildTime 2, costWood 2, tags ['road'] }`——普通建造（buildable 地形），正常渲染。
- 高差豁免：目标格是 road → isPassable 跳过高差判定（修路 = 陡坡垫平）。

## 高差地图生成（2026-08-14）

- `stone z 1→2`（石丘）：山地边缘带（elevation 0.5-0.62）→ `detail>0.35 ? ore : stone`（石丘+矿）；丘陵带（0.28-0.5）`detail>0.6 → stone`（缓坡 z1 过渡带）。
- 出生点连通：ensureSpawnConnectivity BFS 用 climb1 + z 判定（石丘围困 → 边界水/树/石丘破口为草地）；多 seed 出生可达 58-72%。
- 寻路性能（石丘地图实测 >70s → 4.6s）：失败路径入缓存（getPath+航点段）、onTileChange→clearTrailCache（地形变更失效）、nearestPassable/moveAdjacent 目标 z 感知、trailCache 上限 8192。

## 无限地图：双图层 chunk（2026-08-14，DESIGN §205-214/§355-385）

- **chunk = 64×64 tile**（`CHUNK_SIZE`）；出生区 = 3×3 chunk（`WORLD_CHUNKS`，192×192 不变）。
- **生成层**：`seededRng(chunkX, chunkY)` 确定性——noise 坐标化纯函数 `tileAt(x, y, seed)`（elevation/moisture/detail/sparse 四种子由 `deriveBiomeSeeds` 派生），懒生成（`ensureChunk` 缓存 `Uint8Array`，不落盘）；稀疏化从顺序 rng 流改坐标 hash（`hash(x,y,sparse) < 0.25`）。
- **覆盖层**：`overlay: Map<chunkKey, Map<offset, tileIndex>>`（与生成层一致的格不存；setTile 改回生成层默认 → 删覆盖记录）。
- **坐标/键编码**：chunkKey `(cx+32768) + (cy+32768)*65536`（负坐标）；建筑 key `x + y*2^31`（`COORD_K`，|x|<2^31 无碰撞；`World.keyToXY` 负坐标安全：先 % 取 x 再整除，Math.floor 对负 key 有浮点误差）。**一切 key 解码必须走 `World.keyToXY`**（2026-08-14 曾漏改 17 处 `k % width` 旧解码 → 桥不修/篝火不迁/伤口不疗）。
- **序列化**：`serializeChunks()` = 覆盖层 diff（存档/增量）；`serializeTerrainChunks()` = 已生成 chunk 完整地形（初始快照/客户端，客户端无生成层算法）；`SaveData.tiles: string[]（旧档全量）| ChunkData[]（新档）`；旧档 `loadTiles` 写入覆盖层、`loadBuildings` 旧 key（y*width+x）经 `legacyKeyDecode` 迁移。
- **出生区连通**：ensureSpawnConnectivity BFS **出界即停**（inBounds 恒 true，出界 = 视为已连通外部；否则 BFS 顺着可达大陆无限外扩生成海量 chunk，构造 >30s）。
- **寻路**：A* pop 时跳过 closed/更优 cost 的过期节点（碎片地图堆膨胀曾致 60000 迭代仍空路径）；无篝火默认上限 15000 / 有篝火 40000 / 显式 maxIter 尊重钳制。
- **协议**：`tileGrid: ChunkData[]`；RemoteWorld 未知区 `getTile → 'mountain'`、未下发 chunk 的 setTile 忽略（server 权威）。
- **客户端渲染**：地表/地形图标按 chunk 缓存 Graphics，相机移动增量挂载/卸载（视口 + 1 chunk 余量），树精灵随 chunk 容器进 entityLayer 2.5D 排序。

## 香料丛与加料烹饪（2026-08-14）

- 新地形 `spiceBush`（香料丛）：`{ growable: true, harvest: { product: 'spice', time: 1.5, yieldSuccess: 2, yieldFail: 1, dc: 50 } }`——与树同走采集管线（workChop 谓词 `growable && harvest` 数据驱动命中），但 `passable: true`（灌木不挡路，出生圈连通/破口逻辑无需特判）；采完变 grass（growable 缺省替换）。
- 生成规则（noise.ts）：草地（grass）上 `hash(x,y,spiceSeed) < 0.005` 长香料丛；spice 种子为独立派生轴（deriveBiomeSeeds.spice），改密度不影响地形其它属性。
- 加料配方 `cook_spiced`（cooking 包）：`{ kind: 'batch', input: [food×4, wood×1, spice×1], output: { food, 7 }, interval: 4 }`；建筑经 `def.meta.cookSpiced` 引用（cook 建筑自动尝试加料，缺 spice 回落基础配方）。
- `overrideDef` 深合并（2026-08-14 起）：嵌套字段（如 `meta`）按 key 合并保留，数组/标量仍整体替换——thermo 的 `meta.heat` 与 cooking 的 `meta.cookSpiced` 可共存。
## 制衣玩法包数值（2026-08-15 clothing，用户需求：材质 + 染料 + 设计=科技抽卡）

- 装配：clothing 包默认挂载；系统 'clothing' 位于 BASE_SYSTEM_ORDER 产出组末尾（cook 后、raid 前，25 系统）。
- 材质两路（稀缺度/风险差异）：皮路线（pelt 猫击杀掉落 ×2 → leather 鞣革 ×1 → peltShirt 皮衣 ×1；leather ×2 → leatherCoat 皮大衣 ×1）；麻路线（flaxBush 亚麻丛野外采 → linen 织布 ×2 → linenShirt 亚麻衫 ×1）。
- 保暖值（ItemDef.meta.warmth，thermo 包跨包契约读取）：peltShirt +3、leatherCoat +6、linenShirt -1（散热，夏穿凉爽）；素衣/染色衣 warmth 同款，染色仅悦目心情差。
- 染料：redBush/blueBush/yellowBush 野外浆果丛（各 0.25% 密度 < 香料 0.5%——衣服是后期玩法，原料刻意稀缺）→ redDye/blueDye/yellowDye；染色配方程序生成 9 个（`dye_<色>_<基衣>`：基衣×1 + 染料×1 → 染色衣×1，interval 4）。
- 设计 = 科技（碎片制抽卡，fragments 3）：craft:clothing（unlocks ['loom'] 裁缝台）/ craft:linen（织布+麻衫）/ craft:coat（皮大衣）/ craft:dye（染色）。配方科技门控为**包内表**（TECH_OF，dye_* 前缀 → craft:dye），不走内核 RecipeDef——款式 = 设计 = 科技抽卡解锁。
- 裁缝台 loom（tech:'craft:clothing'，costWood 15，buildTime 5，1×1，tags ['craft','cloth']）：`meta.tailor` = 本台可产配方 id 列表（数据驱动）；TailorSystem 独立系统（不依赖 craft 包——hg 游牧局卸载 craft 后仍可缝皮衣，但无 techPool 抽卡 → 科技永不解锁 → 裁缝台建不了，整套自然休眠；猫 loot 被 hg override 成 food 后皮来源也断）。
- 穿戴：命令协议 'wear'（itemId 缺省 = 脱衣）；状态存 `PawnState.extra.worn = { body?: 物品id }`（存档扩展点，自动随档）；换装旧衣回库存；心情 +3（染色 +5）。
- 跨包契约：thermo 有效温度 += `ItemDef.meta.warmth`（读 `extra.worn.body`）；协议 pawns.worn = `extra.worn.body`（server 填充，客户端染色 tint）；items.w = `meta.wearable === true`（HUD 穿衣按钮过滤）。
- 生成规则（noise.ts）：flax/red/blue/yellow 四个独立种子轴；草地 hash(x,y,seed) < 0.004/0.0025 点缀（spice 先例）；地形 def 由包 registerTile 注册（tileAt 只产 id 字符串）。

### 生成层点缀数据化（2026-08-15 追加：纯插件收敛，替代上文 spice/flax 的 noise.ts 写死分支）

- 玩法地形不再进 noise.ts——`TileDef.sparse: { density, on? }` 声明：本地形以 `density` 概率点缀在 `on` 地形上（缺省 `'grass'`）。
- World 构造时 `buildSparsePatches(seed, tiles)` 收集：轴种子 = 按 defs 收集序从主 seed 独立 rng 派生（每个条目一个种子，改任一密度不影响其它点缀的坐标 hash）；种子在构造时固定，chunk 懒生成 `tileAt(x,y,seeds,patches)` 查表仍确定性。
- 现状：spiceBush（内核 defs 表，0.005）、flaxBush/redBush/blueBush/yellowBush（clothing 包 registerTile，0.004/0.0025×3）。改密度/加点缀 = 数据行，零内核代码。

## 11. 系统执行序：类别序 × 组内注册序推导（2026-08-15 追加：一致性重构，替代 10.1.6 全量数组）

- **唯一人工数据 = 类别语义序** `CATEGORY_ORDER`（defs/systems.ts，7 类）：`needs→ai→society→production→raid→world→boot`（boot 引导类恒表尾——出生刷人晚于全体系统装配/init）。
- **组内序 = 注册序（apply 序）推导**：requires 拓扑自动拉齐（包清单不承担图约束），同层稳定初始序 = playstyle 清单序。新增玩法包 = **只改 playstyle 清单一处**（系统 def 带 category 即自动归组）。
- **表内 id 归类别，表外 id 走锚点**：`SYSTEM_DEFS`（Record，含内核系统 behavior 内联 ctor）登记的系统按类别推导；清单外第三方包保留旧语义——`before` 锚点插位，无锚点追加表尾。
- **一致性**：内核系统（SYSTEM_DEFS 内联 ctor）与插件系统（包回填）走同一装配规则（类别推导/卸载过滤/锚点兜底），区别只有 ctor 来源；各包 registerSystemDef 的 category 必须与 SYSTEM_DEFS 表一致（脏数据会被推导暴露——2026-08-15 修复 8 处历史遗留）。
- 默认装配 25 系统执行序 = 推导结果快照（assembly.test EXPECTED_ORDER 显式断言，防推导规则回归）。

## 12. 跨包契约登记表（2026-08-15 追加：contracts.ts，字符串契约不拼错/不静默失效）

- **跨包/跨层字符串键唯一权威表**：`item.meta.warmth`（clothing 写/thermo 读，数字）、`item.meta.wearable`（clothing 写/协议 w 透传）、`pawn.extra.worn`（clothing 写/thermo+服务端+渲染读，{ body? }）。
- **key 常量**（K_WARMTH/K_WEARABLE/K_WORN）：写方/读方/客户端/服务端一律引用常量，拼错 = 编译期错误；登记表 + `validateContracts`（存在性谓词）由 playstyleManager apply 末尾严格校验——写方在场却漏写/写错 = 装配期抛错；卸载写方 = 谓词空真（不误伤卸载纪律）。
- **单包自洽键不入表**（meta.dye/tailor/heat/cookSpiced 等写读同包）；building meta 深合并共存（overrideDef 深合并）与本表正交。
- **色值 = 表现层数据**：clothing 包只持染料 id（red/blue/yellow）+ 中文色名（物品名/配方名），渲染 tint 色值唯一权威在 renderer 本地 `DYE_COLORS` 表——服务端不持有色值，杜绝两端色值来源不一致（旧 CLOTH_COLORS 曾由 renderer import 包导出 = 客户端反向依赖，已消除）。
- **K_DYE 常量**（2026-08-15 审计追加）：`item.meta.dye` 本是单包自洽键（不入表），但 CONTRACTS 的 check 谓词用它做"衣物族"检测——谓词引裸串时键改名会静默失效，故定常量（check 与 clothing 写/读侧共用）。
- **协议值语义登记**（2026-08-15 审计追加）：`protocol.pawns.worn` 的值 = 穿着衣物 itemId，**染色款 id 带 `{dye}_{base}` 前缀**（renderer 用 split('_')[0] 解析染料 tint、server 原样透传）——字段级契约之外的"值格式"约定同样入表登记，改 id 格式会静默破坏染色渲染。
- **命令契约**（COMMAND_CONTRACTS）与**协议契约**（PROTOCOL_CONTRACTS）与 CONTRACTS 三类统一由 `validateContracts` 校验；命令处理器随包 apply 注册不随系统卸载（wear = 纯数据操作面，卸载 clothing 后契约空真）。

## 13. 数值位置：两种模式（2026-08-15 审计裁决）

全库数值来源有两种**明确位置**，以包的新旧为界（历史继承，非错误）：

| 模式 | 位置 | 适用 | 可调性 |
|---|---|---|---|
| **tuning 段** | `defs/tuning.ts` 分段（gather/craft/repair/raid/needs/san/desire/social/population/tech/combat/autobuild/economy/faction/card…） | 从内核迁出的老系统（迁出时保留 tuning 读点） | `overrideTuning()` mod 可覆盖 |
| **包内 CFG** | 玩法包文件头 `const CFG`（clothing/medicine/power/prison/thermo/trade，注释头「玩法包自治」） | 新玩法包的私有平衡表 | 无 override 口（随包装卸 = 天然隔离；要调直接改包） |

- 裁决：**新玩法包数值一律走包内 CFG**，不塞进内核 tuning（"不往内核 tuning 塞玩法参数"纪律，medicine.ts 注释明示）；包内 CFG 就是该包的 tuning 表——位置 = 包的私有数据，随包装卸、不污染全局。
- 例外（包内数据但**数据化**）：注册数据（defs 表条目/配方/科技/事件权重）必须走 register* 通道（clothing 的衣物 defs、power 的 forge 配方、trade 的 DEALS 定价表、wildmouse 的事件参数）——这些是"表"不是"数值常数"，mod 可 overrideDef 调整。
- 属性位置总纲（2026-08-15 全库审阅后）：**静态数值 → tuning 段或包内 CFG；注册数据 → register* 通道的 defs 表；跨包/跨层键 → contracts.ts 常量 + 登记表；单包自洽键 → 包内裸串（meta 容器）；表现层（色值）→ renderer 本地表；运行时状态 → PawnState/World/BuildingData 实例字段；存档扩展 → extra（JSON-safe）。**

## 14. 存档字段三层边界（2026-08-15 审计第二轮：全 sim 数据面审阅）

| 层 | 随档 | 内容 | 说明 |
|---|---|---|---|
| **顶层长期态** | ✅ save/load 显式字段 | dna/slots/needs/health/faith/skills/desires/inventory/oracleBuff/assignedJob/fireId/knownFires/techs/techFragments/stockpile/buildings/tiles | 引擎与玩法共享的持久状态，白名单显式声明 |
| **extra 扩展点** | ✅ 原样 JSON 还原 | pawns.extra（worn/wounds/hurtAcc/captive 等）、buildings.extra（charge） | 玩法包状态自动随档，零内核改动（SaveData.pawns[].extra/building.extra） |
| **瞬时工作态** | ❌ 不随档（设计） | path/pathIndex/mineTarget/chopXY/praying/healing/caveWork/mining/各种冷却（commandCooldown/crazyCooldown/huntScanCd/pathCd…）/job/lastDecision/urgent | 读档后小人回到闲置态重新决策——工作目标/路径/进度丢失为**有意轻量存档**（模拟读档回退可接受）；长期目标（assignedJob/oracleBuff/fireId）在顶层随档 |

- **PawnState.climb 差距登记**：注释声称"单位各自能力，mod 可 overrideTuning"，但实现 = spawn 时取 `tuning.pawn.climb` 后**从不修改**（存档不还原也无差别——值恒等于 tuning）。当前全小人 climb 相同、行为正确；若未来做个体差异（如天赋加攀爬），需在 SaveData 增加字段。enemyDef.climb 有差异化（猫 2 > 鼠人 1）不受影响。
- **审计结论**：tuning 全表 379 键**零死参数**（spawnCounts 为 Record 动态键，Object.entries 遍历消费）；客户端（hud/renderer/remote）契约常量全覆盖无裸串；remote 重建 mods.items 只透传协议 w（wearable 标记）——warmth 等 sim 内部数值不下发，渲染/穿衣无需（渲染 tint 从 worn id 的 `{dye}_` 前缀解析，不依赖物品数据）。

## 15. RW-1 直接指挥玩法包（work-priority + drafting，2026-08-15 追加）

两个新玩法包全部默认挂载（playstyle 清单 23→25 包）。按 §13 裁决：**新玩法包数值一律包内 CFG**，不塞内核 tuning。

### 15.1 work-priority 包（工作优先级 = 权重调制数据）

| 数据 | 位置 | 语义 |
| --- | --- | --- |
| 优先级档位乘法表 | 包内 CFG.weightMuls = `{0:0, 1:6, 2:3, 3:1.5, 4:0.7}` | 抽卡权重乘子：0 = 清零禁止、1 最高、4 最低（0.7 → 仍会偶发抽到，非绝对禁止——紧急/无其他卡时不至于卡死） |
| 允许值集 | 常量 `WORK_PRIORITY_ALLOWED = [0,1,2,3,4]`（导出供 cmdValidate/测试共用） | 缺省（未设置）= 自主，不算 0~4 档 |
| 运行时状态 | `PawnState.extra.workPriorities = Record<jobId, 0\|1\|2\|3\|4>`（键 = 职业 id，见 JOB_CARD） | 契约键 K_WORK_PRIORITIES；缺键 = 未设置 = 自主；显式 0 = 禁止 |

- **调制规则**：`ruleWorkPriority`（id 'workPriority'，`before:'job'`）——卡的职业 ∈ 已设置优先级？否 → 不调制；是 → 取该卡涉及多个已设职业的**最优（最小数字）档**乘子。紧急需求分支在 decide 之前，优先级不压 urgent（测试锁定）。
- **旧档兼容**：`migrateFromAssignedJob`（load 时幂等跑：有 assignedJob + 无 workPriorities → 主职 1 其余 0）；`applyAssignedJobShortcut`（assign 命令时**强制**主职 1 其余 0，取消指派 = 清空 workPriorities 回自动——与迁移区分：迁移不覆盖已有微调，命令语义 = 快捷设定）。
- **注册幂等**：权重规则表是模块级全局（跨 Sim 实例共享），包 check-then-register（`weightRulesOf().some(id==='workPriority')` 再 registerWeightRule，防多实例重复注册抛错）。

### 15.2 drafting 包（征召/攻击 = 指挥状态数据）

| 数据 | 位置 | 语义 |
| --- | --- | --- |
| autoEngageRadius / repathInterval / stopDist / targetLostRadius | 包内 CFG（14 格 / 0.4s / 0.8 格 / 8 格） | 无指定时自动接敌半径；追击重寻路节流（防每帧 A* 风暴）；贴近停止距离（raid meleeRange 内即可互殴）；目标下标错位后的位置找回半径 |
| 征召状态 | `PawnState.extra.drafted = boolean` | 契约键 K_DRAFTED；true = 不自主（behavior 决策门，见 DESIGN §21） |
| 攻击目标 | `PawnState.extra.attackTarget = { hostileIndex, x, y }` | 契约键 K_ATTACK；hostileIndex = 敌人数组下标（= 协议 hostiles.i，客户端右键即快照下标）；x/y = 指定时位置快照（每 tick 刷新/找回用） |

- **决策门**：behavior 每 tick `if (extra[K_DRAFTED] === true) { job='待命'; path 照走; continue; }`——门在理智分支前（完全听指挥）；被动衰减（needs/san 系统）不被门豁免（征召只挡自主行动，不挡世界消耗）。
- **战斗接敌**：raidSystem `attackDesignatorOf(i)`——有征召小人指定了 i 且在其 meleeRange 内 → 该小人优先接敌（覆盖"最近者"）；无指定者才回落最近扫描。**伤害/闪避/掉落公式零复制**（数字唯一权威在 raidSystem）。
- **命令契约**：`draft {args.drafted: boolean}`（batch 走 selected；征召清工作态+路径、解除清攻击指定）+ `attack {args.hostileIndex: number}`（只作用于已征召小人；cmdValidate 校验 pawnId 存在 + hostileIndex ∈ [0, hostiles.length)）。
- **协议字段**：`pawns.drafted?: boolean`（snapshot + delta，标量 diff，缺省 undefined = 未征召；server 从 extra 归一 `=== true || undefined`）。attackTarget 不下发（服务端内部结算数据，客户端无需）。
- **契约登记**（contracts.ts 三类表追加）：`pawn.extra.drafted` / `pawn.extra.attackTarget`（check = drafting 包在场 → draft/attack 命令处理器必须已注册）、COMMAND `draft [drafted]` / `attack [hostileIndex]`、PROTOCOL `pawns.drafted`。

### 15.3 神谕卡式工作引导包（oracle-guidance，2026-08-15 追加）

**§15.1（work-priority 包）已撤回**（用户裁决：逐小人数字优先级 = 直接管理意图进选择链）；本节为修订 M1 的数据面。默认挂载（playstyle 清单 25 包不变——worker 包数 24→23、oracle-guidance 加入）。

| 数据 | 位置 | 语义 |
| --- | --- | --- |
| 降旨冷却 / 目标时长 | 包内 CFG `{ cooldownSeconds: 45, defaultDuration: 120 }`（HUD 展示镜像 ORACLE_CFG cooldownSeconds，权威在包命令处理器） | 防止面板变遥控器；目标时长与随机神谕一致（同槽 sim.oracleGoal 不跳变） |
| 冷却存储 | `WeakMap<SimContext, number>`（模块级闭包，键 = ctx 对象身份，GC 安全） | **瞬态不随档**（与 commandCooldown 同设计，§14 三层边界"瞬时工作态"）。为什么不用模块级 Map：跨 Sim 实例串扰 |
| 新增策略卡 | 伐木令 `oracle:chop`（workType 'chop'，weight 8）/ 采矿令 `oracle:mine`（workType 'mine'，weight 7） | 条件 `stockLow` 阈值读 tuning 路径 `population.foodThreshold`（数据驱动铁律：mod 可覆盖）；意义 = 2026-08-13「伐木令退位为可选神谕目标」定案落库，随机神谕同样采样（引导非经济平衡，经济调节归 economy 包账本） |
| 插卡 id 前缀 | 习惯卡 id = `strategy:${cardId}`（HUD 以 `strategy:` 前缀识别"身上策略卡"） | printCard 插入后仍走抽 3 选 1 卡池（非保证执行）；选中小人才插（无选中 = 仅降目标） |
| 蓝图副作用 | 策略卡 `blueprint` 声明 → build 命令入队（nearCamp 营地旁环扫 / far 远环扫，半径回退，与 dummyLlm 同构；**LLM 层冻结禁改 §8，包内自带落点扫描**） | 队列去重（buildQueue 已有同 defId → 跳过）= "只入队一次"；建成后形成闭环始终是引擎既有建造语义 |

- **契约登记**：**零新增** pawn.extra 键、零协议字段（strategy 命令走 COMMAND_CONTRACTS 新增登记：`strategy [cardId]`，发令方 hud/客户端 → 处理器 oracle-guidance，check = 包在场 → 处理器必须已注册；cmdValidate 走通用通道——pawnId 存在性即可，cardId 合法性由包处理器把关，与 wear 同模式）。
- **SimContext.printCard**（唯一内核扩展）：Sim 早已实现的 LLM 印卡通道上接口（策略卡/习惯卡插入槽位）；为什么进接口：纯插件无法不经接口触碰小人槽位（槽位是引擎数据）。

## 敌人表捕食者语义（2026-08-16）

`EnemyDef` 新增可选字段（机会捕食者玩法由 `predator` 标记启用,普通敌人不受影响）：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `predator` | `boolean` | 捕食者：袭击波固定 1 只（压力只放大 hp 强度）、目标 = 最近鼠实时位置、接触 ≤ `tuning.combat.captureRange`(1.5) 复用 DEX 闪避判定 → 未闪开即叼走（`pawn_died cause='captured'` + `Hostile.carried` 携带态）、逃跑方向 = 远离营地中心、跑离 ≥ `captureFleeDist`(32) 得手消失。不拆家、不原地磨血。 |
| `carrySpeedMul` | `number` | 叼走后的逃跑移速倍率（缺省 1.5）。 |
| `dash` | `{ range: number; cd: number } \| undefined` | 冲刺技能（2026-08-16）：捕食者周期性向目标方向瞬移 `range` 格，`cd` 秒冷却——越过近身反击圈突围；运行时 `hostile.dashCd` 递减。 |

- 移动/捕获/得手数值在 `tuning.combat`（captureRange/captureFleeDist）,逃跑速度倍率在敌人表（同一敌人数据驱动,mod 可 overrideDef/registerEnemy 自定义捕食者）。
- 捕猎期近身反击沿用 `meleeRange`(3) + `pawnDmg`(5)（近身反击拦截语义,非捕食者攻击不做特殊加成）;得手途中被击杀 = 共用 killHostile 掉落路径（food 私有进击杀者口袋）。
- `cat` 现为捕食者样例（hp110/speed8/dmg6/climb2,predator:true,carrySpeedMul:1.5,loot food 3）;`raider` 保持非捕食者（faction 'unit' 群体袭击语义不变）。

## 世界层升级/摧毁钩子（2026-08-16 审查修复）

| 新增 | 位置 | 语义 |
| --- | --- | --- |
| `World.canUpgradeAt(x, y, def)` | world.ts | 升级落点校验：新 footprint 超出旧 footprint 的格子必须可建且不被其他建筑占用（旧格豁免）。`upgradeBuilding` 前置调用 + `buildSystem` 升级分支放弃蓝图不扣资源（原:升级无条件覆盖 gridToBuilding → 相邻建筑格子归属被顶掉）。数据面 = 复用 BuildingDef.size 推导 footprint,零新字段。 |
| `World.onBuildingDestroyed(key)` 回调 | world.ts | 建筑摧毁（damageBuilding hp≤0 分支）触发;sim 挂 clearTrailCache（原:缓存只在建成/地形变更清,被拆锚点段仍被寻路复用）。 |

## DLC 跨文件依赖与契约补验（2026-08-16 审查修复）

| 数据 | 位置 | 语义 |
| --- | --- | --- |
| `manifest.requires.mods: string[]` | mods/loader.ts ModManifest | 声明本包依赖的其他 mod id（parse 校验 id 合法性）。挂载器（server/modManager.ts）按依赖**拓扑喂序**挂载——与 in-code ModPack 的 requires/topoSort DAG 对齐;缺失依赖 = 显式报错跳过该包（不半挂载:defs 引用悬空的包比不加载更危险）。0.1.0 现有 10 个 mods/*.mod.json 均无此字段 = 不受影响。 |
| 契约补验时机 | server/index.ts | loadModsFromDir 之后补跑 `validateContracts`（原:唯一校验在 ModRegistry.default() 内部、先于 DLC 挂载 → DLC 注册的 def/命令从不进契约表;违例 fail-stop 与 mod 加载失败同策略）。 |

## 存档新增 `techUnlockedAt`（2026-08-16 审查修复）

`SaveData.techUnlockedAt: Record<string, number>`（解锁时刻随档）——原:不随档 → `techBuildWeight` 读档恒 0,科技建筑自动建造权重永不爬升。旧档兼容:无此字段 → 已解锁科技按读档时刻起算（权重从 0 重新爬升,不永久冻结）。其余存档字段不变。

## 历史装配态快照（2026-08-16 早前）

- 451/49、26 系统、25 包；详细演进见 AGENTS.md / PROGRESS.md。

## 战术表与战场指挥数据面（field-command 包，2026-08-16）

- **战术动作表 = 数据登记**：`TACTICS`（field-command 包导出）= id → { label, desc, move 分类, engageRadius } 的查表——命令面（train/dispatch 白名单）、HUD 按钮渲染、系统驱动（switch(move)）三处共用同一张表；新增战术 = 表加一行 + 驱动 switch 加分支。
- **包内数值 CFG**（DATA_DRIVEN §13 玩法包自治，注释数值意图）：`engageRadius 20`（冲锋接敌半径，>drafting 自动 14 = 先敌接战语义）、`trainCooldown 15s`（训练冷却/小人）、`retreatDistance 40` + `moveInterval 0.5s`（撤退/集结移动节流的距离-节流对）、`refreshInterval 0.8s`（冲锋/集火指定刷新节流，慢于 drafting 追击 0.4s 一档）、`regroupSpread 2`（集结散布）。
- **状态写入纪律**：战术/编制状态全走 pawn.extra（存档扩展点，随档透传零迁移）；冷却/节流/树快照是瞬态缓存（不随档）。
- **协议字段值语义**（PROTOCOL_CONTRACTS 登记）：`pawns.commander` 缺省 undefined = 非指挥官（role ∈ officer/general；subordinates = 存活编制）；`pawns.tactic` = 生效战术 id（无战术 = undefined；active 优先于 underOrder 的回显规则在 server 序列化端）。

## 暖炉燃料数据面（thermo 包，2026-08-16 审计中①）

- `CFG.fuelInterval = 10`：燃料结算周期（秒）——暖炉头注承诺"每 10s 烧 1 木维持热度"由此落地；`fuelPerEval = 1`：每周期消耗木数；`fuelItem = 'wood'`：燃料物品 id（全局仓库，改 id 即换燃料）。
- **语义**：结算只在周期阈值处发生（timer 累计，非每 2s 评估周期）；结算先于热场评估（断供当周期即失效）。**只对 def.id === 'heater'** 的暖炉烧木——campfire/church 是内核免费暖源不动（"篝火免费取暖"是既有世界观）。无木可烧 → 暖炉进离线集合（本结算周期不出热，补木下周期恢复）。
- 烧木记 `recordSpend(null,'wood',1)`（economy 账本：供暖是营地级支出；同批修复的 prison 喂食 / hg 篝火重建遵循同一记账纪律）。

## 技能成长与敌人生成数据面（2026-08-16 审计 L5/L6）

- **tuning.combat.skillGrowth**（数据驱动化）：`base 10`（技能起点，未练默认）/ `cap 100`（上限）/ `gainMin 1`/`gainMax 10`（过线增幅）——COC 语义（掷 d100 > 当前值才升）不变，参数全可覆盖；`skillOf` 无记录时默认值同源读 base。
- **敌人生成 = 表驱动快照**：`pushHostile(ctx, enemy, x, y, { targetX, targetY, hpMul })`——hostile 快照字段 = EnemyDef 全字段 spread + 命中字段（hp×hpMul / target / enemyId=d.id / dmgPerSec=d.dmg）；EnemyDef 新字段自动进所有生成路径（raid 压力波/wildmouse 竞争群/hg 猎物）。

## 驯兽数值（beast-taming 包，2026-08-16）

- CFG 表（玩法包自治）：`tameHpRatio 0.25`（重伤线）/ `feedPerSec 0.5`（驯化投喂速率）/ `tameTime 20s`（驯化时长）/ `guardEngage 8`（守卫扑咬半径）/ `guardDps 6`（守卫撕咬 dps，略高于野猫 5——驯养伙食好）。
- 守卫跟随：直线移动（无寻路，hostiles 统一移动协议），速度 = 猫移速（3.5 格/s）。无战跟随驯养人到 2.5 格内停下。

## 捕食者近身反击倍率（2026-08-16 战斗平衡）

- `tuning.combat.predatorReactionMul = 0.25`：非征召鼠对捕食者（predator 标记）的近身反击伤害倍率（自动反击只拖不杀——90hp 捕食者被非征召反击击杀需 45s，玩家有充足窗口驯化/指挥）；征召鼠（K_DRAFTED）恒全伤（1.0）。语义 = 自动防御只拖延、玩家指挥才能高效击杀——给战场指挥（征召/冲锋）与驯兽守卫（重伤窗口）真实介入价值。
- 适用点：仅 raidSystem 捕食者分支的近身反击（nearestPawnInRange 自动选取，非玩家操作）；carried 逃跑途中被追砍保持全伤（叼着鼠的猫本该被全力截杀）。
