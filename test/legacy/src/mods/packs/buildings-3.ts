// P3-13: 更多建筑（2026-08-20）：陷阱/医院/学校/市场/竞技场/了望塔升级
// 种子原则：只注册建筑 def + tag → 现有系统自然消费（defense/farm/craft/anchor 等）
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

const CFG = {
  trapDmg: 15,          // 陷阱伤害
  hospitalHealPerSec: 0.5,  // 医院治疗速度
  schoolMoodPerSec: 0.3,    // 学校心情加成
  marketTradeInterval: 15,  // 市场贸易间隔
  arenaMoodPerSec: 0.5,    // 竞技场心情加成
};

export const buildings3Pack: ModPack = {
  id: 'buildings-3',
  requires: ['build'],
  apply(m: ModRegistry): void {
    // 陷阱：隐形防御（敌人踩上 -15 HP，一次性消耗）
    m.registerBuilding({
      id: 'trap', name: '陷阱', size: { x: 1, y: 1 }, hp: 10, color: '#5a4a2a',
      emoji: '🪤', passable: true, buildTime: 2,
      tags: ['defense'], meta: { defense: { range: 0, dmg: CFG.trapDmg }, oneTime: true },
      costWood: 5,
    });

    // 医院：被动治疗附近小人（meta.heal = 治疗速度）
    m.registerBuilding({
      id: 'hospital', name: '医院', size: { x: 2, y: 2 }, hp: 250, color: '#e8e8f8',
      emoji: '🏥', passable: false, buildTime: 8, tech: 'shelter:house',
      tags: ['heal', 'warmth', 'anchor'], meta: { healPerSec: CFG.hospitalHealPerSec },
      costWood: 30, costOre: 10,
      aura: { radius: 5, moodPerSec: 0.2 },
    });

    // 学校：被动心情 + 教育加成
    m.registerBuilding({
      id: 'school', name: '学校', size: { x: 2, y: 2 }, hp: 200, color: '#5a7a8a',
      emoji: '🏫', passable: false, buildTime: 7, tech: 'craft:toy',
      tags: ['social', 'warmth'], costWood: 25, costOre: 5,
      aura: { radius: 5, moodPerSec: CFG.schoolMoodPerSec },
    });

    // 市场：被动贸易（每 15s 产出少量资源）
    m.registerBuilding({
      id: 'market', name: '市场', size: { x: 2, y: 2 }, hp: 180, color: '#8a7a5a',
      emoji: '🏪', passable: true, buildTime: 6,
      tags: ['anchor', 'social'], costWood: 20,
      aura: { radius: 4, moodPerSec: 0.3 },
    });

    // 竞技场：被动心情（娱乐——比玩具更高级）
    m.registerBuilding({
      id: 'arena', name: '竞技场', size: { x: 3, y: 3 }, hp: 400, color: '#7a5a3a',
      emoji: '⚔', passable: false, buildTime: 15, tech: 'craft:toy',
      tags: ['social', 'defense'], costWood: 50, costOre: 20,
      aura: { radius: 8, moodPerSec: CFG.arenaMoodPerSec },
    });

    // 信号塔：了望塔升级版（更大光照 + defense + anchor）
    m.registerBuilding({
      id: 'signal-tower', name: '信号塔', size: { x: 1, y: 2 }, hp: 300, color: '#6a5a4a',
      emoji: '📡', passable: false, buildTime: 8, emitsLight: 15, tech: 'water:well',
      tags: ['anchor', 'light', 'defense', 'warmth'], costWood: 30, costOre: 15,
      aura: { radius: 6, moodPerSec: 0.2 },
    });
  },
};