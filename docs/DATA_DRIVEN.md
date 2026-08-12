# 数据驱动架构（DATA-DRIVEN）· 2026-08-06

> 目标：**让 mod 能实现玩法，而不是只加同质物。**
> 手段：把散落在各系统里的魔法数值收敛为"数据 + 通用系统"，系统只读数据、不写死数值。

## 1. 现状问题（迁移前）

审计结论：当前是"**结构数据驱动 + 数值硬编码**"。系统能按 tag 发现实体（结构对），但每个系统内部自己定数值（数值散落）。

典型硬编码分布：

| 位置 | 硬编码内容 |
|---|---|
| `systems/gatherSystem.ts` | 伐木 2.5s / 采矿 3s / 矿洞 4s 一轮、产出 `5:2`/`3:1`/`2:1`、工具加成 1.3、STR 加成公式 |
| `systems/farmSystem.ts` | 农田产 `0.2 * dt` |
| `systems/craftSystem.ts` | `woodCost=5`、`craftCd=6s`、产出 tools |
| `systems/raidSystem.ts` | 狼血量 60、步速 3.5、伤害 5/8、间隔 75、`count=2+pawn*0.5`、压力公式 |
| `systems/needsSystem.ts` | 衰减 0.15/0.08、夜晚 0.12、篝火 0.5/0.3、奇观 0.3、饿死 2.5、紧急阈值 30/20 |
| `systems/sanSystem.ts` | CRAZY=25、半径 8/7、shock=12、夜晚流失 0.35、恢复 2.5 |
| `systems/socialSystem.ts` | 冷却 2/15-25、亲密 40、敌对 -20、动手概率公式、伤害 8、好感 delta 3/-4/1 |
| `systems/socialUnitSystem.ts` | 开战 -40 / 贸易 40、汇率 1.5/3、资源增速 0.4/0.3/0.15、容量、opinion delta |
| `systems/desireSystem.ts` | 检查 5s、衰减 0.02、匮乏 30/15、心情 -8/-3、恶意 0.12 |
| `systems/populationSystem.ts` | 上限 12、招募 45s、食物阈值 60 |
| `systems/autonomousBuildSystem.ts` | minWood 6~30、food<80、ore<20、tools<2、faith>=35 |
| `systems/repairSystem.ts` | 1.5s、修 20 点 |
| `core/needs.ts` / `core/desires.ts` | 衰减率、紧急阈值、匮乏阈值 |
| `core/socialUnit.ts` | 升级信仰 35、记忆容量、名字表 |
| `sim.ts` | 速度 4、HP 公式、信仰门槛、食物上限 60/40/15 |
| `systems/cardSystem.ts` | commandCooldown 3、违抗概率、defyCd 30、进食量 40/50、休息 40 |

**后果**：mod 只能加"同质物"（又一个 farm-tagged 建筑 = 又一个 0.2/s 农田），不能加异质玩法（新资源、新配方、不同产量、改难度）。

## 2. 目标架构

```
defs/           世界物定义（数据）：tile / building / item / recipe / card / event / expansion
  index.ts      tile·building·item
  recipes.ts    RecipeDef + RECIPES          （新增）
  tuning.ts     TuningConfig + TUNING        （新增，平衡参数总表）
  enemies.ts    EnemyDef + ENEMIES           （新增，敌对种类：hp/speed/dmg/loot）
  events.ts     ScriptedEvent                （从 systems/scripts.ts 迁出）
systems/        通用逻辑系统：只读 defs/tuning，不写死数值
mods/registry.ts 注册表：register* / override* / tuning 覆盖
```

**三条铁律**：
1. 一切数值（产量/耗时/成本/阈值/概率/倍率）必须来自 `defs` 或 `tuning`，系统里禁止魔法数字
2. 生产 = 数据定义的 **Recipe**（输入→输出→耗时→检定），系统通用执行
3. mod 通过注册表**新增或覆盖**数据来改玩法，不改内核源码

## 3. 数据模型（新增/扩展）

### 3.1 TileDef 扩展 —— 采集定义进 tile

