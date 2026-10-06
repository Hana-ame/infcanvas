# v3 玩法包手册（2026-10-06）

> **本文件才是与当前代码对应的事实。** `docs/DLC_PACKS.md` 描述的是 v3 之前的版本
> （62 个玩法包 / 50 个系统），那些包在当前代码里**不存在**，详见该文件开头的失效抬头。
>
> 纪律：`docs/` 只能追加不能删减，所以旧文档保留原文作为历史记录；
> **不要**再把 `DLC_PACKS.md` 当作现状依据。

## 一句话现状

当前 `src/mods/packs/` 共 **10 个文件**，其中 **8 个是默认玩法包**（`playstyle.ts` 是清单本身，
不是包；`sample-berry.ts` 是 DLC 示例，默认**不**挂载）。

**只有 2 种可堆放资源**：`food` 🍎 / `wood` 🪵（`src/mods/contracts.ts:11-13`，
全库仅此两键）。文档里出现过的矿、工具、矿石都不是游戏实体。

**只有 10 个卡系列**（`src/mods/contracts.ts:36-48`，新系列必须在此登记）：

| 常量 | 语义 |
|---|---|
| `SER_GATHER` / `SER_WOOD` | 采集 / 伐木 |
| `SER_BUILD` | 建造（篝火、棚屋、仓库、**开垦**） |
| `SER_EAT` / `SER_REST` | 吃 / 睡 |
| `SER_SOCIAL` | 社交 |
| `SER_WANDER` | 游走 |
| `SER_FIGHT` / `SER_FLEE` | 战 / 逃 |
| `SER_FARM` | 播种 / 收割 |

---

## 八个默认包的职责

装配顺序由 `requires` 拓扑推导（`src/mods/pack.ts` 的 Kahn 算法），**清单里的书写顺序不承担依赖**。

| 包 | 解决什么玩法问题 | 注册内容 | 依赖 |
|---|---|---|---|
| `needs` | 小人会饿会困，不介入就会静止 | 4 个 `cardWeight` 钩子 + `wander`/`eat`/`sleep` 三卡 | — |
| `gathering` | 把"找吃的"变成有代价的决策 | `gather_berry`、`chop_tree`（**duration 6~8s**） | — |
| `building` | 给攒下来的资源一个去处 | `campfire`/`hut`/`store` 三建筑 + 三张建造卡 + 1 个木料钩子 | — |
| `social` | 群体不是一盘散沙 | `chat` 卡 | — |
| `raid` | 给和平线一个威胁，检验反应链 | `cat` 敌人 + `fight`/`flee` 卡 + 1 个恐惧钩子 | — |
| `bootstrap` | 开局第一堆火（**死锁防线**） | 出生 + 篝火 | `building` |
| `tech-pool` | 让"变强"也走抽签 | 4 科技 + 碎片抽卡池 | — |
| `farming` | 粮食的稳定来源 | `field` 建筑 + `build_field`/`sow_field`/`harvest_field` | `building` |

### 每个包的已知要点

**`needs`** — 4 个权重钩子分别按饥饿/精力/心情/理智倾斜对应系列（`needs.ts:35-58`）。
这是"需求影响抽签"的唯一实现处。

**`gathering`** — 两张卡执行 6~8s（`gathering.ts:49,60`）。**这个时长是平衡的敏感参数**：
它与敌袭的 2 DPS 相乘，决定了"猫在咬的时候鼠还有多久才轮得到抽战斗卡"。
延长它会直接削弱战或逃的响应（见 `docs/PROGRESS.md` 平衡根因那一行）。

**`building`** — 三个建筑的科技门控**刻意不同**：`campfire` 无门控（否则新营地连火都生不起来 =
死锁开局，`building.ts:40-45` 有注释）、`store` 要「仓储术」、`hut` 无门控。
木料钩子（`building.ts:99-106`）：木≥20 → `SER_BUILD` ×1.8、木≥12 → ×1.3、
心情<40 时 `build_hut` 再 ×2。篝火每 12s 烧 1 木，断薪按 id 序**确定性**熄一座。

**`raid`** — 敌袭按累积 `raid.pressure` 触发（`pressurePerSec 0.55` 对 `pressureThreshold 100`，
≈ 每 180s 一波），锚点取**离鼠群质心最近的火**（不是世界原点）。恐惧钩子有两个因子：
按血量倾斜，以及 `threatWorkMul`（有敌近时压制非战斗卡，`raid.ts:28-35`）——
后者是 2026-10-06 平衡修复的关键，**改它必须重跑存活复采**（见下"数值纪律"）。

**`tech-pool`** — 4 个科技，其中 `craft:tool`（简易工具）与 `craft:toolkit`（精工工具）
的 `unlocks` 是**空数组**：它们是名字，不是可解锁的实体。只有 `storage:store` 解锁真东西。

