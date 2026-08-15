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
  z?: number; // 地形高度（桥面=1 > 水面=0 > 深水=-1）；渲染/通行分层用
  passable: boolean; // 小人能否走过
  buildable: boolean; // 能否在上面建造
  color: string; // 渲染色（P0 用色块，后期换纹理）
  emoji?: string; // 地块上的装饰图标（树/矿）
  mineral?: boolean; // 是否可开采资源
  growable?: boolean; // 是否可收获（如树）
  shelter?: boolean;  // 天然庇护（洞穴等）：休息/心情恢复（needsSystem 消费；未改造也有房屋属性）
  moveCost?: number; // 寻路代价（默认 1）
  harvest?: HarvestDef; // 采集定义（树/矿），生产数值进数据
  harvestReplaces?: string; // 采集后替换的 tile id（缺省：growable→'grass'，mineral→'dirt'）
  // 生成层点缀声明（2026-08-15 数据化：原 spice/flax/red/blue/yellow 写死在 noise.ts 的
  // 玩法规则迁出）——本地形以 density 概率点缀在 on 地形上（缺省 'grass'），轴种子由
  // World 构造按 defs 收集序从主 seed 派生（独立轴：改任一密度不影响其它点缀的坐标 hash）。
  // 内核只按声明生成（引擎领域），点缀什么/密度多少 = 玩法数据（spiceBush 香料丛先例
  // 2026-08-14 同步迁入；clothing 亚麻丛/染料丛 2026-08-15 由此接入）
  sparse?: { density: number; on?: string };
  sprite?: string; // 客户端表现层：素材 id（如 'terrain:tree'），缺省按 growable/mineral/内置 id 推断；sim 不消费
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
  costWood?: number; // 额外木成本（奇观，默认 = size.x*size.y*2）
  costOre?: number; // 矿石成本（奇观）
  onWater?: boolean; // 只能建在水面（竹筏）：footprint 全水 + 邻接陆地/已有筏
  onCave?: boolean;   // 只能建在天然洞穴上（洞穴改造：caveHouse）
  onTunnel?: boolean; // 地道入口（另一维度）：任何地表格可挖（"与地图不产生关联"——不受地形/高差约束）
  z?: number;         // 建筑高度（道路=坡道垫平用；缺省沿用所在格地形 z）
  replacesTile?: string; // 地形改造：完成后把 footprint 格替换为该 tile（修桥 = 水格变桥面）
  tags?: string[]; // 语义标签（数据驱动：mod 新建筑打标签即接入系统行为）
  recipe?: string; // 生产配方 id（引用 RECIPES，农田/工作台/矿洞）
  upgradesTo?: string; // 原地升级目标 id（如篝火→教堂；建该目标时若原地是此建筑则升级而非新建）
  tech?: string; // 需要的科技 id（缺省无需科技；科技卡抽到后解锁建造）
  capabilities?: string[]; // 能力声明（数据驱动：'oracle' 等；替代按 defId 特判）
  emitsLight?: number; // 发光半径（>0 参与光照图，替代按 'campfire' 特判）
  aura?: {         // 光环定义（篝火/奇观），收敛 needsSystem/sanSystem 写死数值
    radius?: number;
    moodPerSec?: number;
    restPerSec?: number;
    sanPerSec?: number;
  };
  sprite?: string; // 客户端表现层：素材 id（如 'building:church'），缺省 `building:${id}`；sim 不消费
  // 玩法包自定义字段（2026-08-14 插件化大系统实验：电力 power{gen/storage/use}、
  // 温度 heat、贸易 rate、囚犯容量等由各玩法包声明语义并自行读取；内核不读未知键，
  // 只保证随 def 注册/覆盖流通——避免"加个系统就要改内核类型"）
  meta?: Record<string, unknown>;
}

export interface ItemDef {
  id: string;
  name: string;
  // 库存语义（2026-08-15 审计第三轮清理）：stackable/maxStack 已删——当前库存 =
  // Record<id, number> 统一计数无上限，两字段只有写方无读方（"预留" = 猜测需求，
  // 审计裁决不留无消费字段）；未来实现"不可堆叠/库存上限"时在 ItemDef 重新声明即可
  // 玩法包自定义字段（2026-08-15 clothing 制衣玩法包补上：对齐 BuildingDef.meta 的
  // 通用扩展容器——2026-08-14 插件化大系统实验确立"defs.meta = 玩法包自由声明语义、
  // 内核不读未知键"；ItemDef 此前缺 meta 导致跨包数据通道断裂（thermo 要读衣服保暖值，
  // 没有 defs 通道就得包间写死耦合）。clothing 用 meta.warmth（正=御寒/负=散热）、
  // meta.wearable（可穿标记，HUD 过滤）；语义由玩法包声明并自行读取）
  meta?: Record<string, unknown>;
}