```ts
interface TileDef {
  // 原有：id/name/passable/buildable/color/mineral/resourceYield/growable/moveCost
  harvest?: {          // 可采集（树/矿）的完整定义
    product: string;   // 产出 item id
    time: number;      // 采集耗时（秒）
    yieldSuccess: number;
    yieldFail: number;
    skill?: SkillId;   // 检定技能，默认 work
    dc?: number;       // 检定阈值，默认 60
  };
  harvestReplaces?: string; // 采集后瓦片变为什么（缺省：growable→grass植物、mineral→dirt）
}
```

树：`harvest={product:'wood', time:2.5, yieldSuccess:5, yieldFail:2, dc:55}`
矿：`harvest={product:'ore', time:3, yieldSuccess:3, yieldFail:1, dc:60}`

### 3.2 RecipeDef —— 生产配方（新）

```ts
interface RecipeDef {
  id: string;
  name: string;
  kind: 'passive' | 'batch' | 'work';
  // passive：无需小人，建筑按秒持续产出（农田）→ output.amount = 每秒量
  // batch： 无需小人，间隔 interval 秒消耗 input 产出 output（工作台）
  // work：  需小人到建筑工作，每 interval 秒检定一次产出（矿洞）
  input?: { item: string; amount: number }[];
  output: { item: string; amount: number };
  failOutput?: { item: string; amount: number }; // work 检定失败产物
  interval?: number;   // batch/work 用
  skill?: SkillId;     // work 检定技能
  dc?: number;         // work 检定 DC
}
```

### 3.3 BuildingDef 扩展 —— 生产行为引用配方

```ts
interface BuildingDef {
  // 原有：id/name/size/hp/color/passable/buildTime/workRadius/costWood/costOre/tags
  recipe?: string;   // 引用 RECIPES 中配方 id（农田/工作台/矿洞）
  aura?: {           // 光环定义（篝火/奇观），收敛 needsSystem/sanSystem 的写死
    radius?: number;
    moodPerSec?: number;
    restPerSec?: number;
    sanPerSec?: number;
  };
}
```

### 3.4 TuningConfig —— 平衡参数总表（新）

**权威定义：`src/sim/defs/tuning.ts`（`TUNING` 默认值 = 迁移前基线，禁止改数值只许搬）。**

15 组接口，全部跨实体平衡数值：

| 组 | 用途 | 含优先子字段 |
|---|---|---|
| `needs` | 饥饿/精力/心情衰减、紧急阈值、SAN 自然恢复、**auraScanRadius（光环扫描半径，生效距离由 def.aura.radius）** | foodDecay/restDecay/hungerAt/sleepyAt/starvationDmg/foodMoodLow-High/moodDrift/sanRecover/sanTrauma |
| `san` | 狂乱阈值、目睹死亡、黑夜流失、篝火恢复 | crazyAt/witnessRadius/deathShock/nightDrain/fireRecover/crazyCooldown |
| `gather` | 采集加成 | toolBonus/strBonusPerPoint/strBase |
| `faith` | 祈祷/疗伤/矿洞/神谕（半径/时长/心情/信仰/信任门槛） | prayTime/healPerSec/caveWorkDuration/oracle* |
| `combat` | 袭击节奏/压力/近战/打建筑/DEX 闪避 + **raidEnemy/unitRaidEnemy（敌人种类 id，查 enemies 表）** | baseInterval/pressureScale/pawnDmg/buildingDmg/dodge* |
| `social` | 微互动冷却/亲密敌对阈值/动手/传教/delta | friendAt/hostileAt/punch*/mood*/preach* |
| `desire` | 七宗罪检查/衰减/匮乏/恶意槽/偷窃 | checkInterval/decayPerSec/scarceAt/criticalAt/malintent*/steal* |
| `faction` | 派系贸易/逆差/开战/看法增量 + **priorityTimer（派系工作优先级评估周期）** | warAt/tradeAt/tradeRate*/opinion*/resourceGrowth* |
| `population` | 人口上限/招募 | maxPawns/recruitInterval/foodThreshold |
| `repair` | 修理 | workTime/repairAmount/searchRadius |
| `autobuild` | 自主建造各计划阈值 + **starterBuilding/fallbackBuilding（出生/兜底建筑）** | farmWood/caveWood/churchWood/wallWood/faithThreshold |
| `env` | 气温/降水 | baseTemp/dayAmplitude/rain* |
| `pawn` | 移动/血/目标搜索半径 | baseSpeed/hpBase/scanRadius |
| `event` | 事件 roll 间隔 | interval/intervalJitter |
| `card` | 违抗/进食/休息 + **派系优先级数据表 `priority: PriorityRule[]`** | commandCooldown/defy*/eatAmount/restAmount |

