// 敌对种类定义（数据驱动）：野猫等袭击敌人的一切数值进数据，raidSystem 从表查
// mod 可 registerEnemy 新增种类，或 overrideTuning({combat:{raidEnemy:'id'}}) 切换袭击类型
export interface EnemyDef {
  id: string;
  name: string;
  hp: number;                 // 基础血量（袭击时 * 叙事压力）
  speed: number;              // 移速（格/秒）
  climb: number;              // 通过能力：可攀爬的地形高差上限（用户 2026-08-14 设计：每个单位各自的通过能力）
  dmg: number;                // 每秒伤害
  faction?: string;           // 派系身份（'unit' 掠夺者触发征服逻辑，普通野怪不设）
  loot?: { item: string; amount: number }; // 击杀掉落
  // 捕食者（2026-08-16 用户设计"哈基米独行叼走"）：独行、目标=最近鼠、接触即叼走逃离——
  // 不走群体袭击/拆家/原地磨血路径；mod 可用 registerEnemy 定义自己的捕食者
  predator?: boolean;
  carrySpeedMul?: number;     // 叼走鼠后的逃跑移速倍率（数据驱动）
  // 冲刺技能（2026-08-16：猫的跳跃/冲刺——周期性向目标方向瞬间位移，越过近身反击圈）
  dash?: { range: number; cd: number; };
}

export const ENEMIES: Record<string, EnemyDef> = {
  // 天敌=野猫（2026-08-14 修正世界观：小人是鼠鼠，天敌是猫不是狼——狼是早期幻觉设定）
  // 猫 climb 2 > 鼠人 1：能爬上石头/矮坡追猎（各自通过能力差异化）
  // 2026-08-16 设计（用户）：哈基米 = 独行捕食者——力量速度远高于鼠鼠（基准 hp40/speed4 →
  // 猫 hp110/speed8），接触鼠直接叼走跑路，不纠缠不拆家。击杀掉落=肉（私有进口袋）
  // 2026-08-16 战斗平衡：hp 90→110（更扛揍）、speed 6.5→8（突围快，玩家更难拦）。
  cat: { id: 'cat', name: '野猫', hp: 110, speed: 8, climb: 2, dmg: 6, predator: true, carrySpeedMul: 1.5, loot: { item: 'food', amount: 3 }, dash: { range: 6, cd: 8 } },
  // 派系掠夺者（派系 vs 派系袭击的兵种；faction 'unit' → 征服/UI 身份识别）
  raider: { id: 'raider', name: '掠夺者', hp: 90, speed: 3.5, climb: 1, dmg: 7, faction: 'unit', loot: { item: 'ore', amount: 4 } },
};
