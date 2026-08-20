// 季节系统玩法包（2026-08-20，用户「季节」）：春夏秋冬循环影响温度/作物/敌袭频率
// 设计：dayLength=120s = 1 天；4 季各 30 天 = 120 天 = 1 年。季节通过 env.temperature
// 偏移 + cropYield 倍率 + raidInterval 倍率影响世界。季节切换发事件提示玩家。
// 数据驱动：季节表 + 倍率全在 CFG，mod 可 overrideTuning 调。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

const CFG = {
  seasonLength: 10, // 2026-08-20 平衡：30→10（每季20分钟, 30分钟走1.5季）       // 每季 30 天（dayLength=120s → 每季 3600s = 1 小时游戏时间）
  tempDelta: { spring: 2, summer: 8, autumn: 0, winter: -12 }, // 季节温度偏移（叠加到 env.temperature）
  cropMul: { spring: 1.0, summer: 1.3, autumn: 0.8, winter: 0.3 }, // 作物产出倍率
  raidMul: { spring: 0.8, summer: 1.0, autumn: 1.2, winter: 1.5 }, // 敌袭频率倍率（冬更凶）
};

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];

// 根据天数计算当前季节（seasonLength 天/季，4 季循环）
export function currentSeason(day: number): Season {
  return SEASONS[Math.floor((day % (SEASONS.length * CFG.seasonLength)) / CFG.seasonLength)];
}

export const SEASON_CONFIG = CFG;

// 季节系统：春夏秋冬循环 → 季节切换时温度偏移 + 发事件提示
// 2026-08-20：节流 2s（季节按天判定，每帧检查无意义）；seasonLength=10 天
class SeasonSystem {
  id = 'seasons';
  private lastSeason: Season | null = null;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  private _throttle = 0;
  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < 2) return;
    this._throttle = 0;
    const day = Math.floor(this.ctx.time / this.ctx.dayLength) + 1;
    const season = currentSeason(day);
    // 季节切换时发事件 + 应用温度偏移
    if (season !== this.lastSeason) {
      this.lastSeason = season;
      const delta = CFG.tempDelta[season];
      this.ctx.env.temperature = Math.max(-20, Math.min(40, this.ctx.env.temperature + delta * 0.1));
      const names: Record<Season, string> = { spring: '🌸 春天来了', summer: '☀ 盛夏时节', autumn: '🍂 秋收季节', winter: '❄ 寒冬降临' };
      this.ctx.logEvent(names[season]);
    }
  }
}

export const seasonsPack: ModPack = {
  id: 'seasons',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'seasons', label: '季节', category: 'world',
      ctor: (ctx) => new SeasonSystem(ctx),
    });
  },
};