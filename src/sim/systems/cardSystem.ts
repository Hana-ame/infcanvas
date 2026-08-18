// 行为系统：消费卡的意图(intent) → 执行（走位/工作/进食/祈祷）
// 意图执行器可注册：mod 加新意图 = 注册一个执行器
//（2026-08-16 大文件拆分：执行器实现迁至 systems/executors.ts 纯函数实现表——
// 本类只留决策循环/移动/到达回执，装配走"声明表 × 实现表"双表数据驱动）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import type { PawnState } from '../sim';
import type { BehaviorCard, CardContext, CardView, BehaviorIntent } from '../ai/pawn';
import { drawCards, pickBest, BASE_CARDS } from '../ai/pawn';
import { JOB_CARD, JOBS } from '../defs/jobs';
import { BUILTIN_INTENTS, BUILTIN_WORKS } from '../defs/executors';
import { fulfill } from '../core/desires';
// RW-1 征召（M2）：K_DRAFTED 门在 update 里让征召小人跳过自决（跨包键走常量）
import { K_DRAFTED } from '../mods/contracts';
// 执行器实现表 + 迁出后仍需借用的内部 helper（findHelpTarget/consumeFood 原为类
// 方法，现由 decide 的 helpTargetOf 与紧急处理直接调用）
import {
  intentImplOf,
  workImplOf,
  findHelpTarget,
  consumeFood,
  type ExecutorDeps,
  type IntentExecutor,
  type WorkExecutor,
} from './executors';

// 类型 re-export：意图/工作执行器类型的权威定义在 executors.ts（实现表同源）；
// sim.ts/registry.ts 等既有 import 路径（'../systems/cardSystem'）保持不变
export type { IntentExecutor, WorkExecutor } from './executors';

// 拥挤统计格表（2026-08-16 热路径优化，配合 walk）：pawnPositions 按取整格聚合人数。
// 字符串键 `${x},${y}`（x/y 取整整数化，字符串拼接免 Map 数组/双层 Map 的分配开销）
const buildCrowdGrid = (c: SimContext): Map<string, number> => {
  const g = new Map<string, number>();
  for (const [, p] of c.pawnPositions) {
    const k = `${Math.round(p.x)},${Math.round(p.y)}`;
    g.set(k, (g.get(k) ?? 0) + 1);
  }
  return g;
};

export class BehaviorSystem implements GameSystem {
  id = 'behavior';
  private intentExecutors = new Map<string, IntentExecutor>();
  private workExecutors = new Map<string, WorkExecutor>();

