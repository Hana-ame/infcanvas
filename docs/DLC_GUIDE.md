# DLC 添加指南（2026-08-20）

> 新增一个 DLC 玩法包的完整流程。每步都有检查清单，按序完成即可。

## 速查：当前基线

- 测试：`npm test` = **625 用例 / 62 文件**
- 默认装配：**50 系统 / 62 包**
- `npm test` 基线更新后必须全绿 + `npx tsc --noEmit` 干净

---

## Step 1: 创建包文件

在 `src/mods/packs/` 下创建 `<your-dlc>.ts`：

```ts
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

const CFG = {
  // 所有数值在此，注释说明语义 + 来源
  someValue: 10,
};

class YourSystem {
  id = 'your-dlc';
  constructor(private ctx: SimContext) {}
  init(_bus: EventBus): void {}
  update(dt: number): void {
    // 系统逻辑
  }
}

export const yourDlcPack: ModPack = {
  id: 'your-dlc',
  requires: [], // 硬依赖写 here；无依赖 = []
  apply(m: ModRegistry): void {
    // 注册建筑/tile/item/enemy/card/recipe/system/command
    m.registerSystemDef({
      id: 'your-dlc', label: '你的 DLC', category: 'world',
      ctor: (ctx) => new YourSystem(ctx),
    });
  },
};
```

### 检查清单

- [ ] 文件头注释：做什么 + 为什么（AGENTS.md 代码注释纪律）
- [ ] 所有数值在 CFG 对象内，注释来源
- [ ] `requires` 显式声明（无依赖 = `[]`，硬依赖 vs 可选联动写注释）
- [ ] category 与 SYSTEM_DEFS 表一致（needs/ai/society/production/raid/world/boot）
- [ ] 系统只依赖 SimContext 接口，不碰 Sim 本体（可单独测试）

---

## Step 2: 注册到 playstyle.ts

打开 `src/mods/packs/playstyle.ts`，改 3 处：

```ts
// 1. import（按字母序插入）
import { yourDlcPack } from './your-dlc';

// 2. PACKS 表（按字母序插入）
'your-dlc': yourDlcPack,

// 3. DEFAULT_PLAYSTYLE_PACKS 数组（按字母序插入）
'your-dlc',
```

### 检查清单

- [ ] import 语句路径正确
- [ ] PACKS 表条目 id 与 pack.id 一致
- [ ] DEFAULT_PLAYSTYLE_PACKS 数组条目 id 与 pack.id 一致

---

## Step 3: 更新基线测试

**仅当 DLC 注册了新系统时需要改**（纯数据包如 buildings-extra 跳过此步）。

### 3a. assembly.test.ts

```ts
// EXPECTED_ORDER 数组末尾追加 'your-dlc'
// PACK_IDS 数组追加 'your-dlc'
// toHaveLength: 41 → 42
// 注释标题更新
```

### 3b. dlc-framework-stress.test.ts

```ts
// systemDefs before mount: 40 → 41
// systemDefs after mount: 41 → 42
// systemIds baseline (⑤): 41 → 42
// systemIds ① single DLC: 42 → 43
// systemIds ② 8 DLCs: 49 → 50
// systemIds ⑥ 3 DLCs 1 disabled: 43 → 44
// systemIds ⑦ single DLC: 42 → 43
```

### 3c. dlc-deploy.test.ts

```ts
// 默认系统数: 41 → 42
// with 2 demo DLCs: 43 → 44
```

### 检查清单

- [ ] `npx tsc --noEmit` 干净
- [ ] `npm test` 全绿（基线更新后）

---

## Step 4: 添加隔离测试

在 `src/mods/packs/__tests__/dlc-isolated.test.ts` 追加一个测试：

```ts
it('your-dlc：单独挂载 → 功能验证', () => {
  const t = createDlcTest('your-dlc', { pawnCount: 1 });
  expect(t.sim.systemIds).toContain('your-dlc');
  t.step(1); // 不崩
  // 验证 DLC 核心功能
});
```

### 检查清单

- [ ] 验证系统/建筑/命令注册
- [ ] 验证核心功能（step 不崩 + 预期行为）
- [ ] 如果 DLC requires 其他包，验证依赖自动解析

---

