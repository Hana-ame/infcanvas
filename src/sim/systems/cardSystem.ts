// 行为系统：消费卡的意图(intent) → 执行（走位/工作/进食/祈祷）
// 意图执行器可注册：mod 加新意图 = 注册一个执行器
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import type { PawnState } from '../sim';
import type { BehaviorCard, CardContext, CardView, BehaviorIntent } from '../ai/pawn';
import { drawCards, pickBest } from '../ai/pawn';
import { BUILDINGS } from '../defs';

// 意图执行器：mod 可注册新意图
export type IntentExecutor = (ctx: SimContext, eid: number, st: PawnState, intent: BehaviorIntent) => void;

export class BehaviorSystem implements GameSystem {
  id = 'behavior';
  private intentExecutors = new Map<string, IntentExecutor>();

  constructor(private ctx: SimContext) {
    // 注册内建意图执行器
    this.intentExecutors.set('walkAndWork', (c, eid, st, intent) => this.execWalkAndWork(c, eid, st, intent));
    this.intentExecutors.set('eat', (c, eid, st, intent) => this.execEat(c, eid, st, intent));
    this.intentExecutors.set('rest', (c, eid, st, intent) => this.execRest(c, eid, st, intent));
    this.intentExecutors.set('heal', (c, eid, st, intent) => this.execHeal(c, eid, st, intent));
    this.intentExecutors.set('pray', (c, eid, st, intent) => this.execPray(c, eid, st, intent));
    this.intentExecutors.set('idle', (c, eid, st) => { st.job = '闲逛'; });
  }

  // mod 入口：注册新意图执行器
  registerIntent(action: string, fn: IntentExecutor): this {
    this.intentExecutors.set(action, fn);
    return this;
  }

  init(_bus: EventBus): void {}

