/**
 * social 包 —— 社交种子卡：闲聊（心情/关系）+ 口角（低心情翻脸）。
 *
 * 关系值（-100..100）是"事实层"：本阶段只有闲聊写它，未来外交/贸易/传闻包读它。
 * 口角不是脚本事件：概率 × 局面谓词（心情低）→ 效果表，事件从局面触发（原则②）。
 * 本包无系统——证明玩法可以纯由卡构成（系统不是必需品）。
 *
 * ---- 缺陷订正（2026-10-06）：闲聊卡从"硬闸"改成"磁铁" ----
 *
 * 【现象】闲聊卡条件失败率 97.0%，实测被抽中占比 1.5%——社交事实上是死代码。
 * 【原写法】`condition: (p, ctx) => neighborOf(p, ctx) !== null`，而
 *   neighborOf 用 `tuning.social.chatRadius = 2.5` 找同伴。问题在于**半径与
 *   鼠群实际密度差了 18 倍**：实测鼠群两两距离平均 46.4 格、中位 40.2 格，
 *   ≤2.5 格的抽样只有 **1.1%**。于是 condition 常年 false，社交永不发生。
 * 【为什么原来没人发现】它**不报错、不崩、测试也过**（早期测试里两只鼠被手动
 *   摆在一起，于是条件恰好成立）。这是一类"通过测试但功能不存在"的缺陷。
 * 【为什么不调大 chatRadius 就完事】chatRadius 是**开口说话的贴身距离**，
 *   把它调到 26 会让"说话"变成"隔空喊话"，语义就废了。
 * 【根因（更一般的一层）】卡 condition 是**硬闸**：不满足就根本不在候选池里，
 *   权重再高也没用。所以凡是"需要先靠近才能做"的行为，都必须把"靠近"写进
 *   卡里——否则它永远是死代码。这与 gathering 的 `workFeature`（先走路再采）
 *   是同一个模式，本轮只是把该模式补到 social 上。
 * 【修法】拆成两个半径，同一张卡里完成"走过去 + 开口"：
 *   - condition 用 **approachRadius**（磁铁半径，26 格）判定"值得去看看"；
 *   - action 里若还没走到 **chatRadius**（2.5 格）内，就规划路径过去，**不开聊**；
 *   - 到了才结算心情/关系/口角。
 *   这样不碰抽卡引擎语义（原则①地基不动），也不新增任何硬 if 行为树：
 *   "去哪找谁"由抽卡决定，"走过去"是引擎 moveStep 的本职。
 * 【推翻路径】若实测导致鼠群长期扎堆不走（采集半径被压缩），把
 *   `social.approachRadius` 调小即可回退，不必改代码结构。
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
      duration: 12,
      // 磁铁半径：看得见同伴就值得抽上（真去不去、能不能到，交给 action）
      condition: (p, ctx) => peerWithin(p, ctx, ctx.tuning.social.approachRadius) !== null,
      action(p, ctx) {
        // 先按磁铁半径找一个**当前可见**的同伴当目标（稳定目标，避免每 tick 换人）
        const target = peerWithin(p, ctx, ctx.tuning.social.approachRadius);
        if (!target) {
          ctx.finishCard(p); // 对方走出磁铁圈了：收工重抽
          return;
        }
        const s = ctx.tuning.social;
        const d = Math.hypot(target.pos.x - p.pos.x, target.pos.y - p.pos.y);
        if (d > s.chatRadius) {
          // 还不够近——**走过去**，但先只走到能开口的距离，别贴脸站定
          if (p.path.length === 0) {
            const gx = Math.round(target.pos.x);
            const gy = Math.round(target.pos.y);
            // 不可达（水/岩隔开）就收工：否则 condition 恒真 → 原地空转到 duration 结束
            if (!ctx.setPath(p, gx, gy)) ctx.finishCard(p);
          }
          return; // 路上——引擎 moveStep 推进（与 gathering.workFeature 同一模式）
        }
        p.path = []; // 到位停走
        const other = target;
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
        ctx.log(`💬 ${p.name} 和 ${other.name} 聊了几句`);
        ctx.finishCard(p); // 一次一聊，聊完重抽（要不要继续社交交给权重）
      },
    });
  },
};

/** 磁铁半径内的最近同伴（找不到返回 null）。
 *  注意 `bestD` 初值即半径 ⇒ 超出半径的一律不算，与 approachRadius 语义一致。 */
function peerWithin(p: PawnState, ctx: SimContext, radius: number): PawnState | null {
  let best: PawnState | null = null;
  let bestD = radius;
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