/**
 * client/i18n.ts —— RimWorld UI 国际化与双语净化系统 (i18n: 纯净简体中文 `zh` / 原版英文 `en`)
 *
 * 核心职责：
 *  1. 彻底消除中文界面下夹杂括号英文（如 `概览 (Overview)`、`负重 (Mass carried)`、`栓动步枪 (Bolt-Action Rifle)`）的混排现象；
 *  2. 提供完整的 `zh` (简体中文) 与 `en` (English) 双语字典与实时切换能力（右下角 `🌐 中文 / EN` 按钮或快捷键 `L`）；
 *  3. 对来自模拟层 (`src/sim/*`) 与各 UI 模块的文本、HTML 模板提供无损本地化映射，确保在不破坏底层测试契约的前提下，UI 文字在中文/英文模式下均纯粹统一。
 */

export type UiLocale = 'zh' | 'en';

const STORAGE_KEY = 'infcanvas-rw-locale';

let currentLocale: UiLocale = (() => {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    // ignore storage errors in sandboxed iframe
  }
  return 'zh';
})();

export function getUiLocale(): UiLocale {
  return currentLocale;
}

export function setUiLocale(loc: UiLocale): void {
  currentLocale = loc;
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = loc === 'zh' ? 'zh-CN' : 'en';
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, loc);
    }
  } catch {
    // ignore
  }
}

export function toggleUiLocale(): UiLocale {
  const next: UiLocale = currentLocale === 'zh' ? 'en' : 'zh';
  setUiLocale(next);
  return next;
}

/** 双语选择器：中文模式返回 zh，英文模式返回 en */
export function t(zh: string, en: string): string {
  return currentLocale === 'en' ? en : zh;
}

/**
 * 固定词条中英精确对照表
 */
const ZH_TO_EN_EXACT: Record<string, string> = {
  // 顶栏与四角 HUD
  '▾ 殖民者顶栏': '▾ Colonists',
  '▸ 殖民者顶栏': '▸ Colonists',
  '▾ 信封与警报': '▾ Letters & Alerts',
  '▸ 信封与警报': '▸ Letters & Alerts',
  '▾ 检视面板': '▾ Inspect',
  '▸ 检视面板': '▸ Inspect',
  '▾ 指令栏': '▾ Gizmos',
  '▸ 指令栏': '▸ Gizmos',
  '▾ 指令栏 (Gizmos)': '▾ Gizmos',
  '▸ 指令栏 (Gizmos)': '▸ Gizmos',
  '殖民地物资总览': 'Colony Resources',
  '特色料理与多元食材': 'Meals & Ingredients',
  '米面谷物储备': 'Grains & Flour',
  '鲜肉/鱼生/禽蛋': 'Meat, Fish & Eggs',
  '香料/奶酪/百花蜜': 'Spices, Cheese & Honey',
  '果蔬与荧光菌': 'Produce & Glow-Caps',
  '战地草药': 'Herbal Medicine',
  '建筑与工业材料': 'Construction Materials',
  '原木建材': 'Wood Logs',
  '花岗石块': 'Granite Blocks',
  '精炼钢铁': 'Steel',
  '动物毛皮': 'Plainleather',
  '精密零件与贵金属': 'Components & Valuables',
  '精密零件': 'Components',
  '黄金储备': 'Gold',
  '全部': 'All',
  '➕ 新建组': '➕ New Group',
  '创建': 'Create',
  '悬停地面查看环境信息': 'Hover over terrain to inspect cell',
  // 底部主菜单栏
  '建筑规划': 'Architect',
  '工作指派': 'Work',
  '日程管制': 'Schedule',
  '小队行囊': 'Squads',
  '派系外交': 'Factions',
  'DLC与存档': 'DLC & Saves',
  '百科指南': 'Wiki Guide',
  // 检视窗页签
  '概览': 'Bio',
  '健康(部位)': 'Health',
  '装备/武器': 'Gear',
  '心情': 'Needs',
  '技能': 'Skills',
  '建筑详情': 'Building',
  '内设家具': 'Furniture',
  '室内装饰': 'Decor',
  '室内工作台': 'Workbenches',
  // Gizmos 指令栏
  '征召战斗': 'Draft',
  '解除征召': 'Undraft',
  '建造墙体': 'Build Wall',
  '建造房门': 'Build Door',
  '房间内设': 'Room Layout',
  '开采矿脉': 'Mine Vein',
  '砍伐乔木': 'Chop Wood',
  '拆除建筑': 'Deconstruct',
  '商队贸易': 'Caravan Trade',
  // 生理机能 (Capacities)
  '意识': 'Consciousness',
  '移动': 'Moving',
  '操作': 'Manipulation',
  '语言': 'Talking',
  '进食': 'Eating',
  '视觉': 'Sight',
  '听觉': 'Hearing',
  '呼吸': 'Breathing',
  '血液过滤': 'Blood Filtration',
  '血液循环': 'Blood Pumping',
  '消化代谢': 'Metabolism',
  '生殖能力': 'Fertility',
  // 资源与料理名称
  '高山稻米': 'Highland Rice',
  '晶莹稻米': 'Crystal Rice',
  '冰原土豆': 'Tundra Potato',
  '沙地粉土豆': 'Sand Potato',
  '甜玉米粒': 'Sweet Corn',
  '黄金甜玉米': 'Golden Sweet Corn',
  '精磨麦粉': 'Wheat Flour',
  '鲜切生兽肉': 'Raw Meat',
  '雪花霜降肉排': 'Prime Rib Cut',
  '冷水鲜鱼肉': 'Fresh Fish Fillet',
  '野禽鲜蛋': 'Wildfowl Egg',
  '野生甜浆果': 'Wild Berries',
  '林间野浆果': 'Wild Berries',
  '幽光洞穴蘑菇': 'Glow-Cap Mushroom',
  '霜叶甘蓝': 'Frost Cabbage',
  '霜叶脆青菜': 'Frost Greens',
  '野生琥珀蜂蜜': 'Amber Wild Honey',
  '秘制香辛料': 'Aromatic Spice',
  '窖藏醇香奶酪': 'Aged Cheese',
  '蜜汁炭烤野味串': 'Honey Roast Skewers',
  '篝火菌菇山芋吊锅': 'Campfire Mushroom Pot',
  '香草盐烤冷水鱼': 'Herb Grilled Fish',
  '黄金扬州蛋炒饭': 'Golden Egg Fried Rice',
  '红烧慢炖牛腩土豆煲': 'Braised Beef & Potato',
  '芝士奶油菌菇烩面': 'Creamy Mushroom Pasta',
  '浆果蜜糖松软厚松饼': 'Berry Honey Pancakes',
  '极地九宫格麻辣红油火锅': 'Polar Spicy Hotpot',
  '黑椒脆皮霜降牛排配烤蔬': 'Black-Pepper Prime Steak',
  '星海金汤芝士龙虾鱼柳釜饭': 'Imperial Seafood Rice Pot',
};