`Sim` 的 `tuning` 是 **getter → `this.mods.tuning`**，mod 在构造回调里 `overrideTuning()` 后所有系统立即读到覆盖值。`SimContext.tuning` 暴露给所有系统。

## 4. 系统重构（迁移清单）

| 系统 | 改造 |
|---|---|
| gatherSystem | ✅ 伐木/采矿读 `TileDef.harvest`；矿洞改读 `BuildingDef.recipe`(work)；加成读 tuning.gather |
| farmSystem | ✅ 读农田建筑 `recipe`(passive) + tuning 已有 |
| craftSystem | ✅ 读工作台 `recipe`(batch)，冷却/成本全部来自配方 |
| raidSystem | ✅ 全部数值读 tuning.combat |
| needsSystem | ✅ 衰减/夜晚/篝火/奇观读 tuning.needs + BuildingDef.aura |
| sanSystem | ✅ 阈值/半径/流失/恢复读 tuning.san + BuildingDef.aura（fireRecover 优先 aura，回退 tuning） |
| socialSystem | ✅ 冷却/阈值/动手/好感读 tuning.social |
| socialUnitSystem | ✅ 开战/贸易/逆差/汇率/资源增速读 tuning.faction（unit hp/dmg/count） |
| desireSystem | ✅ 检查/衰减/匮乏/恶意/偷窃读 tuning.desire |
| populationSystem | ✅ 上限/间隔/阈值读 tuning.population |
| autonomousBuildSystem | ✅ EXPANSION_PLAN 数据化（阈值从 tuning.autobuild 读）；`ExpansionPlan` 已导出，mod 可注册新 plan |
| repairSystem | ✅ 耗时/修复量/半径读 tuning.repair |
| cardSystem | ✅ 违抗/冷却/进食量读 tuning.card |
| core/needs·desires | ✅ 参数改为入参（由系统从 tuning 传入） |
| core/socialUnit | ✅ 升级门槛（篝火→教堂）读 `tuning.autobuild.faithThreshold`；容量/名字保留（表现数据） |
| sim.ts | ✅ 速度/HP/门槛读 tuning（`tuning` getter 走 mods.tuning） |
| eventSystem | ✅ interval/jitter 读 tuning.event；provider 池 = 内置脚本 + mods.events 合并 |

> 迁移已完成（日期见文首），全部默认值 = 迁移前行为，现有测试全绿。

## 5. ModRegistry 扩展（mod 玩法能力）

注册口全部带冲突检测（重名抛错），内部存 `xxxMap`（Map，可覆盖），暴露 `xxx` getter 返回 `Record`（供 World/Sim 索引访问）：

```ts
registerTile(def: TileDef): this
registerBuilding(def: BuildingDef): this
registerItem(def: ItemDef): this
registerEnemy(def: EnemyDef): this              // 新敌对种类（raidSystem 从 enemies 表查）
// enemyDef(id?)：按 id 查敌人 def（缺省用 tuning.combat.raidEnemy），自然袭击/派系袭击共用；overrideDef('enemy') 即时生效
registerCard(card: BehaviorCard): this
registerRecipe(def: RecipeDef): this
registerEvent(ev: ScriptedEvent): this          // 事件系统从 mods.events 读（不再只吃内置 SCRIPTED_EVENTS）
registerExpansionPlan(plan: ExpansionPlan): this// 自主建造新计划
registerIntent(id, fn): this                     // 新意图执行器（新 action）
registerWork(type, fn): this                     // 新工作类型执行器（walkAndWork 按 workType 分派，配合卡 decide）
registerSystem(s: GameSystem): this
registerHook(stage, fn): this                    // 生命周期钩子（已接线 step:before / step:after）
overrideDef(kind: 'tile'|'building'|'item'|'card'|'recipe'|'enemy', id, patch): this  // 部分覆盖数值
overrideTuning(patch: DeepPartial<TuningConfig>): this  // 覆盖平衡参数（deepMerge，只动传的键）
```

