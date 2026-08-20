// 死亡机制 DLC（2026-08-20，用户「没有死亡机制吗？都需要」）：
// 衰老/过劳死/探险受伤/尸体/墓碑/处决——让死亡成为游戏中有意义的风险。
// 种子原则：只加字段+系统+建筑+命令，不写新事件链（死亡事件已由 killPawn 发出）。
// 设计：
//   ① age：PawnState.age 出生时 0，每 tick 递增（tuning.lifespan~500 天），超寿命后随机恶化
//   ② 过劳死：san < 0 时持续掉 HP（san 崩溃不止是乱跑——真会死）
//   ③ 探险受伤：距营地 > 50 格且持续远征的 pawn 有概率受伤（迷路/摔伤/遭遇）
//   ④ 尸体：死亡时在死亡位置放 corpse 建筑，aura 扣 mood；可 burial 变墓碑（+mood）
//   ⑤ 处决：execute 命令（选中 pawn → 杀死，带事件）
import type { ModRegistry, AiAction } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { PawnState } from '../../sim/types';
import type { ModPack } from '../pack';
import { World } from '../../sim/core/world';

const CFG = {
  lifespan: 500,           // 寿命（天），每天 1 tick = 0.2s？实际 sim 1 tick 0.2s → 500 天 = 500*86400/0.2 tick = 太长
  // 算了——寿命用"游戏天数"（sim.time / 86400）。500 天 ≈ 500 * 86400 = 43200000s sim time。
  // 实际 1 秒 real time = 1s sim time（speed=1）。所以 500 天 ≈ 500h real ≈ 21 天。合理。
  ageDecayStart: 365,      // 365 天后开始衰老衰减（HP 上限 -0.5/天）
  oldAgeHpDecay: 0.5,      // 衰老 HP 上限衰减/天
  sanDeathThreshold: -20,  // san < -20 时开始掉 HP（过劳死）
  sanDeathDmg: 0.5,        // san 过劳 HP 流失/秒
  exploreDist: 50,         // 距营地 > 50 格 = 探险中
  exploreInjuryChance: 0.001, // 每 tick 探险受伤概率（~0.2%/s）
  exploreInjuryTypes: ['cut', 'sprain', 'fall'] as const,
  corpseMoodDecay: 0.5,    // 尸体附近 mood 衰减/秒（范围 5 格）
  tombMoodBonus: 0.2,      // 墓碑 mood 加成/秒（范围 5 格）
  burialCostWood: 5,       // 埋葬消耗木材
};

// 扩展 PawnState 类型（age 字段）
declare module '../../sim/types' {
  interface PawnState {
    age?: number;           // 年龄（游戏秒）
    exploreStart?: number;  // 开始探险的时间（距营地 > 50 格时标记）
  }
}

