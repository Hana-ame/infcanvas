// 敌袭包（2026-08-21 从零重写）——野猫周期来袭
// 简单：每 60s 一只野猫出现在营地边缘 → 走向营地 → 攻击最近的鼠。

import type { Sim } from '../../sim/sim';
import type { Hostile } from '../../sim/types';
import type { ModPack } from '../pack';

const R = {
  interval: 60,       // 袭击间隔（秒）
  catHp: 60, catDmg: 8, catSpeed: 4,
};

export const raidPack: ModPack = {
  id: 'raid',
  apply(m) {
    m.registerEnemy({ id: 'cat', name: '野猫', emoji: '🐈', hp: R.catHp, dmg: R.catDmg, speed: R.catSpeed });

    m.registerSystem({
      id: 'raid',
      category: 'raid',
      ctor: (sim: Sim) => {
        let timer = R.interval;
        return {
          id: 'raid',
          update(dt) {
            // 生成
            timer -= dt;
            if (timer <= 0) {
              timer = R.interval;
              const camp = sim.campPos();
              if (camp) {
                const h: Hostile = {
                  id: `cat${sim.time | 0}`, x: camp.x + 20, y: camp.y, hp: R.catHp, maxHp: R.catHp,
                  dmg: R.catDmg, speed: R.catSpeed, target: camp,
                };
                sim.hostiles.push(h);
                sim.events.push({ time: sim.time, text: '🐈 野猫来袭！' });
              }
            }
            // 移动 + 攻击
            for (const h of sim.hostiles) {
              const t = h.target;
              if (!t) continue;
              const d = Math.hypot(t.x - h.x, t.y - h.y);
              const step = h.speed * dt;
              if (d > 1) {
                h.x += (t.x - h.x) / d * step;
                h.y += (t.y - h.y) / d * step;
              }
              // 攻击最近鼠
              let best: { eid: number; d: number } | null = null;
              for (const p of sim.pawns.values()) {
                const pd = Math.hypot(p.pos.x - h.x, p.pos.y - h.y);
                if (pd <= 1.5 && (!best || pd < best.d)) best = { eid: p.eid, d: pd };
              }
              if (best) {
                const p = sim.pawns.get(best.eid)!;
                p.health.hp -= h.dmg * dt;
                if (p.health.hp <= 0) {
                  sim.events.push({ time: sim.time, text: `⚔ ${p.name} 被野猫杀死` });
                  sim.killPawn(p.eid, 'combat');
                }
              }
            }
            // 清理存活敌人（血量归零）
            sim.hostiles = sim.hostiles.filter((h) => {
              if (h.hp <= 0) {
                sim.stockpile.food += 5;
                sim.events.push({ time: sim.time, text: `⚔ 击杀野猫 +5 食物` });
                return false;
              }
              return true;
            });
          },
        };
      },
    });
  },
};