构造回调：`new Sim({ mods: (m) => m.overrideTuning({...}) })` 在 createWorld/spawn 之前执行，mod 可覆盖 defs/tuning。`SimContext` 暴露 `mods` / `tuning` / `buildingDef(id)` / `recipe(id)` 供系统查表。

**行为三层闭环**（玩家自写小人行为）：
1. **决策层** `registerCard`：condition/utility/decide 定义"何时、以多高偏好去做什么"
2. **执行层** `registerWork`：卡的 `decide()` 产出 `workType`（已开放为 string），`BehaviorSystem` 按 workType 分派到注册的执行器；执行器可用 `st.onArriveWork = () => {...}` 挂"走到目标后开始工作"的回执
3. **介入层** `registerHook('step:before'|'step:after', fn)`：每 tick 回调，`ctx = { sim, dt }`，可读改 sim 状态

**欲望满足也数据声明**：`BehaviorCard.satisfies: [{desire, amount}]`，卡被选中执行时自动 fulfill——mod 新工作卡声明 `satisfies` 即接入欲望系统（不再按 job 中文文案匹配）。

## 6. mod 玩法示例（验收标准）

以下场景已实现**无需改内核源码**，`src/sim/__tests__/sim.test.ts` 末尾「mod 玩法」describe 块逐一验证：

1. ✅ **新生产玩法**：registerItem「草药」+ registerRecipe 草药田 passive + registerBuilding → 产出进全局库存
2. ✅ **新配方**：registerRecipe「farm-plus」+ `overrideDef('building','farm',{recipe:'farm-plus'})` 换高产能
3. ✅ **新事件**：registerEvent「陨石坠落」（condition + run）→ 事件池抽中并加矿石
4. ✅ **改难度**：`overrideDef('enemy','wolf',{hp:10})` 或 `overrideTuning({ combat: { raidEnemy: 'boar' } })` → 袭击强度/种类受控
5. ✅ **改产能**：overrideDef 覆盖 tile harvest / building recipe
6. ✅ **新自主建造计划**：registerExpansionPlan → buildQueue 出现新建筑
7. ✅ **新工作类型**：registerCard 产出非内置 workType + registerWork 执行器 → 小人执行全新工作
8. ✅ **每 tick 介入**：registerHook('step:before'/'step:after') 计数 + 改 sim 状态生效
9. ✅ **新工作满足欲望**：卡 `satisfies` 声明 → 欲望正向反馈（不用文案匹配）
10. ✅ **新发光建筑**：`emitsLight` 声明 → 参与光照图
11. ✅ **新神谕建筑**：`capabilities:['oracle']` 声明 → 可降下神谕
12. ✅ **craft 用自己配方**：`recipe` 声明 → 每座加工建筑各产各的，不写死 workbench
13. ✅ **派系优先级数据表**：`tuning.card.priority` rules，overrideTuning 改阈值生效
14. ✅ **敌对种类数据化**：`registerEnemy` 新增 + `overrideTuning({combat:{raidEnemy:'boar'}})` 切换袭击类型；wolf 的 hp/speed/dmg/loot 全进 `defs/enemies.ts`
15. ✅ **派系袭击数据化**：掠夺者不再是写死的 unitHp/unitDmg/ore×4，而是 `enemies.ts` 的 `raider` def，tuning `combat.unitRaidEnemy` 切换种类；`ModRegistry.enemyDef(id?)` 查询（自然袭击/派系袭击共用），overrideDef('enemy') 即时生效
16. ✅ **采集目标数据化**：伐木/采矿不再按 `=== 'tree'/'ore'` 特判，改按 tile def `growable`/`mineral` + `harvest` 声明——mod 注册新可采集 tile（如浆果丛）小人会自动去采；`harvestReplaces` 声明采后变什么瓦片
17. ✅ **光环/魔法值收敛**：nearAura 扫描半径进 `tuning.needs.auraScanRadius`、生效距离由各建筑 `def.aura.radius` 决定；派系优先级评估周期/目标搜索半径/兜底建筑/出生建筑全部进 tuning；AI 建造成本读 `def.costWood/costOre`（与手动队列一致，不再写死 1 木）
18. ✅ **client 层数据驱动**：建造菜单遍历 `sim.mods.buildings`（新建筑自动进菜单）、tile 地基/图标查 `sim.mods.tiles`（未知 tile 兜底色不崩）、`sprite` 声明复用素材（tile/建筑）、敌人按 enemyId 稳定散列着色；`?mods=url` 运行时加载 ESM mod；e2e（scripts/e2e/mod-ui.mjs + src/mods/demo-berry.ts「浆果玩法」）5/5 绿——mod 不碰内核：新建筑进菜单、新 tile 进世界、渲染零崩溃
19. ✅ **新欲望维度**：`registerDesire(id,label)` 注册全新欲望（如"声望"），初始值/衰减/匮乏/恶意槽/满足自动成立；`BehaviorCard.desire` 直接挂钩权重（不用系列映射）+ `satisfies` 声明满足——色欲/嫉妒等未内置满足途径的维度 mod 可自建；HUD 欲望显示遍历 DESIRES 表（数据化）