class DeathSystem {
  id = 'death';
  private _throttle = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {
    // 监听死亡事件 → 放尸体建筑
    _bus.on('pawn_died', (ev: unknown) => {
      const e = ev as { eid: number; x: number; y: number; cause: string };
      // 只在死亡格放尸体（非捕获/处决可能没尸体）
      if (e.cause === 'executed' || e.cause === 'captured') return;
      const def = this.ctx.mods.buildings['corpse'];
      if (!def) return;
      this.ctx.world.placeBuilding(Math.round(e.x), Math.round(e.y), 'corpse', 'player');
    });
  }

  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < 1) return; // 1s 节流
    this._throttle = 0;

    for (const eid of this.ctx.iterPawns) {
      // 2026-08-20 通用 HP 归零检查（战斗/疾病/流血等未触发 killPawn 的兜底）
      const h = this.ctx.readHealth(eid);
      if (h && h.hp <= 0) { this.ctx.killPawn(eid, 'injuries'); continue; }
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;

      // ① 年龄增长
      st.age = (st.age ?? 0) + 1;

      // ② 衰老：超过寿命开始衰减
      const ageDays = (st.age ?? 0) / 86400;
      if (ageDays > CFG.lifespan) {
        const hp = this.ctx.readHealth(eid);
        if (hp) {
          this.ctx.setHealth(eid, { hp: Math.max(0, hp.hp - 5), maxHp: Math.max(1, hp.maxHp - 1) });
          if (hp.hp <= 0) {
            this.ctx.killPawn(eid);
            this.ctx.logEvent(`💀 #${eid} 寿终正寝，享年 ${Math.floor(ageDays)} 天`);
            continue;
          }
        }
      } else if (ageDays > CFG.ageDecayStart) {
        // 衰老衰减（HP 上限下降）
        const hp = this.ctx.readHealth(eid);
        if (hp && hp.hp > 1) {
          this.ctx.setHealth(eid, { hp: Math.max(1, hp.hp - 0.5), maxHp: Math.max(1, hp.maxHp - 0.5) });
        }
      }

      // ③ 过劳死：san < 阈值 → 掉 HP
      const n = this.ctx.readNeeds(eid);
      if (n && n.san < CFG.sanDeathThreshold) {
        const hp = this.ctx.readHealth(eid);
        if (hp && hp.hp > 0) {
          this.ctx.setHealth(eid, { hp: Math.max(0, hp.hp - CFG.sanDeathDmg), maxHp: hp.maxHp });
          if (hp.hp <= 0) {
            this.ctx.killPawn(eid);
            this.ctx.logEvent(`💀 #${eid} 精神崩溃至死`);
            continue;
          }
        }
      }

      // ④ 探险受伤：距营地 > 50 格 + 持续远征
      const campDist = this.campDist(pos);
      if (campDist > CFG.exploreDist) {
        if (!st.exploreStart) st.exploreStart = this.ctx.time;
        const exploreTime = this.ctx.time - st.exploreStart;
        // 探险超过 30 秒后每 tick 有概率受伤
        if (exploreTime > 30 && this.ctx.rng.next() < CFG.exploreInjuryChance) {
          const injury = CFG.exploreInjuryTypes[Math.floor(this.ctx.rng.next() * CFG.exploreInjuryTypes.length)]!;
          const hp = this.ctx.readHealth(eid);
          if (hp) {
            const dmg = injury === 'fall' ? 15 : injury === 'cut' ? 10 : 5;
            this.ctx.setHealth(eid, { hp: Math.max(0, hp.hp - dmg), maxHp: hp.maxHp });
            this.ctx.logEvent(`⚠ #${eid} 探险中${injury === 'fall' ? '坠落' : injury === 'cut' ? '受伤' : '扭伤'} -${dmg}HP`);
            if (hp.hp <= 0) {
              this.ctx.killPawn(eid);
              this.ctx.logEvent(`💀 #${eid} 探险中不幸身亡`);
            }
          }
        }
      } else {
        st.exploreStart = undefined; // 回到营地 → 重置探险计时
      }
    }

    // ⑤ 尸体 aura：尸体附近扣 mood（每 5s 检查一次范围内的 pawn）
    if (this.ctx.time % 5 < 1) {
      for (const [k, b] of this.ctx.world.buildings) {
        if (b.def.id !== 'corpse' && b.def.id !== 'tomb') continue;
        const { x, y } = World.keyToXY(k);
        const isTomb = b.def.id === 'tomb';
        for (const eid of this.ctx.iterPawns) {
      // 2026-08-20 通用 HP 归零检查（战斗/疾病/流血等未触发 killPawn 的兜底）
      const h = this.ctx.readHealth(eid);
      if (h && h.hp <= 0) { this.ctx.killPawn(eid, 'injuries'); continue; }
          const pos = this.ctx.pawnPositions.get(eid);
          if (!pos) continue;
          const d = Math.hypot(pos.x - x, pos.y - y);
          if (d <= 5) {
            const n = this.ctx.readNeeds(eid);
            if (n) {
              this.ctx.setNeeds(eid, { food: n.food, rest: n.rest, mood: Math.max(0, Math.min(100, n.mood + (isTomb ? CFG.tombMoodBonus : -CFG.corpseMoodDecay))), san: n.san });
            }
          }
        }
      }
    }
  }

  // 距最近篝火/教堂的距离
  private campDist(pos: { x: number; y: number }): number {
    let best = Infinity;
    for (const [k, b] of this.ctx.world.buildings) {
      if (b.def.id !== 'campfire' && b.def.id !== 'church') continue;
      const { x, y } = World.keyToXY(k);
      const d = Math.hypot(pos.x - x, pos.y - y);
      if (d < best) best = d;
    }
    return best;
  }
}