/**
 * 英文模式下的高频短语与子串替换表
 */
const ZH_FRAGMENT_TO_EN: ReadonlyArray<readonly [RegExp, string]> = [
  // Full drawer headers & building descriptions (must run BEFORE short word replacements!)
  [/建筑规划菜单 \(直接建造墙壁与门 \/ 外部设施禁放室内 · 室内内设\/装饰\/工作台请点击封闭房间后在房间面板内布置\)/g, "Architect Menu (Walls & Doors Direct · Exterior Only Outside · Click Enclosed Room to Furnish Indoors)"],
  [/工作指派总表 \(全宽模式 · 已自动隐藏侧栏窗口 · 左键调高 \/ 右键调低 · 从左至右优先执行\)/g, "Work Priorities (Full-Width · Left-Click Higher / Right-Click Lower · Executed Left to Right)"],
  [/承重与隔断墙体，支持左键拖拽连续画线，自动与四向邻墙和山体无缝连接并围合出可布置内设的封闭房间。/g, "Load-bearing wall. Drag to draw continuous lines; auto-connects 8-way corners and encloses indoor rooms."],
  [/分隔房间的通道门，殖民者可自由进出并保持室内封顶保温（围合后点击房间内部即可布置内设\/装饰\/工作台）。/g, "Room doorway. Colonists pass freely while keeping rooms enclosed and roofed for indoor furnishing."],
  [/铺设在高低地形交界处，柔化过渡并连通 z±1 台阶。/g, "Built on elevation edges to smoothly connect z±1 terrain steps."],
  [/3×2 露天光伏阵列，需露天采光，持续输出 \+1400W 清洁电力。/g, "3×2 outdoor solar array requiring open skylight; outputs +1400W clean power."],
  [/3×2 高耸风力涡轮机组，必须在室外旷野迎风运转，输出 \+1650W 强劲风电。/g, "3×2 outdoor wind turbine requiring open air; outputs +1650W wind power."],
  [/2×2 室外远距探照灯塔，通电后照亮并驱散半径 38 格战争迷雾（耗电 250W）。/g, "2×2 outdoor lighthouse beacon; clears 38-tile fog of war radius when powered (250W)."],
  [/2×2 巨型露天篝火信标，照亮并驱散半径 22 格迷雾，可炙烤野炊料理。/g, "2×2 outdoor great bonfire; clears 22-tile fog radius and roasts campfire dishes."],
  [/2×2 浓烟发电机组，需置于室外通风处，输出 \+1000W 电力。/g, "2×2 wood-fired generator placed outdoors for ventilation; outputs +1000W power."],
  [/1×1 简易露天营火，提供野外照明、取暖与炭烤肉串\/浓汤烹制。/g, "1×1 outdoor campfire providing warmth, light, and skewer/soup cooking."],
  [/1×1 地面绝缘输电线缆，支持拖拽铺设连接室外风电\/太阳能与室内用电设备。/g, "1×1 insulated power conduit; drag to connect outdoor generators with indoor appliances."],
  [/5×5 殖民地露天核心堡垒，内置 \+600W 发电机与远距视野信标。/g, "5×5 colony citadel hub with built-in +600W generator and long-range vision beacon."],
  [/1×2 舒适室内床铺，供殖民者安稳睡眠与伤员包扎恢复。/g, "1×2 comfortable indoor bed for colonist sleep and medical tending."],
  [/2×2 宽敞双人床铺，大幅加速睡眠与生命恢复。/g, "2×2 spacious double bed that accelerates rest and health recovery."],
  [/2×1 温馨实木餐桌，让殖民者优雅享用特色料理，避免无桌进食负面心情。/g, "2×1 solid wood dining table; prevents Ate Without Table mood penalty."],
  [/2×1 室内分层储物架，存放于货架上的食材与物资永不风化。/g, "2×1 indoor storage shelf; items stored on shelves never deteriorate."],
  [/2×1 室内大容量保鲜柜，妥善存放搜刮战利品与珍贵料理食材。/g, "2×1 insulated preservation cabinet for gourmet ingredients and scavenged loot."],
  [/1×2 室内防雨储能电池组，平衡电网负荷并提供 \+200W 稳压缓冲。/g, "1×2 indoor battery bank balancing grid load with +200W backup buffer."],
  [/1×1 翠绿室内盆景，显著提升房间美观度 \(\+15 美观\) 与居住者心情。/g, "1×1 indoor bonsai pot boosting room beauty (+15 Beauty) and mood."],
  [/1×1 精雕细琢的鼠族艺术雕像，大幅提升房间等级与美观度 \(\+45 美观\)。/g, "1×1 carved marble sculpture boosting room impressiveness (+45 Beauty)."],
  [/1×1 室内柔和照明灯具，驱散室内昏暗并提升房间工作与进食舒适度。/g, "1×1 warm indoor standing lamp eliminating darkness penalty."],
  [/2×2 华丽手工编织地毯，可自由踩踏通行，提升房间奢华感 \(\+28 美观\)。/g, "2×2 walk-over plush carpet adding luxury and warmth (+28 Beauty)."],
  [/2×1 专业厨房炉灶，可烹制黄金蛋炒饭、奶香菌菇炖肉、九宫格火锅与皇室满汉全席。/g, "2×1 chef stove for cooking Golden Egg Fried Rice, Creamy Stew, Hotpot & Royal Feast."],
  [/2×1 精加工料理案台，研磨秘制香辛料、发酵奶酪、精修霜降肉排并制作刺身拼盘。/g, "2×1 culinary prep bench for grinding spices, aging cheese, and slicing sashimi."],
  [/2×1 案板工作台，将猎物尸体精准分割为鲜切兽肉、雪花霜降肉排与毛皮。/g, "2×1 butcher table for yields of fresh meat, prime cuts, and leather."],
  [/2×1 自动供餐机，高效率将生鲜食材合成为应急无菌营养膏。/g, "2×1 automated dispenser synthesizing raw food into sterile nutrient paste."],
  [/2×1 室内科研工作台，供殖民者研究新科技并提升智识技能。/g, "2×1 indoor research bench for unlocking colony technologies."],
  [/2×2 农田种植区，可切换种植晶莹水稻、黄金甜玉米、精磨小麦、霜叶青菜、沙地土豆或药草根（需肥力 ≥50%）。/g, "2×2 growing zone for Crystal Rice, Sweet Corn, Wheat, Frost Greens, Potatoes, or Healroot (Fert ≥50%)."],
  [/2×2 殖民地标准物资存放区。/g, "2×2 standard colony stockpile zone."],
  [/5×5 殖民地主力仓储中心，支持商队交易与跨组物资调配。/g, "5×5 grand stockpile hub supporting caravan trade and cross-squad logistics."],
  [/体面安葬阵亡者遗体的墓穴，可消除露天看见尸体的负面心情。/g, "Respectful grave for burying the fallen, preventing Observed Corpse mood penalties."],
  [/1×1 自动防御机枪塔，自动射击视野内的敌袭者与猎物（耗电 80W）。/g, "1×1 automated defense mini-turret firing at hostiles in sight (80W)."],
  [/2×2 射击掩体工事，为驻守殖民者提供 55% 掩体减伤。/g, "2×2 sandbag bunker providing 55% cover damage reduction to defenders."],
  [/1×1 杀伤性木刺陷阱，敌军踩中时造成高额穿刺伤害。/g, "1×1 lethal spike trap dealing high piercing damage when stepped on."],

  // Terrains, Skills, Pawns, Squads, Log Phrases
  [/花岗岩山体/g, "Granite Mountain"],
  [/粗糙岩地/g, "Rough Stone"],
  [/肥沃黑土/g, "Rich Soil"],
  [/砾石地/g, "Stony Gravel"],
  [/深水/g, "Deep Water"],
  [/浅水/g, "Shallow Water"],
  [/沼泽/g, "Marsh"],
  [/沙地/g, "Sand"],
  [/泥地/g, "Packed Dirt"],
  [/壤土/g, "Loam Soil"],
  [/战地医疗/g, "Medicine"],
  [/掘地筑造/g, "Construction"],
  [/农艺烹饪/g, "Cooking & Plants"],
  [/科研巧工/g, "Intellectual"],
  [/精准射击/g, "Shooting"],
  [/社交谈判/g, "Social"],
  [/拖回尸体/g, "Hauling Corpse"],
  [/旅鼠·墨菲\(陌生人\)/g, "Murphy (Stranger)"],
  [/旅鼠·墨菲/g, "Murphy"],
  [/主力拓荒一组/g, "Alpha Squad"],
  [/远征搜刮二组/g, "Beta Squad"],
  [/机动护卫三组/g, "Gamma Squad"],
  [/主力拓荒/g, "Alpha Squad"],
  [/一组/g, ""],
  [/二组/g, ""],
  [/三组/g, ""],
  [/远征搜刮/g, "Beta Squad"],
  [/机动护卫/g, "Gamma Squad"],
  [/拓荒/g, " Squad"],
  [/聊了几句/g, "chatted briefly"],
  [/立起了篝火/g, "lit a campfire"],
  [/野营-/g, "Camp-"],
  [/ 和 /g, " and "],
  [/鼠1/g, "Ratkin 1"],
  [/鼠2/g, "Ratkin 2"],
  [/鼠3/g, "Ratkin 3"],
  [/鼠4/g, "Ratkin 4"],
  [/鼠5/g, "Ratkin 5"],
  [/鼠6/g, "Ratkin 6"],

  [/【室内内设 · 选中房间布置】/g, '[Indoor Furniture] '],
  [/【室内装饰 · 选中房间布置】/g, '[Indoor Decor] '],
  [/【室内工作台 · 选中房间布置】/g, '[Indoor Workbench] '],
  [/【外部设施 · 禁放室内】/g, '[Exterior Only] '],
  [/电网负荷：/g, 'Grid Load: '],
  [/未建电网/g, 'No Grid'],
  [/过载告警/g, 'Overloaded!'],
  [/正常运作/g, 'Operating Normally'],
  [/正常/g, 'Normal'],
  [/🏠 布置房间/g, '🏠 Furnish Room'],
  [/🏠 房间内设布置/g, '🏠 Room Layout'],
  [/🎯 选点放置/g, '🎯 Place'],
  [/⚡ 布置入室/g, '⚡ Auto-Furnish'],
  [/返回常规检视/g, 'Back'],
  [/返回检视/g, 'Back'],
  [/⚔ 征召待命/g, '⚔ Drafted'],
  [/⚔ 征召中/g, '⚔ Drafted'],
  [/空闲\/巡视/g, 'Idle / Patrol'],
  [/自由活动/g, 'Free Roam'],
  [/收起 \(ESC\)/g, 'Close (ESC)'],
  [/✕ 关闭 \(ESC\)/g, '✕ Close (ESC)'],
  [/墙壁与门/g, 'Walls & Doors'],
  [/外部设施 \(禁放室内\)/g, 'Exterior Only'],
  [/农田与仓储/g, 'Zones & Storage'],
  [/防卫工事/g, 'Security'],
  [/作业指令/g, 'Orders'],
  [/造价：/g, 'Cost: '],
  [/占地 /g, 'Size '],
  [/朝向 /g, 'Rot '],
  [/殖民者 \(编组\)/g, 'Colonist (Squad)'],
  [/当前作业状态/g, 'Current Activity'],
  [/擅长技能与热情/g, 'Skills & Passions'],
  [/🔢 数字优先级 \(1=最高 · 4=最低\)/g, '🔢 Manual Priorities (1=High · 4=Low)'],
  [/✔ 勾选模式 \(点击切换数字 1-4\)/g, '✔ Checkmark Mode (Click for 1-4)'],
  [/⚡ 按擅长技能自动分配/g, '⚡ Auto-Assign by Skill'],
  [/➕ 新建编组/g, '➕ New Squad'],
  [/商队贸易窗/g, 'Caravan Trade'],
  [/小队间物资调配/g, 'Squad Transfer'],
  [/小队成员/g, 'Members'],
  [/携带物资：/g, 'Inventory: '],
  [/地面尸体与猎物/g, 'Corpses & Game'],
  [/当前无遗体/g, 'No corpses on map'],
  [/周边派系据点外交与贸易：/g, 'Neighboring Faction Bases & Diplomacy:'],
  [/📍 镜头定位/g, '📍 Locate'],
  [/📍 定位/g, '📍 Locate'],
  [/贸易/g, 'Trade'],
  [/🎺 援军/g, '🎺 Request Aid'],
  [/🎁 赠礼\(\+18\)/g, '🎁 Gift (+18)'],
  [/🕵 盗窃\(-25\)/g, '🕵 Steal (-25)'],
  [/⛓ 绑架\(-45\)/g, '⛓ Kidnap (-45)'],
  [/⚔ 进攻/g, '⚔ Assault'],
  [/🚀 100人同屏压测/g, '🚀 Spawn 100 Pawns'],
  [/⏱ 帧率压测/g, '⏱ Benchmark'],
  [/🔍 全景视野/g, '🔍 Max Zoom'],
  [/💾 保存存档/g, '💾 Save'],
  [/⤴️ 读取存档/g, '⤴️ Load'],
  [/🎲 生成新地图/g, '🎲 New World'],
  [/● 已启用/g, '● Enabled'],
  [/○ 默认禁用/g, '○ Disabled'],
  [/停用此 DLC/g, 'Disable DLC'],
  [/启用此 DLC/g, 'Enable DLC'],
  [/加载 Mod/g, 'Load Mod'],
  [/☀ 全员标准作息/g, '☀ All Standard'],
  [/🌓 全员双相睡眠 \(\+心情\)/g, '🌓 All Biphasic (+Mood)'],
  [/殖民者/g, 'Colonist'],
  [/作息预设/g, 'Preset'],
  [/遇敌姿态/g, 'Hostility Response'],
  [/随身携药/g, 'Carry Meds'],
  [/🗡 迎击/g, '🗡 Attack'],
  [/🏃 逃跑/g, '🏃 Flee'],
  [/🛡 忽略/g, '🛡 Ignore'],
  [/标准/g, 'Std'],
  [/夜班/g, 'Night'],
  [/双相/g, 'Biphasic'],
  [/🤝 派系商队贸易/g, '🤝 Faction Trade'],
  [/⚖ 跨组零价调拨 \(P=0\)/g, '⚖ Squad Transfer (P=0)'],
  [/🪦 遗体搜刮窗 \(P=0\)/g, '🪦 Corpse Loot (P=0)'],
  [/排序：按分类/g, 'Sort: Category'],
  [/排序：按名称/g, 'Sort: Name'],
  [/排序：按价值/g, 'Sort: Value'],
  [/排序：按单重/g, 'Sort: Mass'],
  [/🍖 食物医药/g, '🍖 Food & Meds'],
  [/🪵 建材矿石/g, '🪵 Materials'],
  [/🔫 武器护甲/g, '🔫 Combat Gear'],
  [/⚙ 精密贵重/g, '⚙ Valuables'],
  [/食物医药/g, 'Food & Meds'],
  [/建材矿石/g, 'Materials'],
  [/武器护甲/g, 'Combat Gear'],
  [/精密贵重/g, 'Valuables'],
  [/特色料理/g, 'Culinary Dish'],
  [/单重/g, 'Mass'],
  [/我方持有/g, 'Colony Stock'],
  [/我方库存/g, 'Colony Stock'],
  [/商队库存/g, 'Trader Stock'],
  [/出售价/g, 'Sell Price'],
  [/收购价/g, 'Buy Price'],
  [/单价/g, 'Price'],
  [/主力拓荒一组/g, 'Alpha Squad'],
  [/远征搜刮二组/g, 'Beta Squad'],
  [/机动护卫三组/g, 'Gamma Squad'],
  [/主力组/g, 'Alpha'],
  [/主力/g, 'Alpha'],
  [/远征/g, 'Beta'],
  [/机动/g, 'Gamma'],
  [/崩溃离队/g, 'Wild'],
  [/访客/g, 'Visitor'],
  [/移速/g, 'Move Speed'],
  [/肥力/g, 'Fertility'],
  [/视野/g, 'Vision'],
  [/可见/g, 'Visible'],
  [/迷雾/g, 'Fogged'],
  [/室外/g, 'Outdoors'],
  [/室内/g, 'Indoors'],
  [/墙体\/门\/山体/g, 'Wall / Door / Rock'],
  [/平坦草地/g, 'Grassland'],
  [/肥沃黑土/g, 'Rich Soil'],
  [/沙砾荒地/g, 'Gravel'],
  [/浅水滩/g, 'Shallow Water'],
  [/高地岩台/g, 'Highland Rock'],
  [/天然岩体/g, 'Solid Rock'],
];

