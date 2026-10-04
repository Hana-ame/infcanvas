/**
 * social 包 —— 社交种子卡：闲聊（心情/关系）+ 口角（低心情翻脸）。
 *
 * 关系值（-100..100）是"事实层"：本阶段只有闲聊写它，未来外交/贸易/传闻包读它。
 * 口角不是脚本事件：概率 × 局面谓词（心情低）→ 效果表，事件从局面触发（原则②）。
 * 本包无系统——证明玩法可以纯由卡构成（系统不是必需品）。
 */
import type { ModPack } from '../pack';
import { SER_SOCIAL } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState } from '../../sim/types';

export const socialPack: ModPack = {
  id: 'social',
  requires: [],
  apply(m) {
    m.registerCard({
      id: 'chat',
      label: '闲聊',
      series: SER_SOCIAL,
      weight: 5,
      condition: (p, ctx) => neighborOf(p, ctx) !== null,
      action(p, ctx) {
        const other = neighborOf(p, ctx);
        if (!other) {
          ctx.finishCard(p); // 对方走了
          return;
        }
        const s = ctx.tuning.social;
        p.needs.mood = clamp100(p.needs.mood + s.chatMoodGain);
        other.needs.mood = clamp100(other.needs.mood + Math.round(s.chatMoodGain / 2));
        ctx.addRelation(p.eid, other.eid, s.chatRelGain);
        // 口角：局面谓词（有人心情很低）× 概率 → 负面效果。抽卡决定聊不聊，聊砸了是命运
        if (ctx.rng() < s.quarrelChance && Math.min(p.needs.mood, other.needs.mood) < s.lowMoodQuarrelAt) {
          p.needs.mood = clamp100(p.needs.mood - s.quarrelMoodHit);
          other.needs.mood = clamp100(other.needs.mood - s.quarrelMoodHit);
          ctx.addRelation(p.eid, other.eid, -s.quarrelRelHit);
          ctx.log(`😾 ${p.name} 和 ${other.name} 吵了一架`);
        }
        ctx.finishCard(p); // 一次一聊，聊完重抽（要不要继续社交交给权重）
      },
    });
  },
};

/** 最近邻鼠（聊天半径内） */
function neighborOf(p: PawnState, ctx: SimContext): PawnState | null {
  let best: PawnState | null = null;
  let bestD = ctx.tuning.social.chatRadius;
  for (const o of ctx.pawns()) {
    if (o.eid === p.eid) continue;
    const d = Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y);
    if (d <= bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}
