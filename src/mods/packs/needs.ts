/**
 * needs 包 —— 需求衰减 + 吃/睡种子卡 + 饥饿疲惫权重调制。
 *
 * 原则①②的落点：饥饿不构成"必须吃"的规则——它只是把 eat/gather 系列卡的权重推高；
 * 抽不到就继续饿（饿出故事）。衰减速率全部读 tuning.needs，零硬编码。
 */
import type { ModPack } from '../pack';
import { K_STOCK_FOOD } from '../contracts';
import { SER_EAT, SER_REST, SER_GATHER, SER_SOCIAL, SER_WANDER, SER_FIGHT } from '../contracts';
import type { SimContext } from '../../sim/context';

export const needsPack: ModPack = {
  id: 'needs',
  requires: [],
  apply(m) {
    // ---- 系统：需求随时间衰减（类别 needs → 先于决策引擎执行）----
    m.registerSystemDef({
      id: 'needs',
      category: 'needs',
      ctor: (ctx: SimContext) => ({
        id: 'needs',
        update(dt) {
          const n = ctx.tuning.needs;
          for (const p of ctx.pawns()) {
            p.needs.food = clamp(p.needs.food - n.foodDecay * dt);
            p.needs.rest = clamp(p.needs.rest - n.restDecay * dt);
            p.needs.mood = clamp(p.needs.mood - n.moodDecay * dt);
            p.needs.san = clamp(p.needs.san - n.sanDecay * dt);
          }
        },
      }),
    });

    // ---- 权重钩子：需求只是权重输入（原则①：禁止 if-else 行为树）----
    m.registerHook('cardWeight', (p, card) => {
      const f = p.needs.food;
      if (card.series === SER_EAT) return f < 30 ? 4 : f < 55 ? 1.8 : 1;
      if (card.series === SER_GATHER) return f < 30 ? 2.5 : f < 55 ? 1.4 : 1;
      return 1;
    });
    m.registerHook('cardWeight', (p, card) => {
      const r = p.needs.rest;
      if (card.series !== SER_REST) return 1;
      return r < 25 ? 5 : r < 50 ? 2 : 1;
    });
    m.registerHook('cardWeight', (p, card) => {
      if (p.needs.mood >= 35) return 1;
      if (card.series === SER_SOCIAL) return 2; // 低落找同伴
      if (card.series === SER_WANDER) return 1.5;
      return 1;
    });
    m.registerHook('cardWeight', (p, card) => {
      if (p.needs.san >= 20) return 1;
      // 崩溃边缘：不想打架、只想缩起来
      if (card.series === SER_FIGHT) return 0.5;
      if (card.series === SER_REST) return 1.5;
      return 1;
    });

    // ---- 卡：闲逛（无活可干时的种子行为：随机小步走 + 微心情恢复。
    //      没有它，"什么卡都抽不中"的鼠只能吃引擎兜底——闲逛是玩法不是引擎职责）----
    m.registerCard({
      id: 'wander',
      label: '闲逛',
      series: SER_WANDER,
      weight: 3,
      duration: 3,
      action(p, ctx, dt) {
        if (p.path.length === 0) {
          // 随机方向 1~2 格，最多试 4 次挑可通行落点（随机源 = ctx.rng，同 seed 同闲逛史）；
          // 此前盲选常落在水上 → setPath 失败 → 鼠在水边呆立一整个卡期
          for (let i = 0; i < 4; i++) {
            const ang = ctx.rng() * Math.PI * 2;
            const dist = 1 + Math.floor(ctx.rng() * 2);
            const tx = Math.round(p.pos.x + Math.cos(ang) * dist);
            const ty = Math.round(p.pos.y + Math.sin(ang) * dist);
            if (ctx.passable(tx, ty)) {
              ctx.setPath(p, tx, ty);
              break;
            }
          }
        }
        p.needs.mood = clamp(p.needs.mood + 0.5 * dt); // 散步的微小治愈
      },
    });

    // ---- 卡：吃东西（营地仓库抽象；运货工作卡是未来玩法，不预设机制链）----
    m.registerCard({
      id: 'eat',
      label: '吃东西',
      series: SER_EAT,
      weight: 8,
      condition: (p, ctx) => p.needs.food < 95 && (ctx.stockpile[K_STOCK_FOOD] ?? 0) > 0,
      action: (p, ctx) => {
        // 即时结算卡：效果一次 + finishCard 防止 duration 内重复进食
        if ((ctx.stockpile[K_STOCK_FOOD] ?? 0) <= 0) {
          ctx.finishCard(p);
          return;
        }
        ctx.stockpile[K_STOCK_FOOD] -= 1;
        p.needs.food = clamp(p.needs.food + ctx.tuning.needs.eatFoodGain);
        p.needs.mood = clamp(p.needs.mood + ctx.tuning.needs.eatMoodGain);
        ctx.finishCard(p);
      },
    });

    // ---- 卡：睡觉（火旁睡得又快又安稳——火的价值观由数值自然表达）----
    m.registerCard({
      id: 'sleep',
      label: '睡觉',
      series: SER_REST,
      weight: 6,
      duration: 10,
      condition: (p) => p.needs.rest < 70,
      action(p, ctx, dt) {
        const n = ctx.tuning.needs;
        const fire = ctx.nearestBuildingByTag('fire', p.pos.x, p.pos.y, 8);
        if (fire && ctx.adjacent(p, fire.pos.x, fire.pos.y, 2.5)) {
          p.needs.rest = clamp(p.needs.rest + n.sleepRestNearFire * dt);
          p.needs.san = clamp(p.needs.san + n.sleepSanNearFire * dt);
          // 棚屋旁边睡：额外回心情（家的安全感——shelter 标签终于有功能了）
          const shelter = ctx.nearestBuildingByTag('shelter', p.pos.x, p.pos.y, 3);
          if (shelter) p.needs.mood = clamp(p.needs.mood + 1 * dt);
        } else {
          // 回火边睡；火被水/岩隔断就野外打盹（不站桩）
          if (fire && p.path.length === 0) ctx.setPath(p, fire.pos.x, fire.pos.y);
          p.needs.rest = clamp(p.needs.rest + n.sleepRestWild * dt);
        }
        if (p.needs.rest >= 98) ctx.finishCard(p); // 睡饱即醒
      },
    });
  },
};

export function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}
