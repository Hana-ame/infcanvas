// 行为系统：消费卡的意图(intent) → 执行（走位/工作/进食/祈祷）
// 意图执行器可注册：mod 加新意图 = 注册一个执行器
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { PositionData } from '../sim';
import { TECHS } from '../defs/techs';
import type { EventBus } from '../core/events';
import { World } from '../core/world';
import type { PawnState } from '../sim';
import type { BehaviorCard, CardContext, CardView, BehaviorIntent } from '../ai/pawn';
import { drawCards, pickBest, BASE_CARDS } from '../ai/pawn';
import { JOB_CARD, JOBS } from '../defs/jobs';
import { BUILTIN_INTENTS, BUILTIN_WORKS } from '../defs/executors';
import { fulfill } from '../core/desires';
// RW-1 工作优先级：decide 把 pawn.extra[K_WORK_PRIORITIES] 暴露给权重规则（跨包键走常量）
import { K_WORK_PRIORITIES } from '../mods/contracts';

// 意图执行器：mod 可注册新意图
export type IntentExecutor = (ctx: SimContext, eid: number, st: PawnState, intent: BehaviorIntent) => void;

// 工作执行器：mod 可注册新工作类型（walkAndWork 按 workType 分派到执行器）
export type WorkExecutor = (ctx: SimContext, eid: number, st: PawnState, intent: BehaviorIntent) => void;

export class BehaviorSystem implements GameSystem {
  id = 'behavior';
  private intentExecutors = new Map<string, IntentExecutor>();
  private workExecutors = new Map<string, WorkExecutor>();

  constructor(private ctx: SimContext) {
    // 数据驱动：内置意图/工作执行器从表（defs/executors.ts）装配，handler 指向类方法
    for (const d of BUILTIN_INTENTS) {
      const fn = (this as unknown as Record<string, unknown>)[d.handler] as IntentExecutor;
      this.intentExecutors.set(d.id, fn.bind(this));
    }
    for (const d of BUILTIN_WORKS) {
      const fn = (this as unknown as Record<string, unknown>)[d.handler] as WorkExecutor;
      this.workExecutors.set(d.type, fn.bind(this));
    }
  }

  // mod 入口：注册新意图执行器
  registerIntent(action: string, fn: IntentExecutor): this {
    this.intentExecutors.set(action, fn);
    return this;
  }

  // mod 入口：注册新工作类型执行器（配合卡 decide 产出的 workType）
  registerWork(type: string, fn: WorkExecutor): this {
    this.workExecutors.set(type, fn);
    return this;
  }

  init(_bus: EventBus): void {}

