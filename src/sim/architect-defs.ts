/**
 * architect-defs.ts —— RimWorld 建造规划表 (`ARCHITECT_BUILDABLES`) 与手动工作类型定义 (`RIMWORLD_WORK_TYPES`)：
 *  1. 建筑规划菜单 (`structure`) 仅保留建造墙体 (`wall`)、房门 (`door`) 与地形斜坡 (`slope`)；
 *  2. 独立「外部设施 (`exterior`)」分类：包含太阳能板 (`solar_generator`)、风力发电机 (`wind_turbine`)、
 *     雷达探照灯塔 (`electric_beacon_tower`)、驱雾大篝火 (`great_bonfire`) 等，严格禁止放置在室内 (`exteriorOnly: true`)；
 *  3. 室内内设 / 装饰 / 工作台 (`interiorOnly: true`) 均需先在地图上选中封闭房间 (`RoomInspection.indoors`)，
 *     在房间选中后的「房间布置」专属界面中布置！
 */
import type { RimWorldTerrainMeta } from './terrain';

export type RimWorldWorkType =
  | 'firefight'
  | 'doctor'
  | 'cook'
  | 'construct'
  | 'grow'
  | 'mine'
  | 'plant_cut'
  | 'hunt'
  | 'haul'
  | 'research';

export interface RimWorldWorkDef {
  id: RimWorldWorkType;
  label: string;
  shortLabel: string;
  icon: string;
  relevantSkill: string;
  mappedCardIds: string[];
}

export const RIMWORLD_WORK_TYPES: readonly RimWorldWorkDef[] = [
  { id: 'firefight', label: '灭火应急 (Firefight)', shortLabel: '灭火', icon: 'campfire', relevantSkill: 'mining_construct', mappedCardIds: ['fight', 'flee'] },
  { id: 'doctor', label: '医生看护 (Doctor)', shortLabel: '医生', icon: 'medical', relevantSkill: 'medical_social', mappedCardIds: ['heal'] },
  { id: 'construct', label: '建造维修 (Construct)', shortLabel: '建造', icon: 'wall', relevantSkill: 'mining_construct', mappedCardIds: ['build_campfire', 'build_hut', 'build_store', 'build_wall', 'build_tower', 'build_trap', 'build_bed'] },
  { id: 'grow', label: '种植农艺 (Grow)', shortLabel: '种植', icon: 'field', relevantSkill: 'plants_cook', mappedCardIds: ['till_field', 'sow_field', 'harvest_field'] },
  { id: 'mine', label: '采矿掘进 (Mine)', shortLabel: '采矿', icon: 'mine', relevantSkill: 'mining_construct', mappedCardIds: ['gather_berry'] },
  { id: 'plant_cut', label: '伐木割除 (Plant Cut)', shortLabel: '割除', icon: 'chop', relevantSkill: 'plants_cook', mappedCardIds: ['chop_tree'] },
  { id: 'cook', label: '烹饪屠宰 (Cook)', shortLabel: '烹饪', icon: 'stove', relevantSkill: 'plants_cook', mappedCardIds: ['cook'] },
  { id: 'hunt', label: '狩猎野生 (Hunt)', shortLabel: '狩猎', icon: 'hunt', relevantSkill: 'combat_shoot', mappedCardIds: ['hunt', 'hunt_rabbit', 'hunt_deer'] },
  { id: 'haul', label: '搬运搜刮 (Haul)', shortLabel: '搬运', icon: 'haul', relevantSkill: 'medical_social', mappedCardIds: ['gather_berry', 'trade'] },
  { id: 'research', label: '科学研究 (Research)', shortLabel: '研究', icon: 'research_bench', relevantSkill: 'research_craft', mappedCardIds: ['chat', 'wander'] },
];

export type ArchitectCategory =
  | 'structure'
  | 'exterior'
  | 'production'
  | 'furniture'
  | 'decoration'
  | 'security'
  | 'zone';

export type RoomLayoutSubTab = 'furnish' | 'decor' | 'workbench';

