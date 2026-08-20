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
  level?: 'minor';     // 日常状态流（eat/rest/mood_changed）：recent 视图降噪（2026-08-20 用户
                       // "历史被 mood 淹没"——20 条 recent 被高频吃饭/休息/心情刷屏,大事沉底。
                       // 完整事实仍全部保留在 entries（可 query/导出），只影响 recent 概览视图）
}

// 日常状态流事件类型：recent 概览降噪（完整日志保留不删）
const MINOR_TYPES = new Set<string>(['eat', 'rest', 'mood_changed']);

// 历史日志（事件存储 + 查询；cap 软上限 + 批量裁剪防高频分配；record 是采样热点）
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
    // 日常状态流判 minor：吃饭/休息/心情变化属生理节律,高频低信息,不给 recent 概览占位
    //（2026-08-20 热路径优化：原用 spread 条件展开 level 字段 = 每次记录多一个临时对象，
    // record 是采样最大单点（6%+）；直接赋值无分配差异、语义相同）
    if (MINOR_TYPES.has(ev.type)) base.level = 'minor';
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
      case 'event_happened':
        base.data = { eventId: ev.eventId };
        break;
      case 'faction_event':
        base.data = { kind: ev.kind, from: ev.from, to: ev.to };
        break;
    }
    this.entries.push(base);
    // 容量裁剪（2026-08-20 热路径优化：原每次超限即 splice 头部 = 事件持续流入时
    // 每 tick 整表复制（5000 条引用），profiler 采样 record 为单点最大热点；
    // 改批量裁剪：超限一次裁到 cap 的 3/4 留缓冲，裁剪频率降约 4 倍——cap 语义 =
    // 软上限（entries 在 3/4cap ~ cap 间振荡），query/recent/toJSON 只读不受影响）
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - Math.floor(this.cap * 0.75));
    }
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
    // 概览视图：优先最近 20 条高信息事件（major/normal,过滤 minor 状态流）；
    // 若高信息不足 3 条（游戏刚开局全是吃饭睡觉）,回退最近 20 条原始,不丢新发生的事
    const major = this.entries.filter((e) => e.level !== 'minor').slice(-20).reverse();
    return major.length >= 3 ? major : this.entries.slice(-20).reverse();
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
