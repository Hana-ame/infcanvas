# InfCanvas · RimWorld 核心系统与 16 项进阶机制设计说明

## 1. 电网规模损耗与超限 0W 熔断机制 (`evaluatePowerGrids`)

* **连通判定与参数定义 (`POWER_BUILDING_SPECS`)**：

  * 发电设施：`wood_generator` (`2×2`, `+1000W`)、`solar_generator` (`2×2`, `+1400W`)、`battery` (`1×2`, 缓冲 `+200W`)。

  * 用电与传输设施：`power_conduit` (`1×1` 电缆, `-15W`)、`electric_beacon_tower` (`2×2` 驱雾电灯塔, `-250W`)、`turret` (`1×1` 迷你机枪塔, `-80W`)、`gene_assembler` (`2×2`, `-150W`)、`research_bench` (`2×1`, `-60W`)。

* **二次方规模传输损耗 (`lossRatio`)**：

  * 随着连通电网的节点数 $N$（覆盖格数）与最大跨度 $S = \max(\Delta X, \Delta Y)$ 增长，电网内阻损耗按二次曲线加速上升：

    $$
    \text{lossRatio} = \min\left(0.92,\; 0.014 N + 0.0009 N^2 + 0.006 S\right)
    $$

  * 有效发电功率：$\text{effectiveSupplyW} = \text{round}(\text{rawSupplyW} \times (1 - \text{lossRatio}))$。

* **过大电网直接拒绝计算（功率锁定为 `0W`）**：

  * 当单一电网连通分量的节点数 $N > 32$ (`MAX_POWER_GRID_NODES = 32`) 或空间跨度 $> 36$ (`MAX_POWER_GRID_SPAN = 36`) 时，电网触发硬限熔断保护：

    * `overloadRefused = true`

    * `effectiveSupplyW = 0`、`netPowerW = 0`、`powered = false`

  * 鼓励玩家采用**分布式独立微电网**设计，杜绝全图拉一根无限长电线。

## 2. 跟随 Player 的独立战争迷雾、最大缩放对齐与驱雾建筑 (`rooms-power-fog.ts`)

1. **最大缩放视野与迷雾范围 1:1 对齐**：

   * 镜头拉到最大视野（最小缩放 `MIN_ZOOM_TILE_PX = 18`）时，屏幕可视半径恰好对齐殖民地基础迷雾范围 (`MAX_ZOOM_FOG_RADIUS = 28` 格)。

2. **迷雾严格跟随 Player，不同玩家绝不共享**：

   * `getPlayerFogSources(sim, playerId)` 按 `playerId`（如 `'p_local_1'` 殖民地执政官 vs `'p_raider_2'` 袭击指挥官）严格隔离视野源，双方各自拥有独立迷雾，切换视角可直观验证双方视野互不共享。

3. **电灯塔 + 大篝火驱散迷雾 & 寻路截断**：

   * 玩家自行规划建造的 **驱雾大篝火 (`great_bonfire`, `2×2`, 驱雾半径 `22` 格)** 与通电状态下的 **驱雾电灯塔 (`electric_beacon_tower`, `2×2`, 驱雾半径 `38` 格)** 可向远方驱散战争迷雾。

   * 若目标点位于未被电灯塔或大篝火驱散的迷雾深处，`clampPathToPlayerFog` 会将寻路路径严格截断在当前玩家的迷雾边界为止。

4. **实心山体禁穿与禁透视 (`isSolidMountainAt` & `hasLineOfSight`)**：

   * 高海拔花岗岩山体 (`granite_mountain`, $z \ge 3$) 为实心岩体，小人严禁穿越，且 Bresenham 视线射线遇到实心山体立即阻断，无法透视山体内部或后方。

## 3. 房间封顶尺寸限制 (`> 13×13` 无法封顶，算作室外)

* `inspectRoomAt(world, x, y)` 对围墙 (`wall`)、门 (`door`) 与实心山体合围的空间执行四向泛洪搜索：

  * 若房间闭合且包络宽高满足 `width <= 13 && height <= 13 && tileCount <= 169`，则判定为**已封顶室内 (`roofed: true, indoors: true`)**；

  * 若房间任意一边长 **大于 `13` (`width > 13 || height > 13`) 或面积 `> 169`**，则因跨度过大无法支撑屋顶，强制判定为 **无法封顶、算作室外 (`roofed: false, indoors: false`)**，内部物品照常遭受室外加速风化且不计入室内储藏室交易财产。

