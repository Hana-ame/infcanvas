# 当前 DLC / 玩法包清单（2026-08-20）

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
| `work-priority` | 职业优先级（未完成接入） |
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
| `weapons` | 武器扩展 |

## 说明

- 这些包默认全部挂载；实际游戏可通过 `ModRegistry.default([...])` 排除或调整。
- 纯数据包只注册 def/事件/建筑/物品；需要系统逻辑的包会注册新 `GameSystem`。
- 某些包仍处于“种子”或“未完全接入”状态（如 `work-priority`），建议以代码为准。
