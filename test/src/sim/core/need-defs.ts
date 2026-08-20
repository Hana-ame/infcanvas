// 需求注册表（2026-08-20，用户「需求可通过 DLC 添加」）：
// 原设计：NeedsComp 固定 4 字段（food/rest/mood/san），NeedsData 类型硬编码，
// tickNeeds 硬编码衰减逻辑 → DLC 无法添加新需求（如 hygiene/entertainment/warmth）。
// 本模块提供数据驱动的需求注册：DLC 调 registerNeedDef 注册新需求类型 +
// 衰减率 + 紧急阈值 → tickNeedsBatch 自动处理 + readNeeds 自动返回。

export interface NeedDef {
  id: string;              // 需求 id（如 'hygiene'）
  label: string;           // 显示名（如 '卫生'）
  init: number;            // 初始值（0-100）
  decay: number;           // 每秒衰减率
  nightDecayMul?: number;  // 夜晚衰减倍率（默认 1）
  urgentAt?: number;       // 紧急阈值（低于此值 = 紧急）
  starveDmg?: number;      // 归零时 HP 流失/s（如 food=0 → 饿死）
  moodLow?: number;        // 低于此值 → mood 流失
  moodHigh?: number;       // 高于此值 → mood 回升
  moodDriftDown?: number;  // mood 流失率
  moodDriftUp?: number;    // mood 回升率
  sanThreshold?: number;   // 低于此值 → san 流失
  sanDrain?: number;       // san 流失率
}

// 内置 4 需求定义（数据化原硬编码逻辑）
export const CORE_NEEDS: NeedDef[] = [
  { id: 'food', label: '饥饿', init: 80, decay: 0.15, urgentAt: 30, starveDmg: 2.5, moodLow: 30, moodHigh: 70, moodDriftDown: 0.5, moodDriftUp: 0.3, sanThreshold: 20, sanDrain: 0.2 },
  { id: 'rest', label: '精力', init: 90, decay: 0.1, nightDecayMul: 1.5, urgentAt: 20 },
  { id: 'mood', label: '心情', init: 60, decay: 0 },
  { id: 'san', label: '理智', init: 100, decay: 0, sanThreshold: 20, sanDrain: 0.2 },
];

// 需求注册表：id → NeedDef
const needRegistry = new Map<string, NeedDef>();

// 初始化内置需求
for (const def of CORE_NEEDS) needRegistry.set(def.id, def);

// 注册新需求类型（DLC 调用 → 需求注册表 + tickNeedsBatch 自动处理衰减）
export function registerNeedDef(def: NeedDef): void {
  needRegistry.set(def.id, def);
}

// 查询需求定义（衰减率/紧急阈值等配置）
export function getNeedDef(id: string): NeedDef | undefined {
  return needRegistry.get(id);
}

// 获取全部已注册需求定义（用于遍历衰减/紧急检查）
export function getAllNeedDefs(): NeedDef[] {
  return [...needRegistry.values()];
}

// 检查需求是否已注册（防重复）
export function isRegisteredNeed(id: string): boolean {
  return needRegistry.has(id);
}

// 获取所有需要衰减的需求（decay > 0）
export function getDecayingNeeds(): NeedDef[] {
  return getAllNeedDefs().filter(d => d.decay > 0);
}

// 获取所有会触发紧急的需求（有 urgentAt）
export function getUrgentNeeds(): NeedDef[] {
  return getAllNeedDefs().filter(d => d.urgentAt !== undefined);
}