// 天文系统玩法包（2026-08-20，用户「天文」）：日食月食/星象/潮汐
// 设计：天文事件按周期发生——日食（白天变暗 → isNight 短暂为 true）、
// 月食（夜晚额外理智流失）、潮汐（水位涨落影响航海/渡水）。
// 星象 = 轻量 buff 系统：特定星象时 mood/rest 微调。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

const CFG = {
  eclipseInterval: 300,     // 日食周期（秒）
  eclipseDuration: 30,      // 日食持续（秒）→ 期间 isNight 强制 true
  lunarEclipseInterval: 600, // 月食周期
  lunarEclipseDrain: 0.5,   // 月食夜晚额外理智流失/s
  tideInterval: 120,        // 潮汐周期
  tideAmplitude: 2,         // 水位涨落幅度（格）
  starBuffInterval: 90,     // 星象切换周期
  starMoodBonus: 1,         // 吉星心情加成
};

export const ASTRONOMY_CONFIG = CFG;

// 天文系统：日食（白天短暂变暗）/月食（夜晚额外理智流失）/星象 buff/潮汐水位涨落
// 2026-08-20：节流 2s（星象/潮汐是慢变量，每帧评估无意义）；日食/月食用 accumDt 累计
class AstronomySystem {
  id = 'astronomy';
  private eclipseTimer = 0;
  private lunarTimer = 0;
  private tideTimer = 0;
  private starTimer = 0;
  private eclipseActive = false;
  private eclipseTime = 0;
  // 潮汐水位偏移（其他包读 env 或 world 可用）
  tideOffset = 0;
  starBonus = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  private _starTimer = 0;
  update(dt: number): void {
    this._starTimer += dt;
    if (this._starTimer < 2) return;
    const accumDt = this._starTimer; // 累计 2s 的 accumDt
    this._starTimer = 0;
    // 日食
    this.eclipseTimer += accumDt;
    if (this.eclipseActive) {
      this.eclipseTime -= accumDt;
      if (this.eclipseTime <= 0) {
        this.eclipseActive = false;
        this.ctx.logEvent('☀ 日食结束了');
      }
    } else if (this.eclipseTimer >= CFG.eclipseInterval) {
      this.eclipseTimer = 0;
      this.eclipseActive = true;
      this.eclipseTime = CFG.eclipseDuration;
      this.ctx.logEvent('🌑 日食！白天短暂陷入黑暗');
    }

    // 月食（夜晚额外流失）
    this.lunarTimer += accumDt;
    if (this.lunarTimer >= CFG.lunarEclipseInterval && this.ctx.isNight()) {
      this.lunarTimer = 0;
      for (const eid of this.ctx.iterPawns) {
        const n = this.ctx.readNeeds(eid);
        if (n) { n.san -= CFG.lunarEclipseDrain * accumDt; this.ctx.setNeeds(eid, n); }
      }
      this.ctx.logEvent('🌕 月食！夜空血红，鼠鼠们心神不宁');
    }

    // 潮汐
    this.tideTimer += accumDt;
    if (this.tideTimer >= CFG.tideInterval) {
      this.tideTimer = 0;
      this.tideOffset = -this.tideOffset; // 涨/落交替
    }

    // 星象 buff
    this.starTimer += accumDt;
    if (this.starTimer >= CFG.starBuffInterval) {
      this.starTimer = 0;
      this.starBonus = this.ctx.rng.next() < 0.5 ? CFG.starMoodBonus : 0;
      if (this.starBonus > 0) this.ctx.logEvent('✨ 吉星高照');
    }
    if (this.starBonus > 0) {
      for (const eid of this.ctx.iterPawns) {
        const n = this.ctx.readNeeds(eid);
        if (n) { n.mood = Math.min(100, n.mood + this.starBonus * accumDt); this.ctx.setNeeds(eid, n); }
      }
    }
  }

  // 日食期间 isNight 强制 true（其他系统读此判断）
  isEclipse(): boolean { return this.eclipseActive; }
}

export const astronomyPack: ModPack = {
  id: 'astronomy',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'astronomy', label: '天文', category: 'world',
      ctor: (ctx) => new AstronomySystem(ctx),
    });
  },
};