  update(dt: number): void {
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const pos = this.ctx.readPosition(eid);
      if (!pos) continue;

      // 工作中（采集/祈祷/疗伤/建造进度）不打断
      if (st.mining || st.chopXY || st.praying || st.healing) continue;

      // 玩家命令冷却递减
      if ((st.commandCooldown ?? 0) > 0) st.commandCooldown = (st.commandCooldown ?? 0) - dt;

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

      // 玩家命令冷却中：空闲等待（不自动决策，尊重玩家指挥）
      if ((st.commandCooldown ?? 0) > 0) {
        st.job = '听从指令';
        continue;
      }

      // 空闲：抽3选1 → 执行意图
      const intent = this.decide(eid, st);
      if (intent) {
        st.job = intent.label;
        const exec = this.intentExecutors.get(intent.action);
        if (exec) exec(this.ctx, eid, st, intent);
      } else {
        st.job = '闲逛';
      }
    }
  }

  // 抽卡决策 → 返回意图（并记录决策日志）
  private decide(eid: number, st: PawnState): BehaviorIntent | null {
    const view: CardView = {
      needsOf: (e) => this.ctx.readNeeds(e),
      healthOf: (e) => this.ctx.readHealth(e),
      isNight: () => this.ctx.isNight(),
      hasCampfire: () => this.ctx.world.hasBuilding('campfire'),
      buildQueueCount: this.ctx.buildQueue.length,
      stockpile: this.ctx.stockpile,
    };
    const ctx: CardContext = { view, eid };
    const pawnLike = { dna: st.dna, slots: st.slots };
    const drawn = drawCards(pawnLike, this.ctx.rng, 3, ctx);
    const card = pickBest(drawn, ctx);
    if (!card) return null;
    // 意图失真：违抗 roll —— 3张里若有"本我卡"(生理/娱乐系)没被选，
    // 小人心情差或懒惰时会违抗，改选本我卡（个体利益 ≠ 玩家利益）
    const picked = card;
    const idCard = drawn.find((c) => c !== picked && (c.series === 'physio' || c.series === 'leisure'));
    let chosen = picked;
    if (idCard) {
      const n = this.ctx.readNeeds(eid);
      const lazy = st.dna.traits.includes('懒惰');
      const moodLow = (n?.mood ?? 60) < 30;
      const base = (lazy ? 0.5 : 0) + (moodLow ? 0.35 : 0);
      if (base > 0 && this.ctx.rng.next() < base) {
        chosen = idCard;
        this.ctx.logEvent('😒 小人违抗了安排');
      }
    }
    // 记录决策（狗屁倒灶日志素材）
    st.lastDecision = {
      drawn: drawn.map((c) => c.name),
      picked: chosen.name,
      time: this.ctx.time,
    };
    return chosen.decide(ctx);
  }

  // ---- 意图执行 ----
  private execWalkAndWork(c: SimContext, eid: number, st: PawnState, intent: BehaviorIntent): void {
    const pos = c.readPosition(eid);
    if (!pos) return;
    if (intent.workType === 'chop') {
      const tree = c.findNearest(pos, (x, y) => c.world.getTile(x, y) === 'tree', true);
      if (tree) { st.chopTarget = tree; c.moveAdjacent(eid, tree.x, tree.y); }
      else st.job = '闲逛';
    } else if (intent.workType === 'mine') {
      const ore = c.findNearest(pos, (x, y) => c.world.getTile(x, y) === 'ore', true);
      if (ore) { st.mineTarget = ore; c.moveAdjacent(eid, ore.x, ore.y); }
      else st.job = '闲逛';
    } else if (intent.workType === 'build') {
      if (c.buildQueue.length > 0) {
        // 找最近的蓝图（而不是永远第一个）
        const pos = c.readPosition(eid);
        let best: (typeof c.buildQueue)[number] | null = null;
        let bestD = Infinity;
        if (pos) {
          for (const b of c.buildQueue) {
            const d = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2;
            if (d < bestD) { bestD = d; best = b; }
          }
        }
        const b = best ?? c.buildQueue[0];
        const def = BUILDINGS[b.defId];
        st.job = `建造:${def.name}`;
        c.moveTo(eid, b.x, b.y);
      } else st.job = '闲逛';
    }
  }

  private execEat(c: SimContext, eid: number, _st: PawnState, _intent: BehaviorIntent): void {
    const n = c.readNeeds(eid);
    if (n && c.stockpile.food > 0) {
      c.stockpile.food--;
      n.food = Math.min(100, n.food + 40);
      c.setNeeds(eid, n);
      c.bus.emit({ type: 'eat', eid });
    }
  }

  private execRest(c: SimContext, eid: number, _st: PawnState, _intent: BehaviorIntent): void {
    const n = c.readNeeds(eid);
    if (n) {
      n.rest = Math.min(100, n.rest + 40);
      c.setNeeds(eid, n);
      c.bus.emit({ type: 'rest', eid });
    }
  }

  // 疗伤：去篝火旁休息回血
  private execHeal(c: SimContext, eid: number, st: PawnState, _intent: BehaviorIntent): void {
    const pos = c.readPosition(eid);
    if (!pos) return;
    const fire = c.findNearest(pos, (x, y) => c.world.getBuilding(x, y)?.def.id === 'campfire', true);
    if (fire) {
      st.healTarget = fire;
      c.moveAdjacent(eid, fire.x, fire.y);
    } else {
      // 无篝火则原地休养
      st.healing = { progress: 0 };
    }
  }

  private execPray(c: SimContext, eid: number, st: PawnState, _intent: BehaviorIntent): void {
    const pos = c.readPosition(eid);
    if (!pos) return;
    const fire = c.findNearest(pos, (x, y) => c.world.getBuilding(x, y)?.def.id === 'campfire', true);
    if (fire) {
      st.prayTarget = fire;
      c.moveAdjacent(eid, fire.x, fire.y);
    } else st.job = '闲逛';
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

  private walk(eid: number, st: PawnState, pos: { x: number; y: number }, dt: number): void {
    const target = st.path![st.pathIndex!];
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dist = Math.hypot(dx, dy);
    const sp = this.ctx.readSpeed(eid);
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
    this.ctx.setPosition(eid, pos);
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
    } else if (st.prayTarget) {
      const { x, y } = st.prayTarget;
      st.prayTarget = undefined;
      st.praying = { x, y, progress: 0 };
    } else if (st.healTarget) {
      st.healTarget = undefined;
      st.healing = { progress: 0 };
    }
  }
}
