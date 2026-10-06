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

// ---- 建筑功能标签（building 定义 / needs·raid·sim 读）----
export const K_TAG_FIRE = 'fire';
export const K_TAG_SHELTER = 'shelter';
export const K_TAG_STORAGE = 'storage';
/** 农田（farming 包写 / farming 包自读）：与上面三个的区别是它**可通行**——
 *  小人要能站进/走出自家田地才谈得上播种收割。跨包语义＝"这是可耕种的地块"。 */
export const K_TAG_FIELD = 'field';

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
