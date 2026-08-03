// 结构化历史日志（DESIGN §3 历史系统）——仿真日志：事实只能来自 sim
// 每次确定性事件 → 结构化条目（时间/类型/实体/地点/因果），可查询、可导出、可回放
// LLM 未来只做叙述润色，绝不产生事实
import type { GameEvent } from './events';

// 历史条目：结构化事实，因果链 = 相关实体引用
export interface HistoryEntry {
  id: number;          // 全局递增
  time: number;        // sim 时间（秒）
  day: number;         // 天数
  type: string;        // 事件类型
  eid?: number;        // 主要实体
  x?: number; y?: number; // 地点
  cause?: string;      // 原因（死亡/事件）
  data?: Record<string, unknown>; // 附加事实（数量/目标等）
}

export class HistoryLog {
  private entries: HistoryEntry[] = [];
  private nextId = 1;
  private cap: number;

  constructor(cap = 5000) {
    this.cap = cap;
  }

  // 订阅事件流，转成结构化条目
  record(ev: GameEvent, now: number, day: number): void {
    const base: HistoryEntry = {
      id: this.nextId++,
      time: Math.round(now),
      day: Math.floor(day),
      type: ev.type,
    };
    switch (ev.type) {
      case 'pawn_spawned':
      case 'pawn_died':
        base.eid = ev.eid;
        base.x = ev.x;
        base.y = ev.y;
        if (ev.type === 'pawn_died') base.cause = ev.cause;
        break;
      case 'work_completed':
        base.eid = ev.eid;
        base.x = ev.x;
        base.y = ev.y;
        base.data = { work: ev.work, success: ev.success };
        break;
      case 'resource_gained':
        base.eid = ev.eid;
        base.data = { item: ev.item, amount: ev.amount };
        break;
      case 'building_built':
        base.x = ev.x;
        base.y = ev.y;
        base.data = { defId: ev.defId };
        break;
      case 'raid_started':
        base.data = { count: ev.count };
        break;
      case 'raid_ended':
        base.data = { survivors: ev.survivors };
        break;
      case 'pawn_recruited':
        base.eid = ev.eid;
        break;
      case 'eat':
      case 'rest':
      case 'mood_changed':
        base.eid = ev.eid;
        if (ev.type === 'mood_changed') base.data = { delta: ev.delta };
        break;
      case 'social':
        base.eid = ev.eid;
        base.data = { target: ev.target, tone: ev.tone, topic: ev.topic };
        break;
    }
    this.entries.push(base);
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
  }

  // 查询：按类型 / 实体过滤，从新到旧
  query(opts: { type?: string; eid?: number; limit?: number } = {}): HistoryEntry[] {
    let list = this.entries;
    if (opts.type) list = list.filter((e) => e.type === opts.type);
    if (opts.eid !== undefined) list = list.filter((e) => e.eid === opts.eid);
    const limit = opts.limit ?? 50;
    return list.slice(-limit).reverse();
  }

  get recent(): HistoryEntry[] {
    return this.entries.slice(-20).reverse();
  }

  get count(): number {
    return this.entries.length;
  }

  // 导出（供回放/存档/LLM 润色）
  toJSON(): HistoryEntry[] {
    return this.entries.slice();
  }

  clear(): void {
    this.entries = [];
  }
}
