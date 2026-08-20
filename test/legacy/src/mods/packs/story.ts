// 故事模板扩展包（2026-08-20，用户「故事模板多加一点」）：
// 20 个新 ScriptedEvent，覆盖 5 类故事：自然/社交/灾难/机遇/传奇
// 种子原则：每个事件 = condition + run → 事件系统自然 roll 触发 → logEvent → 进入社交传闻
import type { SimContext } from '../../sim/systems/context';
import type { ScriptedEvent } from '../../sim/systems/eventSystem';
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

const EVENTS: ScriptedEvent[] = [
  // ===== 自然类 =====
  {
    id: 'eclipse', name: '日食', weight: 1, cooldown: 600, minTime: 200,
    run(ctx) { ctx.logEvent('🌑 日食降临，白昼如夜，鼠鼠们惊恐不安'); ctx.adjustMoodAll?.(-3); },
  },
  {
    id: 'aurora', name: '极光', weight: 0.8, cooldown: 500, minTime: 300,
    condition: (ctx) => ctx.env.temperature < 10,
    run(ctx) { ctx.logEvent('🌌 极光绚烂，夜空如画，全员心情振奋'); ctx.adjustMoodAll?.(5); },
  },
  {
    id: 'earthquake', name: '地震', weight: 0.5, cooldown: 800, minTime: 400,
    run(ctx) {
      let dmg = 0;
      for (const eid of ctx.pawnList) {
        const h = ctx.readHealth(eid);
        if (h) { ctx.setHealth(eid, { hp: Math.max(0, h.hp - 10), maxHp: h.maxHp }); dmg++; }
      }
      ctx.logEvent(`🌋 地震！${dmg} 名小人受伤`);
    },
  },
  {
    id: 'rainstorm', name: '暴雨', weight: 2, cooldown: 300, minTime: 100,
    run(ctx) { ctx.env.raining = true; ctx.logEvent('⛈ 暴雨倾盆，篝火可能被浇灭'); },
  },

  // ===== 社交类 =====
  {
    id: 'friendship', name: '友谊萌芽', weight: 2, cooldown: 200, minTime: 100,
    run(ctx) {
      const list = ctx.pawnList;
      if (list.length < 2) return;
      const a = list[Math.floor(ctx.rng.next() * list.length)]!;
      const b = list[Math.floor(ctx.rng.next() * list.length)]!;
      if (a === b) return;
      const stA = ctx.pawnStates.get(a);
      if (stA) { stA.relationships = stA.relationships ?? new Map(); stA.relationships.set(b, (stA.relationships.get(b) ?? 0) + 15); }
      const stB = ctx.pawnStates.get(b);
      if (stB) { stB.relationships = stB.relationships ?? new Map(); stB.relationships.set(a, (stB.relationships.get(a) ?? 0) + 15); }
      ctx.logEvent(`🤝 #${a} 和 #${b} 成为了好朋友`);
    },
  },
  {
    id: 'rivalry', name: '口角冲突', weight: 1.5, cooldown: 200, minTime: 150,
    run(ctx) {
      const list = ctx.pawnList;
      if (list.length < 2) return;
      const a = list[Math.floor(ctx.rng.next() * list.length)]!;
      const b = list[Math.floor(ctx.rng.next() * list.length)]!;
      if (a === b) return;
      const stA = ctx.pawnStates.get(a);
      if (stA) { stA.relationships = stA.relationships ?? new Map(); stA.relationships.set(b, (stA.relationships.get(b) ?? 0) - 10); }
      ctx.logEvent(`💢 #${a} 和 #${b} 发生了口角`);
    },
  },
  {
    id: 'feast', name: '篝火晚会', weight: 1.5, cooldown: 400, minTime: 200,
    condition: (ctx) => (ctx.stockpile.food ?? 0) > 30,
    run(ctx) {
      ctx.stockpile.food = Math.max(0, (ctx.stockpile.food ?? 0) - 20);
      ctx.adjustMoodAll?.(8);
      ctx.logEvent('🎉 篝火晚会！消耗 20 食物，全员心情大涨');
    },
  },
  {
    id: 'funeral', name: '追悼会', weight: 1, cooldown: 300, minTime: 100,
    run(ctx) {
      ctx.adjustMoodAll?.(-3);
      ctx.adjustMoodAll?.(2); // 追悼后释然
      ctx.logEvent('🕯 为逝者举行追悼会，哀思后心中释然');
    },
  },

  // ===== 灾难类 =====
  {
    id: 'wildfire', name: '野火', weight: 0.5, cooldown: 600, minTime: 300,
    condition: (ctx) => !ctx.env.raining && ctx.env.temperature > 25,
    run(ctx) {
      let destroyed = 0;
      const toBurn: number[] = [];
      for (const [k, b] of ctx.world.buildings) {
        if (ctx.rng.next() < 0.2) toBurn.push(k);
      }
      ctx.logEvent(`🔥 野火蔓延！${toBurn.length} 栋建筑受损`);
    },
  },
  {
    id: 'famine', name: '饥荒', weight: 0.8, cooldown: 500, minTime: 300,
    condition: (ctx) => (ctx.stockpile.food ?? 0) < 20,
    run(ctx) {
      for (const eid of ctx.pawnList) {
        ctx.adjustNeedField(eid, 'mood', -5);
        ctx.adjustNeedField(eid, 'san', -3);
      }
      ctx.logEvent('😱 饥荒蔓延！食物告急，人心惶惶');
    },
  },
  {
    id: 'cold_snap', name: '寒潮', weight: 1, cooldown: 400, minTime: 200,
    run(ctx) {
      ctx.env.temperature -= 10;
      ctx.adjustMoodAll?.(-2);
      ctx.logEvent('🥶 寒潮来袭！气温骤降 10°C');
    },
  },
  {
    id: 'locust_swarm', name: '蝗灾', weight: 0.4, cooldown: 700, minTime: 400,
    run(ctx) {
      const lost = Math.min(30, ctx.stockpile.food ?? 0);
      ctx.stockpile.food = Math.max(0, (ctx.stockpile.food ?? 0) - lost);
      ctx.logEvent(`🦗 蝗虫过境！食物 -${lost}`);
    },
  },

  // ===== 机遇类 =====
  {
    id: 'treasure', name: '发现宝藏', weight: 0.6, cooldown: 500, minTime: 250,
    run(ctx) {
      const item = ctx.rng.next() < 0.5 ? 'wood' : 'ore';
      const amount = 10 + Math.floor(ctx.rng.next() * 20);
      ctx.stockpile[item] = (ctx.stockpile[item] ?? 0) + amount;
      ctx.logEvent(`💎 发现埋藏的宝藏！${item === 'wood' ? '木材' : '矿石'} +${amount}`);
    },
  },
  {
    id: 'inspiration', name: '灵感迸发', weight: 1.5, cooldown: 300, minTime: 150,
    run(ctx) {
      const eid = ctx.pawnList[Math.floor(ctx.rng.next() * ctx.pawnList.length)];
      if (eid !== undefined) {
        ctx.adjustNeedField(eid, 'mood', 10);
        ctx.logEvent(`💡 #${eid} 灵感迸发！心情 +10`);
      }
    },
  },
  {
    id: 'good_harvest', name: '风调雨顺', weight: 2, cooldown: 200, minTime: 100,
    run(ctx) {
      ctx.stockpile.food = Math.min(500, (ctx.stockpile.food ?? 0) + 15);
      ctx.stockpile.wood = Math.min(500, (ctx.stockpile.wood ?? 0) + 10);
      ctx.logEvent('🌈 风调雨顺！食物 +15 木材 +10');
    },
  },
  {
    id: 'wandering_trader', name: '行商路过', weight: 1.2, cooldown: 400, minTime: 200,
    run(ctx) {
      const gain = 5 + Math.floor(ctx.rng.next() * 10);
      ctx.stockpile.ore = Math.min(500, (ctx.stockpile.ore ?? 0) + gain);
      ctx.logEvent(`🧳 行商路过，留下 ${gain} 矿石`);
    },
  },

  // ===== 传奇类 =====
  {
    id: 'ancient_dragon', name: '远古巨龙', weight: 0.1, cooldown: 9999, minTime: 600,
    run(ctx) {
      // 巨龙飞过 → 全员震撼 + 少量伤害
      ctx.adjustMoodAll?.(10);
      for (const eid of ctx.pawnList) {
        const h = ctx.readHealth(eid);
        if (h) ctx.setHealth(eid, { hp: Math.max(0, h.hp - 5), maxHp: h.maxHp });
      }
      ctx.logEvent('🐉 远古巨龙掠过天际！全员震撼但被余波波及');
    },
  },
  {
    id: 'prophecy', name: '预言降临', weight: 0.3, cooldown: 9999, minTime: 500,
    run(ctx) {
      ctx.adjustMoodAll?.(3);
      ctx.logEvent('🔮 一位老者留下预言，鼠鼠们若有所思');
    },
  },
  {
    id: 'meteor_shower', name: '流星雨', weight: 0.5, cooldown: 800, minTime: 400,
    run(ctx) {
      ctx.stockpile.ore = Math.min(500, (ctx.stockpile.ore ?? 0) + 15);
      ctx.adjustMoodAll?.(4);
      ctx.logEvent('☄ 流星雨！矿石 +15，全员心情振奋');
    },
  },
  {
    id: 'golden_age', name: '黄金时代', weight: 0.2, cooldown: 9999, minTime: 800,
    condition: (ctx) => (ctx.stockpile.food ?? 0) > 50 && ctx.pawnList.length > 5,
    run(ctx) {
      ctx.adjustMoodAll?.(15);
      ctx.stockpile.wood = Math.min(500, (ctx.stockpile.wood ?? 0) + 30);
      ctx.stockpile.food = Math.min(500, (ctx.stockpile.food ?? 0) + 30);
      ctx.logEvent('👑 黄金时代降临！全员心情暴涨，资源丰饶');
    },
  },
];

// 辅助：全员 mood 调整（SimContext 没有 adjustMoodAll → 遍历实现）
// 挂到 SimContext 上作为 monkey-patch（事件 run 内部用）
declare module '../../sim/systems/context' {
  interface SimContext {
    adjustMoodAll?(delta: number): void;
  }
}

export const storyPack: ModPack = {
  id: 'story',
  requires: [],
  apply(m: ModRegistry): void {
    // 注册 adjustMoodAll 能力
    m.registerHook('step:before', ({ sim }: { sim: SimContext & { adjustMoodAll?: (d: number) => void } }) => {
      if (!sim.adjustMoodAll) {
        sim.adjustMoodAll = (delta: number) => {
          for (const eid of sim.pawnList) sim.adjustMood(eid, delta);
        };
      }
    });
    // 注册事件
    for (const ev of EVENTS) m.registerEvent(ev);
  },
};