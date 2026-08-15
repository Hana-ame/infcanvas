// 默认玩法清单 + 管理器（playstyle manifest，2026-08-14 完全插件化）
// 背景：此前 ModRegistry.default() 把"构成默认模拟器的玩法包列表"硬编码成 12 个
//   r.mount(...) 调用——"通过插件机制组装"但"选哪些包"不是数据。本文件把清单外置：
//   DEFAULT_PLAYSTYLE_PACKS = 有序包 id 数组（数据，倒手即可换玩法）
//   defaultPlaystylePack = 一个"聚合包"：requires 引用上述清单，依赖解析自动拉齐全部
// 2026-08-15 自动组 DAG：挂载序由框架 topoSort 从 requires 推导（前置先 apply），
//   清单数组顺序不再承担图约束——只是"要挂哪些包"的选择器 + 同层稳定初始序。
// 2026-08-15 第一个插件 = 管理器：本文件新增 playstyleManager——"默认装配"从框架
//   （ModRegistry.default 硬编码清单校验/挂载）迁入此插件；default() 只做数据种子 +
//   mount 管理器。换玩法 = 换一份管理器/聚合包，框架零代码。
// 2026-08-15 Stage1 完全插件化：内核纯引擎裁决后，原内核 8 个"社会骨架"系统
//   （needs/san/desire → needs 包；social/build/raid/population/events 各一包）也迁入本清单。
// 2026-08-15 Stage B+C+D 内核纯引擎：behavior/socialUnit 两个"引擎系统"也迁出为玩法包
//   （behavior/social-unit/economy/bootstrap），内核 = 0 系统纯演算框架。本清单随之扩为
//   21 包（新增 behavior/socialUnit/economy/bootstrap 4 个）。
// 2026-08-15 clothing 制衣玩法包（用户需求：服装制作/染料/设计=科技抽卡/材质）：清单扩为
//   24 包（产出组尾部追加 clothing——制衣在烹饪后结算，raid 前）。
//   注意：清单只决定"挂哪些包"；**系统执行序**由 defs/systems.ts 推导（类别序 CATEGORY_ORDER
//   × 组内注册序，见 sim.registerSystems），两者解耦。
// 2026-08-15 一致性重构（用户裁决：插件/mod 行为一致）：behavior 决策引擎从玩法包迁回内核
//   （SYSTEM_DEFS 内联 ctor = 引擎服务归内核，装配/卸载规则与其他系统完全一致）——本清单
//   随之 24→23 包；techPool/autobuild 移到 population/events 之后（清单序 = 组内注册序，
//   调整后类别推导的执行序与旧 BASE_SYSTEM_ORDER 逐位一致，零漂移）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';
import { validateContracts } from '../../sim/mods/contracts';
import { needsPack } from './needs';
import { economyPack } from './economy';
import { socialUnitPack } from './social-unit';
import { socialPack } from './social';
import { gatheringPack } from './gathering';
import { buildPack } from './build';
import { farmingPack } from './farming';
import { craftingPack } from './crafting';
import { repairPack } from './repair';
import { techPoolPack } from './tech-pool';
import { autobuildPack } from './autobuild';
import { medicinePack } from './medicine';
import { powerPack } from './power';
import { thermoPack } from './thermo';
import { tradePack } from './trade';
import { prisonPack } from './prison';
import { wildmousePack } from './wildmouse';
import { cookingPack } from './cooking';
import { raidPack } from './raid';
import { populationPack } from './population';
import { eventsPack } from './events';
import { bootstrapPack } from './bootstrap';
import { clothingPack } from './clothing';
import { workPriorityPack } from './work-priority';