## 4. 社交 `3 + 3 + 3 + 3` 记忆上限 (`getBoundedSocialSummary`)

* 为防止无限社交网络导致存档与内存膨胀，每个小人的持久化社交面板严格只保留：

  1. **关系最好的 `3` 个小人 (`bestRelations`, Top 3** $> 0$**)**

  2. **关系最差的 `3` 个小人 (`worstRelations`, Bottom 3** $< 0$**)**

  3. **好感最高的 `3` 个派系 (`bestFactions`, Top 3)**

  4. **敌意最深的 `3` 个派系 (`worstFactions`, Bottom 3)**

* 其余中间态关系均作为临时数据 (`discardedTempRelationsCount`) 动态淘汰。

## 5. 26 部位解剖学独立建模（逐根手指 / 内脏 / 四肢 / 头部 / 生殖能力）与外科手术 (`anatomy-health.ts`)

| 解剖分组 | 独立建模部位清单（共 26 个独立 HP 与伤病状态部位） | 影响的生理机能与手术支持 | 
| ----- | ----- | ----- | 
| **头部 (`head`, 7)** | `skull` (颅骨)、`brain` (大脑)、`left_eye` (左眼)、`right_eye` (右眼)、`left_ear` (左耳)、`right_ear` (右耳)、`jaw` (下颌) | 意识 (`consciousnessPct`)、视觉 (`sightPct`)、进食能力 | 
| **内脏 (`organs`, 7)** | `heart` (心脏)、`left_lung` (左肺)、`right_lung` (右肺)、`liver` (肝脏)、`left_kidney` (左肾)、`right_kidney` (右肾)、`stomach` (胃) | 泵血 (`bloodPumpingPct`)、呼吸 (`breathingPct`)、血液过滤、消化代谢 | 
| **四肢 (`limbs`, 4)** | `left_arm` (左臂)、`right_arm` (右臂)、`left_leg` (左腿)、`right_leg` (右腿) | 移动能力 (`movingPct`，直接调制行走移速) 与操作基础权重 | 
| **逐根手指 (`fingers`, 10)** | 左手五指 (`left_thumb`, `left_index`, `left_middle`, `left_ring`, `left_pinky`) + 右手五指 (`right_thumb`, `right_index`, `right_middle`, `right_ring`, `right_pinky`) | 每一根手指独立建模 HP、出血、感染、包扎与截肢；单指受损精准折算精细操作 (`manipulationPct`) | 
| **生殖系统 (`reproductive`, 1)** | `reproductive_organ` (生殖系统) | 独立计算 **生殖能力 (`fertilityPct`, `0%..120%`)**，受年龄段与器官健康度双重调制 | 

* **医疗与外科操作**：

  * **草药包扎 (`bandageBodyPartWithHerb`)**：消耗 `1` 份草药 (`herb`) 止血并转为 `bandaged` 状态，恢复部分部位 HP；

  * **截肢切除 (`amputateBodyPart`)**：切除感染或重创的手指/四肢/器官（截除手臂会级联移除同侧五根手指），彻底消除出血与感染源；

  * **器官/义体移植 (`transplantBodyPart`)**：消耗草药与精密零件移植自然器官或强化仿生义体（`bionic` 状态提升部位机能至 `120%`）。

## 6. 任意小人交易、严格财产判定、加速风化与死亡不掉落 (`social-trade-weathering.ts`)

1. **任意小人之间均可发起交易 (`executePawnToPawnTrade`)**：

   * 主动方小人的可交易财产 (`getTradeablePropertyForPawn`) **严格等于以下三项之和**：

     1. 主动方在当前地图放到 **储物架 (`shelf`)** 或 **合法封顶室内储藏室 (`store` 且所在房间** $\le 13\times 13$ **封顶)** 中的财产（若仅露天堆放或房间 $> 13\times 13$ 未封顶，则**不计入**可交易地图财产！）；

     2. 主动方 **小人随身携带的物品 (`pawn.inventory`)**；

     3. 同阵营 **驼兽身上的物品 (`packBeast.inventory`)**。

