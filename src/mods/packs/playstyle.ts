/**
 * playstyle.ts —— 默认玩法清单（纯数据，2026-08-21 从零 v3）。
 *
 * 纪律：
 *  - 这里只决定"默认挂哪些包"，顺序不承担依赖约束（拓扑由 pack.topoSort 从
 *    requires 推导，乱序也正确）。
 *  - 新增玩法包：写包 → 声明 requires → 在此登记一行。完事。
 *  - DLC 不进本清单（requires: [] 的独立包，按需显式 mountPacks）。
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
];