## Step 5: 文档同步（AGENTS.md 纪律）

### 5a. PROGRESS.md

追加一行表格：
```md
| your-dlc DLC（2026-08-20，用户「XXX」） | 功能描述 | ✅ 实现 + N 回归 |
```

### 5b. DESIGN.md（如有架构变化）

追加章节描述 DLC 的设计思路。

### 5c. PLAYING.md（如有玩家可见行为）

追加段落描述玩家如何使用 DLC 内容。

### 5d. AGENTS.md

更新命令区的基线数字（测试用例数 / 文件数 / 系统数 / 包数）。

### 检查清单

- [ ] PROGRESS.md 追加表格行
- [ ] DESIGN.md 追加章节（如有架构变化）
- [ ] PLAYING.md 追加段落（如有玩家可见行为）
- [ ] AGENTS.md 基线数字更新

---

## Step 6: 最终验证

```bash
npx tsc --noEmit    # 类型检查
npm test            # 全量测试
npx vitest run src/mods/packs/__tests__/dlc-isolated.test.ts  # 隔离测试
```

### 检查清单

- [ ] tsc 干净
- [ ] 全量测试全绿
- [ ] 隔离测试通过
- [ ] DLC 可通过 `ModRegistry.default(['your-dlc'])` 排除（插拔验证）

---

## 附：DLC 可注册的内容

| 方法 | 用途 | 示例 |
|---|---|---|
| `m.registerSystemDef(def)` | 注册系统 | seasons/industrial/flying |
| `m.registerBuilding(def)` | 注册建筑 | rail/steam-engine/dock |
| `m.registerTile(def)` | 注册地形 | herb/biome-desert |
| `m.registerItem(def)` | 注册物品 | steel/coal/cloth |
| `m.registerEnemy(def)` | 注册敌人 | eagle/deer/scorpion |
| `m.registerCardDef(def)` | 注册卡牌 | fish(钓鱼工作卡) |
| `m.registerRecipe(def)` | 注册配方 | aqueductRecipe |
| `m.registerWork(type, impl)` | 注册工作类型 | fish |
| `m.registerCommand(name, handler)` | 注册命令 | board_cart/tame |
| `m.registerStrategyCard(def)` | 注册策略卡 | 垦田令/拓荒令 |
| `m.registerTech(def)` | 注册科技 | — |
| `m.registerHook(event, fn)` | 注册钩子 | extra-needs(step:before) |
| `m.overrideTuning(key, value)` | 覆盖数值 | — |

## 附：DLC 可选依赖

```ts
export const yourDlcPack: ModPack = {
  id: 'your-dlc',
  requires: ['build'],           // 硬依赖：build 包必须先挂载
  apply(m: ModRegistry): void { /* ... */ },
};
```

`requires` 会被 `topoSort` 自动解析为拓扑序——清单顺序不重要。
如果排除 `build` 包，`your-dlc` 也会被级联排除（依赖断裂安全）。

## 附：DLC 排除（插拔）

```ts
// 游戏开始前排除指定 DLC
const mods = ModRegistry.default(['your-dlc']);
const sim = new Sim({ seed: 42, pawnCount: 40, registry: mods });
```

级联排除：排除 `drafting` 会自动排除依赖它的 `field-command`。


## 进阶：DLC 里加 DLC（2026-08-20 追加）

### 子包嵌套（subpacks）
大 DLC = 若干小 DLC 的组合（适合 DLC 商店拆装/聚合包）：
```ts
export const megaDlc: ModPack = {
  id: 'mega-dlc', requires: [],
  subpacks: [dlcA, dlcB, dlcC],   // mount 时自动先挂子包（requires 解析 + 幂等去重）
  apply(m) { /* 父包逻辑 */ },
};
```

### 运行时热挂载（Sim.mountPack）
游戏运行中（不重启）挂载新 DLC：
```ts
sim.mountPack(newDlc);
```
- 新建筑/物品/系统 def/命令即时注册
- 新系统增量装配（复用类别序推导，已装配不重复），下一 tick 生效
- 新建筑自动同步到 World（registerBuildingDef）
- 新命令自动进 cmdValidate 白名单
- 前提：包 def 无重复 id（与编译期挂载同一规则）