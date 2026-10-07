/**
 * playstyle.ts —— 默认玩法清单（纯数据，2026-08-21 从零 v3）。
 *
 * 纪律：
 *  - 这里只决定"默认挂哪些包"，顺序不承担依赖约束（拓扑由 pack.topoSort 从
 *    requires 推导，乱序也正确）。
 *  - 新增玩法包：写包 → 声明 requires → 在此登记一行。完事。
 *  - DLC 不进本清单（requires: [] 的独立包，按需显式 mountPacks 或登记进 DLC_PACKS）。
 */
import type { ModPack } from '../pack';
import { needsPack } from './needs';
import { gatheringPack } from './gathering';
import { buildingPack } from './building';
import { socialPack } from './social';
import { raidPack } from './raid';
import { bootstrapPack } from './bootstrap';
import { techPoolPack } from './tech-pool';
import { farmingPack } from './farming';
import { cookingPack } from './cooking';
import { eventsPack } from './events';
import { combatPack } from './combat';
import { huntingPack } from './hunting';
import { medicinePack } from './medicine';
import { envPack } from './env';
import { factionsPack } from './factions';
import { fortifyPack } from './fortify';

export const DEFAULT_PLAYSTYLE_PACKS: ModPack[] = [
  needsPack, // 需求衰减 + 吃/睡 + 饥饿权重调制
  gatheringPack, // 采集野果 / 砍树
  buildingPack, // 篝火 / 棚屋 + 自主建造
  socialPack, // 闲聊 / 口角 / 关系值
  raidPack, // 叙事压力敌袭 + 战/逃卡
  bootstrapPack, // 开局篝火 + 出生（requires building，拓扑自动殿后）
  techPoolPack, // 科技抽卡池（碎片制）：按间隔发碎片，靠前科技先攒齐；门控 hut/store 建造
  farmingPack, // 农耕：开垦/播种/收割三张卡 + 地块冷却式生长（requires building）
  cookingPack, // 烹饪（R3-4）：烹烤卡（走火边）+ 熟食这种更划算的食物
  eventsPack, // 事件（局面触发）：丰收/寒潮/瘟疫/流浪者/丰收节，谓词+效果表，无脚本线
  combatPack, // 战术：据守/集火/迂回/集结（防御的行为层 = 大兵团战术空间入口）
  huntingPack, // 狩猎（R3-3）：被动动物/肉/草药材料链
  medicinePack, // 医疗（R3 瘟疫/饥荒）：病榻建筑 + 照料卡（耗草药）+ 自然恢复（requires building）
  envPack, // 环境：昼夜/温度/天气 + 冻伤中暑（无新卡，只走权重钩子与掉血）
  factionsPack, // 派系外交：贸易卡 + 掠夺（raider）+ 传闻（requires building/raid/bootstrap）
  fortifyPack, // 防御（line/fort）：围墙/哨塔/陷阱三张建造卡 + 陷阱触发系统（requires building）
];

/**
 * 可用 DLC 清单（P0 地基）：包 id → 带 `dlc` 声明的玩法包。
 *
 * 为什么与 DEFAULT_PLAYSTYLE_PACKS **同文件但不同表**：两者都是"纯数据清单"，
 * 同属 playstyle 模块（registry 只 import 这一个模块，框架其余部分不碰玩法包）。
 * 分开两张表是因为它们的**默认命运相反**——本体表是"默认全挂"，DLC 表是
 * "默认全不挂、由 dlc_load.json 显式启用"（见 proj-infcanvas-dlc-design-2026-10-07）。
 *
 * 纪律：
 *  - 新增 DLC：写包（ModPack 带 `dlc: { title }`）→ 在此登记一行 → 完事。
 *    **不要**把它加进 DEFAULT_PLAYSTYLE_PACKS（那会让原版体验被 DLC 污染）。
 *  - 空表是合法状态：没有 DLC 时 `ModRegistry.default()` 与加参 `default({dlc:[]})`
 *    行为完全一致（零回归）。传未登记的 id 会**响亮报错**（拼错不该静默变"没装"）。
 */
export const DLC_PACKS: Record<string, ModPack> = {};