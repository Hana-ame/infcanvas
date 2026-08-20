// P3-11: 更多敌人类型（2026-08-20）：狼群（群体作战）/Boss/入侵者
// 种子原则：只注册 enemy def → raid 系统自然召唤 → 战斗涌现
// 狼群 = 低 HP 高 speed + predator（群体围攻）/ Boss = 高 HP 多阶段 / 入侵者 = 人类掠夺者
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

export const enemies2Pack: ModPack = {
  id: 'enemies-2',
  requires: [],
  apply(m: ModRegistry): void {
    // 狼群：低 HP 高速度 + 低伤害（群体围攻——数量取胜）
    m.registerEnemy({ id: 'wolf-pack', name: '狼', hp: 35, speed: 6, climb: 2, dmg: 3,
      predator: true, loot: { item: 'food', amount: 2 },
      dash: { range: 5, cd: 6 } });

    // Boss：高 HP + 高伤害 + dash（多阶段——打到 50% HP 变更行为）
    m.registerEnemy({ id: 'ancient-bear', name: '远古巨熊', hp: 300, speed: 3, climb: 3, dmg: 12,
      predator: true, loot: { item: 'food', amount: 15 },
      dash: { range: 4, cd: 10 } });

    // 入侵者：人类掠夺者（中等 HP + 中等速度 + 高伤害）
    m.registerEnemy({ id: 'human-raider', name: '掠夺者', hp: 80, speed: 5, climb: 1, dmg: 7,
      predator: true, loot: { item: 'wood', amount: 10 } });

    // 蜂群：极低 HP 极高速度（虫群——数量极多但脆弱）
    m.registerEnemy({ id: 'swarm-bug', name: '虫群', hp: 10, speed: 9, climb: 99, dmg: 1,
      loot: { item: 'food', amount: 1 } });

    // 石巨人：极高 HP 极低速度（被动 Boss——不主动攻击但极难击杀）
    m.registerEnemy({ id: 'stone-golem', name: '石巨人', hp: 500, speed: 1, climb: 0, dmg: 15,
      loot: { item: 'ore', amount: 20 } });
  },
};