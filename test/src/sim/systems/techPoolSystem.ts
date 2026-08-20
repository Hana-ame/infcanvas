// 科技抽卡池（独立系统，与神谕慢决策层完全解耦）
// 用户定案（2026-08-13）："科技是要抽卡"、"科技是另外的池子"、"神谕不能降下科技"
// —— 神谕只管目标层（策略卡）；科技有自己的独立抽卡池，按 TECH_ORDER 顺序渐进解锁
// （"往后抽卡"：越靠后的科技越晚才抽得到）。
// 碎片制（用户 2026-08-14 追加定案）："每个科技都有碎片，碎片攒齐了才能组成科技，也是抽卡"——
// 每抽给一块碎片（攒齐 fragments 块自动解锁整卡）。抽卡加权：候选 = 所有未解锁科技，
// 权重按 TECH_ORDER 顺序线性递减（rank 越前越易抽到）→ 既保持"往后抽卡"渐进
// （靠前科技先攒满先解锁），又保留抽卡随机性（不会 100% 必中下一张）。
// 重复可开出（用户 2026-08-15 裁决）：候选池 = 全部科技（含已解锁）——抽到已解锁
// 科技 = 重复卡，碎片无效（grantTechFragment 返回 false 不累计）→ 抽取被重复稀释，
// 新科技解锁期望降低（渐进节奏更缓）。rank 靠前的科技重复权重高（开重复多 = 合理，
// 早期科技就是常见卡）。
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { TECH_ORDER } from '../defs/techs';

// 科技池系统：按间隔发科技碎片 → 攒齐解锁科技 → BuildingDef.tech 门控建造
export class TechPoolSystem implements GameSystem {
  id = 'techPool';
  private acc = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    // 2026-08-20 节流：系统自带 acc 累加器 + poolInterval 检查 = 天然节流
    // 无需额外 _throttle（acc < poolInterval 即 return）
    const t = this.ctx.tuning.tech;
    this.acc += dt;
    if (this.acc < t.poolInterval) return;
    this.acc = 0;
    if (this.ctx.rng.next() >= t.poolChance) return;
    if (this.ctx.techs.size >= TECH_ORDER.length) return; // 全解锁：抽无可抽（全重复空转无意义）
    // 候选池 = 全部科技（含已解锁 = 重复卡；权重 = 顺序 rank 线性递减，越靠前越常见）
    const n = TECH_ORDER.length;
    const pool: string[] = [];
    const weights: number[] = [];
    for (let rank = 0; rank < n; rank++) {
      const id = TECH_ORDER[rank];
      pool.push(id);
      weights.push(n - rank); // rank0 权重最高（如 11 项时 11/10/…/1）
    }
    const picked = this.ctx.rng.weightedPick(pool, weights);
    if (!picked) return;
    // 抽到已解锁 = 重复卡：grantTechFragment 返回 false（碎片不累计，不重抽——重复也消耗轮次）
    this.ctx.grantTechFragment(picked);
  }
}