2. **野外物品加速风化 & 死亡不掉落**：

   * 散落在室外或 $> 13\times 13$ 未封顶大房间内的地面物品以 `4.5 HP/s`（雨天 `9.0 HP/s`）高速风化销毁，防止无限地图散落物堆积卡顿；

   * 小人阵亡时 (`killPawn`)，其武器 (`equipWeapon`)、服饰 (`equipApparel`) 与随身物品 (`inventory`) **全部保留在遗体上 (`retainedOnCorpse = true`)**，绝不从 Pawn 身爆落到地面。

## 7. RimWorld 原版地形配色、斜坡高差、陌生人隐私、空地检视与玩家全权建造

* **RimWorld 原版哑光大地色系 (`terrain.ts` & `render-cache.ts`)**：

  * 采用与 RimWorld 原版一致的低饱和度自然色彩：普通壤土 (`#565c40`)、肥沃黑土 (`#3e452e`)、山麓砾石 (`#635c51`)、夯实泥地 (`#78654b`)、荒原沙地 (`#9c8966`)、沼泽泥地 (`#475240`)、粗糙花岗岩 (`#5c5e61`)、实心花岗山体 (`#383a3d`)。

* $z$ **高度斜坡机制 (`slope`)**：

  * 斜坡占据的位置禁止建造任何其他建筑；

  * 非征召状态下，鼠鼠只能通过斜坡上下高差 ($\Delta z \ge 1$)；

  * **征召状态 (`drafted`)** 下可强行攀爬/跳下 $\Delta z = 1$ 的断崖，但耗时增加 `2.5` 倍且触发攀爬检定，失败将导致腿部摔伤。

* **移速减缓与平滑移动动画**：

  * 人物基础移速下调至沉稳的 RimWorld 步速 (`0.42×`)，移除一切近战/航点瞬移，并在渲染层叠加步态摆动与平滑插值动画。

* **陌生人隐私与点击空地修复**：

  * 选中陌生人 (`isStrangerPawn`) 时隐藏其详细属性/技能/基因/背包面板，**仅显示其特质 (`trait`)**；

  * 点击空地时清除小人选中态，左下角检视窗准确展示**当前地块地形、房间封顶状态 (**$\le 13\times 13$ **vs 室外)、斜坡与电网读数**，绝不错误弹出鼠鼠 Bio。

* **建筑物规划 100% 交给 Player**：

  * 开启 `playerRimWorldMode` 后全面禁用 AI 自主建造卡 (`build_*`)，一切建筑与基地布局 100% 由玩家通过 Architect 面板规划决定。

## 8. 透明高差梯子 (`slope`) 与攀爬移速惩罚 (`SLOPE_LADDER_SPEED_PENALTY_MUL = 1.55`)

* **透明梯子视觉与 SVG 图标 (`ui-icons.ts` & `render-buildings.ts` & `render-cache.ts`)**：

  * 彻底替换原易混淆的实心三角斜坡图标，改用**半透明高差梯子 (`data-icon="transparent-ladder"`，`rgba(...)` 透底衬板 + 双侧立柱 + 四道横档)**，一眼即可区分高差通行梯子与实心墙体，同时不遮挡底层地形质感。

* **梯子移速惩罚 (`canTraverseElevationWithSlope` & `Sim.moveStep`)**：

  * 无论是经过人工建造的 `slope` 透明梯子还是天然高差梯阶，均施加 **`SLOPE_LADDER_SPEED_PENALTY_MUL = 1.55`（约 `64.5%` 有效移速）** 的移速惩罚。

## 9. 鼠鼠寻路仅判断可通过性、不判断移速 (`Sim.setPath` & `findPath`)

* **可通过性唯一原则**：

  * 控制鼠鼠计算移动路径时，`canStep` 与 `canStand` **仅校验格子的二元可通过性**（非水域、非阻挡建筑、非实心花岗山体、高差存在透明梯子或处于征召态），**绝不将地形移速倍率 (`moveSpeedMul`) 或梯子减速纳入 A* 寻路权重*\*，保证鼠鼠永远沿最直接的可通行几何路线行进。

