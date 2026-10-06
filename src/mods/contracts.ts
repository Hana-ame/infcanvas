/**
 * contracts.ts —— 跨包契约（原则⑦）：跨包共享的字符串键一律常量化 + 统一校验。
 *
 * 纪律来源：旧项目曾因裸串 'worn' 拼写漂移埋雷。规则：
 *  - 跨包键（一个包写、另一个包读）→ 必须用这里的 K_* 常量，拼错 = 编译期错误；
 *  - 单包自洽键（写读同包）不入表，但命名要能看出归属；
 *  - validateContracts 在默认装配末尾跑：语义级校验（如策略卡引用的系列必须真实存在），
 *    卸载写方 = 校验自然通过（空真不误伤卸载纪律）。
 */

// ---- 资源池键（gathering 写 / building·needs 读）----
export const K_STOCK_FOOD = 'food';
export const K_STOCK_WOOD = 'wood';
/** 熟食（R3-4 cooking 包写 / needs.eat 读）：与 K_STOCK_FOOD 是**并列的第二种食物**，
 *  不是 food 的子类——两者都直接喂饱食，只是熟食每份换到的饱食更多（见 tuning.cooking）。
 *  为什么需要第二个键（而不是给 food 加一个"熟/生"标记）：存档/协议/库存都是扁平
 *  的 Record<string,number>（`ctx.stockpile`），加一个键是唯一能随档、天然分池、
 *  且卸载 cooking 包后自然残留不报错的做法（原则④卸载不破坏核心）。 */
export const K_STOCK_MEAL = 'meal';
/** 生肉（hunting 包写 / needs.eat·cooking 读）：与 food/meal 并列的第三种食物，
 *  每份饱食介于生食与熟食之间（见 tuning.hunting）。肉类走独立键而非 food 的子标记，
 *  理由与 K_STOCK_MEAL 相同——扁平 Record<string,number> 库存里，加键是唯一能随档、
 *  天然分池、且卸载 hunting 包后残留不报错的做法。 */
export const K_STOCK_MEAT = 'meat';
/** 草药（medicine 包写 / medicine 照料卡读）：治疗材料，非食物。 */
export const K_STOCK_HERB = 'herb';

// ---- 建筑功能标签（building 定义 / needs·raid·sim 读）----
export const K_TAG_FIRE = 'fire';
export const K_TAG_SHELTER = 'shelter';
export const K_TAG_STORAGE = 'storage';
/** 农田（farming 包写 / farming 包自读）：与上面三个的区别是它**可通行**——
 *  小人要能站进/走出自家田地才谈得上播种收割。跨包语义＝"这是可耕种的地块"。 */
export const K_TAG_FIELD = 'field';
/** 防御建筑标签（fortify 包写 / combat·factions 读）：三者都可通行与否各有语义，
 *  但共享一个"这是防御工事"的跨包语义，供 raid 的索敌范围/据守卡判定使用。 */
export const K_TAG_WALL = 'wall';   // 围墙：阻挡通行，低血，纯迟滞
export const K_TAG_TOWER = 'tower'; // 哨塔：可通行（站人），据守卡在此自动集火
export const K_TAG_TRAP = 'trap';   // 陷阱：可通行但踩中扣血（被动伤害）
/** 病榻（medicine 包写 / medicine 照料卡读）：重伤鼠在此照料效率更高。 */
export const K_TAG_BED = 'bed';
/**
 * 寻路航点（内核 fireAnchorsList 读）：长距寻路的分段中转锚点。
 *
 * 为什么单独一个标签而不是复用 K_TAG_FIRE：篝火天然有航点价值（营地核心），
 * 但哨塔/地标也值得做航点（用户 2026-10-07「标志位扩展到哨塔/地标」）。
 * 若让哨塔挂 'fire' 标签来蹭航点，副作用是它会进入所有
 * `nearestBuildingByTag('fire')` 的查询（cooking 会在哨塔旁开火、sleep 会在哨塔旁
 * 结算火旁恢复）——那是语义污染，不是复用。两个标签各司其职：
 *   'fire' = 热源（取暖/烹饪/火旁恢复的语义锚点）
 *   'waypoint' = 纯寻路中转（无热源语义）
 * 火堆同时挂两个标签。
 */
export const K_TAG_WAYPOINT = 'waypoint';

/** 工作系列词汇表（卡的 series）：需求钩子/特质 seriesMul 按系列命中。
 *  跨包词汇 → 常量 + 登记校验。（原"策略卡引用校验"随"××令"移除一并删除） */
export const SER_GATHER = 'gather'; // 采集食物
export const SER_WOOD = 'wood'; // 砍木
export const SER_BUILD = 'build'; // 兴建
export const SER_EAT = 'eat';
export const SER_REST = 'rest';
export const SER_SOCIAL = 'social';
export const SER_WANDER = 'wander';
export const SER_FIGHT = 'fight';
export const SER_FLEE = 'flee';
export const SER_FARM = 'farm'; // 农耕（开垦/播种/收割）
/** 烹饪（R3-4 cooking 包）：与 SER_GATHER/SER_FARM 同为"把食物弄到手"的系列，
 *  但走的是火——它把"火的第三个用途"变成一条独立的抽卡系列，好让需求钩子能单独
 *  调制（例：缺火时压低 cooking 权重，见 cooking.ts 的 hook）。 */
export const SER_COOK = 'cook';
/** 狩猎（hunting 包）：追击被动动物 + 取肉。与 SER_GATHER 的区别是目标**会跑**，
 *  所以它是一条独立的抽卡系列，恐惧钩子/熟练度调制可以单独命中。 */
export const SER_HUNT = 'hunt';
/** 医疗（medicine 包）：照料重伤同伴。与 SER_SOCIAL 同为"陪伴型"系列，但结算的是 HP。 */
export const SER_HEAL = 'heal';
/** 防御（combat 包）：据守/集火/伏击。与 SER_FIGHT 的区别是 SER_FIGHT 是追击敌人，
 *  本系列是"让敌人在我设计的战场上挨打"——大兵团战术的入口。 */
export const SER_DEFEND = 'defend';
/** 贸易（factions 包）：与友好派系互访换货。 */
export const SER_TRADE = 'trade';

/** 全部合法系列（新系列必须在此登记，否则 validateContracts 报错） */
export const ALL_SERIES: readonly string[] = [
  SER_GATHER,
  SER_WOOD,
  SER_BUILD,
  SER_EAT,
  SER_REST,
  SER_SOCIAL,
  SER_WANDER,
  SER_FIGHT,
  SER_FLEE,
  SER_FARM,
  SER_COOK,
  SER_HUNT,
  SER_HEAL,
  SER_DEFEND,
  SER_TRADE,
];

import type { ModRegistry } from './registry';

/**
 * 装配末校验：所有注册卡的 series 在词汇表内（防拼写漂移）。
 * 卸载对应玩法包后引用消失 = 自然通过，不误伤。
 */
export function validateContracts(reg: ModRegistry): string[] {
  const errors: string[] = [];
  for (const c of reg.cards) {
    if (!ALL_SERIES.includes(c.series)) errors.push(`卡 ${c.id} 引用未登记系列「${c.series}」`);
  }
  return errors;
}