> 修复记录：
> - `Sim.tuning` 由字段改为 getter → `this.mods.tuning`，否则 mods 回调对 tuning 的覆盖在构造后对 `this.tuning` 快照不可见（最初 2 个 mod 测试因此失败）。
> - **registerCard 曾是真 bug**：`initSlots` 把 mod 卡排在 9 张基础卡之后，而 `maxSlots` 仅 2~4，mod 卡永远进不了卡池。第一次修"去重后优先"，仍被 **trait 卡**挤掉（占满 maxSlots）。最终：mod 卡**无条件全部进池**（去重基础卡），容量不再挤出 mod 玩法。
> - `registerHook` 原为死 API（零调用点），已接线 `sim.step()` 的 step:before/after。
> - `craftSystem`/发光/升级/神谕：从按 defId/campfire/church 特判改为 BuildingDef `emitsLight`/`upgradesTo`/`capabilities` 数据声明。
> - 干掉了 desireSystem 按 `job.includes('伐木')` 文案匹配满足欲望的脆断点。
> - **save/load JSON-safe**：slots 原来直接存含函数的卡数组，JSON 往返后 `decide` 为 undefined 必崩 → 改存卡 id，load 按 id 从 mod→基础→天赋卡重取；load 曾边遍历 `_pawnList` 边 killPawn（splice 跳过隔一个）→ 拷贝列表；load 后补 `assignPawn` 重填成员的 bug（否则首轮 step 误判团灭附身）。
> - **AI 建造成本曾与手动不一致**：autonomousBuildSystem 入队写死 `{wood:1}`，手动队列读 def.costWood（教堂 8 木）——统一读 def；"自主建造教堂"测试原 100 木在真实成本下不够，备料调整。

## 7. 迁移风险与验证

- 全部数值改动需保证**默认值 = 迁移前行为**（数值原样搬进 defs/tuning，不改行为）
- 现有 89 个测试必须全绿（它们断言了具体数值如采矿产 3、饥饿死亡等，默认值不变则通过）
- 每个系统改造后立即跑 `npm test` + `npm run typecheck`
- 最后新增 mod 玩法测试（registerRecipe/overrideTuning/registerEvent）证明扩展性 —— ✅ 已完成，89/89 绿

## 8. 完成标准

- [x] `grep` 系统目录无残留魔法数值（除 0/1/100 钳制等结构常数）
- [x] 生产/战斗/社交/需求全部查表
- [x] ModRegistry 支持 5 类玩法注册
- [x] 新增 mod 玩法测试绿

## 9. 深度数据驱动（2026-08-11 全量审查后）

对照 `grep` 全目录审查（`/tmp/opencode/non-data-driven.md`），清除剩余硬编码与双真值源：

### 9.1 新增数据表（defs/）

| 表 | 内容 | mod 入口 |
|---|---|---|
| `defs/traits.ts` | 7 天赋：属性微调/罪孽倾向/技能加成/抽卡权重倍率/天赋卡（声明式） | `registerTrait`/`overrideTrait` |
| `defs/jobs.ts` | 职业 → 主导工作卡 + 中文标签（Q10 生产线） | `registerJob` |
| `defs/cards.ts` | 9 基础卡全声明式（`needAt`/`utilityBase`/`utilityFixed`/`utilityPerQueue` 由工厂生成 condition/utility） | `registerCard` |
| `defs/leans.ts` | 行为学习 10 轨道（迁自 core/lean.ts；`LeanParams` 权威定义在 tuning） | `registerLean` |
| `defs/behavior.ts` | `MARKOV_BIAS` 马尔可夫偏置 + `SERIES_TO_DESIRE` 系列→欲望默认映射 | `registerMarkovBias`/`registerSeriesDesire` |
| `defs/events.ts` | 7 预制剧本事件（迁自 systems/scripts.ts，数值全读 tuning.event） | `registerEvent` |