  constructor(private ctx: SimContext) {
    // 数据驱动装配（2026-08-16 拆分后）：声明表 defs/executors.ts 的 handler 键 ×
    // 实现表 executors.ts（INTENT_IMPL/WORK_IMPL 纯函数）——不再反射类方法名
    //（迁出前 handler = 类方法名字符串）。deps.workExecutors 传引用：mod 运行期
    // registerWork 注册的新工作要在执行时查到（不能装配时快照）
    const deps: ExecutorDeps = { workExecutors: this.workExecutors };
    for (const d of BUILTIN_INTENTS) {
      const fn = intentImplOf(d.handler, deps);
      if (!fn) throw new Error(`内置意图 ${d.id} 缺实现：${d.handler}`);
      this.intentExecutors.set(d.id, fn);
    }
    for (const d of BUILTIN_WORKS) {
      const fn = workImplOf(d.handler);
      if (!fn) throw new Error(`内置工作 ${d.type} 缺实现：${d.handler}`);
      this.workExecutors.set(d.type, (c, eid, st, intent) => fn(c, eid, st));
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

  // 热路径优化（2026-08-16 第三轮）：CardView 每 tick 只构造一次——所有函数以 eid 为参数
  // 或独立于 pawn，故可复用；per-pawn 字段（lastSeries/assignedJob）在循环内刷新。
  private makeView(): CardView {
    return {
      needsOf: (e) => this.ctx.readNeeds(e),
      healthOf: (e) => this.ctx.readHealth(e),
      isNight: () => this.ctx.isNight(),
      hasCampfire: () => this.ctx.world.hasBuildingWithTag('warmth'),
      hasCave: () => this.ctx.world.hasBuildingWithTag('mine'),
      hasRaft: () => this.ctx.world.hasBuildingWithTag('raft'),
      hasBuildingWithTag: (tag: string) => this.ctx.world.hasBuildingWithTag(tag),
      desiresOf: (e) => this.ctx.pawnStates.get(e)?.desires ?? null,
      env: this.ctx.env,
      lastSeries: undefined as string | undefined,
      factionPriority: this.ctx.factionPriority,
      oracleGoal: this.ctx.oracleGoal,
      techs: this.ctx.techs,
      assignedJob: undefined as string | undefined,
      leanOf: (e, k) => this.ctx.leanOf(e, k),
      expectEarnOf: (e, workType) => this.ctx.pawnStates.get(e)?.expectEarnBy?.[workType] ?? 0,
      buildQueueCount: this.ctx.buildQueue.length,
      stockpile: this.ctx.stockpile,
      tuning: this.ctx.tuning,
      markovBias: this.ctx.mods.markovBias,
      jobCards: this.ctx.mods.jobCards,
      desireOfSeries: (series) => this.ctx.mods.seriesDesire[series] ?? null,
      helpTargetOf: (eid) => findHelpTarget(this.ctx, eid),
      hostilesNearby: (eid) => {
        const pos = this.ctx.pawnPositions.get(eid);
        if (!pos) return false;
        return this.ctx.hostiles.some((h) => {
          if (h.enemyId !== 'cat') return false;
          return (h.x - pos.x) ** 2 + (h.y - pos.y) ** 2 <= 40 * 40;
        });
      },
      campfireDist: (eid) => {
        const pos = this.ctx.pawnPositions.get(eid);
        if (!pos) return -1;
        const near = this.ctx.world.nearestBuildingWithTag(Math.round(pos.x), Math.round(pos.y), 64, 'warmth');
        return near === null ? -1 : near.dist;
      },
    };
  }

  update(dt: number): void {
    // 拥挤统计格表（2026-08-16 热路径优化）：walk 的拥挤惩罚/占位检查原为每小人每帧
    // 全表遍历 pawnPositions（40 人 = 每帧 ~1600 次距离检查，profiler 定位为行为系统
    // 占 step 耗时 50% 的主因之一）。每帧先按取整格聚合一次（O(n) 哈希），walk 内
    // 查 3×3 邻域/目标格即得 O(1)——语义近似注释见 walk。
    const crowdGrid = buildCrowdGrid(this.ctx);
    // 热路径优化（2026-08-16 第三轮）：CardView 只需每 tick 构造一次，复用。
    const view = this.makeView();
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const pos = this.ctx.readPosition(eid);
      if (!pos) continue;

      // RW-1 征召门（2026-08-15，drafting 玩法包 K_DRAFTED 契约键）：
      // 征召中的小人**不自主**——不抽卡/不工作/不休闲/不吃不睡不治疗，保持站位；
      // 玩家 move 命令依然有效（path 继续走完）。为什么动内核：抽卡决策是引擎内部循环，
      // 纯插件无法在不动引擎的前提下阻止它（只读一个契约键，是最小协议扩展）。
      // 被动衰减不豁免：needs/san 照跑（下方理智/紧急分支被这扇门挡住，征召只挡"自主行动"）。
      // Key point: 门放在理智分支**之前**——征召 = 完全听指挥，连理智崩溃的自主乱跑也不执行
      //（但精神崩溃的危险依然存在，解除征召后立即恢复）。
      if (st.extra?.[K_DRAFTED] === true) {
        st.job = '待命';
        // 玩家命令冷却继续衰减（修复 2026-08-16 审查：此处 continue 跳过了下方唯一衰减点
        // → 玩家 move 命令设的 commandCooldown 在征召期间永不归零 → DraftSystem 追击永冻。
        // 征召只挡"自主决策"，不挡冷却流逝；3s 窗口走完即恢复征召追击。）
        if ((st.commandCooldown ?? 0) > 0) st.commandCooldown = (st.commandCooldown ?? 0) - dt;
        if (st.path && st.pathIndex < st.path.length) this.walk(eid, st, pos, dt, crowdGrid); // 玩家命令的路径照走
        continue;
      }

      // 理智崩溃：狂乱行为由 SanSystem 接管（发呆/乱跑），不自动决策
      // 崩溃前遗留的路径仍推进（否则 path 走不完 + SanSystem 见 path 早退 = 永久冻结）
      const n = this.ctx.readNeeds(eid);
      if (n && n.san < this.ctx.tuning.san.crazyAt) {
        st.job = '理智崩溃';
        if (st.path && st.pathIndex < st.path.length) this.walk(eid, st, pos, dt, crowdGrid);
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
        this.walk(eid, st, pos, dt, crowdGrid);
        continue;
      }

      // 玩家命令冷却中：空闲等待（不自动决策，尊重玩家指挥）
      if ((st.commandCooldown ?? 0) > 0) {
        st.job = '听从指令';
        continue;
      }

      // 空闲：抽3选1 → 执行意图
      // 每 pawn 刷新 view 的 per-pawn 字段（CardView 复用，减分配）
      view.lastSeries = st.lastSeries;
      view.assignedJob = st.assignedJob;
      const intent = this.decide(eid, st, view);
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
  private decide(eid: number, st: PawnState, view: CardView): BehaviorIntent | null {
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

  // 紧急需求处理（st.urgent 由 NeedsSystem 按阈值设定）：直接进食/休息，不抽卡、不打断
  private handleUrgent(eid: number, st: PawnState, dt: number): void {
    void dt;
    const n = this.ctx.readNeeds(eid);
    if (!n) return;
    if (st.urgent === 'eat' && n.food >= this.ctx.tuning.needs.urgentEatAt) { st.urgent = undefined; return; }
    if (st.urgent === 'rest' && n.rest >= this.ctx.tuning.needs.urgentRestAt) { st.urgent = undefined; return; }
    if (st.urgent === 'eat' && consumeFood(this.ctx, eid, st, this.ctx.tuning.card.eatCost)) {
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

  // 沿 path 逐段移动（速度 × 心情系数 moodFactor × 拥挤系数 crowdFactor，读 tuning.pawn）；
  // 走完全程 → onArrive
  // 拥挤惩罚（2026-08-16 用户反馈"鼠鼠挤同一路径"）：±1 格内其他鼠越多移速越慢（floor 钳制），
  // 目标格被占时停在格前 crowdStopGap 排队不叠格——多鼠同目标自然减速成队列（涌现式避让，
  // 零新增状态，只读 pawnPositions 快照）
  //（2026-08-16 热路径优化：原拥挤统计与占位检查=每走一步全表遍历 pawnPositions
  //（40 人 → 每帧 1600 次距离检查，profiler 定位行为系统占 step 50% 的主因之一）；
  // 改由 update 每帧先按格聚合一次（buildCrowdGrid），此处查 3×3 邻域/目标格即 O(1)）
  private walk(eid: number, st: PawnState, pos: { x: number; y: number }, dt: number, crowdGrid: Map<string, number>): void {
    // 本帧起始格（walk 末尾会增量更新 crowdGrid——占位检查维持帧内顺序可见性：
    // 先到者被后到者看到（与原逐人检查语义一致）；只改同格计数，O(1)）
    const fromKey = `${Math.round(pos.x)},${Math.round(pos.y)}`;
    const target = st.path![st.pathIndex!];
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dist = Math.hypot(dx, dy);
    const sp = this.ctx.readSpeed(eid);
    const nd = this.ctx.readNeeds(eid);
    const pw = this.ctx.tuning.pawn;
    const moodFactor = nd ? pw.moodSpeedBase + (nd.mood / 100) * pw.moodSpeedScale : 1;
    // 拥挤：统计 ±1 格外人（切比雪夫 ≤1 的离散格近似——连续坐标取整归格，两人距离 ≤1
    // 必落同格或邻格，仅临界值（0.5 格内）有 ±1 误差；惩罚本身是连续渐变、无跳变，可接受）
    let crowd = 1;
    {
      let d = 0;
      const rx = Math.round(pos.x);
      const ry = Math.round(pos.y);
      for (let ox = rx - 1; ox <= rx + 1; ox++) {
        for (let oy = ry - 1; oy <= ry + 1; oy++) {
          d += crowdGrid.get(`${ox},${oy}`) ?? 0;
        }
      }
      d -= 1; // 自己（必在表中）
      if (d > 0) crowd = Math.max(pw.crowdingFloor, 1 - pw.crowdingPenalty * d);
    }
    const move = (sp?.v ?? pw.baseSpeed) * moodFactor * crowd * dt;
    if (dist <= move) {
      // 目标格被他人占据：工作目标格（chop/mine/cave/heal/pray/onArriveWork）允许重叠作业
      //（共同采集/挖掘不阻塞——排死会卡住生产，clothing 测试 30s 采不到 flax 即是此坑）；
      // 纯移动目标（玩家 move 命令等无工作回执）则停在 gap 排队,等占位者离开再补位
      const hasWork = !!(st.chopTarget ?? st.mineTarget ?? st.caveTarget ?? st.healTarget ?? st.prayTarget ?? st.onArriveWork);
      // 占位检查（同格聚合近似）：目标格聚集人数 - 自己（若同格）= 占用他人数；
      // 原逐人 hypot<0.5 判定 → 格聚合半径 1 格，含 0.5 边界外的临界误报（排队语义不敏感）
      const tk = `${Math.round(target.x)},${Math.round(target.y)}`;
      const selfOnTarget = Math.round(pos.x) === Math.round(target.x) && Math.round(pos.y) === Math.round(target.y);
      const occupied = (crowdGrid.get(tk) ?? 0) - (selfOnTarget ? 1 : 0) > 0;
      if (occupied && !hasWork && dist > pw.crowdStopGap) {
        pos.x += (dx / dist) * pw.crowdStopGap;
        pos.y += (dy / dist) * pw.crowdStopGap;
      } else if (occupied && !hasWork) {
        // 已贴身（≤gap）：原地等（对方让开才能 snap,否则一直贴着不叠）
      } else {
        pos.x = target.x;
        pos.y = target.y;
        st.pathIndex++;
        if (st.pathIndex >= st.path!.length) {
          st.path = [];
          this.onArrive(eid, st);
        }
      }
    } else {
      pos.x += (dx / dist) * move;
      pos.y += (dy / dist) * move;
    }
    this.ctx.setPosition(eid, pos);
    this.ctx.pawnPositions.set(eid, { x: pos.x, y: pos.y });
    // 增量更新格表（从 fromKey 移到新格；同格不动零开销）——见 walk 头注释
    const toKey = `${Math.round(pos.x)},${Math.round(pos.y)}`;
    if (toKey !== fromKey) {
      const from = (crowdGrid.get(fromKey) ?? 0) - 1;
      if (from <= 0) crowdGrid.delete(fromKey); else crowdGrid.set(fromKey, from);
      crowdGrid.set(toKey, (crowdGrid.get(toKey) ?? 0) + 1);
    }
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
