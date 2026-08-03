// 预制剧本（P0 随机事件，用户 Q5）—— def 驱动，可被 LLM provider 替换
// 每个事件 = 印卡/调权重/改世界，通过 SimContext 影响 sim，核心零改动
import type { SimContext } from './context';
import type { ScriptedEvent } from './eventSystem';

export const SCRIPTED_EVENTS: ScriptedEvent[] = [
  {
    id: 'wanderer', name: '流浪者加入', weight: 5, cooldown: 180, minTime: 120,
    run(ctx) {
      // 在营地边缘生成一个新小人（无家可归者投奔）
      const cx = Math.floor(ctx.world.width / 2);
      const cy = Math.floor(ctx.world.height / 2);
      for (let r = 4; r <= 8; r++) {
        const x = cx + ctx.rng.int(-r, r);
        const y = cy + ctx.rng.int(-r, r);
        if (ctx.world.inBounds(x, y) && ctx.world.isPassable(x, y)) {
          const eid = ctx.spawnPawn(x, y);
          if (eid !== -1) {
            ctx.logEvent('🚶 一名流浪者加入营地');
            ctx.adjustMood(eid, 10);
            ctx.bus.emit({ type: 'pawn_recruited', eid });
          }
          return;
        }
      }
    },
  },
  {
    id: 'crop_bounty', name: '作物丰收', weight: 4, cooldown: 240,
    run(ctx) {
      ctx.stockpile.food = Math.min(500, (ctx.stockpile.food ?? 0) + 20);
      ctx.logEvent('🌾 农田大丰收，食物 +20');
    },
  },
  {
    id: 'ore_find', name: '发现矿脉', weight: 4, cooldown: 240, minTime: 200,
    run(ctx) {
      ctx.stockpile.ore = Math.min(500, (ctx.stockpile.ore ?? 0) + 15);
      ctx.logEvent('⛏ 勘探发现富矿，矿石 +15');
    },
  },
  {
    id: 'plague', name: '小瘟疫', weight: 3, cooldown: 300, minTime: 300,
    run(ctx) {
      for (const eid of ctx.pawnList) {
        const hk = ctx.readHealth(eid);
        if (hk) {
          hk.hp = Math.max(10, hk.hp - 15);
          ctx.setHealth(eid, hk);
        }
        ctx.adjustMood(eid, -5);
      }
      ctx.logEvent('🤒 一场小瘟疫席卷营地');
    },
  },
  {
    id: 'merchant', name: '游商到访', weight: 4, cooldown: 240, minTime: 150,
    run(ctx) {
      ctx.stockpile.wood = Math.min(500, (ctx.stockpile.wood ?? 0) + 10);
      ctx.stockpile.food = Math.min(500, (ctx.stockpile.food ?? 0) + 10);
      ctx.logEvent('🧺 游商到访，交换到木头与食物');
    },
  },
  {
    id: 'mood_boost', name: '庆典时节', weight: 4, cooldown: 300,
    run(ctx) {
      for (const eid of ctx.pawnList) ctx.adjustMood(eid, 8);
      ctx.logEvent('🎉 营地举行小型庆典，大家心情变好');
    },
  },
];
