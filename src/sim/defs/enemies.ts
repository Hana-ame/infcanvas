// 敌对种类定义（数据驱动）：野狼等袭击敌人的一切数值进数据，raidSystem 从表查
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
  wolf: { id: 'wolf', name: '野狼', hp: 60, speed: 3.5, dmg: 5, loot: { item: 'ore', amount: 2 } },
};
