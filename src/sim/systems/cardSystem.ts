// 卡系统：小人决策核心 —— 需求紧急处理 + 移动 + 抽3选1执行
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import type { PawnState } from '../sim';
import type { BehaviorCard, CardContext } from '../ai/pawn';
import { drawCards, pickBest } from '../ai/pawn';
import { BUILDINGS } from '../defs';

export class CardSystem implements GameSystem {
  id = 'card';

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const pos = this.ctx.readPosition(eid);
      if (!pos) continue;

      // 紧急需求优先
      if (st.urgent) {
        this.handleUrgent(eid, st, dt);
        continue;
      }

      // 走路
      if (st.path && st.pathIndex < st.path.length) {
        this.walk(eid, st, pos, dt);
        continue;
      }

      // 空闲：抽3选1
      this.assignCardWork(eid, st, pos);
    }
  }

  private walk(eid: number, st: PawnState, pos: { x: number; y: number }, dt: number): void {
    const target = st.path![st.pathIndex!];
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dist = Math.hypot(dx, dy);
    const sp = this.ctx.readSpeed?.(eid) ?? { v: 4 };
    const nd = this.ctx.readNeeds(eid);
    const moodFactor = nd ? 0.6 + (nd.mood / 100) * 0.6 : 1;
    const move = (sp?.v ?? 4) * moodFactor * dt;
    if (dist <= move) {
      pos.x = target.x;
      pos.y = target.y;
      st.pathIndex++;
      if (st.pathIndex >= st.path!.length) {
        st.path = [];
        this.onArrive(eid, st);
      }
    } else {
      pos.x += (dx / dist) * move;
      pos.y += (dy / dist) * move;
    }
    this.ctx.setPosition?.(eid, pos);
    this.ctx.pawnPositions.set(eid, { x: pos.x, y: pos.y });
  }

  private onArrive(eid: number, st: PawnState): void {
    if (st.mineTarget) {
      const { x, y } = st.mineTarget;
      st.mineTarget = undefined;
      st.mining = { x, y, progress: 0 };
    } else if (st.chopTarget) {
      const { x, y } = st.chopTarget;
      st.chopTarget = undefined;
      st.chopProgress = 0;
      st.chopXY = { x, y };
    }
  }

  private handleUrgent(eid: number, st: PawnState, dt: number): void {
    void dt;
    const n = this.ctx.readNeeds(eid);
    if (!n) return;
    if (st.urgent === 'eat' && n.food >= 70) { st.urgent = undefined; return; }
    if (st.urgent === 'rest' && n.rest >= 70) { st.urgent = undefined; return; }
    if (st.urgent === 'eat' && this.ctx.stockpile.food > 0) {
      this.ctx.stockpile.food--;
      n.food = Math.min(100, n.food + 50);
      this.ctx.setNeeds(eid, n);
      this.ctx.bus.emit({ type: 'eat', eid });
      st.urgent = undefined;
    } else if (st.urgent === 'rest') {
      n.rest = Math.min(100, n.rest + 40);
      this.ctx.setNeeds(eid, n);
      this.ctx.bus.emit({ type: 'rest', eid });
      st.urgent = undefined;
    }
  }

  private assignCardWork(eid: number, st: PawnState, pos: { x: number; y: number }): void {
    if (st.chopXY || st.mining) return;
    const ctx: CardContext = {
      sim: {
        buildQueueCount: this.ctx.buildQueue.length,
        stockpile: this.ctx.stockpile,
        needsOf: (e) => this.ctx.readNeeds(e),
        isNight: () => this.ctx.isNight(),
      },
      eid,
    };
    const pawnLike = { dna: st.dna, slots: st.slots };
    const drawn = drawCards(pawnLike, this.ctx.rng, 3, ctx);
    const card = pickBest(drawn, ctx);
    if (!card) { st.job = '闲逛'; return; }
    this.executeCard(eid, st, pos, card, ctx);
  }

  private executeCard(eid: number, st: PawnState, pos: { x: number; y: number }, card: BehaviorCard, ctx: CardContext): void {
    switch (card.action) {
      case 'chop': {
        const tree = this.ctx.findNearest(pos, (x, y) => this.ctx.world.getTile(x, y) === 'tree', true);
        if (tree) { st.job = '伐木'; st.chopTarget = tree; this.ctx.moveAdjacent(eid, tree.x, tree.y); }
        else st.job = '闲逛';
        break;
      }
      case 'mine': {
        const ore = this.ctx.findNearest(pos, (x, y) => this.ctx.world.getTile(x, y) === 'ore', true);
        if (ore) { st.job = '采矿'; st.mineTarget = ore; this.ctx.moveAdjacent(eid, ore.x, ore.y); }
        else st.job = '闲逛';
        break;
      }
      case 'build': {
        if (this.ctx.buildQueue.length > 0) {
          const b = this.ctx.buildQueue[0];
          const def = BUILDINGS[b.defId];
          st.job = `建造:${def.name}`;
          this.ctx.moveTo(eid, b.x, b.y);
        } else st.job = '闲逛';
        break;
      }
      case 'eat': {
        st.job = '进食';
        const n = this.ctx.readNeeds(eid);
        if (n && this.ctx.stockpile.food > 0) {
          this.ctx.stockpile.food--;
          n.food = Math.min(100, n.food + 40);
          this.ctx.setNeeds(eid, n);
          this.ctx.bus.emit({ type: 'eat', eid });
        }
        break;
      }
      case 'rest': {
        st.job = '休息';
        const n = this.ctx.readNeeds(eid);
        if (n) { n.rest = Math.min(100, n.rest + 40); this.ctx.setNeeds(eid, n); }
        break;
      }
      case 'pray':
      case 'idle':
      default:
        st.job = '闲逛';
        break;
    }
  }
}
