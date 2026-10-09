/**
 * client/presentation.ts —— 表现层文案/配色目录（客户端唯一权威）。
 *
 * 为什么单独一个模块（从 view.ts 拆出，2026-10-08 hud 维度）：
 *  view.ts 之前同时装两样东西——**视图契约**（WorldView 接口 + ColonySummary/PawnDetail
 *  等展示模型）与**表现数据表**（卡牌图标、特质配色、地形中文名）。契约是 sim 与
 *  渲染/HUD 之间的"接口"，数据表是"渲染长什么样"的实现细节；混在一个文件里，
 *  新增一张卡的图标要改契约文件，读者分不清"加接口"还是"加配色"。
 *
 *  拆开后依赖方向是单向且清晰的：presentation → view（只 import 类型），
 *  而 view 不再反向依赖任何表现数据。HUD/渲染层要显示名，走本模块；
 *  要契约与模型，走 view。
 *
 * 纪律（沿用原注释）：逻辑层的 card.label / 特质 name 不下发也够用，
 *  本模块本地化图标与配色，让画面更可读；新增卡片/特质时只改这里。
 */

/** 卡牌 → 图标+短标签：表现层数据，客户端唯一权威（逻辑层的 card.label 不下发也够用，
 *  这里本地化图标让画面更可读）。 */
export const CARD_LABEL: Record<string, string> = {
  gather_berry: '🍓采野果',
  chop_tree: '🪓砍树',
  eat: '🍎吃饭',
  sleep: '😴睡觉',
  wander: '🚶闲逛',
  chat: '💬闲聊',
  fight: '⚔迎战',
  flee: '🏃撤退',
  build_campfire: '🔥搭篝火',
  build_hut: '🏠盖棚屋',
  build_field: '🪏开垦农田',
  sow_field: '🌱播种',
  harvest_field: '🌾收割',
  cook: '🍖生火烤熟',
  build_store: '📦建仓库',
  // ↓ 种子句 R4 一轮新增（hunting/medicine/fortify/combat/factions 五包）：
  //   漏标的话 HUD 会显示原始 id（用户已指认过 3 次同类缺口，这里一次补齐）
  hunt: '🏹追猎',
  heal: '🩹照料',
  build_bed: '🛏盖病榻',
  build_wall: '🧱砌墙',
  build_tower: '🗼造哨塔',
  build_trap: '🕳挖陷阱',
  hold: '🛡据守',
  focus: '🎯集火',
  flank: '↩迂回',
  rally: '📣集结',
  trade: '🤝贸易',
  sample_pick_berry: '🫐摘蓝莓',
  _stun: '…愣住',
};

/** 卡 id → 图标+短标签（未知 id 回落原样显示，保证"漏标"可见而不是显示空白）。 */
export function cardLabel(id: string | null | undefined): string {
  if (!id) return '';
  return CARD_LABEL[id] ?? id;
}

/** 特质 → 显示色（表现层数据；逻辑层特质表只有 name 与 seriesMul 权重） */
export const TRAIT_COLOR: Record<string, string> = {
  strong: '#c96f4a',
  lazy: '#7d9c5a',
  owl: '#8a7fc9',
  workaholic: '#c9b24a',
  cheerful: '#d98aa6',
};

/** 地形 id → 中文名（悬停属性卡用；逻辑层只有判定用的 id） */
export const TERRAIN_NAME: Record<string, string> = {
  grass: '草地',
  dirt: '泥地',
  stone: '岩层',
  water: '水域',
};