**`farming`** — ⚠ **`build_field` 归 `SER_BUILD` 不是 `SER_FARM`**，所以"开垦"不会被饥饿推上来，
它走的是 `building` 包的木料钩子；饥饿只影响 `sow_field`/`harvest_field`。
这与玩家"饿了→自动种地"的心智模型有一层落差，是**已知待确认的设计问题**。

---

## v3 包 ↔ 旧文档包的对应

`DLC_PACKS.md` 列了 62 个包。按三类划分：

**已迁移到 v3 的**（换了名字或换了形态）：`needs`、`gathering`、`build`(→`building`)、
`farming`、`social`、`raid`、`techPool`(→`tech-pool`)、`events`(已并入内核 `sim` 的事件流)。

**已明确删除的**（有删除裁定，不是遗漏）：

| 旧机制 | 删除依据 |
|---|---|
| `oracle-guidance` / 「××令」/ `registerStrategyCard` | `src/mods/registry.ts:8`：2026-08-21 用户裁定**整体移除**；`contracts.ts:24`；`__tests__/contracts.test.ts:3` |
| `field-command`（玩家插卡面） | `mastery` 是卡被抽中后自动演化（`systems.ts:116`），玩家插不了 |
| 神谕 `oracleMul` 权重因子 | 当前权重管线 `src/sim/cards.ts:43-52` 已无该因子 |

> 「旧版决策层」这个说法在旧 PLAYING 文档里出现过 16 次。**它对应的是被删除的神谕权重注入层**，
> 不是五个玩家入口里的任何一个 —— 卡池/权重/目标层/插卡/神谕在 v3 全部不对应。

**从未在 v3 存在的**（整片功能从未迁移）：`economy`、`crafting`、`repair`、`medicine`、
`power`、`thermo`、`trade`、`prison`、`wildmouse`、`cooking`、`clothing`、`drafting`、
`autobuild`、`population` 等。

**结论：旧文档里 62 个包，当前代码 8 个。差距不是"还没写"，是"决定不要了"。**

---

## 如何新增一个玩法包

### 三步

1. 写包 → 2. 声明 `requires` → 3. 在 `playstyle.ts` 登记一行（`playstyle.ts:8` 的纪律注释）。

### 骨架（照抄最简包，别自创）

`src/mods/packs/sample-berry.ts` 是仓库里的**完整可照抄示例**（独立 DLC 包形态，
`requires: []` 显式声明）。最小结构：

```ts
import type { ModPack } from '../pack';

export const myPack: ModPack = {
  id: 'my-pack',
  requires: [],            // 纪律：必须显式声明（含空数组），无前置也要写 []
  mount(m) {
    m.registerCard({ id: 'my_action', label: '…', series: SER_XXX, /* … */ });
  },
};
```

### 契约纪律（`validateContracts` 会拦你）

- **新卡系列必须先在 `contracts.ts:36-48` 的 `ALL_SERIES` 登记**，否则装配时报错；
- **新资源键必须先在 `contracts.ts:11-13` 登记**，且键名要进 `K_TAG_*` 词表；
- 建筑功能标签同理走 `K_TAG_*`；
- `pack.topoSort` 按 `requires` 做 Kahn 拓扑挂载，**乱序写清单也正确**。

### 跨 tick 状态

需要跨 tick 记东西（敌袭压力、生长计时等）走 `ctx.scratch`，键集中管理并说明语义。
`scratch` **进 golden 指纹** —— 所以动它就是动玩法，门禁会红。

---

## 数值纪律

**所有可调数值进 `src/sim/tuning.ts`，玩法包只注册不硬编码。**
例外：`registerEnemy` 的敌人属性（`raid.ts:25` 的 `hp/dmg/speed/atkCd/climb`）目前写在包里，
这是一处**已知例外**，不是范例。

改数值后**必须**跑完这三样再合：

1. **多 seed 存活复采**：CI 只跑 4 个 seed，这个取样**偏乐观**——历史上 12 seed 均值 2.75/4
   而 4 seed 看起来像 3.5/4。至少 12 个 seed × 900 tick，看均值**和分布**。
2. **`golden` 确定性门禁**：指纹是**跑出来的**，只要数值改变了行为，指纹就会变。
   按约定在同一系列提交里更新常量并写明原因（`docs/DESIGN.md` 有判别流程）。
3. **`survival-loop.test.ts`**：断言的是机制（被咬时抽战斗卡的比例），不是结果好看。

> ⚠ `balance smoke` 在 CI 里是 `continue-on-error` 的**报告型** job：它红不会挡住合并，
> 但红了一定要查。它曾红了一整个项目历史。
