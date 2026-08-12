// 科技抽卡池（独立系统，与神谕慢决策层完全解耦）
// 用户定案（2026-08-13）："科技是要抽卡"、"科技是另外的池子"、"神谕不能降下科技"
// —— 神谕只管目标层（策略卡）；科技有自己的独立抽卡池，按 TECH_ORDER 顺序渐进解锁
// （"往后抽卡"：越靠后的科技越晚才抽得到），抽到即解锁（BuildingDef.tech 门控建造）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { TECH_ORDER } from '../defs/techs';

export class TechPoolSystem implements GameSystem {
  id = 'techPool';
  private acc = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    const t = this.ctx.tuning.tech;
    this.acc += dt;
    if (this.acc < t.poolInterval) return;
    this.acc = 0;
    // 按顺序抽下一张未解锁科技（概率抽出，留空档避免推进过速）
    const next = TECH_ORDER.find((id) => !this.ctx.techs.has(id));
    if (!next) return;
    if (this.ctx.rng.next() >= t.poolChance) return;
    this.ctx.unlockTech(next);
  }
}