// 包目录对照表（id → 真包对象；管理器/测试用）。id 校验失败即抛错——防清单改错 id 后
// 静默丢包。2026-08-15 从 registry.ts 迁入本文件（数据归数据层，框架不再 import 玩法包）。
export const PLAYSTYLE_PACKS: Record<string, ModPack> = {
  needs: needsPack,
  economy: economyPack,
  socialUnit: socialUnitPack,
  social: socialPack,
  gathering: gatheringPack,
  build: buildPack,
  farming: farmingPack,
  crafting: craftingPack,
  repair: repairPack,
  techPool: techPoolPack,
  autobuild: autobuildPack,
  medicine: medicinePack,
  power: powerPack,
  thermo: thermoPack,
  trade: tradePack,
  prison: prisonPack,
  wildmouse: wildmousePack,
  cooking: cookingPack,
  raid: raidPack,
  population: populationPack,
  events: eventsPack,
  bootstrap: bootstrapPack,
  clothing: clothingPack,
  'work-priority': workPriorityPack,
};

// 有序清单（顺序 = apply 序 = def 注册序 = 组内系统执行序的稳定初始序；执行序推导见
//   defs/systems.ts CATEGORY_ORDER + sim.registerSystems）：
//   needs(生存/理智/欲望) → economy(经济账本+派系优先级) → socialUnit(派系单位) →
//   social(社交) → gathering(采集,锚 before build) → build(建造) →
//   farm/craft/repair/medicine/power/thermo/trade/prison/cooking（产出/结算先于敌袭）→
//   raid(敌袭) → population(补员) → events(剧本事件) → techPool/autobuild(科技/扩张) →
//   bootstrap(引导) → clothing(制衣，产出组尾——清单末位使组内注册序 = cook 后 raid 前)。
//   说明：behavior 决策引擎已归内核（不在此清单）；bootstrap 类别 'boot' 恒表尾（类别序
//   决定，与清单位置无关，此处放末位仅语义直观）。
export const DEFAULT_PLAYSTYLE_PACKS: string[] = [
  'needs',
  'economy',
  'socialUnit',
  'social',
  'gathering',
  'build',
  'farming',
  'crafting',
  'repair',
  'medicine',
  'power',
  'thermo',
  'trade',
  'prison',
  'wildmouse',
  'cooking',
  'raid',
  'population',
  'events',
  'techPool',
  'autobuild',
  'bootstrap',
  'clothing',
  'work-priority',
];

// 聚合包：自身无行为，仅声明前置依赖（依赖图拓扑自动按序拉齐上面的玩法包）
export const defaultPlaystylePack: ModPack = {
  id: 'default',
  name: '默认玩法',
  requires: [...DEFAULT_PLAYSTYLE_PACKS],
  apply(): void {},
};

// 管理器包（2026-08-15 第一个插件 = 管理器）
// 框架不再内置"默认装配"：ModRegistry.default() 只做数据种子 + mount 本管理器，
// 装配的一切（清单校验 + 组 DAG 拉齐玩法包）都在这里。换玩法 = 换管理器/聚合包，
// 框架零代码。apply 期间调 m.mount() 安全：topoSort 闭包收集不含本管理器，无环。
export const playstyleManager: ModPack = {
  id: 'playstyle-manager',
  name: '默认玩法管理器',
  apply(m: ModRegistry): void {
    for (const id of DEFAULT_PLAYSTYLE_PACKS) {
      const pack = PLAYSTYLE_PACKS[id];
      if (!pack) throw new Error(`mod: 默认玩法清单引用了未登记的包 "${id}"（playstyle 对照表与清单不一致）`);
      m.registerPack(pack);
    }
    // 聚合包 requires = 清单 → 框架 topoSort 自动组 DAG，推导挂载序（前置先 apply）
    m.mount(defaultPlaystylePack);
    // 契约校验（2026-08-15 一致性：跨包字符串契约唯一权威表，见 sim/mods/contracts.ts）。
    // 默认管理器 = 严格模式：写方在场却未按要求写出契约键 → 抛错防回归（拼错/改名漏改
    // 在装配期暴露）；第三方管理器可自行决定跳过或降级。
    const violations = validateContracts(m);
    if (violations.length > 0) throw new Error(violations.join('\n'));
  },
};