/**
 * 将形如 `"中文名称 (English Name)"` 的双语字符串按当前语言净化：
 *  - `zh` 模式：剔除紧跟在中文字符后面的 `(English Name)` 括号后缀，只保留纯净中文；
 *  - `en` 模式：优先提取括号内的英文名称（如 `"栓动步枪 (Bolt-Action Rifle)"` -> `"Bolt-Action Rifle"`），或查表翻译。
 */
export function tr(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (currentLocale === 'zh') {
    return stripMixedEnglishInZh(trimmed);
  }

  // English mode
  if (ZH_TO_EN_EXACT[trimmed]) return ZH_TO_EN_EXACT[trimmed];

  const parenMatch = trimmed.match(/^([^\n(]+?)\s*\(([A-Za-z][A-Za-z0-9\s.,·+'%/&-]{2,})\)(.*)$/);
  if (parenMatch) {
    const enInner = parenMatch[2].trim();
    const rest = parenMatch[3].trim();
    return rest ? `${enInner} ${localizeFragmentEn(rest)}` : enInner;
  }

  return localizeFragmentEn(trimmed);
}

/**
 * 在中文模式下，安全剥离紧跟在中文字符或中文词汇后的 `(English...)` 混排括号，
 * 绝不触碰 HTML/CSS 函数（如 `rgb(...)`、`min(...)`）或快捷键 `(ESC)` / `(R)` / `(1×1)`。
 */
function stripMixedEnglishInZh(str: string): string {
  return str.replace(/([\u4e00-\u9fa5])\s*\(([A-Za-z][A-Za-z0-9\s.,+'%/&-]{2,})\)/g, (full, zhChar: string, inner: string) => {
    const clean = inner.trim();
    // 保留快捷键提示如 (ESC), (Space)
    if (clean === 'ESC' || clean === 'Space') return full;
    return zhChar;
  });
}

function localizeFragmentEn(str: string): string {
  let out = ZH_TO_EN_EXACT[str] ?? str;
  // 将形如 "中文词组 (English Phrase)" 的部分替换为括号内的 "English Phrase"
  out = out.replace(/([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_·/]*)\s*\(([A-Za-z][A-Za-z0-9\s.,+'%/&-]{2,})\)/g, '$2');
  for (const [re, rep] of ZH_FRAGMENT_TO_EN) {
    out = out.replace(re, rep);
  }
  return out;
}

/**
 * 对整段 HTML 模板字符串进行当前语言的自动本地化：
 *  - `zh` 模式：剥离冗余的 `(English)` 双语括号，使中文界面 100% 纯净无夹生英文；
 *  - `en` 模式：提取括号内英文并替换常用 HUD 词条为纯正 RimWorld 英文。
 */
export function localizeHtml(html: string): string {
  if (!html) return html;
  if (currentLocale === 'zh') {
    return stripMixedEnglishInZh(html);
  }
  return localizeFragmentEn(html);
}
