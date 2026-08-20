// 需求包（2026-08-21 从零重写）——食物/精力/心情/理智衰减
// 衰竭方向：food/rest 持续下降触发饥饿/困倦；mood 受环境；san 篝火恢复。
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

const F = {
  foodDecay: 1.2,     // 食物/秒（100→0 约 80 秒饿）
  restDecay: 0.7,     // 精力/秒
  sanDecay: 0.4,      // 理智/秒（野外精神消耗）
  sanRecover: 8,      // 篝火旁理智回复/秒
  restRecover: 6,     // 篝火旁精力回复/秒
  moodHungry: 0.3,    // 饥饿心情损失/秒
};

export const needsPack: ModPack = {
  id: 'needs',
  apply(m) {
    m.registerSystem({
      id: 'needs',
      category: 'needs',
      ctor: (sim: Sim) => ({
        id: 'needs',
        update(dt) {
          const camp = sim.campPos();
          for (const p of sim.pawns.values()) {
            p.needs.food = Math.max(0, p.needs.food - F.foodDecay * dt);
            p.needs.rest = Math.max(0, p.needs.rest - F.restDecay * dt);
            p.needs.san = Math.max(0, p.needs.san - F.sanDecay * dt);
            // 篝火恢复
            if (camp && Math.hypot(p.pos.x - camp.x, p.pos.y - camp.y) <= 2) {
              p.needs.san = Math.min(100, p.needs.san + F.sanRecover * dt);
              p.needs.rest = Math.min(100, p.needs.rest + F.restRecover * dt);
            }
            if (p.needs.food < 30) p.needs.mood = Math.max(0, p.needs.mood - F.moodHungry * dt);
          }
        },
      }),
    });
  },
};