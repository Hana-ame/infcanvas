// 预制剧本事件表（数据驱动，用户 Q5）—— 迁自 systems/scripts.ts
// 每个事件 = condition（符合状况才进候选池）+ run（效果），效果数值全读 tuning.event
// 函数合法（表 = TS 模块）；mod 可 registerEvent 追加、overrideEvent 覆盖
import type { SimContext } from '../systems/context';
import type { ScriptedEvent } from '../systems/eventSystem';
// ---- 声明式事件（DLC 形态：事件组 = .mod.json 纯声明，零代码）----
// 当事件组以 DLC 包加入时：defs.events 声明 when（事件谓词 id）+ effects（效果表），
// loader 挂载时经 declaredEventToScripted 转成函数式 ScriptedEvent（与内置事件同接口）。
// 效果白名单执行器（与 LLM 层同一哲学：数值钳制、不碰选择链）。
export type DeclaredEffect =
  | { kind: 'mood'; amount: number; text: string }      // 全体心情 ±
  | { kind: 'resource'; item: string; amount: number; text: string } // 库存增减
  | { kind: 'log'; text: string };                       // 纯叙事

export interface DeclaredEvent {
  id: string;
  name: string;
  weight: number;
  cooldown?: number;
  minTime?: number;
  when?: string[];        // 事件谓词 id（AND 组合；缺省 = 无状况约束）
  effects: DeclaredEffect[];
}

// 事件谓词表（SimContext 签名；与卡谓词 CardContext 表分开，事件按世界状况匹配）
// mod 可用 registerEventPredicate 扩展（totem 插件示例：hasTotem）
export const EVENT_PREDICATES: Record<string, (ctx: SimContext) => boolean> = {
  hasWarmth: (ctx) => hasBuildingTag(ctx, 'warmth'),
  hasFarm: (ctx) => hasBuildingTag(ctx, 'farm'),
  hasCave: (ctx) => hasBuildingTag(ctx, 'mine'),
  hasChurch: (ctx) => hasBuildingTag(ctx, 'church'),
  hasWonder: (ctx) => hasBuildingTag(ctx, 'wonder'),
  hasRaft: (ctx) => hasBuildingTag(ctx, 'raft'),
  moodLow: (ctx) => avgMood(ctx) < 50,
  moodHigh: (ctx) => avgMood(ctx) > 70,
  foodPlenty: (ctx) => (ctx.stockpile.food ?? 0) > ctx.tuning.event.wandererFoodAt * 2,
  populationAtLeast4: (ctx) => ctx.pawnList.length >= 4,
};

export function eventPredicateOf(id: string): (ctx: SimContext) => boolean {
  const fn = EVENT_PREDICATES[id];
  if (!fn) throw new Error(`事件谓词 "${id}" 未注册（registerEventPredicate 或内置表）`);
  return fn;
}

// 声明式事件 → 函数式 ScriptedEvent（when → condition AND 组合；effects → run 白名单执行）
export function declaredEventToScripted(ev: DeclaredEvent): ScriptedEvent {
  return {
    id: ev.id,
    name: ev.name,
    weight: ev.weight,
    cooldown: ev.cooldown,
    minTime: ev.minTime,
    condition: ev.when?.length
      ? (ctx) => ev.when!.every((pid) => eventPredicateOf(pid)(ctx))
      : undefined,
    run(ctx) {
      for (const eff of ev.effects) {
        if (eff.kind === 'mood') {
          for (const eid of ctx.pawnList) ctx.adjustMood(eid, eff.amount);
          ctx.logEvent(eff.text);
        } else if (eff.kind === 'resource') {
          ctx.stockpile[eff.item] = (ctx.stockpile[eff.item] ?? 0) + eff.amount;
          ctx.logEvent(eff.text);
        } else {
          ctx.logEvent(eff.text);
        }
      }
    },
  };
}

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
  return n === 0 ? ctx.tuning.needs.initMood : sum / n;
}