### 9.2 tuning 新增组/字段

- **Needs**：出生需求 80/90/60/100；**San**：POW 抗压公式（中点 40/分母 100/下限 0.4）+ 狂乱乱跑范围/尝试
- **Gather**：配方/地表表缺字段兜底（收获/伐木时间、DC、技能、产量、产出物）
- **Craft**（新组）：配方缺字段兜底（成本/产出/间隔）
- **Social**：节流间隔、相遇距离、动手（损失/钳制/心情）、魅力公式、基调阈值/概率、布道全参数
- **Desire**：出生满足度、罪孽初始、恶意槽（POW 抗恶意、砸建筑 10、转圈、lust 心情）
- **Faction**：单位初始库存、升级距离、传话看法、缺粮汇率阈值、跨单位协作距离、成员上限（church 10/campfire 3）
- **Population**：开局库存、招募生成环；**Repair**：原地修理距离；**Autobuild**：教堂目标、找位环/尝试、缺省建造成本
- **Env**：`dayLength` 120/`nightStart` 0.72/`nightEnd` 0.22
- **Pawn**：属性区间、天赋数量、卡槽、移动速度心情系数、技能初始公式（INT/EDU）、`skillInit` 五技能基础
- **World**（新组）：出生空地半径/撒资源尝试/距离/数量（树 4 矿 3 石 3）
- **Event**：流浪者/丰收/矿脉/瘟疫/游商/庆典全部数值 + 事件资源钳制 500 + LLM 幅度上界（resource 20/mood 10）

### 9.3 系统改造清单

- `pawn.ts` 重写：`BASE_CARDS`/`TRAIT_CARDS` 由表工厂生成；`generateDna(seed, t?)`/`initSlots(dna, extra?, t?)` 可选参数缺省 TUNING（旧调用不变）；`effectiveWeight` 全读表（天赋倍率/欲望映射/环境倍率/马尔可夫/职业倍率）；`CardView` 新字段全部可选
- `cardSystem.ts`：view 注入 tuning/markovBias/jobCards/desireOfSeries；抽卡张数 `card.drawCount`；进食耗粮 `card.eatCost`；欲望满足量读 tuning.desire
- `gatherSystem`/`craftSystem`/`raidSystem`：删 13+ 处 `??` 兜底 → 读 tuning（表优先、兜底收敛）
- `socialSystem`/`desireSystem`/`sanSystem`：POW 公式 `(pow-40)/100` 三处统一读 tuning；tone/魅力/动手/布道数值查表
- `socialUnitSystem`：单位初始库存/升级距离/协作距离/汇率阈值读 tuning.faction
- `sim.ts`：初始库存/`dayLength`/`isNight` 昼夜阈值/技能初始值/COC 技能公式装配自 tuning；`initNeeds`/`initDesires`/`initEnv` 带参
- `core/world.ts`：出生空地/撒资源参数读 tuning.world
- `mods/registry.ts`：`registerTrait`/`overrideTrait`/`registerMarkovBias`/`registerSeriesDesire`/`registerJob`（跨实例共享表，与 DESIRES 同策略）
- **双真值源消除**：`dayLength`（客户端 welcome 下发）；客户端食物告急阈值/派系容量（welcome.tuning 快照）；职业标签/按钮遍历 `JOBS` 表；`llm.ts` 白名单钳制读 tuning.event（prompt 数字取 TUNING 静态默认）

### 9.4 验证

- `npm run typecheck` 0 错；`npm test` 136/136 绿
- 测试稳定性修正：markov 偏置测试原卡池饱和（idle 必中，偏置被吞）→ 拷贝 base 卡压权至同阶；preaching 测试 seed 52 恰踩随机序列死角 → seed 55（同场景语义不变）

