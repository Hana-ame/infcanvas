// 敌对种类定义（数据驱动）：野猫等袭击敌人的一切数值进数据，raidSystem 从表查
// mod 可 registerEnemy 新增种类，或 overrideTuning({combat:{raidEnemy:'id'}}) 切换袭击类型
export interface EnemyDef {
  id: string;
  name: string;
  hp: number;                 // 基础血量（袭击时 * 叙事压力）
  speed: number;              // 移速（格/秒）
  dmg: number;                // 每秒伤害
  faction?: string;           // 派系身份（'unit' 掠夺者触发征服逻辑，普通野怪不设）
  loot?: { item: string; amount: number }; // 击杀掉落
}

export const ENEMIES: Record<string, EnemyDef> = {
  // 天敌=野猫（2026-08-14 修正世界观：小人是鼠鼠，天敌是猫不是狼——狼是早期幻觉设定）
  cat: { id: 'cat', name: '野猫', hp: 60, speed: 3.5, dmg: 5, loot: { item: 'ore', amount: 2 } },
  // 派系掠夺者（派系 vs 派系袭击的兵种；faction 'unit' → 征服/UI 身份识别）
  raider: { id: 'raider', name: '掠夺者', hp: 90, speed: 3.5, dmg: 7, faction: 'unit', loot: { item: 'ore', amount: 4 } },
};
