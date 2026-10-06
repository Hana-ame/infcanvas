# 当前 DLC / 玩法包清单（2026-08-20）

> # ⚠️ 本文件已失效 —— 描述的是 v3 之前的版本
>
> **2026-10-06 审计实测**：下面列的 **62 个玩法包 / 50 个系统在当前代码里不存在**。
> 当前 `src/mods/packs/` 只有 **10 个文件**，其中默认挂载的玩法包是 **8 个**
> （`needs` / `gathering` / `building` / `social` / `raid` / `bootstrap` / `tech-pool` / `farming`）。
> `src/mods/packs/playstyle.ts:20-29` 是这 8 个包的装配清单（逐行实测，不是估算）。
>
> **差距不是"还没写"，是"决定不要了"** —— 例如 `oracle-guidance` / 「××令」机制
> 已由 2026-08-21 用户裁定**整体移除**（`src/mods/registry.ts:8`），
> `field-command`（玩家插卡面）在 v3 不存在。
>
> **当前事实请看 [`DLC_PACKS_v3.md`](DLC_PACKS_v3.md)**（含 8 包逐包职责、
> 62 个旧包的三类划分、以及新增玩法包的骨架与契约纪律）。
>
> 为什么保留原文：`docs/` 铁律是**只能追加不能删减**，原文作为历史记录留存。
> 但**不要再把本文件当作现状依据**。

---

> 默认装配共 **62 个玩法包**、**50 个系统**。
> 本清单是 `DEFAULT_PLAYSTYLE_PACKS` 的速查表；详细添加流程见 `docs/DLC_GUIDE.md`。

## 核心基础包

| 包 | 说明 |
|---|---|
| `needs` | 生存需求：食物/精力/心情/理智 |
| `economy` | 经济账本与派系优先级 |
| `socialUnit` | 篝火归属/派系涌现 |
| `social` | 社交、流言、关系 |
| `gathering` | 采集、伐木、采矿 |
| `build` | 建造 |
| `farming` | 农耕 |
| `crafting` | 手工制作 |
| `repair` | 建筑修理 |
| `medicine` | 医疗、伤口、感染 |
| `power` | 电力 |
| `thermo` | 温度、暖炉、冷热 |
| `trade` | 贸易 |
| `prison` | 囚禁 |
| `wildmouse` | 野鼠生态 |
| `cooking` | 烹饪 |
| `raid` | 敌袭 |
| `population` | 人口增长 |
| `events` | 脚本事件 |
| `techPool` | 科技碎片抽卡 |
| `autobuild` | 自动扩张 |
| `bootstrap` | 出生引导 |
| `clothing` | 制衣、材质、染料 |
| `oracle-guidance` | 策略卡/神谕引导 |
| `drafting` | 征召战斗 |
| `field-command` | 战场指挥 |
| `beast-taming` | 驯兽守卫 |

## 扩展 DLC 包

| 包 | 说明 |
|---|---|
| `seasons` | 四季变化 |
| `astronomy` | 日食/月食/星象/潮汐 |
| `sailing` | 航海 |
| `disease` | 疾病传播与草药治疗 |
| `breeding` | 生育系统 |
| `lineage` | 血脉/谱系 |
| `genetics` | 基因遗传 |
| `flying` | 飞行单位与防空 |
| `buildings-extra` | 箭塔/城墙/灯塔/水渠/仓库 |
| `biomes` | 沙漠/雪原/沼泽/火山 |
| `meteor` | 流星/陨石 |
| `visitor` | 访客 |
| `neutral-fauna` | 中立动物 |
| `waterworks` | 水利 |
| `rail` | 铁路运输 |
| `industrial` | 工业革命 |
| `extra-needs` | 卫生/娱乐/社交需求 |
| `buildings-2` | 建筑扩展二期 |
| `clothing-2` | 服饰扩展二期 |
| `zone` | 区域系统 |
| `work-priority` | 职业优先级（ai 组：指派职业 utility +10 进决策抽卡） |
| `diplomacy` | 派系外交 |
| `belt` | 传送带物流 |
| `masterpiece` | 工匠杰作 |
| `gossip-facts` | 事实进入社交传闻 |
| `ruins` | 旧世界遗迹 |
| `biomes-2` | 丛林/草原/苔原 |
| `enemies-2` | 更多敌人 |
| `events-2` | 更多事件 |
| `buildings-3` | 建筑扩展三期 |
| `clothing-3` | 服饰扩展三期 |
| `story` | 故事模板事件 |
| `hot-cold` | 前线/后方热区冷区 |
| `fortifications` | 防御工事 |
| `weapons` | 武器扩展（火器科技树：燧发枪→步枪→机枪→冲锋枪→大炮） |
| `urban-combat` | 巷战视野（Bresenham LOS 视线遮挡，墙后不可射击） |

## 说明

- 这些包默认全部挂载；实际游戏可通过 `ModRegistry.default([...])` 排除或调整。
- 纯数据包只注册 def/事件/建筑/物品；需要系统逻辑的包会注册新 `GameSystem`。
- 某些包仍处于“种子”或“未完全接入”状态（如 `work-priority`），建议以代码为准。
