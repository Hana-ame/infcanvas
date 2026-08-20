// 建造包（2026-08-21 从零重写）——命令 + 营地效果
// campfire：熏暖回 san/rest（needs 包读 campPos）——本包注册建筑 def + build 命令。

import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const buildPack: ModPack = {
  id: 'build',
  apply(m) {
    m.registerBuilding({
      id: 'campfire', name: '篝火', emoji: '🔥',
      hp: 80, passable: false, costWood: 10, tags: ['warmth', 'anchor'],
    });
    m.registerBuilding({
      id: 'wall', name: '墙', emoji: '🧱',
      hp: 200, passable: false, costWood: 2, tags: ['barrier'],
    });
    m.registerBuilding({
      id: 'house', name: '小屋', emoji: '🏠',
      hp: 150, passable: true, costWood: 20, tags: ['shelter'],
    });

    m.registerCommand('build', (sim, args) => {
      const defId = args.buildingId as string;
      const x = args.x as number, y = args.y as number;
      const def = sim.reg.buildings.get(defId);
      if (!def) { sim.events.push({ time: sim.time, text: `⚠ 未知建筑 ${defId}` }); return; }
      const cost = def.costWood ?? 0;
      if (sim.stockpile.wood < cost) { sim.events.push({ time: sim.time, text: `⚠ 木材不足（需 ${cost}）` }); return; }
      const b = sim.world.addBuilding(defId, x, y);
      if (!b) { sim.events.push({ time: sim.time, text: '⚠ 该位置无法建造' }); return; }
      sim.stockpile.wood -= cost;
      sim.events.push({ time: sim.time, text: `🏗 建好了 ${def.name}` });
    });
  },
};