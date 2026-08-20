// 行为决策包（2026-08-21 从零重写）——每 tick 简单意图选择
// 优先级：饿→找食物 / 困→回营地 / 有路径→走 / 闲→采集。
// 规则式（不搞抽卡），第一版最小正确。

import type { Sim } from '../../sim/sim';
import { isHarvested } from './gather';
import type { ModPack, Category } from '../pack';

const B = {
  hungryAt: 40,   // food < 此值 → 找食物
  tiredAt: 30,    // rest < 此值 → 回营地
  walkSpeed: 6,   // 格/秒
};

function moveTowards(sim: Sim, eid: number, tx: number, ty: number): void {
  const p = sim.pawns.get(eid)!;
  if (p.commandCd > 0) { p.commandCd -= B.walkSpeed / 60; return; } // 玩家命令冷却
  if (p.path.length === 0) p.path = sim.pathTo(eid, tx, ty);
}

export const behaviorPack: ModPack = {
  id: 'behavior',
  apply(m) {
    m.registerSystem({
      id: 'behavior',
      category: 'ai',
      ctor: (sim: Sim) => ({
        id: 'behavior',
        update(dt) {
          const camp = sim.campPos();
          for (const p of sim.pawns.values()) {
            // ① 玩家命令冷却：不自主
            if (p.commandCd > 0) { p.commandCd -= dt; continue; }
            // ② 走路径
            if (p.path.length > 0) {
              const next = p.path[0]!;
              const d = Math.hypot(next.x - p.pos.x, next.y - p.pos.y);
              const step = B.walkSpeed * dt;
              if (d <= step) {
                p.pos = next;
                p.path.shift();
                // 到达 = 触发格效果（采集/建造留在 gather/build 包处理）
              } else {
                p.pos.x += (next.x - p.pos.x) / d * step;
                p.pos.y += (next.y - p.pos.y) / d * step;
              }
              p.job = '移动';
              continue;
            }
            // ③ 饿 → 找食物（树/浆果 → 先采集树，简单：最近的树 = 食物源）
            if (p.needs.food < B.hungryAt) {
              const tree = sim.world.nearestOf('tree', p.pos.x, p.pos.y, 15);
              if (tree) {
                p.path = sim.pathTo(p.eid, tree.x, tree.y);
                p.job = '觅食';
                p.target = tree;
                continue;
              }
            }
            // ④ 困 → 回营地
            if (p.needs.rest < B.tiredAt && camp) {
              p.path = sim.pathTo(p.eid, camp.x, camp.y);
              p.job = '回家';
              continue;
            }
            // ⑤ 闲 → 采集最近的树（+木头），跳过已采（冷却中）
            const tree = (() => {
              for (let r = 1; r <= 15; r++) {
                const t = sim.world.nearestOf('tree', p.pos.x, p.pos.y, r);
                if (t && !isHarvested(t.x, t.y, sim.time)) return t;
              }
              return null;
            })();
            if (tree) {
              p.path = sim.pathTo(p.eid, tree.x, tree.y);
              p.job = '采集';
              p.target = tree;
            } else {
              p.job = '闲逛';
            }
          }
        },
      }),
    });
  },
};