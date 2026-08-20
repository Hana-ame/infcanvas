// 采集包（2026-08-21 从零重写）——到达树/矿格后产出
// 简单：到达目标格停留 1s 产出（树→食物+木，矿→矿石）。不搞进度条工作系统。

import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

const G = {
  gatherTime: 1.0,    // 采集耗时（秒）
  woodPerTree: 5,     // 每棵树产出木材
  foodPerTree: 10,    // 每棵树产出食物（浆果）
  orePerRock: 3,      // 每块矿石
};

// 目标格状态（实体 → 正在采的格 + 计时）
const gathering = new Map<number, { x: number; y: number; t: number }>();

export const gatherPack: ModPack = {
  id: 'gather',
  apply(m) {
    m.registerSystem({
      id: 'gather',
      category: 'production',
      ctor: (sim: Sim) => ({
        id: 'gather',
        update(dt) {
          for (const p of sim.pawns.values()) {
            // 有"采集"目标且已到达 → 开始采
            const tg = p.target;
            const tgt = tg && Math.hypot(tg.x - p.pos.x, tg.y - p.pos.y) < 0.5;
            if (tgt && tg && p.job === '采集' && sim.world.tile(tg.x, tg.y) === 'tree') {
              const g = gathering.get(p.eid) ?? { x: tg.x, y: tg.y, t: 0 };
              g.t += dt;
              p.job = '采集中';
              if (g.t >= G.gatherTime) {
                // 产出
                sim.world.tiles[g.y]![g.x] = 'grass'; // 树砍掉
                sim.stockpile.wood += G.woodPerTree;
                sim.stockpile.food += G.foodPerTree;
                sim.events.push({ time: sim.time, text: `🌳 ${p.name} 采到 ${G.foodPerTree} 食物 + ${G.woodPerTree} 木` });
                gathering.delete(p.eid);
                p.target = undefined;
              } else gathering.set(p.eid, g);
            }
            // 矿
            if (tgt && tg && p.job === '采集' && sim.world.tile(tg.x, tg.y) === 'ore') {
              const g = gathering.get(p.eid) ?? { x: tg.x, y: tg.y, t: 0 };
              g.t += dt;
              p.job = '采矿中';
              if (g.t >= G.gatherTime) {
                sim.world.tiles[g.y]![g.x] = 'grass';
                sim.stockpile.ore += G.orePerRock;
                sim.events.push({ time: sim.time, text: `⛏ ${p.name} 采到 ${G.orePerRock} 矿石` });
                gathering.delete(p.eid);
                p.target = undefined;
              } else gathering.set(p.eid, g);
            }
          }
        },
      }),
    });
  },
};