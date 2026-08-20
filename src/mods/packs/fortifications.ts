// 战场工事 DLC（2026-08-20）：壕沟/拒马/鹿角/胸墙/地堡/铁丝网/碉堡
// 种子原则：只注册建筑 + tag（barrier/defense/fortify）→ raid 系统自然消费
// 工事 = 不可走/高 HP/有防御 tag → 敌人需绕行或拆毁，玩家用其构筑防线
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

const CFG = {
  trenchHp: 500,        // 壕沟：极高 HP（地道）+ 不可通行
  abatisHp: 200,        // 拒马：中等 HP + 不可通行 + 伤害经过敌人
  chevalHp: 150,        // 鹿角：低 HP + 不可通行 + 减速
  parapetHp: 300,       // 胸墙：高 HP + 不可通行 + 遮挡（light tag）
  bunkerHp: 800,        // 地堡：极高 HP + 可藏人 + 防御
  wireHp: 80,           // 铁丝网：低 HP + 不可通行 + 减速经过者
  pillboxHp: 600,       // 碉堡：高 HP + 防御 + 驻兵射击
  emplacementHp: 400,   // 炮台基座：中等 HP + 部署炮位
};

export const fortificationsPack: ModPack = {
  id: 'fortifications',
  requires: ['build'],
  apply(m: ModRegistry): void {
    // 壕沟：不可通行 + 极高 HP（地道结构，敌人需绕行）
    m.registerBuilding({
      id: 'trench', name: '壕沟', size: { x: 1, y: 3 }, hp: CFG.trenchHp, color: '#3a2a1a',
      emoji: '🕳', passable: false, buildTime: 8,
      tags: ['barrier', 'fortify'], meta: {},
      costWood: 10, costOre: 5,
    });

    // 拒马（abatis）：不可通行 + 伤害经过的敌人（meta.defense.dmg 接触伤害）
    m.registerBuilding({
      id: 'abatis', name: '拒马', size: { x: 1, y: 1 }, hp: CFG.abatisHp, color: '#5a3a2a',
      emoji: '🚧', passable: false, buildTime: 3,
      tags: ['barrier', 'defense', 'fortify'], meta: { defense: { range: 1, dmg: 5 } },
      costWood: 8,
    });

    // 鹿角（cheval de frise）：不可通行 + 减速经过的敌人
    m.registerBuilding({
      id: 'cheval', name: '鹿角', size: { x: 1, y: 1 }, hp: CFG.chevalHp, color: '#6a4a3a',
      emoji: '🔱', passable: false, buildTime: 2,
      tags: ['barrier', 'fortify'], meta: { slowMul: 0.5 },
      costWood: 5,
    });

    // 胸墙（parapet）：不可通行 + 高 HP + 遮挡（emitsLight=0 → 暗区屏障）
    m.registerBuilding({
      id: 'parapet', name: '胸墙', size: { x: 1, y: 2 }, hp: CFG.parapetHp, color: '#7a7a6a',
      emoji: '🧱', passable: false, buildTime: 5,
      tags: ['barrier', 'fortify', 'road'], meta: {},  // road tag → z 判定豁免（修路垫平）
      costWood: 12, costOre: 8,
    });

    // 地堡（bunker）：极高 HP + 可藏人（passable=true，小人躲入射击）
    m.registerBuilding({
      id: 'bunker', name: '地堡', size: { x: 2, y: 2 }, hp: CFG.bunkerHp, color: '#5a5a4a',
      emoji: '🏯', passable: true, buildTime: 10,
      tags: ['defense', 'fortify', 'shelter', 'warmth'], meta: { defense: { range: 8, dmg: 3 } },
      costWood: 30, costOre: 20,
      aura: { radius: 4, moodPerSec: 0.2 },
    });

    // 铁丝网：低 HP + 不可通行 + 减速
    m.registerBuilding({
      id: 'barbed-wire', name: '铁丝网', size: { x: 1, y: 2 }, hp: CFG.wireHp, color: '#9a9a8a',
      emoji: '⛓', passable: false, buildTime: 2, tech: 'craft:clothing',
      tags: ['barrier', 'fortify'], meta: { slowMul: 0.3 },
      costOre: 5,
    });

    // 碉堡（pillbox）：高 HP + 防御 + 驻兵射击（meta.defense = 远程）
    m.registerBuilding({
      id: 'pillbox', name: '碉堡', size: { x: 2, y: 2 }, hp: CFG.pillboxHp, color: '#6a6a5a',
      emoji: '🏰', passable: false, buildTime: 8, tech: 'shelter:house',
      tags: ['defense', 'fortify', 'barrier'], meta: { defense: { range: 10, dmg: 4 } },
      costWood: 25, costOre: 15,
    });

    // 炮台基座：部署炮位（建造在此上 → 射程加成）
    m.registerBuilding({
      id: 'emplacement', name: '炮台基座', size: { x: 2, y: 2 }, hp: CFG.emplacementHp, color: '#8a8a7a',
      emoji: '🎯', passable: false, buildTime: 6,
      tags: ['defense', 'fortify'], meta: { defenseRangeBonus: 1.5 },
      costWood: 15, costOre: 10,
    });

    // 科技：筑城术
    m.registerTech({ id: 'military:fortify', name: '筑城术', unlocks: ['trench','bunker','pillbox','emplacement'], desc: '建造壕沟/地堡/碉堡/炮台', fragments: 4 });
  },
};