// P3-12: 更多事件（2026-08-20）：瘟疫/丰收/迁徙/火山喷发/商队
// 种子原则：用 ScriptedEvent（condition + run）注册 → 事件系统自然 roll 触发
// 瘟疫 = 全体 disease 注入 / 丰收 = 食物暴涨 / 迁徙 = 中立生物涌入 / 火山 = 全体伤害
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { ScriptedEvent } from '../../sim/systems/eventSystem';
import type { ModPack } from '../pack';

const EVENTS: ScriptedEvent[] = [
  {
    id: 'plague', name: '瘟疫', weight: 0.5, minTime: 600,
    run(ctx: SimContext) {
      let infected = 0;
      for (const eid of ctx.pawnList) {
        if (ctx.rng.next() < 0.2) {
          const st = ctx.pawnStates.get(eid);
          if (st) {
            st.extra = { ...st.extra, disease: { type: '瘟疫', severity: 0.3 } };
            infected++;
          }
        }
      }
      ctx.logEvent(`🦠 瘟疫爆发！${infected} 名小人感染`);
    },
  },
  {
    id: 'bounty', name: '丰收', weight: 1.0, minTime: 300,
    run(ctx) {
      ctx.stockpile.food = Math.min(500, (ctx.stockpile.food ?? 0) + 50);
      ctx.logEvent('🌾 丰收时节！食物 +50');
    },
  },
  {
    id: 'migration', name: '动物迁徙', weight: 0.8, minTime: 400,
    run(ctx) {
      const cx = Math.floor(ctx.world.width / 2);
      const cy = Math.floor(ctx.world.height / 2);
      for (let i = 0; i < 5; i++) {
        const a = ctx.rng.next() * Math.PI * 2;
        const r = 15 + ctx.rng.next() * 10;
        ctx.world.placeBuilding(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 'campfire', 'neutral-fauna');
      }
      ctx.logEvent('🦌 一群鹿迁徙经过此地');
    },
  },
  {
    id: 'volcano', name: '火山喷发', weight: 0.3, minTime: 900,
    run(ctx) {
      for (const eid of ctx.pawnList) {
        const h = ctx.readHealth(eid);
        if (h) ctx.setHealth(eid, { hp: Math.max(0, h.hp - 20), maxHp: h.maxHp });
      }
      ctx.logEvent('🌋 火山喷发！全体受伤 -20HP');
    },
  },
  {
    id: 'caravan', name: '商队到访', weight: 1.2, minTime: 200,
    run(ctx) {
      ctx.stockpile.wood = Math.min(500, (ctx.stockpile.wood ?? 0) + 15);
      ctx.stockpile.ore = Math.min(500, (ctx.stockpile.ore ?? 0) + 5);
      ctx.logEvent('🐪 商队到访！带来物资');
    },
  },
];

export const events2Pack: ModPack = {
  id: 'events-2',
  requires: [],
  apply(m: ModRegistry): void {
    for (const ev of EVENTS) m.registerEvent(ev);
  },
};