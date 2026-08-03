// 随机事件系统（用户 Q5：P0 用随机事件/预制剧本，预留 LLM 插入能力）
// 对齐 DESIGN §6："LLM 只印卡和触发事件" —— 事件通过统一接口改卡权重/收益/世界
// provider 可插换：P0 = 确定性随机脚本；P1 = LLM 生成事件（同一接口）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

// 事件定义（预制剧本，def 驱动）
export interface ScriptedEvent {
  id: string;
  name: string;
  weight: number;      // 触发权重
  cooldown?: number;   // 距上次触发最小秒数
  minTime?: number;    // 开局多少秒后可触发
  run(ctx: SimContext): void; // 事件效果
}

export type EventProvider = () => ScriptedEvent | null;

// 事件系统：定时 roll 事件（确定性，随天气/时间/环境调制权重）
export class EventSystem implements GameSystem {
  id = 'events';
  private timer = 0;
  private interval = 45; // 每 45 秒 roll 一次
  private lastTrigger = new Map<string, number>(); // id → 上次触发时间
  private provider: EventProvider;

  constructor(private ctx: SimContext, scripts: ScriptedEvent[]) {
    this.provider = this.makeProvider(scripts);
  }

  // 预留 LLM 插入：替换 provider 为 LLM 生成的事件（同一接口）
  setProvider(p: EventProvider): void {
    this.provider = p;
  }

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.interval + Math.floor(this.ctx.rng.next() * 30); // 45-75s 一次
    const ev = this.provider();
    if (ev) {
      this.lastTrigger.set(ev.id, this.ctx.time);
      ev.run(this.ctx);
      this.ctx.logEvent(`✨ ${ev.name}`);
      this.ctx.bus.emit({ type: 'event_happened', eventId: ev.id });
    }
  }

  private makeProvider(scripts: ScriptedEvent[]): EventProvider {
    return () => {
      const now = this.ctx.time;
      const pool = scripts.filter((s) => {
        if (s.minTime && now < s.minTime) return false;
        if (s.cooldown) {
          const last = this.lastTrigger.get(s.id) ?? -Infinity;
          if (now - last < s.cooldown) return false;
        }
        return true;
      });
      if (pool.length === 0) return null;
      // 按权重抽取（种子化）
      const total = pool.reduce((a, s) => a + s.weight, 0);
      let r = this.ctx.rng.next() * total;
      for (const s of pool) {
        r -= s.weight;
        if (r < 0) return s;
      }
      return pool[pool.length - 1];
    };
  }
}