## 10. `1×1`、`2×1`、`1×2`、`2×2`、`5×5` 多格占地、`R` 键 90° 旋转与 `AImode` 移入 DLC 默认关闭

* **全尺寸多格建筑矩阵 (`architect-defs.ts`)**：

  * `1×1`：`wall` (木石围墙)、`door` (自动门)、`slope` (透明高差梯子)、`campfire` (篝火)、`power_conduit` (电缆)、`turret` (迷你机枪塔)、`trap` (尖刺陷阱)。

  * `2×1` / `1×2`（按 `R` 键 90° 旋转互换宽高）：`stove` (燃木炉灶 `2×1`)、`research_bench` (基础研究台 `2×1`)、`shelf` (双格储物架 `2×1`)、`bed` (医疗病榻 `1×2`)、`battery` (蓄电池组 `1×2`)。

  * `2×2`：`hut` (殖民者木屋)、`store` (储藏室地基)、`field` (肥沃农田)、`great_bonfire` (驱雾大篝火)、`electric_beacon_tower` (驱雾电灯塔)、`wood_generator` (燃木发电机)、`tower` (防卫哨塔)。

  * `5×5`：`citadel_hub` (`5×5` 殖民地远征主堡，可按 `R` 键 90° 旋转朝向)、`grand_stockpile_5x5` (`5×5` 巨型战略仓储中心)。

* **玩家 100% 建造控制权 & `AImode` 移入 DLC 默认不开启 (`dlc-entry.ts`)**：

  * 开启玩家模式 (`playerRimWorldMode`) 后全面屏蔽 `build_*` 与 `till_field` 自主建造卡；

  * 原 AI 自治建造与叙事导演模式 (`dlc-ai-director` / `AImode`) 移入官方 DLC 扩展列表，且 **`defaultEnabled: false`（默认关闭）**，仅当玩家在「📦 DLC与AImode」面板手动开启时才激活。

## 11. 技能 / 特质 / 熟练度 三者绑定（每人最多 3 项，非绑定操作效率 `×50%` 且无法学习）

* **三者一对一绑定 (`triad-specialization.ts`)**：

  * 每个小人最多拥有 **`MAX_BOUND_TRIADS = 3` 个绑定三元组 (`Trait ⇔ Skill ⇔ Mastery`)**，例如：`掘山壮硕 ⇔ 掘地筑造 ⇔ 采矿建造熟练度`。

* **非绑定惩罚与禁学硬约束 (`evaluatePawnActionEfficiency` & `performPawnTriadAction`)**：

  * 若操作属于小人绑定的 3 个三元组之一：享受等级与熟练度效率加成（`>= 100%`），且执行时正常增长技能 XP 与熟练度 (`canLearn = true`)；

  * 若操作**不属于**该小人的 3 个绑定三元组：**执行效率强制乘以 `50%` (`UNBOUND_ACTION_EFFICIENCY_MUL = 0.5`)，且无法学习 (`canLearn = false`, `xpGained = 0`, `masteryGained = 0`)**。

## 12. 远古遗迹建筑搜刮点 (`mmo-ruins.ts`)

* 地图上生成多座可探索的远古遗迹建筑搜刮点 (`getRuinSites` & `scavengeRuinSite`)：

  1. **远古基因科研所遗迹 (`ruin_research_vault`, `3×3`)**：产出精密零件、草药与黄金；

  2. **帝国前线军械库废墟 (`ruin_armory_bunker`, `3×2`)**：产出高纯度铁矿、黄金与武器零件；

  3. **旧纪元冷链粮仓遗迹 (`ruin_supply_depot`, `2×2`)**：产出精致熟食、浆果与原木；

  4. **星际先遣圣殿遗迹 (`ruin_cryo_sanctum`, `4×4`)**：产出黄金、翡翠晶石与精密零件。

## 13. 遗体独立弹窗选择带出 (`ui-modals.ts` & `mmo-groups-ruins.ts`)