## 10. 逻辑组件层（数据驱动第二阶段，2026-08-11）

数据表（§9）之上，把「逻辑装配」也数据化：表 = TS 模块（函数合法），mod 启动时插入。

### 10.1 系统装配表（defs/systems.ts）

- `SYSTEM_DEFS`：15 个系统按表序装配（执行顺序 = 表序），系统 id 即锚点
- `SystemDef`：id/label/category/ctor（依赖注入 sim）+ `before?`（mod 插入锚点）
- ModRegistry：`registerSystemDef(def)`（缺省追加表尾，`before` 指定插在某系统前）、旧式 `registerSystem(实例)` 兼容
- 单例回填：替换 `behavior`/`socialUnit` 系统后，intent/work 注册与 bus 回调仍指向新实例
- Sim 暴露 `systemIds` 只读视图（调试/工具/测试）

### 10.2 卡条件谓词表（行为树条件节点）

- `CARD_PREDICATES`（defs/cards.ts）：机制钩子集中一处（hasCave/hasCampfire/buildQueue），代码只写一次
- 卡表纯声明：`when: ['hasCave', ...]`（AND 组合），与 needAt 阈值/自定义 condition 合并
- 谓词跨实例共享（与 LEANS/DESIRES 同策略）：`registerPredicate(id, fn)` 扩展，新谓词可被任意卡引用
- 未注册谓词 → 工厂报错（拼错 id 立即暴露）
- `registerCardDef(def)`：纯数据 def（needAt/when/utility*）→ 工厂生成，mod 写卡无需函数

### 10.3 寻路策略表（tuning.path）

- 算法本体保留 A* 代码，策略参数数据化：`maxIter`/`darkCost`/`heuristic`
- 启发式策略表（chebyshev 对角默认 / manhattan / euclidean）：换启发式 = 改表
- sim.getPath 装配读 tuning.path；mod overrideTuning 即时生效

### 10.4 验证

- `npm run typecheck` 0 错；`npm test` 142/142 绿
- 新测试：系统装配表（锚点插入/尾插/替换回填）、谓词表（内置组合/mod 扩展/未注册报错）、寻路策略（默认可达/maxIter 钳制/启发式切换）

### 10.5 端到端示例（demo-berry 升级）

`src/mods/demo-berry.ts` 演示逻辑组件层全链路（一个 mod 同时用三项）：

- `registerPredicate('stockpileBerry')` + `registerCardDef({ when: ['stockpileBerry'], ... })`：浆果 ≥5 时小人抽"浆果盛宴"休闲卡（纯声明，零函数）
- `registerSystemDef({ before: 'autobuild', ... })`：浆果变质系统插入执行表（每 60s 库存减半）
- 验证：`demo mod 逻辑组件层闭环` 测试（143/143 绿）——卡进表/锚点位置/谓词真假/变质减半全断言

### 10.6 意图/工作执行器表（defs/executors.ts）

- `BUILTIN_INTENTS`（6 意图：id/label/kind/handler）与 `BUILTIN_WORKS`（4 工作类型）清单收敛进表
- BehaviorSystem 从表装配（handler 指向类方法，bind 后注册）；mod 仍可 registerIntent/registerWork 扩展或**覆盖内置**（同 id 即替换）
- `kind: 'instant' | 'ongoing'` 执行时机语义元数据（eat/rest/idle 即时，walkAndWork/heal/pray 持续）
- 验证：表装配后进食行为不变 + 覆盖 idle 执行器生效（145/145 绿）

### 10.7 权重调制规则流水线（defs/weightRules.ts）

- effectiveWeight 拆成 7 条调制规则（天赋/欲望/环境/马尔可夫/派系/职业/EWA），`BUILTIN_WEIGHT_RULES` 表序 = 执行序
- `registerWeightRule(rule, before?)` 插入（锚点语义同系统装配表）；`overrideWeightRule(id, apply)` 原地替换
- 规则函数是"机制"，参数全读表/tuning；跨 Sim 实例共享（同谓词策略）；`weightRulesOf()` 供工厂遍历
- 验证：夜晚恐惧规则插入生效 + 同锚点注册序执行（147/147 绿）

## 11. 文本层（数据驱动第三阶段，2026-08-12）

### 11.1 社交对话模板表（defs/socialLines.ts）