// 地表定义表（消费方：地图生成/寻路通行与代价/采集系统 harvest/客户端渲染；tile id 同时是存档 key）
// z = 地形高度（海拔）：高差判定 |Δz| > 单位通过能力(climb) 则无法上下（用户 2026-08-14 设计）
// stone z2 = 石丘（高地）：与低地 Δ2 → 鼠人 climb1 上不去（修路/地道翻越）——"生成高低差地图"（2026-08-14）
export const TILES: Record<string, TileDef> = {
  grass: { id: 'grass', name: '草地', z: 0, passable: true, buildable: true, color: '#3a7d44' },
  dirt: { id: 'dirt', name: '泥土', z: 0, passable: true, buildable: true, color: '#8b6f47' },
  sand: { id: 'sand', name: '沙滩', z: 0, passable: true, buildable: true, color: '#d9c98a' },
  desert: { id: 'desert', name: '沙漠', z: 0, passable: true, buildable: true, color: '#c2b280' },
  water: { id: 'water', name: '水', z: 0, passable: false, buildable: false, color: '#2a6bb0', emoji: '💧' },
  bridge: { id: 'bridge', name: '桥面', z: 1, passable: true, buildable: false, moveCost: 2, color: '#8a6432', emoji: '🌉' },
  stone: { id: 'stone', name: '石头', z: 2, passable: true, buildable: true, color: '#8a8a8a', emoji: '🪨' },
  cave: { id: 'cave', name: '洞穴', z: 0, passable: true, buildable: false, shelter: true, moveCost: 1.5, color: '#3a2a1a', emoji: '🕳️' },
  mountain: { id: 'mountain', name: '山地', z: 2, passable: false, buildable: false, color: '#4a4a4a' },
  tree: {
    id: 'tree', name: '树木', z: 1, passable: false, buildable: false, color: '#2e5d2e', emoji: '🌳',
    growable: true,
    harvest: { product: 'wood', time: 2.5, yieldSuccess: 5, yieldFail: 2, dc: 55 },
  },
  // 香料丛（2026-08-14 香料玩法）：低矮灌木，可通行（不像树挡路——出生圈连通性/破口
  // 逻辑都无需特判）；growable + harvest 自动接入采集（cardSystem workChop 谓词
  // `growable && harvest` 数据驱动命中，采集后变 grass）。产出 spice 供篝火加料烤制。
  spiceBush: {
    id: 'spiceBush', name: '香料丛', z: 0, passable: true, buildable: false, moveCost: 1.2,
    color: '#5a8a3a', emoji: '🌿',
    growable: true,
    harvest: { product: 'spice', time: 1.5, yieldSuccess: 2, yieldFail: 1, dc: 50 },
    // 生成层点缀（2026-08-15 数据化：原 noise.ts 写死分支迁入——草地约 0.5% 密度，
    // 独立轴种子由 World 构造派生；灌木可通行不挡路，出生圈连通/破口零特判）
    sparse: { density: 0.005 },
  },
  ore: {
    id: 'ore', name: '矿脉', z: 1, passable: true, buildable: false, color: '#9c8a5a', emoji: '⛏️',
    mineral: true, moveCost: 2,
    harvest: { product: 'ore', time: 3, yieldSuccess: 3, yieldFail: 1, dc: 60 },
  },
};

