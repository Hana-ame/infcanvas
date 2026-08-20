// 建筑扩展包（2026-08-20，用户「添加建筑包」）：箭塔/城墙/灯塔/水渠/仓库升级
// 设计：纯数据驱动——注册 5 个新建筑 def，每个有不同的 tag/meta/能力。
// 箭塔 = 防御（自动射击近身敌人）；城墙 = 不可走屏障；灯塔 = 光源+航海导航；
// 水渠 = passive 产水（farm 系统结算）；仓库 = resourceCap 提升。
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

export const buildingsExtraPack: ModPack = {
  id: 'buildings-extra',
  requires: ['build'],
  apply(m: ModRegistry): void {
    // 箭塔：自动防御建筑（meta.defense = { range, dmg }）
    m.registerBuilding({
      id: 'arrow-tower', name: '箭塔', size: { x: 1, y: 1 }, hp: 200, color: '#6a5a4a',
      emoji: '🏹', passable: false, buildTime: 5,
      tags: ['defense'], meta: { defense: { range: 8, dmg: 3 } },
      costWood: 20,
    });
    // 城墙：不可走屏障（高 HP，纯挡路）
    m.registerBuilding({
      id: 'wall-stone', name: '石墙', size: { x: 1, y: 1 }, hp: 500, color: '#888',
      emoji: '🧱', passable: false, buildTime: 3,
      tags: ['barrier'], meta: {},
      costWood: 5,
    });
    // 灯塔：大范围光源 + 航海导航锚点
    m.registerBuilding({
      id: 'lighthouse', name: '灯塔', size: { x: 1, y: 1 }, hp: 300, color: '#caa',
      emoji: '🗼', passable: false, buildTime: 8,
      tags: ['anchor', 'warmth', 'light'], meta: { heat: { radius: 8, power: 3 } },
      emitsLight: 12, costWood: 30,
    });
    // 仓库：提升 resourceCap（meta.storage = 附加容量）
    // 水渠已移至 waterworks 包（2026-08-20）
    m.registerBuilding({
      id: 'warehouse', name: '仓库', size: { x: 2, y: 2 }, hp: 200, color: '#7a6a5a',
      emoji: '🏚', passable: false, buildTime: 6,
      tags: ['storage'], meta: { storage: 200 },
      costWood: 25,
    });
  },
};