// 在远处随机刷一个野生篝火营地（Q9：地图随机刷新野生势力 → 独立派系）
export function spawnWildCamp(ctx: SimContext): boolean {
  const w = ctx.world;
  const cx = Math.floor(w.width / 2);
  const cy = Math.floor(w.height / 2);
  const t = ctx.tuning.event;
  for (let attempt = 0; attempt < t.wildCampAttempts; attempt++) {
    // 离主营地较远（环带 min~min+rand），避免太近
    const r = t.wildCampRingMin + ctx.rng.int(0, t.wildCampRingRand);
    const a = ctx.rng.next() * Math.PI * 2;
    const x = cx + Math.round(Math.cos(a) * r);
    const y = cy + Math.round(Math.sin(a) * r);
    if (!w.inBounds(x, y) || !w.canBuildAt(x, y)) continue;
    if (w.placeBuilding(x, y, 'campfire', 'wild')) {
      // 创建野生派系单位
      ctx.socialUnits.onBuildingBuilt(w.buildKey(x, y), 'campfire', ctx.time);
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
    // 状况：有余粮养得起新人（阈值读 tuning.event）
    condition: (ctx) => (ctx.stockpile.food ?? 0) > ctx.tuning.event.wandererFoodAt,
    run(ctx) {
      // 在营地边缘生成一个新小人（无家可归者投奔）
      const t = ctx.tuning.event;
      const cx = Math.floor(ctx.world.width / 2);
      const cy = Math.floor(ctx.world.height / 2);
      for (let r = t.wandererRingMin; r <= t.wandererRingMax; r++) {
        const x = cx + ctx.rng.int(-r, r);
        const y = cy + ctx.rng.int(-r, r);
        if (ctx.world.inBounds(x, y) && ctx.world.isPassable(x, y)) {
          const eid = ctx.spawnPawn(x, y);
          if (eid !== -1) {
            ctx.logEvent('🚶 一名流浪者加入营地');
            ctx.adjustMood(eid, t.wandererMood);
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
      const t = ctx.tuning.event;
      ctx.stockpile.food = Math.min(t.eventCap, (ctx.stockpile.food ?? 0) + t.bountyFood);
      ctx.logEvent(`🌾 农田大丰收，食物 +${t.bountyFood}`);
    },
  },
  {
    id: 'ore_find', name: '发现矿脉', weight: 4, cooldown: 240, minTime: 200,
    // 状况：已经开过矿洞才可能发现新矿脉
    condition: (ctx) => hasBuildingTag(ctx, 'mine'),
    run(ctx) {
      const t = ctx.tuning.event;
      ctx.stockpile.ore = Math.min(t.eventCap, (ctx.stockpile.ore ?? 0) + t.oreFind);
      ctx.logEvent(`⛏ 勘探发现富矿，矿石 +${t.oreFind}`);
    },
  },
  {
    id: 'plague', name: '小瘟疫', weight: 3, cooldown: 300, minTime: 300,
    // 状况：人多了疾病才有传播空间
    condition: (ctx) => ctx.pawnList.length >= ctx.tuning.event.plagueMinPawns,
    run(ctx) {
      const t = ctx.tuning.event;
      for (const eid of ctx.pawnList) {
        const hk = ctx.readHealth(eid);
        if (hk) {
          hk.hp = Math.max(t.plagueHpFloor, hk.hp - t.plagueHpDmg);
          ctx.setHealth(eid, hk);
        }
        ctx.adjustMood(eid, t.plagueMood);
      }
      ctx.logEvent('🤒 一场小瘟疫席卷营地');
    },
  },
  {
    id: 'merchant', name: '游商到访', weight: 4, cooldown: 240, minTime: 150,
    // 状况：有可用以交换的物资（木/粮，阈值读 tuning.event）
    condition: (ctx) => (ctx.stockpile.wood ?? 0) > ctx.tuning.event.merchantGoodsAt || (ctx.stockpile.food ?? 0) > ctx.tuning.event.merchantGoodsAt,
    run(ctx) {
      const t = ctx.tuning.event;
      ctx.stockpile.wood = Math.min(t.eventCap, (ctx.stockpile.wood ?? 0) + t.merchantWood);
      ctx.stockpile.food = Math.min(t.eventCap, (ctx.stockpile.food ?? 0) + t.merchantFood);
      ctx.logEvent('🧺 游商到访，交换到木头与食物');
    },
  },
  {
    id: 'mood_boost', name: '庆典时节', weight: 4, cooldown: 300,
    // 状况：整体心情低落时才会举行庆典提振士气
    condition: (ctx) => avgMood(ctx) < ctx.tuning.event.moodBoostAt,
    run(ctx) {
      const t = ctx.tuning.event;
      for (const eid of ctx.pawnList) ctx.adjustMood(eid, t.moodBoost);
      ctx.logEvent('🎉 营地举行小型庆典，大家心情变好');
    },
  },
];