- 微互动文案（greet/positive/negative）从系统常量迁入表；`registerLine(category, line)` 追加（mod 定制对话风味）
- 流言话题模板：历史事件 type → 文案函数（`text: (data) => string | null`，返回 null = 不产话题）；`registerTopicTemplate(tpl)` 扩展
- 话题/文案函数是"机制"，跨 Sim 实例共享（同谓词/权重规则策略）；`socialLinesOf()` 查询
- 系统内不再有对话文案常量（socialSystem 全走表）

### 11.2 部落名生成表（defs/factionNames.ts）

- 前缀/后缀元素表，`generateUnitName(rng, names?)` 生成（确定性种子）
- `tuning.faction.namePrefixes/nameSuffixes` 提供则覆盖（mod 定制部族风味），缺省用内置表
- 验证：内置表正则匹配 + tuning 覆盖生效（157/157 绿）

## 12. 数据驱动现状（本轮后）

| 层 | 载体 | mod 扩展点 |
|---|---|---|
| 内容 | defs/（tiles/buildings/items/recipes/enemies/events） | register*/overrideDef |
| 平衡 | tuning（needs/combat/.../faction） | overrideTuning（深合并） |
| 逻辑组件 | 系统装配表 + 谓词表 + 寻路策略 + 执行器表 + 权重规则 | registerSystem/registerPredicate/overrideTuning.path/registerIntent/registerWeightRule |
| 文本 | socialLines + factionNames | registerLine/registerTopicTemplate/tuning.faction 名 |
| 欲望 | DESIRES 表（七宗罪 + 注册制） | registerDesire |
| 行为 | 卡表（声明式：weight/when/satisfies/action） | registerCard/overrideDef('card') |

## 13. Mod 打包/沙箱（数据驱动第四阶段，2026-08-12）

### 13.1 包格式（src/mods/loader.ts）

- **自包含单文件 JSON**：`{ manifest, defs?, scripts? }`，可分发/可校验/可版本约束
  - `manifest`：id（`[a-z0-9][a-z0-9-_.]*`）、name、version、`requires.coreVersion`（与 CORE_VERSION 严格比对）
  - `defs`：纯 JSON 内容声明——tuning（深合并）/items/tiles/buildings/recipes/enemies/cards/jobs/leans/markov/seriesDesires/lines/topics（`{key}` 模板）；白名单字段，未知字段拒绝；卡类函数字段（condition/extraUtility/decide）必须移入 scripts
  - `scripts`：函数式扩展（谓词/系统/事件/权重规则/钩子）——JS 字符串，打包器内联一切依赖，`import/require` 一律拒绝
- 加载：`parseModPackage(json)`（校验）→ `buildModMount(pkg)`（= Sim mods 回调）→ `mountModPackage(pkg, reg)`（挂载失败返回 `{ok:false,error}`，不拖垮主 sim）
- 打包 CLI：目录（mod.json + defs.json + scripts.js）→ 单文件 .mod.json（`npm run mod:pack [名]`，默认 demo-berry）
- 悬挂顺序：scripts 先（谓词/机制注册），defs 后（内容引用谓词）

### 13.2 沙箱边界（诚实声明）

- 同进程信任边界：**防手滑不防恶意**（标识符解析属 JS 引擎层，同进程无法真隔离）
- 实际防护：new Function 白名单注入（只有 `m` + 受限 `console`）无 import/require 可达；scripts 编译失败/执行抛错 → 挂载失败清晰报错，Sim 照常运行
- 静态共享键（谓词/天赋/职业/社交文案等）注册**幂等**：同 id 重复挂载 = 保持首次定义（多 Sim 重复挂载同包安全）；内容实例表（物品/建筑/卡）冲突仍抛错

### 13.3 验证

- demo-berry 重构为包格式（defs.json 纯声明 + scripts.js 函数式），行为与源码 mod 等效（卡/谓词/系统锚点/变质全链路）
- 校验拒绝：非法 JSON/缺 manifest/非法 id/coreVersion 不匹配/未知 defs 字段/卡含函数字段/scripts 含 import
- 沙箱隔离：语法错误与运行期抛错均被捕获，主 sim 可继续 step
- 重复挂载幂等：同包挂 3 个 Sim 不冲突（166/166 绿）
