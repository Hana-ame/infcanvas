// 数据驱动定义系统（defs）—— mod 友好的地基
// P0 先做 tile/terrain + 简单 building 定义
// 数据驱动铁律：一切数值（产量/耗时/成本/阈值）来自 defs 或 tuning，系统不写死魔法数字
// 详见 docs/DATA_DRIVEN.md
import type { SkillId } from '../ai/pawn';

export interface HarvestDef {
  product: string;   // 产出 item id
  time: number;      // 采集耗时（秒）
  yieldSuccess: number;
  yieldFail: number;
  skill?: SkillId;   // 检定技能，默认 work
  dc?: number;       // 检定阈值，默认 60
}

export interface TileDef {
  id: string;
  name: string;
  passable: boolean; // 小人能否走过
  buildable: boolean; // 能否在上面建造
  color: string; // 渲染色（P0 用色块，后期换纹理）
  emoji?: string; // 地块上的装饰图标（树/矿）
  mineral?: boolean; // 是否可开采资源
  resourceYield?: string; // 开采产出物品 id（兼容旧引用，新逻辑走 harvest）
  growable?: boolean; // 是否可收获（如树）
  moveCost?: number; // 寻路代价（默认 1）
  harvest?: HarvestDef; // 采集定义（树/矿），生产数值进数据
}

export interface BuildingDef {
  id: string;
  name: string;
  size: { x: number; y: number }; // footprint 格数
  hp: number;
  color: string;
  emoji?: string; // 建筑图标
  passable: boolean; // 建完后小人能否通过（墙=否，地板=是）
  buildTime: number; // 建造所需 job 秒数
  workRadius?: number; // 工作半径（如灶台/工作台）
  costWood?: number; // 额外木成本（奇观，默认 = size.x*size.y*2）
  costOre?: number; // 矿石成本（奇观）
  tags?: string[]; // 语义标签（数据驱动：mod 新建筑打标签即接入系统行为）
  recipe?: string; // 生产配方 id（引用 RECIPES，农田/工作台/矿洞）
  upgradesTo?: string; // 原地升级目标 id（如篝火→教堂；建该目标时若原地是此建筑则升级而非新建）
  capabilities?: string[]; // 能力声明（数据驱动：'oracle' 等；替代按 defId 特判）
  emitsLight?: number; // 发光半径（>0 参与光照图，替代按 'campfire' 特判）
  aura?: {         // 光环定义（篝火/奇观），收敛 needsSystem/sanSystem 写死数值
    radius?: number;
    moodPerSec?: number;
    restPerSec?: number;
    sanPerSec?: number;
  };
}

export interface ItemDef {
  id: string;
  name: string;
  stackable: boolean;
  maxStack: number;
}

export const TILES: Record<string, TileDef> = {
  grass: { id: 'grass', name: '草地', passable: true, buildable: true, color: '#3a7d44' },
  dirt: { id: 'dirt', name: '泥土', passable: true, buildable: true, color: '#8b6f47' },
  sand: { id: 'sand', name: '沙滩', passable: true, buildable: true, color: '#d9c98a' },
  desert: { id: 'desert', name: '沙漠', passable: true, buildable: true, color: '#c2b280' },
  water: { id: 'water', name: '水', passable: false, buildable: false, color: '#2a6bb0', emoji: '💧' },
  stone: { id: 'stone', name: '石头', passable: true, buildable: true, color: '#8a8a8a', emoji: '🪨' },
  mountain: { id: 'mountain', name: '山地', passable: false, buildable: false, color: '#4a4a4a' },
  tree: {
    id: 'tree', name: '树木', passable: false, buildable: false, color: '#2e5d2e', emoji: '🌳',
    growable: true, resourceYield: 'wood',
    harvest: { product: 'wood', time: 2.5, yieldSuccess: 5, yieldFail: 2, dc: 55 },
  },
  ore: {
    id: 'ore', name: '矿脉', passable: true, buildable: false, color: '#9c8a5a', emoji: '⛏️',
    mineral: true, resourceYield: 'ore', moveCost: 2,
    harvest: { product: 'ore', time: 3, yieldSuccess: 3, yieldFail: 1, dc: 60 },
  },
};

export const BUILDINGS: Record<string, BuildingDef> = {
  campfire: { id: 'campfire', name: '篝火', size: { x: 1, y: 1 }, hp: 80, color: '#4a2a1a', emoji: '🔥', passable: true, buildTime: 1, workRadius: 3, upgradesTo: 'church', emitsLight: 4, tags: ['anchor', 'warmth', 'heal', 'pray', 'social'], aura: { radius: 6, moodPerSec: 0.5, restPerSec: 0.3 } },
  wall: { id: 'wall', name: '墙', size: { x: 1, y: 1 }, hp: 200, color: '#8a8a8a', emoji: '🧱', passable: false, buildTime: 3, tags: ['barrier'] },
  floor: { id: 'floor', name: '地板', size: { x: 1, y: 1 }, hp: 50, color: '#b8a884', emoji: '⬜', passable: true, buildTime: 1, tags: [] },
  door: { id: 'door', name: '门', size: { x: 1, y: 1 }, hp: 100, color: '#7a5a1a', emoji: '🚪', passable: true, buildTime: 2, tags: ['barrier'] },
  farm: { id: 'farm', name: '农田', size: { x: 2, y: 2 }, hp: 80, color: '#6a8a3a', emoji: '🌾', passable: true, buildTime: 4, workRadius: 0, tags: ['farm', 'food'], recipe: 'farm' },
  workbench: { id: 'workbench', name: '工作台', size: { x: 1, y: 1 }, hp: 300, color: '#5a3a1a', emoji: '🛠️', passable: false, buildTime: 5, workRadius: 2, tags: ['craft', 'tools'], recipe: 'workbench' },
  cave: { id: 'cave', name: '矿洞', size: { x: 1, y: 1 }, hp: 500, color: '#3a2a1a', emoji: '⛰️', passable: false, buildTime: 6, workRadius: 1, tags: ['mine'], recipe: 'cave' },
  church: { id: 'church', name: '教堂', size: { x: 2, y: 2 }, hp: 600, color: '#5a3a6a', emoji: '⛪', passable: false, buildTime: 12, workRadius: 5, tags: ['faith', 'anchor', 'oracle'], capabilities: ['oracle'] },
  monument: { id: 'monument', name: '纪念碑', size: { x: 3, y: 3 }, hp: 1200, color: '#8a7a5a', emoji: '🗿', passable: false, buildTime: 40, workRadius: 6, costWood: 60, costOre: 25, tags: ['wonder'], aura: { radius: 6, moodPerSec: 0.3 } },
};

export const ITEMS: Record<string, ItemDef> = {
  wood: { id: 'wood', name: '木头', stackable: true, maxStack: 50 },
  ore: { id: 'ore', name: '矿石', stackable: true, maxStack: 50 },
  food: { id: 'food', name: '食物', stackable: true, maxStack: 100 },
};

export const ITEM_EMOJI: Record<string, string> = {
  wood: '🪵',
  ore: '⛏️',
  food: '🍖',
};
