// P2-8: diplomacy（2026-08-20，Crusader Kings 风格派系外交）
// 设计：多个营地（campfire）之间存在外交关系 → 贸易/战争/和平
// 派系关系 = -100（敌对）~ +100（盟友），0 = 中立
// 关系影响：>50 可贸易 / <0 可袭击 / <-50 可宣战
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

const CFG = {
  evalInterval: 10,     // 外交评估 10s 一次
  tradeThreshold: 50,  // 关系 > 50 可贸易
  warThreshold: -50,   // 关系 < -50 可宣战
  tradeGain: { wood: 5, food: 5 },  // 每次贸易获得
  relationDrift: 0.01, // 关系自然漂移（向 0 靠拢）
  relationGainFromTrade: 1,  // 贸易后关系 +1
  relationLossFromRaid: 5,  // 被袭击后关系 -5
};

// 派系关系表：fireKey1 × fireKey2 → relation(-100~100)
// 对称存储：rel(A,B) = rel(B,A)
const relations = new Map<string, number>();

const relKey = (a: number, b: number) => a < b ? `${a}-${b}` : `${b}-${a}`;

// 外交系统：多营地间关系 -100~+100，>50 自动贸易（+资源+好感），<-50 可宣战
// 关系漂移向 0 靠拢，10s 节流评估
// ctx.getCap("diplomacy") 提供 getRelation/adjustRelation
class DiplomacySystem {
  id = 'diplomacy';
  private _throttle = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < CFG.evalInterval) return;
    this._throttle = 0;

    // 收集所有营地
    const campfires: number[] = [];
    for (const [k, b] of this.ctx.world.buildings) {
      if (b.def.id === 'campfire' || b.def.id === 'church') campfires.push(k);
    }

    // 关系漂移（向 0 靠拢）
    for (const [key, val] of relations) {
      if (val > 0) relations.set(key, Math.max(0, val - CFG.relationDrift * CFG.evalInterval));
      else if (val < 0) relations.set(key, Math.min(0, val + CFG.relationDrift * CFG.evalInterval));
    }

    // 贸易：关系 > tradeThreshold 的派系对自动贸易
    for (let i = 0; i < campfires.length; i++) {
      for (let j = i + 1; j < campfires.length; j++) {
        const key = relKey(campfires[i]!, campfires[j]!);
        const rel = relations.get(key) ?? 0;
        if (rel > CFG.tradeThreshold) {
          // 贸易
          this.ctx.stockpile.wood = Math.min(500, (this.ctx.stockpile.wood ?? 0) + CFG.tradeGain.wood);
          this.ctx.stockpile.food = Math.min(500, (this.ctx.stockpile.food ?? 0) + CFG.tradeGain.food);
          relations.set(key, rel + CFG.relationGainFromTrade);
          this.ctx.logEvent(`🤝 派系贸易：+${CFG.tradeGain.wood}木 +${CFG.tradeGain.food}食（关系 ${rel + CFG.relationGainFromTrade}）`);
        }
      }
    }
  }

  // 获取关系值
  getRelation(a: number, b: number): number {
    return relations.get(relKey(a, b)) ?? 0;
  }

  // 修改关系值
  adjustRelation(a: number, b: number, delta: number): void {
    const key = relKey(a, b);
    const cur = relations.get(key) ?? 0;
    relations.set(key, Math.max(-100, Math.min(100, cur + delta)));
  }
}

export const diplomacyPack: ModPack = {
  id: 'diplomacy',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'diplomacy', label: '外交', category: 'society',
      ctor: (ctx) => {
        const sys = new DiplomacySystem(ctx);
        ctx.provide('diplomacy', {
          getRelation: (a: number, b: number) => sys.getRelation(a, b),
          adjustRelation: (a: number, b: number, delta: number) => sys.adjustRelation(a, b, delta),
        });
        return sys;
      },
    });
  },
};