  update(dt: number): void {
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const pos = this.ctx.readPosition(eid);
      if (!pos) continue;

      // 理智崩溃：狂乱行为由 SanSystem 接管（发呆/乱跑），不自动决策
      // 崩溃前遗留的路径仍推进（否则 path 走不完 + SanSystem 见 path 早退 = 永久冻结）
      const n = this.ctx.readNeeds(eid);
      if (n && n.san < this.ctx.tuning.san.crazyAt) {
        st.job = '理智崩溃';
        if (st.path && st.pathIndex < st.path.length) this.walk(eid, st, pos, dt);
        continue;
      }

      // 工作中（采集/祈祷/疗伤/建造进度）不打断
      if (st.mining || st.chopXY || st.praying || st.healing || st.caveWork) continue;

      // 玩家命令冷却递减
      if ((st.commandCooldown ?? 0) > 0) st.commandCooldown = (st.commandCooldown ?? 0) - dt;
      // 远距回扫冷却递减（miss 后 5s 内不重复大半径扫描，防性能拖垮）
      if ((st.farScanCd ?? 0) > 0) st.farScanCd = (st.farScanCd ?? 0) - dt;
      // 寻路节流冷却递减（两次寻路最小间隔）
      if ((st.pathCd ?? 0) > 0) st.pathCd = (st.pathCd ?? 0) - dt;

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

  // 互助目标探测（2026-08-14 互助卡）：相邻距离内的邻人，满足"弱势（缺食/受伤/低落）"且
  // 我对 TA 好感 ≥ helpFriendAt（亲密才帮）。返回最优目标 eid 或 null。
  private findHelpTarget(eid: number): number | null {
    const s = this.ctx.tuning.social;
    const me = this.ctx.pawnPositions.get(eid);
    if (!me) return null;
    const myRel = this.ctx.pawnStates.get(eid)?.relationships;
    let best: number | null = null;
    let bestNeed = 0;
    for (const other of this.ctx.pawnList) {
      if (other === eid) continue;
      const pos = this.ctx.pawnPositions.get(other);
      if (!pos) continue;
      if (Math.hypot(pos.x - me.x, pos.y - me.y) > s.meetDist) continue; // 必须相邻
      // 好感门槛：亲密才帮（帮助不是义务，是情分）
      const rel = myRel?.get(other) ?? 0;
      if (rel < s.helpFriendAt) continue;
      const stO = this.ctx.pawnStates.get(other);
      const need = this.ctx.readNeeds(other);
      const hp = this.ctx.readHealth(other);
      let score = 0;
      if (need && need.food < s.helpFoodNeedAt) score += 40 - need.food; // 缺食（送食）
      if (hp && hp.hp < s.helpHpNeedAt) score += 60 - hp.hp;             // 受伤（疗伤）
      if (need && need.mood < s.helpMoodNeedAt) score += 30 - need.mood; // 低落（陪伴）
      if (score > bestNeed) { bestNeed = score; best = other; }
    }
    return best;
  }

  // 抽卡决策 → 返回意图（并记录决策日志）
  private decide(eid: number, st: PawnState): BehaviorIntent | null {
    const view: CardView = {
      needsOf: (e) => this.ctx.readNeeds(e),
      healthOf: (e) => this.ctx.readHealth(e),
      isNight: () => this.ctx.isNight(),
      hasCampfire: () => this.ctx.world.hasBuildingWithTag('warmth'),
      hasCave: () => this.ctx.world.hasBuildingWithTag('mine'),
      hasRaft: () => this.ctx.world.hasBuildingWithTag('raft'),
      hasBuildingWithTag: (tag: string) => this.ctx.world.hasBuildingWithTag(tag),
      desiresOf: (e) => this.ctx.pawnStates.get(e)?.desires ?? null,
      env: this.ctx.env,
      lastSeries: st.lastSeries,
      factionPriority: this.ctx.factionPriority,
      // 神谕目标注入 view（策略卡 = 神谕目标，DESIGN §3 三层分离）：
      // 目标工作系列权重 ×oracleGoalMul 偏向该工作，不插小人卡槽、不碰选择链
      oracleGoal: this.ctx.oracleGoal,
      techs: this.ctx.techs,
      assignedJob: st.assignedJob,
      // RW-1 工作优先级：把 pawn 的优先级（extra[K_WORK_PRIORITIES]）暴露给权重规则。
      // 缺省 undefined（全自动）→ workPriority 规则不改动权重，兼容未设置的小人。
      workPriorities: (st.extra?.[K_WORK_PRIORITIES] as Record<string, number> | undefined),
      leanOf: (e, k) => this.ctx.leanOf(e, k),
      expectEarnOf: (e, workType) => this.ctx.pawnStates.get(e)?.expectEarnBy?.[workType] ?? 0,
      buildQueueCount: this.ctx.buildQueue.length,
      stockpile: this.ctx.stockpile,
      tuning: this.ctx.tuning,
      markovBias: this.ctx.mods.markovBias,
      jobCards: this.ctx.mods.jobCards,
      desireOfSeries: (series) => this.ctx.mods.seriesDesire[series] ?? null,
      // 互助探测：找近处"缺食/受伤/低落"且我对 TA 好感 ≥ 门槛的邻人
      helpTargetOf: (eid) => this.findHelpTarget(eid),
      // 附近有可狩猎的猫（采集狩猎 mod 狩猎卡谓词）：索敌半径 ~40 格内存在 cat 敌人
      //（采集狩猎猫游荡在营地 15-40 环带；25 时营地附近伐木的人几乎永远触发不了）
      hostilesNearby: (eid) => {
        const pos = this.ctx.pawnPositions.get(eid);
        if (!pos) return false;
        return this.ctx.hostiles.some((h) => {
          if (h.enemyId !== 'cat') return false;
          return (h.x - pos.x) ** 2 + (h.y - pos.y) ** 2 <= 40 * 40;
        });
      },
      // 距最近 warmth 建筑（篝火）距离；-1 = 全图无火（"夜归篝火"类谓词用）
      campfireDist: (eid) => {
        const pos = this.ctx.pawnPositions.get(eid);
        if (!pos) return -1;
        const w = this.ctx.world;
        const near = w.queryBuildingsNear(Math.round(pos.x), Math.round(pos.y), 64);
        let best = Infinity;
        for (const b of near) if (b.def.tags?.includes('warmth')) best = Math.min(best, b.dist);
        if (best === Infinity) return -1;
        return best;
      },
    };
    const ctx: CardContext = { view, eid };
    const pawnLike = { dna: st.dna, slots: st.slots };
    // Q10：指派职业时确保对应工作卡在池中（否则可能因卡池缺失而闲逛）
    if (st.assignedJob && JOB_CARD[st.assignedJob]) {
      const jobCardId = JOB_CARD[st.assignedJob];
      if (!pawnLike.slots.some((c) => c?.id === jobCardId)) {
        const jobCard = BASE_CARDS.find((c) => c.id === jobCardId);
        if (jobCard) pawnLike.slots = [...pawnLike.slots, jobCard];
      }
    }
    const drawn = drawCards(pawnLike, this.ctx.rng, this.ctx.tuning.card.drawCount, ctx);
    const card = pickBest(drawn, ctx);
    if (!card) return null;
    // 意图失真：违抗 roll —— 仅当"工作卡被选但存在未选的本我卡"时才可能违抗
    // （若本来选的就是本我卡/闲逛，不算违抗）加冷却防刷屏
    const cd = this.ctx.tuning.card;
    const picked = card;
    let chosen = picked;
    if (picked.series === 'work' && !(st.defyCd ?? 0)) {
      const idCard = drawn.find((c) => c !== picked && (c.series === 'physio' || c.series === 'leisure'));
      if (idCard) {
        const n = this.ctx.readNeeds(eid);
        const lazy = st.dna.traits.includes('懒惰');
        const moodLow = (n?.mood ?? this.ctx.tuning.needs.initMood) < cd.defyMoodAt;
        const faithReduce = (st.faith ?? 0) * cd.faithReducePerFaith;
        const base = Math.max(0, (lazy ? cd.defyLazy : 0) + (moodLow ? cd.defyMoodLow : 0) - faithReduce);
        if (base > 0 && this.ctx.rng.next() < base) {
          chosen = idCard;
          st.defyCd = cd.defyCd;
          this.ctx.logEvent('😒 小人违抗了安排');
        }
      }
    }
    if (st.defyCd) st.defyCd--;
    // 熟练度（P0.5 卡演化）：选中即熟练 +1；超过衰减窗口未用 → 回落（惰性衰减，无需定时器）
    const MASTERY_DECAY_AFTER = 600; // 秒：超过此时间未用则回落
    const now = this.ctx.time;
    if (chosen.lastUsed !== undefined && now - chosen.lastUsed > MASTERY_DECAY_AFTER) {
      chosen.mastery = Math.max(0, (chosen.mastery ?? 0) - 2);
    }
    chosen.lastUsed = now;
    chosen.mastery = Math.min(100, (chosen.mastery ?? 0) + 1);
    // 记录决策（狗屁倒灶日志素材）+ 马尔可夫偏置源（DESIGN §6）
    st.lastDecision = {
      drawn: drawn.map((c) => c.name),
      picked: chosen.name,
      time: this.ctx.time,
    };
    st.lastSeries = chosen.series;
    // 卡自带"满足欲望"声明（数据驱动，替代按 job 文案匹配）：选中即满足
    if (st.desires) {
      for (const s of chosen.satisfies ?? []) fulfill(st.desires, s.desire, s.amount);
    }
    return chosen.decide(ctx);
  }

  // ---- 意图执行 ----
  private execIdle(_c: SimContext, _eid: number, st: PawnState, _intent: BehaviorIntent): void {
    st.job = '闲逛';
  }

  // 探索（用户设计：科技建筑只有娱乐卡能"想到"建）：娱乐时灵光一现 → 规划蓝图入队
  // 蓝图落点：营地（首个 campfire）旁环扫可建格；目标建筑从卡 id 解析（explore:well → well）
  // 互助执行（2026-08-14 用户设计：小人对小人好感高 → 帮忙 = 满足对方食物/娱乐需求）。
  // 对象 = findHelpTarget 判定的"值得帮的弱势邻人"（缺食/受伤/低落 + 我好感高）。
  // 送食从自己口袋转给对方（私有食物）；疗伤直接回血；陪伴加心情。受助方好感提升（互惠）。
  private execHelp(c: SimContext, eid: number, st: PawnState, _intent: BehaviorIntent): void {
    const target = this.findHelpTarget(eid);
    if (target === null) { st.job = '闲逛'; return; }
    const s = c.tuning.social;
    const stT = c.pawnStates.get(target);
    if (!stT) return;
    const need = c.readNeeds(target);
    const hp = c.readHealth(target);
    // 送食（对方缺食且我有私粮）
    if (need && need.food < s.helpFoodNeedAt && (st.inventory?.food ?? 0) >= s.helpFoodAmount) {
      st.inventory = { ...st.inventory, food: (st.inventory?.food ?? 0) - s.helpFoodAmount };
      stT.inventory = { ...stT.inventory, food: (stT.inventory?.food ?? 0) + s.helpFoodAmount };
      c.recordSpend(eid, 'food', s.helpFoodAmount);
      need.food = Math.min(100, need.food + 15); // 收到食物 → 饱腹
      c.setNeeds(target, need);
      this.logHelp(c, eid, target, `🤝 #${eid} 把食物分给了饥饿的 #${target}`);
    } else if (hp && hp.hp < s.helpHpNeedAt) {
      // 疗伤（对方受伤）
      hp.hp = Math.min(hp.maxHp, hp.hp + s.helpHealPerSec);
      c.setHealth(target, hp);
      this.logHelp(c, eid, target, `🩹 #${eid} 为受伤的 #${target} 包扎伤口`);
    } else if (need && need.mood < s.helpMoodNeedAt) {
      // 陪伴（对方低落）
      need.mood = Math.min(100, need.mood + s.helpMoodGain);
      c.setNeeds(target, need);
      this.logHelp(c, eid, target, `💗 #${eid} 陪伴情绪低落的 #${target} 说说话`);
    }
    // 互惠：受助方对施助方好感提升
    const relT = stT.relationships ?? new Map<number, number>();
    relT.set(eid, Math.max(s.relFloor, Math.min(s.relCap, (relT.get(eid) ?? 0) + s.helpGiveRel)));
    stT.relationships = relT;
    st.job = '互助';
  }

  // 互助日志 + 好感（施助方对受助方也微增，巩固友谊）
  private logHelp(c: SimContext, eid: number, target: number, text: string): void {
    c.logEvent(text);
    const st = c.pawnStates.get(eid);
    if (st) {
      const rel = st.relationships ?? new Map<number, number>();
      const s = c.tuning.social;
      rel.set(target, Math.max(s.relFloor, Math.min(s.relCap, (rel.get(target) ?? 0) + 1)));
      st.relationships = rel;
    }
  }

  private execExplore(c: SimContext, eid: number, st: PawnState, intent: BehaviorIntent): void {
    st.job = intent.label;
    const buildingId = intent.label.split(':')[1] ?? '';
    const def = c.buildingDef(buildingId);
    if (!def) { st.job = '闲逛'; return; }
    // 已有该建筑（被别人建了）→ 不再探索
    if (c.world.hasBuildingWithTag(buildingId)) { st.job = '闲逛'; return; }
    // 蓝图已在队列（重复探索）→ 跳过（防蓝图堆积：垦田令同款去重）
    if (c.buildQueue.some((b) => b.defId === buildingId)) { st.job = '闲逛'; return; }
    // 营地位置（首个 campfire）
    let camp: { x: number; y: number } | null = null;
    for (const [k, b] of c.world.buildings) {
      if (b.def.id === 'campfire') { camp = World.keyToXY(k); break; }
    }
    if (!camp) { st.job = '闲逛'; return; }
    // 环扫找落点（2→5 回退；靠营地内圈，减少外围被猫拆）
    for (let r = 3; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = camp.x + dx;
          const y = camp.y + dy;
          if (c.world.canBuildFootprint(x, y, def)) {
            c.issueCommand({ type: 'build', x, y, buildingId });
            c.logEvent(`🎈 #${eid} 玩耍时灵光一现：在这里建${def.name}！`);
            return;
          }
        }
      }
    }
    st.job = '闲逛';
  }

  private execWalkAndWork(c: SimContext, eid: number, st: PawnState, intent: BehaviorIntent): void {
    const exec = intent.workType ? this.workExecutors.get(intent.workType) : undefined;
    if (exec) exec(c, eid, st, intent);
    else st.job = '闲逛';
  }

  private workChop(c: SimContext, eid: number, st: PawnState): void {
    const pos = c.readPosition(eid);
    if (!pos) return;
    // 数据驱动目标查找：可收获（growable）且带 harvest 定义的 tile（mod 新采集物自动可采）
    const want = (x: number, y: number): boolean => {
      const t = c.world.getTileDef(x, y);
      return !!t.growable && !!t.harvest;
    };
    // 近距快扫 miss → 远距回扫（营地周边资源采空后仍能远行采伐，防停产）
    const tree = this.findNearFar(c, eid, st, pos, want);
    if (tree) { st.chopTarget = tree; c.moveAdjacent(eid, tree.x, tree.y); }
    else st.job = '闲逛';
  }

  private workMine(c: SimContext, eid: number, st: PawnState): void {
    const pos = c.readPosition(eid);
    if (!pos) return;
    // 数据驱动目标查找：mineral 且带 harvest 定义的 tile
    const ore = this.findNearFar(c, eid, st, pos, (x, y) => {
      const t = c.world.getTileDef(x, y);
      return !!t.mineral && !!t.harvest;
    });
    if (ore) { st.mineTarget = ore; c.moveAdjacent(eid, ore.x, ore.y); }
    else st.job = '闲逛';
  }

  private workCaveMine(c: SimContext, eid: number, st: PawnState): void {
    const pos = c.readPosition(eid);
    if (!pos) return;
    const cave = this.findNearFar(c, eid, st, pos, (x, y) => c.world.getBuilding(x, y)?.def.tags?.includes('mine') ?? false);
    if (cave) { st.caveTarget = cave; c.moveAdjacent(eid, cave.x, cave.y); }
    else st.job = '闲逛';
  }

  // 捕鱼：找竹筏（站上筏 → 钓水格；产出走筏的 recipe 'fishing'）
  private workFish(c: SimContext, eid: number, st: PawnState): void {
    const pos = c.readPosition(eid);
    if (!pos) return;
    const raft = this.findNearFar(c, eid, st, pos, (x, y) => c.world.getBuilding(x, y)?.def.tags?.includes('raft') ?? false);
    if (raft) { st.caveTarget = raft; c.moveAdjacent(eid, raft.x, raft.y); }
    else st.job = '闲逛';
  }

  // 近距快扫 miss → 远距回扫（营地周边资源采空后仍能远行工作，防长期停产）
  // miss 后 5s 冷却内完全跳过扫描：空闲小人（找不到目标）每 tick 都做
  // 15 半径环扫（706 格）是长局行为系统 10 倍退化的主因（profiler 火焰图定位）
  private findNearFar(c: SimContext, eid: number, st: PawnState, pos: PositionData, cond: (x: number, y: number) => boolean): { x: number; y: number } | null {
    if ((st.farScanCd ?? 0) > 0) return null;
    const near = c.findNearest(pos, cond, true);
    if (near) return near;
    const far = c.findNearest(pos, cond, true, c.tuning.pawn.farScanRadius);
    if (!far) st.farScanCd = 5;
    return far;
  }

  // 科技建筑渐进权重（用户设计）：解锁初期只有娱乐探索卡能建（权重 0），
  // 随解锁时长 techBuildWeight 0→1 爬升——普通建造卡在无队列时按权重概率规划蓝图
  private techBuildChance(c: SimContext, eid: number, st: PawnState): void {
    const pos = c.readPosition(eid);
    if (!pos) return;
    const t = c.tuning.tech;
    // 建造兴趣门控（v2026-08-13 兴趣驱动娱乐：建造是娱乐活动之一，只有有 build 兴趣的人才会
    // 「按经验规划」科技建筑；无兴趣者即使科技解锁、权重爬满也不主动建——与探索卡同源设计）
    if (!c.pawnStates.get(eid)?.dna.interests.includes('build')) { st.job = '闲逛'; return; }
    // 已解锁的科技建筑（按解锁顺序，取"营地还没有的"）
    const candidates: { techId: string; defId: string }[] = [];
    for (const techId of Object.keys(c.techs)) {
      const w = c.techBuildWeight(techId);
      if (w <= 0) continue;
      for (const defId of TECHS[techId]?.unlocks ?? []) {
        if (c.world.hasBuildingWithTag(defId)) continue;
        if (c.buildQueue.some((b) => b.defId === defId)) continue;
        candidates.push({ techId, defId });
      }
    }
    if (candidates.length === 0) { st.job = '闲逛'; return; }
    // 按权重概率：权重 1 → 每候选 10% 概率规划（渐进接管）；权重低 → 更少
    for (const cand of candidates) {
      const w = c.techBuildWeight(cand.techId);
      if (c.rng.next() < w * 0.1) {
        const def = c.buildingDef(cand.defId);
        if (!def) continue;
        // 营地旁环扫落点（复用探索落点逻辑）
        let camp: { x: number; y: number } | null = null;
        for (const [k, b] of c.world.buildings) {
          if (b.def.id === 'campfire') { camp = World.keyToXY(k); break; }
        }
        if (!camp) continue;
        for (let r = 2; r <= 5; r++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const x = camp.x + dx;
              const y = camp.y + dy;
              if (c.world.canBuildFootprint(x, y, def)) {
                c.issueCommand({ type: 'build', x, y, buildingId: cand.defId });
                c.logEvent(`🏗 #${eid} 按经验规划建造${def.name}（科技权重已就位）`);
                return;
              }
            }
          }
        }
      }
    }
    st.job = '闲逛';
  }

  private workBuild(c: SimContext, eid: number, st: PawnState): void {
    if (c.buildQueue.length === 0) {
      // 无队列 → 科技建筑渐进权重接管（解锁初期概率低，权重满后稳定自动建）
      this.techBuildChance(c, eid, st);
      return;
    }
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
      const def = c.buildingDef(b.defId);
      st.job = `建造:${def?.name ?? b.defId}`;
      c.moveTo(eid, b.x, b.y);
    } else st.job = '闲逛';
  }

  private execEat(c: SimContext, eid: number, st: PawnState, _intent: BehaviorIntent): void {
    const n = c.readNeeds(eid);
    if (!n) return;
    // 私有食物（2026-08-14）：优先吃自己口袋的；没有 → 公共粮仓兜底
    if (this.consumeFood(c, eid, st, c.tuning.card.eatCost)) {
      n.food = Math.min(100, n.food + c.tuning.card.eatAmount);
      c.setNeeds(eid, n);
      if (st.desires) fulfill(st.desires, 'gluttony', c.tuning.desire.fulfillGluttony);
      c.recordOutcome(eid, 'eat', c.tuning.card.eatAmount);
      c.bus.emit({ type: 'eat', eid });
    }
  }

  // 消耗食物（私有优先，公共兜底）：返回是否吃上。个人 inventory 有 → 扣个人；
  // 没有 → 全局粮仓有 → 扣全局（公共资源）。两个都没有 → 吃不上（饿着/求助）
  private consumeFood(c: SimContext, eid: number, st: PawnState, cost: number): boolean {
    const inv = st.inventory;
    if ((inv?.food ?? 0) >= cost) {
      st.inventory = { ...inv, food: (inv?.food ?? 0) - cost };
      c.recordSpend(eid, 'food', cost); // 经济账本：支出
      return true;
    }
    if (c.stockpile.food > 0) {
      c.stockpile.food -= cost;
      c.recordSpend(eid, 'food', cost); // 经济账本：支出（公共粮仓）
      return true;
    }
    return false;
  }

  private execRest(c: SimContext, eid: number, st: PawnState, _intent: BehaviorIntent): void {
    const n = c.readNeeds(eid);
    if (n) {
      n.rest = Math.min(100, n.rest + c.tuning.card.restAmount);
      c.setNeeds(eid, n);
      if (st.desires) fulfill(st.desires, 'sloth', c.tuning.desire.fulfillSloth);
      c.recordOutcome(eid, 'rest', c.tuning.card.restAmount);
      c.bus.emit({ type: 'rest', eid });
    }
  }

  // 疗伤：去篝火旁休息回血
  private execHeal(c: SimContext, eid: number, st: PawnState, _intent: BehaviorIntent): void {
    const pos = c.readPosition(eid);
    if (!pos) return;
    const fire = c.findNearest(pos, (x, y) => c.world.getBuilding(x, y)?.def.tags?.includes('heal') ?? false, true);
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
    const fire = c.findNearest(pos, (x, y) => c.world.getBuilding(x, y)?.def.tags?.includes('pray') ?? false, true);
    if (fire) {
      st.prayTarget = fire;
      c.moveAdjacent(eid, fire.x, fire.y);
    } else st.job = '闲逛';
  }

  // 紧急需求处理（st.urgent 由 NeedsSystem 按阈值设定）：直接进食/休息，不抽卡、不打断
  private handleUrgent(eid: number, st: PawnState, dt: number): void {
    void dt;
    const n = this.ctx.readNeeds(eid);
    if (!n) return;
    if (st.urgent === 'eat' && n.food >= this.ctx.tuning.needs.urgentEatAt) { st.urgent = undefined; return; }
    if (st.urgent === 'rest' && n.rest >= this.ctx.tuning.needs.urgentRestAt) { st.urgent = undefined; return; }
    if (st.urgent === 'eat' && this.consumeFood(this.ctx, eid, st, this.ctx.tuning.card.eatCost)) {
      n.food = Math.min(100, n.food + this.ctx.tuning.card.eatAmountUrgent);
      this.ctx.setNeeds(eid, n);
      if (st.desires) fulfill(st.desires, 'gluttony', this.ctx.tuning.desire.fulfillGluttony);
      this.ctx.recordOutcome(eid, 'eat', this.ctx.tuning.card.eatAmountUrgent);
      this.ctx.bus.emit({ type: 'eat', eid });
      st.urgent = undefined;
    } else if (st.urgent === 'rest') {
      n.rest = Math.min(100, n.rest + this.ctx.tuning.card.restAmountUrgent);
      this.ctx.setNeeds(eid, n);
      if (st.desires) fulfill(st.desires, 'sloth', this.ctx.tuning.desire.fulfillSloth);
      this.ctx.recordOutcome(eid, 'rest', this.ctx.tuning.card.restAmountUrgent);
      this.ctx.bus.emit({ type: 'rest', eid });
      st.urgent = undefined;
    }
  }

  // 沿 path 逐段移动（速度 × 心情系数 moodFactor，读 tuning.pawn）；走完全程 → onArrive
  private walk(eid: number, st: PawnState, pos: { x: number; y: number }, dt: number): void {
    const target = st.path![st.pathIndex!];
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dist = Math.hypot(dx, dy);
    const sp = this.ctx.readSpeed(eid);
    const nd = this.ctx.readNeeds(eid);
    const pw = this.ctx.tuning.pawn;
    const moodFactor = nd ? pw.moodSpeedBase + (nd.mood / 100) * pw.moodSpeedScale : 1;
    const move = (sp?.v ?? pw.baseSpeed) * moodFactor * dt;
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

  // 到达终点回执：按等待中的目标类型转入对应工作态（采集/祈祷/疗伤/mod 工作）
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
    } else if (st.caveTarget) {
      const { x, y } = st.caveTarget;
      st.caveTarget = undefined;
      // 到达建筑 → 记录 recipe id（caveWork 兼容旧档：旧值无 buildingId → 产矿石）
      const b = this.ctx.world.getBuilding(x, y);
      st.caveWork = { x, y, progress: 0, buildingId: b?.def.recipe };
    } else if (st.prayTarget) {
      const { x, y } = st.prayTarget;
      st.prayTarget = undefined;
      st.praying = { x, y, progress: 0 };
    } else if (st.healTarget) {
      st.healTarget = undefined;
      st.healing = { progress: 0 };
    } else if (st.onArriveWork) {
      // mod 工作的到达回执：executor 设 st.onArriveWork，走到点后调用
      const w = st.onArriveWork;
      st.onArriveWork = undefined;
      w();
    }
  }
}