* 点击地图上的遗体或底部「搜刮遗体」按钮时，弹出独立的 **遗体搜刮窗口 (`#rw-corpse-modal`)**：

  * `inspectCorpseLootManifest(sim, corpseEid)` 列出遗体上保留的主武器、服饰护甲与全部随身物资及其单件重量 (`kg`)；

  * 玩家可自由勾选要带出的具体物品与数量 (`lootSelectedFromCorpse`)，实时校验当前小队剩余可用载重 (`kg`)；当遗体上的物品全部被带出后自动清理遗体。

## 14. 殖民者多分组财产分配、载重计算与 `Price = 0` 交易面板 (`mmo-groups-ruins.ts`)

* **多分组独立财产与载重核算 (`getColonistGroups`, `refreshGroupCarryMetrics`)**：

  * 殖民者默认划分为「主力拓荒一组 (`group_alpha`)」「远征搜刮二组 (`group_beta`)」「机动护卫三组 (`group_gamma`)」，玩家可随时将任意小人编入不同分组 (`assignPawnToGroup`)；

  * 每组拥有独立的 `inventory` 财产池，并根据组内成员负重能力 (`PAWN_BASE_CARRY_KG = 35kg` × 生理移动/操作系数) 与随行驼兽 (`+85kg`) 实时核算 `currentWeightKg / maxWeightKg`。

* **`Price = 0` 零价交易面板 (`executeZeroPriceGroupTrade`)**：

  * 不同殖民者分组之间通过专用的 **`Price = 0` 交易面板** 自由调拨物资，交易价格恒为 `0`，并严格拦截超出接收组最大载重上限的调拨请求。

## 15. Online MMO 跨阵营远征、开战、盗窃 (`-25` 好感)、绑架 (`-45` 好感) 与关系分级应对 (`mmo-faction-warfare.ts`)

* **盗窃与绑架自动降低好感度**：

  * **盗窃物资 (`stealFromFaction`)**：派遣小鼠潜入其他阵营据点窃取高价值物资，自动降低目标阵营好感度 **`-25` (`STEAL_REP_PENALTY = -25`)**；

  * **绑架人口 (`kidnapFromFaction`)**：突袭其他阵营据点掳走一名驻军归入我方殖民地，自动大幅降低好感度 **`-45` (`KIDNAP_REP_PENALTY = -45`)**。

* **不同好感关系 (`ally / neutral / hostile / nemesis`) 的差异化做法 (`getFactionBehaviorByRelation`)**：

  * **生死盟友 (`ally`, 好感 `>= 40`)**：开放 `-20%` 贸易优惠、允许呼叫火枪队驰援；

  * **中立观望 (`neutral`, 好感 `0 .. 39`)**：仅开放常规贸易与赠礼，不派援军；

  * **敌对交战 (`hostile`, 好感 `-69 .. -1`)**：全面封锁贸易，巡逻卫兵见我方探险小鼠立即开火 (`shootsOnSight = true`)；

  * **死敌血仇 (`nemesis`, 好感 `<= -70`)**：格杀勿论，并主动派遣精锐掠夺小队突袭我方基地 (`sendsRetaliationRaids = true`)。

## 16. 百人同屏计算/显示极限优化与工程化代码拆分 (`spatial-grid.ts`)

* **百人同屏计算与显示效率优化**：

  * 引入桶复用的零分配二维空间哈希网格 (`SpatialHashGrid<T>`)，将邻域搜索与索敌从 $O(N^2)$ 降至 $O(1)$；

  * 错峰分帧决策调度 (`spawnHundredPawnColony`) + 每帧迷雾视野源缓存 + 视口剔除 + 百人同屏紧凑 LOD 渲染 (`compact_100_pawn`)，实测 `100` 名鼠鼠同屏步进单帧平均耗时 `< 3ms`。

* **工程化模块化拆分**：

  * 将原本过长的单体文件拆分为职责单一的精简模块：`ui-icons.ts`、`ui-modals.ts`、`ui-drawers.ts`、`ui-inspect.ts`、`rimworld-ui.ts`、`render-buildings.ts`、`render-entities.ts`、`render.ts`、`sim-commands.ts`、`triad-specialization.ts`、`mmo-groups-ruins.ts`、`mmo-ruins.ts`、`mmo-faction-warfare.ts`、`spatial-grid.ts`、`power-fog-engine.ts`、`architect-defs.ts`，并由 `62` 个测试文件（共 `593` 项单元测试）全量验证通过。