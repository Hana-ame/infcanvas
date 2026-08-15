// 经济玩法包（2026-08-15 内核纯引擎：经济规则迁出为插件）
// 背景：Sim 类体内硬编码的经济玩法——记账（alpha 平滑个人预期 + 情绪反馈 + 日志，原
//   recordEarn/recordSpend/flowAdd）与派系工作优先级评估（原 updateFactionPriority/
//   priorityStock）。纯引擎裁决迁出为 economy 玩法包：记账规则经 `provide('economy')` 能力
//   让渡（SimContext.recordEarn/recordSpend 委托给本包），派系优先级评估放本系统 update（
//   执行位在 behavior 前——类别序 needs 先于 ai，保证 behavior 当帧读到最新优先级）。
// 共享状态：资源流账本 flow 由引擎持有（SimContext.flow），本包只写不声明所有权。
import type { ModRegistry } from '../../sim/mods/registry';
import type { GameSystem } from '../../sim/systems/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

// economy 能力：SimContext.recordEarn/recordSpend 委托目标（未挂本包 → 静默无操作）
export interface EconomyCap {
  recordEarn(eid: number | null, item: string, amount: number, workType?: string): void;
  recordSpend(eid: number | null, item: string, amount: number): void;
}

export class EconomySystem implements GameSystem {
  id = 'economy';
  private prioTimer = 0;

  constructor(private ctx: SimContext) {
    // 能力自报：记账规则交给引擎（SimContext.recordEarn/recordSpend 委托到此处）
    ctx.provide('economy', {
      recordEarn: (eid, item, amount, workType) => this.recordEarn(eid, item, amount, workType),
      recordSpend: (eid, item, amount) => this.recordSpend(eid, item, amount),
    } satisfies EconomyCap);
  }

  init(_bus: EventBus): void {}

  // 派系工作优先级评估（原 Sim.updateFactionPriority）：每 priorityTimer 秒按经济账本
  // （资源净支出）与库存阈值兜底刷新 factionPriority——消费方是 behavior 抽卡权重
  update(dt: number): void {
    this.prioTimer -= dt;
    if (this.prioTimer > 0) return;
    this.prioTimer = this.ctx.tuning.faction.priorityTimer;
    const s = this.ctx.stockpile;
    const pri: Record<string, number> = {};
    for (const r of this.ctx.tuning.card.priority) {
      let boost = 1;
      if (r.flowAt !== undefined && this.ctx.flowRatio(r.resource) >= r.flowAt) boost = r.boost;
      else {
        const low = this.priorityStock(r.resource, s);
        if (low < r.lowAt) boost = r.boost;
        if (r.urgentAt !== undefined && low < r.urgentAt && r.urgentBoost !== undefined) boost = r.urgentBoost;
      }
      pri[r.cardId] = boost;
    }
    this.ctx.factionPriority = pri;
  }

  // 取某资源当前量（'queue'：非空返回 -1 恒触发 boost，空返回 Infinity 恒不触发）
  private priorityStock(resource: string, s: Record<string, number>): number {
    if (resource === 'queue') return this.ctx.buildQueue.length > 0 ? -1 : Infinity;
    return s[resource] ?? 0;
  }

  private flowAdd(item: string, key: 'earn' | 'spend', amount: number): void {
    const f = (this.ctx.flow[item] ??= { earn: 0, spend: 0 });
    f[key] += amount;
  }

  // ---- 个人经济预期（原 Sim.recordEarn）：滚动平均 + 现实 vs 预期情绪反馈 ----
  // eid 可空：null = 公共支出只记全局流；否则同时记个人预期
  recordEarn(eid: number | null, item: string, amount: number, workType?: string): void {
    this.flowAdd(item, 'earn', amount);
    if (eid === null) return;
    const st = this.ctx.pawnStates.get(eid);
    if (!st) return;
    const e = this.ctx.tuning.economy;
    const prev = st.expectEarn ?? amount;
    st.expectEarn = (1 - e.alpha) * prev + e.alpha * amount;
    if (workType) {
      const by = (st.expectEarnBy ??= {});
      const prevW = by[workType] ?? amount;
      by[workType] = (1 - e.alpha) * prevW + e.alpha * amount;
    }
    if (amount >= prev * e.goodMul) {
      this.ctx.adjustMood(eid, e.moodGood);
      this.ctx.logEvent(`💰 #${eid} 这次赚得划算（预期 ${Math.round(prev)}，实际 ${amount}）`);
    } else if (amount <= prev * e.badMul) {
      this.ctx.adjustMood(eid, e.moodBad);
      this.ctx.logEvent(`😞 #${eid} 对这次收获失望（预期 ${Math.round(prev)}，实际 ${amount}）`);
    }
  }

  recordSpend(eid: number | null, item: string, amount: number): void {
    this.flowAdd(item, 'spend', amount);
    if (eid === null) return;
    const st = this.ctx.pawnStates.get(eid);
    if (!st) return;
    const e = this.ctx.tuning.economy;
    const prev = st.expectSpend ?? amount;
    st.expectSpend = (1 - e.alpha) * prev + e.alpha * amount;
    if (amount <= prev * e.badMul) {
      this.ctx.adjustMood(eid, e.moodGood);
      this.ctx.logEvent(`💰 #${eid} 这次花得划算（预期 ${Math.round(prev)}，实际 ${amount}）`);
    } else if (amount >= prev * e.goodMul) {
      this.ctx.adjustMood(eid, e.moodBad);
      this.ctx.logEvent(`😞 #${eid} 对这次花费失望（预期 ${Math.round(prev)}，实际 ${amount}）`);
    }
  }
}

export const economyPack: ModPack = {
  id: 'economy',
// 依赖（2026-08-15 显式化）：无硬前置——记账/派系优先级独立能力
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({ id: 'economy', label: '经济', category: 'needs', ctor: (s: Sim) => new EconomySystem(s) });
  }
};