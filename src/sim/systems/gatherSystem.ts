// 采集系统：伐木/采矿进度 → 产出资源（通过事件）
// 数据驱动：产出走 TileDef.harvest / BuildingDef.recipe(work)，失败保底走 tuning.gather；mod 新采集物自动可采
// 数值来源：toolBonus/strBonus/carryCap 均读 tuning.gather（COC §3 属性 → 产出/负重）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import type { GatherTuning } from '../defs/tuning';

// SIZ 负重上限（COC §3 体型 → 负重）：一次采集搬回量
export function carryCapOf(g: Pick<GatherTuning, 'carryBase' | 'carryPerSiz' | 'strBase'>, siz: number): number {
  return g.carryBase + Math.max(0, siz - g.strBase) * g.carryPerSiz;
}

// 产出钳制：不低于 1（保底一次搬回一点），不高于负重上限
export function capGainTo(raw: number, cap: number): number {
  return Math.min(Math.max(0, raw), Math.max(1, Math.floor(cap)));
}

export class GatherSystem implements GameSystem {
  id = 'gather';

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    const g = this.ctx.tuning.gather;
    // 工具加成：每把工具 +30% 采集产出（读 tuning.gather）
    const toolBonus = (this.ctx.stockpile.tools ?? 0) > 0 ? g.toolBonus : 1;
    // STR 力量加成：采集产出（COC §3）
    const strBonusOf = (eid: number): number => {
      const dna = this.ctx.dnaOf(eid);
      return dna ? 1 + Math.max(0, dna.str - g.strBase) * g.strBonusPerPoint : 1;
    };
    // SIZ 负重上限：一次搬回量（COC §3 体型 → 负重；与 STR 产出加成互补）
    const carryOf = (eid: number): number => {
      const dna = this.ctx.dnaOf(eid);
      return dna ? carryCapOf(g, dna.siz) : g.carryBase;
    };
    // 产出钳制：gain = min(计算值, 负重上限)，向下取整
    const capGain = (raw: number, eid: number): number => capGainTo(raw, carryOf(eid));
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const f = this.ctx.tuning.faith;
      // 祈祷进度
      if (st.praying) {
        st.praying.progress += dt;
        if (st.praying.progress >= f.prayTime) {
          st.praying = undefined;
          this.ctx.adjustMood(eid, f.prayMood);
          // APP 外貌：魅力高 → 信仰传播效果好（COC §3）
          const dna = this.ctx.dnaOf(eid);
          const appBoost = dna ? 1 + Math.max(0, (dna.app - f.appBase)) / f.appScale : 1;
          st.faith = Math.min(100, (st.faith ?? 0) + f.prayFaith * appBoost);
          this.ctx.recordOutcome(eid, 'pray', f.prayFaith);
          this.ctx.logEvent('🕯 向篝火祈祷，心灵安宁');
        }
        continue;
      }
      // 疗伤回血
      if (st.healing) {
        st.healing.progress += dt;
        const hk = this.ctx.readHealth(eid);
        if (hk) {
          hk.hp = Math.min(hk.maxHp, hk.hp + f.healPerSec * dt);
          this.ctx.setHealth(eid, hk);
          if (hk.hp >= hk.maxHp || st.healing.progress >= f.healTime) {
            st.healing = undefined;
            st.job = '闲逛';
            this.ctx.logEvent('🩹 伤势痊愈');
          }
        }
        continue;
      }
      // 矿洞持续采掘（稳定产出，饥荒式矿场）——读 BuildingDef.recipe(work)
      if (st.caveWork) {
        st.caveWork.progress += dt;
        // 工作一段时间后结束，避免永远困在矿洞
        st.caveWork.duration = (st.caveWork.duration ?? 0) + dt;
        if ((st.caveWork.duration ?? 0) >= f.caveWorkDuration) {
          st.caveWork = undefined;
          st.job = '闲逛';
          this.ctx.logEvent('⛏ 结束了矿洞采掘');
          continue;
        }
        // 产出按建筑自身 recipe（矿洞→ore；竹筏→food），旧档无 buildingId → 回退矿洞
        const recipe = this.ctx.recipe(st.caveWork.buildingId ?? 'cave');
        const interval = recipe?.interval ?? this.ctx.tuning.gather.harvestInterval;
        if (st.caveWork.progress >= interval) {
          st.caveWork.progress = 0;
          const dc = recipe?.dc ?? this.ctx.tuning.gather.harvestDc;
          const skill = recipe?.skill ?? this.ctx.tuning.gather.harvestSkill;
          const ev = this.ctx.rollEventSkill(eid, dc, skill);
          const gain = capGain(Math.round((ev.success ? (recipe?.output.amount ?? this.ctx.tuning.gather.harvestYield) : (recipe?.failOutput?.amount ?? this.ctx.tuning.gather.harvestFailYield)) * toolBonus * strBonusOf(eid)), eid);
          const item = recipe?.output.item ?? this.ctx.tuning.gather.harvestItem;
          this.ctx.stockpile[item] = (this.ctx.stockpile[item] ?? 0) + gain;
          this.ctx.growSkill(eid, skill); this.ctx.recordOutcome(eid, 'caveMine', ev.success ? gain : -gain);
          this.ctx.bus.emit({ type: 'resource_gained', eid, item, amount: gain });
          // 心情微调（写死 ±2，未进 tuning：改动频率低，保持现状）
          this.ctx.adjustMood(eid, ev.success ? 2 : -2);
          this.ctx.logEvent(ev.success ? `在${recipe?.name ?? '建筑'}获得${item === 'ore' ? '矿石' : item}` : '一无所获');
        }
        continue;
      }
      // 采矿（读 TileDef.harvest）
      if (st.mining) {
        st.mining.progress += dt;
        const tile = this.ctx.world.getTileDef(st.mining.x, st.mining.y);
        const hv = tile.mineral ? tile.harvest : undefined;
        const time = hv?.time ?? this.ctx.tuning.gather.harvestTime;
        if (st.mining.progress >= time) {
          const { x, y } = st.mining;
          // 采后瓦片：harvestReplaces 声明优先，缺省 growable→grass / mineral→dirt
          this.ctx.world.setTile(x, y, tile.harvestReplaces ?? (tile.growable ? 'grass' : 'dirt'));
          const dc = hv?.dc ?? this.ctx.tuning.gather.harvestDc;
          const skill = hv?.skill ?? this.ctx.tuning.gather.harvestSkill;
          const ev = this.ctx.rollEventSkill(eid, dc, skill);
          const gain = capGain(Math.round((ev.success ? (hv?.yieldSuccess ?? this.ctx.tuning.gather.harvestYield) : (hv?.yieldFail ?? this.ctx.tuning.gather.harvestFailYield)) * toolBonus * strBonusOf(eid)), eid);
          this.ctx.stockpile.ore += gain;
          this.ctx.growSkill(eid, skill); this.ctx.recordOutcome(eid, 'mine', ev.success ? gain : -gain);
          this.ctx.bus.emit({ type: 'resource_gained', eid, item: hv?.product ?? this.ctx.tuning.gather.harvestItem, amount: gain });
          this.ctx.bus.emit({ type: 'work_completed', eid, work: 'mine', success: ev.success, x, y });
          // 心情微调（写死 +3/-4，未进 tuning：采到富矿更开心、失败更沮丧）
          this.ctx.adjustMood(eid, ev.success ? 3 : -4);
          this.ctx.logEvent(ev.success ? '采到富矿！' : '采矿一无所获');
          this.ctx.clearTrailCache();
          st.mining = undefined;
        }
      }
      // 伐木
      if (st.chopXY) {
        st.chopProgress = (st.chopProgress ?? 0) + dt;
        const tile = this.ctx.world.getTileDef(st.chopXY.x, st.chopXY.y);
        const h = tile.harvest;
        const time = h?.time ?? this.ctx.tuning.gather.chopTime;
        if (st.chopProgress >= time) {
          const { x, y } = st.chopXY;
          this.ctx.world.setTile(x, y, tile.harvestReplaces ?? 'grass');
          const dc = h?.dc ?? this.ctx.tuning.gather.chopDc;
          const skill = h?.skill ?? this.ctx.tuning.gather.chopSkill;
          const ev = this.ctx.rollEventSkill(eid, dc, skill);
          const gain = capGain(Math.round((ev.success ? (h?.yieldSuccess ?? this.ctx.tuning.gather.chopYield) : (h?.yieldFail ?? this.ctx.tuning.gather.chopFailYield)) * toolBonus * strBonusOf(eid)), eid);
          this.ctx.stockpile.wood += gain;
          this.ctx.growSkill(eid, skill); this.ctx.recordOutcome(eid, 'chop', ev.success ? gain : -gain);
          this.ctx.bus.emit({ type: 'resource_gained', eid, item: h?.product ?? this.ctx.tuning.gather.chopItem, amount: gain });
          this.ctx.bus.emit({ type: 'work_completed', eid, work: 'chop', success: ev.success, x, y });
          // 心情微调（写死 +2/-3，未进 tuning：与采矿档位刻意有差）
          this.ctx.adjustMood(eid, ev.success ? 2 : -3);
          this.ctx.clearTrailCache();
          st.chopXY = undefined;
          st.chopProgress = undefined;
        }
      }
    }
  }
}
