// 预制剧本（P0 随机事件，用户 Q5）—— def 驱动，可被 LLM provider 替换
// 每个事件 = condition（符合状况才进候选池）+ 效果（印卡/调权重/改世界）
// 事件不写死：触发逻辑全在 eventSystem 里按「状况匹配列表」执行
import type { SimContext } from './context';
import type { ScriptedEvent } from './eventSystem';
import type { SocialUnitSystem } from './socialUnitSystem';

// 是否已存在带某标签的建筑（condition 用的查询）
function hasBuildingTag(ctx: SimContext, tag: string): boolean {
  for (const [, b] of ctx.world.buildings) {
    if (b.def.tags?.includes(tag)) return true;
  }
  return false;
}

// 平均心情（condition 用）
function avgMood(ctx: SimContext): number {
  let sum = 0;
  let n = 0;
  for (const eid of ctx.pawnList) {
    const needs = ctx.readNeeds(eid);
    if (needs) { sum += needs.mood; n++; }
  }
  return n === 0 ? 60 : sum / n;
}

// 在远处随机刷一个野生篝火营地（Q9：地图随机刷新野生势力 → 独立派系）
export function spawnWildCamp(ctx: SimContext): boolean {
  const w = ctx.world;
  const cx = Math.floor(w.width / 2);
  const cy = Math.floor(w.height / 2);
  for (let attempt = 0; attempt < 40; attempt++) {
    // 离主营地较远（半径 20-40），避免太近
    const r = 20 + ctx.rng.int(0, 20);
    const a = ctx.rng.next() * Math.PI * 2;
    const x = cx + Math.round(Math.cos(a) * r);
    const y = cy + Math.round(Math.sin(a) * r);
    if (!w.inBounds(x, y) || !w.canBuildAt(x, y)) continue;
    if (w.placeBuilding(x, y, 'campfire', 'wild')) {
      // 创建野生派系单位
      const su = ctx.socialUnits as SocialUnitSystem;
      su.onBuildingBuilt(w.buildKey(x, y), 'campfire', ctx.time);
      ctx.bus.emit({ type: 'building_built', x, y, defId: 'campfire' });
      return true;
    }
  }
  return false;
}

export const SCRIPTED_EVENTS: ScriptedEvent[] = [
  {
    id: 'wild_camp', name: '发现陌生篝火', weight: 4, cooldown: 300, minTime: 300,
    // 状况：已有稳定营地（有派系单位）且派系不算太多 → 才可能冒出陌生势力
    condition: (ctx) => ctx.socialUnits.units.size > 0 && ctx.socialUnits.units.size < 4,
    run(ctx) {
      if (spawnWildCamp(ctx)) {
        ctx.logEvent('🔥 荒野深处升起陌生炊烟——一个独立势力出现了');
      }
    },
  },
  {
    id: 'wanderer', name: '流浪者加入', weight: 5, cooldown: 180, minTime: 120,
    // 状况：有余粮养得起新人
    condition: (ctx) => (ctx.stockpile.food ?? 0) > 10,
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
    // 状况：真的有农田才会丰收
    condition: (ctx) => hasBuildingTag(ctx, 'farm'),
    run(ctx) {
      ctx.stockpile.food = Math.min(500, (ctx.stockpile.food ?? 0) + 20);
      ctx.logEvent('🌾 农田大丰收，食物 +20');
    },
  },
  {
    id: 'ore_find', name: '发现矿脉', weight: 4, cooldown: 240, minTime: 200,
    // 状况：已经开过矿洞才可能发现新矿脉
    condition: (ctx) => hasBuildingTag(ctx, 'mine'),
    run(ctx) {
      ctx.stockpile.ore = Math.min(500, (ctx.stockpile.ore ?? 0) + 15);
      ctx.logEvent('⛏ 勘探发现富矿，矿石 +15');
    },
  },
  {
    id: 'plague', name: '小瘟疫', weight: 3, cooldown: 300, minTime: 300,
    // 状况：人多了疾病才有传播空间
    condition: (ctx) => ctx.pawnList.length >= 3,
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
    // 状况：有可用以交换的物资（木/粮）
    condition: (ctx) => (ctx.stockpile.wood ?? 0) > 5 || (ctx.stockpile.food ?? 0) > 5,
    run(ctx) {
      ctx.stockpile.wood = Math.min(500, (ctx.stockpile.wood ?? 0) + 10);
      ctx.stockpile.food = Math.min(500, (ctx.stockpile.food ?? 0) + 10);
      ctx.logEvent('🧺 游商到访，交换到木头与食物');
    },
  },
  {
    id: 'mood_boost', name: '庆典时节', weight: 4, cooldown: 300,
    // 状况：整体心情低落时才会举行庆典提振士气
    condition: (ctx) => avgMood(ctx) < 55,
    run(ctx) {
      for (const eid of ctx.pawnList) ctx.adjustMood(eid, 8);
      ctx.logEvent('🎉 营地举行小型庆典，大家心情变好');
    },
  },
];