export interface ArchitectBuildableDef {
  defId: string;
  name: string;
  category: ArchitectCategory;
  /** 房间选中界面子分组：内设家具 ('furnish') / 室内装饰 ('decor') / 室内工作台 ('workbench') */
  roomSubTab?: RoomLayoutSubTab;
  /** 是否属于外部设施（太阳能、风电、灯塔、大篝火等）：严禁放在室内 */
  exteriorOnly?: boolean;
  /** 是否属于房间内部设施（内设/装饰/工作台）：必须先选中封闭房间后在房间界面内布置 */
  interiorOnly?: boolean;
  cost: Record<string, number>;
  hp: number;
  w: number;
  h: number;
  passable: boolean;
  tags: string[];
  icon: string;
  desc: string;
  rotatable?: boolean;
  minFertility?: number;
  ruinOnly?: boolean;
}

export interface FootprintCellStatus {
  x: number;
  y: number;
  valid: boolean;
  terrain: RimWorldTerrainMeta;
  reason?: string;
}

export interface FootprintInspection {
  defId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: 0 | 1 | 2 | 3;
  valid: boolean;
  canAfford: boolean;
  avgFertility: number;
  elevDiff: number;
  cells: FootprintCellStatus[];
  reason?: string;
}

export const ARCHITECT_BUILDABLES: readonly ArchitectBuildableDef[] = [
  // ================= 1. 墙壁与房门 (Structure: 只能直接建造墙壁、门与斜坡) =================
  {
    defId: 'wall',
    name: '墙体 (Wall)',
    category: 'structure',
    cost: { wood: 2 },
    hp: 80,
    w: 1,
    h: 1,
    passable: false,
    tags: ['wall'],
    icon: 'wall',
    desc: '承重与隔断墙体，支持左键拖拽连续画线，自动与四向邻墙和山体无缝连接并围合出可布置内设的封闭房间。',
  },
  {
    defId: 'door',
    name: '房门 (Door)',
    category: 'structure',
    cost: { wood: 4 },
    hp: 60,
    w: 1,
    h: 1,
    passable: true,
    tags: ['door'],
    icon: 'door',
    desc: '分隔房间的通道门，殖民者可自由进出并保持室内封顶保温（围合后点击房间内部即可布置内设/装饰/工作台）。',
  },
  {
    defId: 'slope',
    name: '石阶斜坡 (Slope)',
    category: 'structure',
    cost: { wood: 4, stone: 2 },
    hp: 90,
    w: 1,
    h: 1,
    passable: true,
    tags: ['slope', 'waypoint'],
    icon: 'slope',
    rotatable: true,
    desc: '铺设在高低地形交界处，柔化过渡并连通 z±1 台阶。',
  },

  // ================= 2. 外部设施 (Exterior Facilities: 严禁放在室内) =================
  {
    defId: 'solar_generator',
    name: '太阳能板 (Solar Generator)',
    category: 'exterior',
    exteriorOnly: true,
    cost: { wood: 8, ore: 12 },
    hp: 150,
    w: 3,
    h: 2,
    passable: false,
    tags: ['power_gen', 'power_node', 'exterior'],
    icon: 'solar_generator',
    rotatable: true,
    desc: '【外部设施 · 禁放室内】3×2 露天光伏阵列，需露天采光，持续输出 +1400W 清洁电力。',
  },
  {
    defId: 'wind_turbine',
    name: '风力发电机 (Wind Turbine)',
    category: 'exterior',
    exteriorOnly: true,
    cost: { wood: 10, ore: 14 },
    hp: 165,
    w: 3,
    h: 2,
    passable: false,
    tags: ['power_gen', 'power_node', 'exterior'],
    icon: 'wind_turbine',
    rotatable: true,
    desc: '【外部设施 · 禁放室内】3×2 高耸风力涡轮机组，必须在室外旷野迎风运转，输出 +1650W 强劲风电。',
  },
  {
    defId: 'electric_beacon_tower',
    name: '雷达探照灯塔 (Lighthouse Beacon)',
    category: 'exterior',
    exteriorOnly: true,
    cost: { wood: 10, ore: 12 },
    hp: 180,
    w: 2,
    h: 2,
    passable: false,
    tags: ['tower', 'waypoint', 'fog_clear', 'power_node', 'exterior'],
    icon: 'electric_beacon_tower',
    desc: '【外部设施 · 禁放室内】2×2 室外远距探照灯塔，通电后照亮并驱散半径 38 格战争迷雾（耗电 250W）。',
  },
  {
    defId: 'great_bonfire',
    name: '驱雾大篝火 (Great Bonfire)',
    category: 'exterior',
    exteriorOnly: true,
    cost: { wood: 16, stone: 6 },
    hp: 160,
    w: 2,
    h: 2,
    passable: false,
    tags: ['fire', 'waypoint', 'fog_clear', 'exterior'],
    icon: 'great_bonfire',
    desc: '【外部设施 · 禁放室内】2×2 巨型露天篝火信标，照亮并驱散半径 22 格迷雾，可炙烤野炊料理。',
  },
  {
    defId: 'wood_generator',
    name: '户外燃木发电机 (Wood Generator)',
    category: 'exterior',
    exteriorOnly: true,
    cost: { wood: 10, ore: 8 },
    hp: 140,
    w: 2,
    h: 2,
    passable: false,
    tags: ['power_gen', 'power_node', 'exterior'],
    icon: 'wood_generator',
    desc: '【外部设施 · 禁放室内】2×2 浓烟发电机组，需置于室外通风处，输出 +1000W 电力。',
  },
  {
    defId: 'campfire',
    name: '野外营火 (Outdoor Campfire)',
    category: 'exterior',
    exteriorOnly: true,
    cost: { wood: 10 },
    hp: 80,
    w: 1,
    h: 1,
    passable: true,
    tags: ['fire', 'waypoint', 'exterior'],
    icon: 'campfire',
    desc: '【外部设施 · 禁放室内】1×1 简易露天营火，提供野外照明、取暖与炭烤肉串/浓汤烹制。',
  },
  {
    defId: 'power_conduit',
    name: '输电线缆 (Power Conduit)',
    category: 'exterior',
    cost: { ore: 1 },
    hp: 40,
    w: 1,
    h: 1,
    passable: true,
    tags: ['power_conduit', 'power_node'],
    icon: 'power_conduit',
    desc: '1×1 地面绝缘输电线缆，支持拖拽铺设连接室外风电/太阳能与室内用电设备。',
  },
  {
    defId: 'citadel_hub',
    name: '殖民地主堡 (Citadel Hub)',
    category: 'exterior',
    exteriorOnly: true,
    cost: { wood: 30, stone: 20, ore: 15 },
    hp: 650,
    w: 5,
    h: 5,
    passable: false,
    tags: ['shelter', 'waypoint', 'fog_clear', 'power_gen', 'power_node', 'exterior'],
    icon: 'citadel_hub',
    rotatable: true,
    desc: '【外部设施 · 禁放室内】5×5 殖民地露天核心堡垒，内置 +600W 发电机与远距视野信标。',
  },

  // ================= 3. 房间内部：内设家具 (Room Furnishings: 选中房间后布置) =================
  {
    defId: 'bed',
    name: '单人床 / 医疗床 (Bed)',
    category: 'furniture',
    roomSubTab: 'furnish',
    interiorOnly: true,
    cost: { wood: 8 },
    hp: 100,
    w: 1,
    h: 2,
    passable: true,
    tags: ['bed', 'shelter', 'interior'],
    icon: 'bed',
    rotatable: true,
    desc: '【室内内设 · 选中房间布置】1×2 舒适室内床铺，供殖民者安稳睡眠与伤员包扎恢复。',
  },
  {
    defId: 'hut',
    name: '双人精装床位 (Double Bed)',
    category: 'furniture',
    roomSubTab: 'furnish',
    interiorOnly: true,
    cost: { wood: 12 },
    hp: 200,
    w: 2,
    h: 2,
    passable: false,
    tags: ['bed', 'shelter', 'interior'],
    icon: 'hut',
    desc: '【室内内设 · 选中房间布置】2×2 宽敞双人床铺，大幅加速睡眠与生命恢复。',
  },
  {
    defId: 'dining_table',
    name: '实木餐桌与餐椅 (Dining Table)',
    category: 'furniture',
    roomSubTab: 'furnish',
    interiorOnly: true,
    cost: { wood: 10 },
    hp: 110,
    w: 2,
    h: 1,
    passable: false,
    tags: ['furniture', 'shelter', 'interior'],
    icon: 'dining_table',
    rotatable: true,
    desc: '【室内内设 · 选中房间布置】2×1 温馨实木餐桌，让殖民者优雅享用特色料理，避免无桌进食负面心情。',
  },
  {
    defId: 'shelf',
    name: '室内双格货架 (Shelf)',
    category: 'furniture',
    roomSubTab: 'furnish',
    interiorOnly: true,
    cost: { wood: 6 },
    hp: 100,
    w: 2,
    h: 1,
    passable: false,
    tags: ['storage', 'shelf', 'interior'],
    icon: 'shelf',
    rotatable: true,
    desc: '【室内内设 · 选中房间布置】2×1 室内分层储物架，存放于货架上的食材与物资永不风化。',
  },
  {
    defId: 'storage_cabinet',
    name: '密封保鲜储物柜 (Storage Cabinet)',
    category: 'furniture',
    roomSubTab: 'furnish',
    interiorOnly: true,
    cost: { wood: 8 },
    hp: 140,
    w: 2,
    h: 1,
    passable: false,
    tags: ['storage', 'shelf', 'cabinet', 'interior'],
    icon: 'storage_cabinet',
    rotatable: true,
    desc: '【室内内设 · 选中房间布置】2×1 室内大容量保鲜柜，妥善存放搜刮战利品与珍贵料理食材。',
  },
  {
    defId: 'battery',
    name: '室内稳压蓄电池 (Battery)',
    category: 'furniture',
    roomSubTab: 'furnish',
    interiorOnly: true,
    cost: { wood: 4, ore: 8 },
    hp: 100,
    w: 1,
    h: 2,
    passable: false,
    tags: ['power_battery', 'power_node', 'interior'],
    icon: 'battery',
    rotatable: true,
    desc: '【室内内设 · 选中房间布置】1×2 室内防雨储能电池组，平衡电网负荷并提供 +200W 稳压缓冲。',
  },

  // ================= 4. 房间内部：室内装饰 (Room Decorations: 选中房间后布置) =================
  {
    defId: 'plant_pot',
    name: '精致盆栽 (Bonsai Plant Pot)',
    category: 'decoration',
    roomSubTab: 'decor',
    interiorOnly: true,
    cost: { wood: 4 },
    hp: 50,
    w: 1,
    h: 1,
    passable: true,
    tags: ['decor', 'shelter', 'interior'],
    icon: 'plant_pot',
    desc: '【室内装饰 · 选中房间布置】1×1 翠绿室内盆景，显著提升房间美观度 (+15 美观) 与居住者心情。',
  },
  {
    defId: 'art_sculpture',
    name: '大理石艺术雕塑 (Grand Sculpture)',
    category: 'decoration',
    roomSubTab: 'decor',
    interiorOnly: true,
    cost: { stone: 8, gold: 2 },
    hp: 140,
    w: 1,
    h: 1,
    passable: false,
    tags: ['decor', 'shelter', 'interior'],
    icon: 'art_sculpture',
    desc: '【室内装饰 · 选中房间布置】1×1 精雕细琢的鼠族艺术雕像，大幅提升房间等级与美观度 (+45 美观)。',
  },
  {
    defId: 'standing_lamp',
    name: '暖光落地灯 (Standing Lamp)',
    category: 'decoration',
    roomSubTab: 'decor',
    interiorOnly: true,
    cost: { wood: 3, ore: 2 },
    hp: 55,
    w: 1,
    h: 1,
    passable: true,
    tags: ['decor', 'interior', 'power_node'],
    icon: 'standing_lamp',
    desc: '【室内装饰 · 选中房间布置】1×1 室内柔和照明灯具，驱散室内昏暗并提升房间工作与进食舒适度。',
  },
  {
    defId: 'royal_carpet',
    name: '绒毛花纹地毯 (Plush Carpet)',
    category: 'decoration',
    roomSubTab: 'decor',
    interiorOnly: true,
    cost: { wood: 4, leather: 2 },
    hp: 70,
    w: 2,
    h: 2,
    passable: true,
    tags: ['decor', 'interior'],
    icon: 'royal_carpet',
    desc: '【室内装饰 · 选中房间布置】2×2 华丽手工编织地毯，可自由踩踏通行，提升房间奢华感 (+28 美观)。',
  },

  // ================= 5. 房间内部：工作台 (Room Workbenches: 选中房间后布置) =================
  {
    defId: 'stove',
    name: '中华/边缘猛火炉灶 (Artisan Stove)',
    category: 'production',
    roomSubTab: 'workbench',
    interiorOnly: true,
    cost: { wood: 10, ore: 4 },
    hp: 120,
    w: 2,
    h: 1,
    passable: false,
    tags: ['fire', 'stove', 'interior'],
    icon: 'stove',
    rotatable: true,
    desc: '【室内工作台 · 选中房间布置】2×1 专业厨房炉灶，可烹制黄金蛋炒饭、奶香菌菇炖肉、九宫格火锅与皇室满汉全席。',
  },
  {
    defId: 'spice_prep_table',
    name: '料理备菜与香料台 (Culinary Prep Bench)',
    category: 'production',
    roomSubTab: 'workbench',
    interiorOnly: true,
    cost: { wood: 8, stone: 4 },
    hp: 115,
    w: 2,
    h: 1,
    passable: false,
    tags: ['stove', 'production', 'interior'],
    icon: 'spice_prep_table',
    rotatable: true,
    desc: '【室内工作台 · 选中房间布置】2×1 精加工料理案台，研磨秘制香辛料、发酵奶酪、精修霜降肉排并制作刺身拼盘。',
  },
  {
    defId: 'butcher_table',
    name: '屠宰分解台 (Butcher Table)',
    category: 'production',
    roomSubTab: 'workbench',
    interiorOnly: true,
    cost: { wood: 8, ore: 2 },
    hp: 120,
    w: 2,
    h: 1,
    passable: false,
    tags: ['butcher', 'production', 'interior'],
    icon: 'butcher_table',
    rotatable: true,
    desc: '【室内工作台 · 选中房间布置】2×1 案板工作台，将猎物尸体精准分割为鲜切兽肉、雪花霜降肉排与毛皮。',
  },
  {
    defId: 'nutrient_paste_dispenser',
    name: '营养膏合成机 (Paste Dispenser)',
    category: 'production',
    roomSubTab: 'workbench',
    interiorOnly: true,
    cost: { wood: 6, ore: 10 },
    hp: 150,
    w: 2,
    h: 1,
    passable: false,
    tags: ['stove', 'power_node', 'interior'],
    icon: 'nutrient_paste_dispenser',
    rotatable: true,
    desc: '【室内工作台 · 选中房间布置】2×1 自动供餐机，高效率将生鲜食材合成为应急无菌营养膏。',
  },
  {
    defId: 'research_bench',
    name: '研究工作台 (Research Bench)',
    category: 'production',
    roomSubTab: 'workbench',
    interiorOnly: true,
    cost: { wood: 12, ore: 4 },
    hp: 120,
    w: 2,
    h: 1,
    passable: false,
    tags: ['research', 'power_node', 'interior'],
    icon: 'research_bench',
    rotatable: true,
    desc: '【室内工作台 · 选中房间布置】2×1 室内科研工作台，供殖民者研究新科技并提升智识技能。',
  },

  // ================= 6. 农田、露天仓储与防卫工事 (Zones & Security) =================
  {
    defId: 'field',
    name: '农田种植区 (Growing Zone)',
    category: 'zone',
    cost: { wood: 2 },
    hp: 60,
    w: 2,
    h: 2,
    passable: true,
    tags: ['field'],
    icon: 'field',
    minFertility: 0.5,
    desc: '2×2 农田种植区，可切换种植晶莹水稻、黄金甜玉米、精磨小麦、霜叶青菜、沙地土豆或药草根（需肥力 ≥50%）。',
  },
  {
    defId: 'store',
    name: '露天储物区 (Stockpile Zone)',
    category: 'zone',
    cost: { wood: 8 },
    hp: 150,
    w: 2,
    h: 2,
    passable: false,
    tags: ['storage'],
    icon: 'store',
    desc: '2×2 殖民地标准物资存放区。',
  },
  {
    defId: 'grand_stockpile_5x5',
    name: '大型仓储中心 (5×5 Stockpile)',
    category: 'zone',
    cost: { wood: 24, stone: 12 },
    hp: 400,
    w: 5,
    h: 5,
    passable: false,
    tags: ['storage', 'shelf'],
    icon: 'grand_stockpile_5x5',
    rotatable: true,
    desc: '5×5 殖民地主力仓储中心，支持商队交易与跨组物资调配。',
  },
  {
    defId: 'grave',
    name: '墓穴 (Grave)',
    category: 'zone',
    cost: { wood: 2 },
    hp: 120,
    w: 1,
    h: 1,
    passable: true,
    tags: ['grave', 'shelter'],
    icon: 'grave',
    desc: '体面安葬阵亡者遗体的墓穴，可消除露天看见尸体的负面心情。',
  },
  {
    defId: 'turret',
    name: '迷你机枪塔 (Mini-Turret)',
    category: 'security',
    cost: { wood: 6, ore: 10 },
    hp: 110,
    w: 1,
    h: 1,
    passable: false,
    tags: ['tower', 'turret', 'power_node'],
    icon: 'turret',
    desc: '1×1 自动防御机枪塔，自动射击视野内的敌袭者与猎物（耗电 80W）。',
  },
  {
    defId: 'tower',
    name: '沙袋掩体碉堡 (Bunker)',
    category: 'security',
    cost: { wood: 15 },
    hp: 140,
    w: 2,
    h: 2,
    passable: true,
    tags: ['tower', 'waypoint', 'shelter'],
    icon: 'tower',
    desc: '2×2 射击掩体工事，为驻守殖民者提供 55% 掩体减伤。',
  },
  {
    defId: 'trap',
    name: '尖刺陷阱 (Spike Trap)',
    category: 'security',
    cost: { wood: 4 },
    hp: 30,
    w: 1,
    h: 1,
    passable: true,
    tags: ['trap'],
    icon: 'trap',
    desc: '1×1 杀伤性木刺陷阱，敌军踩中时造成高额穿刺伤害。',
  },

  // ================= 7. 远古遗迹内部专属可搜刮设施 =================
  {
    defId: 'ancient_cryptosleep_casket',
    name: '远古休眠舱 (Cryptosleep Casket)',
    category: 'structure',
    cost: { ore: 10, gold: 2 },
    hp: 220,
    w: 2,
    h: 1,
    passable: false,
    tags: ['shelter', 'ancient_danger', 'ruin_scavenge'],
    icon: 'ancient_cryptosleep_casket',
    rotatable: true,
    ruinOnly: true,
    desc: '2×1 远古低温休眠舱，常见于遗迹内部，需派遣小人贴身破拆或搜刮内部物资。',
  },
  {
    defId: 'ancient_locker',
    name: '远古储物柜 (Ancient Locker)',
    category: 'structure',
    cost: { ore: 6 },
    hp: 140,
    w: 1,
    h: 1,
    passable: false,
    tags: ['storage', 'ruin_scavenge'],
    icon: 'ancient_locker',
    ruinOnly: true,
    desc: '遗迹房间内的密封金属储物柜，不能隔空搜刮，必须派遣小人行进至贴身旁才能搜刮。',
  },
  {
    defId: 'ancient_crate',
    name: '远古军用物资箱 (Ancient Supply Crate)',
    category: 'structure',
    cost: { wood: 4, ore: 4 },
    hp: 110,
    w: 1,
    h: 1,
    passable: false,
    tags: ['storage', 'ruin_scavenge'],
    icon: 'ancient_crate',
    ruinOnly: true,
    desc: '遗迹仓库中遗留的加固军需箱，不能隔空搜刮，必须派遣小人走到箱旁才能开箱搜刮。',
  },
  {
    defId: 'ancient_worktable',
    name: '远古实验终端 (Ancient Lab Terminal)',
    category: 'structure',
    cost: { ore: 8, gold: 2 },
    hp: 160,
    w: 2,
    h: 1,
    passable: false,
    tags: ['research', 'ruin_scavenge'],
    icon: 'ancient_worktable',
    rotatable: true,
    ruinOnly: true,
    desc: '2×1 遗迹科研主机与样本台，不能隔空搜刮，必须派遣小人贴身操作搜刮芯片与黄金。',
  },
];

/** 判断某个建筑定义是否为「外部设施（禁止放在室内）」 */
export function isExteriorOnlyBuilding(defId: string): boolean {
  const b = ARCHITECT_BUILDABLES.find((x) => x.defId === defId);
  return Boolean(b?.exteriorOnly);
}

/** 判断某个建筑定义是否为「房间内设/装饰/工作台（需选中房间后布置）」 */
export function isInteriorRoomBuilding(defId: string): boolean {
  const b = ARCHITECT_BUILDABLES.find((x) => x.defId === defId);
  return Boolean(b?.interiorOnly);
}