// 建筑定义表（消费方：BuildSystem 建造/autobuild 规划/光环 aura/工作半径/升级 upgradesTo/科技门控 tech）
export const BUILDINGS: Record<string, BuildingDef> = {
  campfire: { id: 'campfire', name: '篝火', size: { x: 1, y: 1 }, hp: 80, color: '#4a2a1a', emoji: '🔥', passable: true, buildTime: 1, upgradesTo: 'church', emitsLight: 4, tags: ['anchor', 'warmth', 'heal', 'pray', 'social'], aura: { radius: 6, moodPerSec: 0.5, restPerSec: 0.3 } },
  wall: { id: 'wall', name: '墙', size: { x: 1, y: 1 }, hp: 200, color: '#8a8a8a', emoji: '🧱', passable: false, buildTime: 3, tags: ['barrier'] },
  fence: { id: 'fence', name: '篱笆', size: { x: 1, y: 3 }, hp: 100, color: '#8a6a3a', emoji: '🪵', passable: false, buildTime: 2, costWood: 6, tags: ['barrier', 'fence'] },
  rampart: { id: 'rampart', name: '城墙', size: { x: 1, y: 4 }, hp: 600, color: '#7a7268', emoji: '🏰', passable: false, buildTime: 10, costWood: 20, costOre: 6, tags: ['barrier', 'rampart'] },
  floor: { id: 'floor', name: '地板', size: { x: 1, y: 1 }, hp: 50, color: '#b8a884', emoji: '⬜', passable: true, buildTime: 1, tags: [] },
  door: { id: 'door', name: '门', size: { x: 1, y: 1 }, hp: 100, color: '#7a5a1a', emoji: '🚪', passable: true, buildTime: 2, tags: ['barrier'] },
  farm: { id: 'farm', name: '农田', size: { x: 2, y: 2 }, hp: 80, color: '#6a8a3a', emoji: '🌾', passable: true, buildTime: 4, tags: ['farm', 'food'], recipe: 'farm' },
  workbench: { id: 'workbench', name: '工作台', size: { x: 1, y: 1 }, hp: 300, color: '#5a3a1a', emoji: '🛠️', passable: false, buildTime: 5, tags: ['craft', 'tools'], recipe: 'workbench' },
  cave: { id: 'cave', name: '矿洞', size: { x: 1, y: 1 }, hp: 500, color: '#3a2a1a', emoji: '⛰️', passable: false, buildTime: 6, tags: ['mine'], recipe: 'cave' },
  church: { id: 'church', name: '教堂', size: { x: 2, y: 2 }, hp: 600, color: '#5a3a6a', emoji: '⛪', passable: false, buildTime: 12, tags: ['faith', 'anchor', 'oracle'], capabilities: ['oracle'] },
  monument: { id: 'monument', name: '纪念碑', size: { x: 3, y: 3 }, hp: 1200, color: '#8a7a5a', emoji: '🗿', passable: false, buildTime: 40, costWood: 60, costOre: 25, tags: ['wonder'], aura: { radius: 6, moodPerSec: 0.3 } },
  raft: { id: 'raft', name: '竹筏', size: { x: 1, y: 1 }, hp: 40, color: '#8a6a3a', emoji: '🛶', passable: true, buildTime: 2, onWater: true, recipe: 'fishing', tech: 'transport:raft', tags: ['raft', 'water'] },
  // 实验分支：四维度建筑（娱乐/取水/庇护）
  toy: { id: 'toy', name: '玩具', size: { x: 1, y: 1 }, hp: 40, color: '#c8605a', emoji: '🧸', passable: true, buildTime: 2, costWood: 4, tech: 'craft:toy', tags: ['toy', 'fun'], aura: { radius: 5, moodPerSec: 0.3 } },
  well: { id: 'well', name: '水井', size: { x: 1, y: 1 }, hp: 80, color: '#5a7a9a', emoji: '⛲', passable: true, buildTime: 3, costWood: 6, tech: 'water:well', recipe: 'well', tags: ['well', 'water'] },
  // 房屋造价高（用户定案：房屋造价要高）——木屋 = 昂贵庇护
  house: { id: 'house', name: '木屋', size: { x: 2, y: 2 }, hp: 150, color: '#7a5a3a', emoji: '🏠', passable: true, buildTime: 8, costWood: 30, tech: 'shelter:house', tags: ['house', 'shelter'], aura: { radius: 4, restPerSec: 0.5, moodPerSec: 0.2 } },
  // 洞穴居所：只能建在天然洞穴上（onCave），改造资源少（木 5 ≪ 木屋 30）——用户设计
  caveHouse: { id: 'caveHouse', name: '洞穴居所', size: { x: 1, y: 1 }, hp: 80, color: '#4a3a2a', emoji: '⛰️', passable: true, buildTime: 3, costWood: 5, onCave: true, tech: 'shelter:cave', tags: ['house', 'shelter'], aura: { radius: 3, restPerSec: 0.4, moodPerSec: 0.15 } },
  boat: { id: 'boat', name: '渡船', size: { x: 2, y: 2 }, hp: 120, color: '#7a5a2a', emoji: '⛵', passable: true, buildTime: 6, costWood: 12, onWater: true, tech: 'transport:boat', tags: ['raft', 'water'] },
  bridge: { id: 'bridge', name: '木桥', size: { x: 1, y: 1 }, hp: 60, color: '#8a6432', emoji: '🌉', passable: true, buildTime: 3, onWater: true, replacesTile: 'bridge', tech: 'transport:bridge', tags: ['raft', 'water'] },
  // 地道入口（2026-08-14 用户设计："地道不出现在地形上，是另外的判定，和地图不产生关联，
  // 是另一个维度"）——入口可挖在**任何地表格**（与地表地形/z 无关：平地/水/山/树上都能开口），
  // 入口之间由地下隧道直连（寻路虚拟边：成本 = 直线距离，速度无加成；无视地表地形/高差/建筑），
  // 地表**不渲染**（另一维度，不出现在地形上）。限制大宗物品：入口 1×1，格上不可建其他建筑
  tunnel: { id: 'tunnel', name: '地道', size: { x: 1, y: 1 }, hp: 150, color: '#5a4a2a', emoji: '🕳️', passable: true, buildTime: 4, costWood: 4, onTunnel: true, tags: ['tunnel'] },
  // 道路（2026-08-14 用户设计："可以修建道路"）——地表坡道：可建在可建地形上（草地/泥地/沙地/
  // 石头），出现在地形上（正常渲染）；高差判定豁免（修路 = 陡坡垫平，任何单位可沿路上下）
  road: { id: 'road', name: '道路', size: { x: 1, y: 1 }, hp: 60, color: '#c8b080', emoji: '🛤️', passable: true, buildTime: 2, costWood: 2, tags: ['road'] },
};

// 物品定义表（消费方：库存/物流/UI 显示——库存 = Record<id, number> 统一计数，无堆叠上限）
export const ITEMS: Record<string, ItemDef> = {
  wood: { id: 'wood', name: '木头' },
  ore: { id: 'ore', name: '矿石' },
  water: { id: 'water', name: '水' },
  food: { id: 'food', name: '食物' },
  spice: { id: 'spice', name: '香料' }, // 香料丛采集，篝火加料烹饪用（2026-08-14）
};
