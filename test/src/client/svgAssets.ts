// SVG 素材路径索引 —— 2026-08-20 从内联 SVG 改为独立文件
// 所有 SVG 文件存放在 public/assets/svg/ 下，按类型分目录：
//   terrain/ 地形  building/ 建筑  pawn/ 鼠鼠  hostile/ 敌人  hud/ UI 图标
// 加载器（svgLoader.ts）从 URL 加载，Pixi 解析为 GraphicsContext（矢量清晰）
// 新增素材：在对应目录加 .svg 文件即可（32x32，viewBox 0 0 32 32）

const BASE = '/assets/svg';

// 地形
export const TERRAIN_SVG: Record<string, string> = {
  tree: `${BASE}/terrain/tree.svg`,
  ore: `${BASE}/terrain/ore.svg`,
  water: `${BASE}/terrain/water.svg`,
  stone: `${BASE}/terrain/stone.svg`,
};

// 建筑
// 建筑图标复用：通用类型图标（多建筑共用一个 SVG），专用图标独立文件。
// 查找优先级：BuildingDef.sprite → def.id → def.tags 匹配通用类型 → emoji
export const BUILDING_SVG: Record<string, string> = {
  // 专用图标（建筑 id → 独立 SVG）
  campfire: `${BASE}/building/campfire.svg`,
  wall: `${BASE}/building/wall.svg`,
  floor: `${BASE}/building/floor.svg`,
  door: `${BASE}/building/door.svg`,
  farm: `${BASE}/building/farm.svg`,
  workbench: `${BASE}/building/workbench.svg`,
  cave: `${BASE}/building/cave.svg`,
  church: `${BASE}/building/church.svg`,
  monument: `${BASE}/building/monument.svg`,
  fence: `${BASE}/building/fence.svg`,
  rampart: `${BASE}/building/rampart.svg`,
  raft: `${BASE}/building/raft.svg`,
  boat: `${BASE}/building/boat.svg`,
  bridge: `${BASE}/building/bridge.svg`,

  };


// 鼠鼠（按天赋 6 种）
export const PAWN_SVG: Record<string, string> = {
  mouse: `${BASE}/pawn/mouse.svg`,
  strong: `${BASE}/pawn/strong.svg`,
  devout: `${BASE}/pawn/devout.svg`,
  lazy: `${BASE}/pawn/lazy.svg`,
  workaholic: `${BASE}/pawn/workaholic.svg`,
  owl: `${BASE}/pawn/owl.svg`,
};

// 敌人
export const HOSTILE_SVG: Record<string, string> = {
  cat: `${BASE}/hostile/cat.svg`,
  generic: `${BASE}/hostile/generic.svg`,
};

// HUD UI 图标
export const HUD_SVG: Record<string, string> = {
  wood: `${BASE}/hud/wood.svg`,
  ore: `${BASE}/hud/ore.svg`,
  water: `${BASE}/hud/water.svg`,
  food: `${BASE}/hud/food.svg`,
  tools: `${BASE}/hud/tools.svg`,
  people: `${BASE}/hud/people.svg`,
  day: `${BASE}/hud/day.svg`,
  night: `${BASE}/hud/night.svg`,
  warn: `${BASE}/hud/warn.svg`,
  raid: `${BASE}/hud/raid.svg`,
  help: `${BASE}/hud/help.svg`,
  history: `${BASE}/hud/history.svg`,
  factions: `${BASE}/hud/factions.svg`,
  keys: `${BASE}/hud/keys.svg`,
  card: `${BASE}/hud/card.svg`,
  cancel: `${BASE}/hud/cancel.svg`,
  oracle: `${BASE}/hud/oracle.svg`,
};

// 根据天赋返回鼠鼠图标 id（与 HUD 共用）
export function pawnAssetIdFor(traits: readonly string[] | undefined): string {
  if (!traits || traits.length === 0) return "mouse";
  if (traits.includes("强壮")) return "strong";
  if (traits.includes("虔诚")) return "devout";
  if (traits.includes("懒惰")) return "lazy";
  if (traits.includes("工作狂")) return "workaholic";
  if (traits.includes("夜猫子")) return "owl";
  return "mouse";
}

// 敌人图标 id
export function hostileAssetId(enemyId: string): string {
  return enemyId === "cat" ? "cat" : "generic";
}

// 工具：SVG data URL（保留给旧代码兼容；新代码直接引用文件路径）
export function svgDataUri(svg: string): string {
  if (svg.startsWith("/assets/svg/")) return svg;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}