export const deathPack: ModPack = {
  id: 'death',
  requires: [],
  apply(m: ModRegistry): void {
    // 尸体建筑（不可通行，HP 低，aura 扣 mood）
    m.registerBuilding({
      id: 'corpse', name: '遗体', size: { x: 1, y: 1 }, hp: 10, color: '#5a4a3a',
      emoji: '🪦', passable: false, buildTime: 0, tags: ['corpse'], meta: {},
    });
    // 墓碑（埋葬后：mood 正面）
    m.registerBuilding({
      id: 'tomb', name: '墓碑', size: { x: 1, y: 1 }, hp: 50, color: '#7a7a8a',
      emoji: '🪦', passable: true, buildTime: 2, tags: ['memorial'], meta: {}, costWood: CFG.burialCostWood,
    });

    // 死亡系统
    m.registerSystemDef({
      id: 'death', label: '死亡机制', category: 'world',
      ctor: (ctx) => new DeathSystem(ctx),
    });

    // 处决命令：execute { pawnId } → killPawn
    m.registerCommand('execute', (ctx, cmd) => {
      const eid = cmd.pawnId;
      if (eid === undefined) { ctx.logEvent('⚠ 处决需指定 pawnId'); return; }
      // 只能处决己方 pawn（非敌人）
      if (!ctx.pawnStates.has(eid)) { ctx.logEvent('⚠ 目标不存在'); return; }
      ctx.killPawn(eid);
      ctx.logEvent(`🔪 处决了 #${eid}`);
    });

    // 埋葬命令：bury { x, y } → 尸体变墓碑
    m.registerCommand('bury', (ctx, cmd) => {
      const x = Math.round(cmd.x), y = Math.round(cmd.y);
      // 检查是否有尸体
      let found = false;
      for (const [k, b] of ctx.world.buildings) {
        if (b.def.id !== 'corpse') continue;
        const { x: bx, y: by } = World.keyToXY(k);
        if (bx === x && by === y) { found = true; break; }
      }
      if (!found) { ctx.logEvent('⚠ 此处无遗体'); return; }
      // 消耗木材
      if ((ctx.stockpile.wood ?? 0) < CFG.burialCostWood) { ctx.logEvent('⚠ 木材不足（需 5）'); return; }
      ctx.stockpile.wood = (ctx.stockpile.wood ?? 0) - CFG.burialCostWood;
      ctx.world.damageBuilding(x, y, 99999); // 摧毁尸体
      ctx.world.placeBuilding(x, y, 'tomb', 'player');
      ctx.logEvent(`🪦 埋葬了遗体，立碑纪念`);
    });

    // AI 动作：空闲时自动埋葬附近的尸体（ai-director 包可选）
    m.registerAiAction({
      id: 'death:bury-corpse', weight: 3,
      probe: (ctx) => {
        for (const [, b] of ctx.world.buildings) if (b.def.id === 'corpse') return true;
        return false;
      },
      act: (ctx) => {
        for (const [k, b] of ctx.world.buildings) {
          if (b.def.id !== 'corpse') continue;
          const { x, y } = World.keyToXY(k);
          return { type: 'bury', x, y, pawnId: ctx.pawnList[0] ?? 0, source: 'ai' };
        }
        return null;
      },
    });
  },
};