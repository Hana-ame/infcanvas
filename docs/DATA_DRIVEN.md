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

所有**跨实体、跟具体物无关**的平衡数值集中：

```ts
interface TuningConfig {
  needs:   { foodDecay; restDecay; nightRestDrain; hungerAt; sleepyAt; starvationDmg; urgentEatAt; urgentRestAt; }
  san:     { crazyAt; witnessRadius; fireComfortRadius; deathShock; nightDrain; fireRecover; }
  gather:  { toolBonus; strBonusPerPoint; }
  combat:  { wolfHp; wolfSpeed; wolfDmg; pawnDmg; baseInterval; initialRaidDelay; pressureCap; raidCountBase; raidCountPerPawn; }
  social:  { interactCdMin; interactCdMax; friendAt; hostileAt; punchChanceBase; punchChancePerHostility; punchDmg; }
  desire:  { checkInterval; decay; scarceAt; criticalAt; moodCritical; moodScarce; malintentChance; stealThreshold; stealAmount; }
  faction: { warAt; tradeAt; deficitAt; tradeRateNormal; tradeRateShort; resourceGrowthWood/Food/Ore; opinionTradeRecipient; opinionDeficit; unitHp; unitDmg; unitRaidCountMin; unitRaidCountMax; }
  population: { maxPawns; recruitInterval; foodThreshold; }
  repair:  { workTime; repairAmount; searchRadius; }
  autobuild: { minWood; campfireWood; foodThreshold; oreThreshold; toolsThreshold; faithThreshold; wallCap; farmWood; workbenchWood; caveWood; churchWood; }
  env:     { baseTemp; dayAmplitude; rainCool; rainChancePerSec; rainMin; rainMax; }
  upgrade: { faithThreshold; }  // 篝火→教堂
  faith:   { prayTime; prayMood; prayFaith; appBase; appScale; healPerSec; healTime; caveWorkDuration; }
  event:   { interval; intervalJitter; }
  pawn:    { baseSpeed; hpBase; }
  card:    { commandCooldown; }
}
```

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
| core/socialUnit | ✅ UPGRADE_FAITH 改读 tuning.upgrade；容量/名字保留（表现数据） |
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
4. ✅ **改难度**：`overrideTuning({ combat: { wolfHp: 10 } })` → 袭击狼血量受控
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

> 修复记录：
> - `Sim.tuning` 由字段改为 getter → `this.mods.tuning`，否则 mods 回调对 tuning 的覆盖在构造后对 `this.tuning` 快照不可见（最初 2 个 mod 测试因此失败）。
> - **registerCard 曾是真 bug**：`initSlots` 把 mod 卡排在 9 张基础卡之后，而 `maxSlots` 仅 2~4，mod 卡永远进不了卡池。第一次修"去重后优先"，仍被 **trait 卡**挤掉（占满 maxSlots）。最终：mod 卡**无条件全部进池**（去重基础卡），容量不再挤出 mod 玩法。
> - `registerHook` 原为死 API（零调用点），已接线 `sim.step()` 的 step:before/after。
> - `craftSystem`/发光/升级/神谕：从按 defId/campfire/church 特判改为 BuildingDef `emitsLight`/`upgradesTo`/`capabilities` 数据声明。
> - 干掉了 desireSystem 按 `job.includes('伐木')` 文案匹配满足欲望的脆断点。

## 7. 迁移风险与验证

- 全部数值改动需保证**默认值 = 迁移前行为**（数值原样搬进 defs/tuning，不改行为）
- 现有 70 个测试必须全绿（它们断言了具体数值如采矿产 3、饥饿死亡等，默认值不变则通过）
- 每个系统改造后立即跑 `npm test` + `npm run typecheck`
- 最后新增 mod 玩法测试（registerRecipe/overrideTuning/registerEvent）证明扩展性 —— ✅ 已完成，76/76 绿

## 8. 完成标准

- [x] `grep` 系统目录无残留魔法数值（除 0/1/100 钳制等结构常数）
- [x] 生产/战斗/社交/需求全部查表
- [x] ModRegistry 支持 5 类玩法注册
- [x] 新增 mod 玩法测试绿
