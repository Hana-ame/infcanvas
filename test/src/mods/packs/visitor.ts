// 天外来客玩法包（2026-08-20，用户「天外来客」）：外星生物/旅行商人/神秘访客
// 随机来访 → 提供交易/任务/礼物/威胁。走事件系统（event_happened）+ NPC hostile faction='neutral'
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { pushHostile } from '../../sim/systems/hostiles';

const CFG = {
  visitInterval: 300,    // 访客周期（5 分钟）
  visitorTypes: ['trader', 'wanderer', 'alien', 'diplomat'] as const,
  traderFood: 10,         // 商人带来食物
  traderWood: 5,         // 商人带来木材
  wandererMood: 10,      // 流浪者心情加成
  alienTech: 1,          // 外星人给科技碎片
  diplomatFaith: 5,      // 外交官带来信仰
};

const VISITOR_NAMES: Record<string, string> = {
  trader: '旅行商人',
  wanderer: '流浪诗人',
  alien: '外星来客',
  diplomat: '外交使者',
};

// 天外来客系统：4 种随机访客来访 → 旅行商人(送资源)/流浪诗人(心情)/外星来客(科技碎片)/外交使者(信仰)
// 2026-08-20：timer 早退（visitInterval=300s 才触发一次，其余 tick 直接 return）
class VisitorSystem {
  id = 'visitor';
  private timer = CFG.visitInterval;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    // 2026-08-20 节流：访客系统已有 timer 早退（visitInterval 秒一次）
    // 不需额外节流 — timer > 0 即 return
    this.timer = CFG.visitInterval + this.ctx.rng.next() * 180; // 5-8 分钟
    // 随机选访客类型
    const type = CFG.visitorTypes[Math.floor(this.ctx.rng.next() * CFG.visitorTypes.length)]!;
    const name = VISITOR_NAMES[type];
    // 访客 = neutral faction hostile（不攻击也不被攻击）
    const cx = Math.floor(this.ctx.world.width / 2);
    const cy = Math.floor(this.ctx.world.height / 2);
    const r = 15 + this.ctx.rng.next() * 10;
    const a = this.ctx.rng.next() * Math.PI * 2;
    const x = Math.round(cx + Math.cos(a) * r);
    const y = Math.round(cy + Math.sin(a) * r);

    // 中立单位（faction='neutral', speed=0, dmg=0, hp=999）
    pushHostile(this.ctx, {
      id: type, name, hp: 999, speed: 0, climb: 99, dmg: 0,
      faction: 'neutral', loot: { item: 'food', amount: 0 },
    } as never, x, y, { targetX: x, targetY: y });

    // 访客效果（即时触发，3 秒后消失）
    switch (type) {
      case 'trader':
        this.ctx.stockpile.food = (this.ctx.stockpile.food ?? 0) + CFG.traderFood;
        this.ctx.stockpile.wood = (this.ctx.stockpile.wood ?? 0) + CFG.traderWood;
        this.ctx.logEvent(`🧳 ${name}带来礼物：+${CFG.traderFood}食物 +${CFG.traderWood}木材`);
        break;
      case 'wanderer':
        for (const eid of this.ctx.iterPawns) this.ctx.adjustNeedField(eid, 'mood', CFG.wandererMood);
        this.ctx.logEvent(`🎵 ${name}弹唱一曲，全员心情 +${CFG.wandererMood}`);
        break;
      case 'alien':
        // 外星人给科技碎片（tech-pool 包联动）
        this.ctx.stockpile['tech-fragment'] = (this.ctx.stockpile['tech-fragment'] ?? 0) + CFG.alienTech;
        this.ctx.logEvent(`👽 ${name}留下神秘碎片 +${CFG.alienTech}`);
        break;
      case 'diplomat':
        for (const eid of this.ctx.iterPawns) {
          const st = this.ctx.pawnStates.get(eid);
          if (st) st.faith = (st.faith ?? 0) + CFG.diplomatFaith;
        }
        this.ctx.logEvent(`🤝 ${name}到访，全员信仰 +${CFG.diplomatFaith}`);
        break;
    }
  }
}

export const visitorPack: ModPack = {
  id: 'visitor',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'visitor', label: '天外来客', category: 'world',
      ctor: (ctx) => new VisitorSystem(ctx),
    });
  },
};

export { CFG as VISITOR_CONFIG };