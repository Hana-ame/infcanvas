// 系统注册表 —— 所有 sim 系统挂在这里，mod 可新增系统、可排序
// 设计：集中装配 + 统一帧循环；顺序敏感系统用 insertBefore 显式插位
//（如 autobuild 产蓝图必须排在 build 消费蓝图之前）
import type { Sim } from '../sim';
import type { EventBus } from '../core/events';

export interface GameSystem {
  id: string;
  // 每帧 tick（dt 秒）
  update(dt: number): void;
  // 可选：初始化（订阅事件）
  init?(bus: EventBus): void;
}

// 系统容器：注册/插序/统一 init 与 update（mod 友好：register 即可挂新系统）
// 单系统耗时统计（内置性能分析：火焰图/表格由 profiler 插件消费，见 src/mods/profiler.ts）
export interface SysStat {
  totalMs: number;  // 累计耗时
  count: number;    // 调用次数
  maxMs: number;    // 单次峰值
  lastMs: number;   // 最近一次
}

export class SystemRegistry {
  private systems: GameSystem[] = [];
  // 内置性能分析（默认关；开启后 updateAll 对每个系统计时，仅采集不改行为）
  private profiling = false;
  private stats = new Map<string, SysStat>();

  // 开启/关闭系统级计时（幂等；插件可在 hook 里自动开启）
  enableProfiling(on = true): this {
    this.profiling = on;
    if (on) for (const s of this.systems) {
      if (!this.stats.has(s.id)) this.stats.set(s.id, { totalMs: 0, count: 0, maxMs: 0, lastMs: 0 });
    }
    return this;
  }

  // 只读统计（profiler 插件消费；未开启时为空）
  get profileStats(): ReadonlyMap<string, SysStat> {
    return this.stats;
  }

  // 追加注册（默认排尾；不依赖注册顺序的系统直接 append）
  register(s: GameSystem): this {
    this.systems.push(s);
    return this;
  }

  // 插到指定系统前（顺序敏感时用；target 不存在则退化为追加）
  insertBefore(targetId: string, s: GameSystem): this {
    const idx = this.systems.findIndex((x) => x.id === targetId);
    if (idx === -1) this.systems.push(s);
    else this.systems.splice(idx, 0, s);
    return this;
  }

  // 全量初始化：各系统订阅事件（register 顺序不影响 init 时机）
  initAll(bus: EventBus): void {
    for (const s of this.systems) s.init?.(bus);
  }

  // 全量帧循环（注册顺序 = 每帧执行顺序）
  // profiling 开启时逐系统计时（performance.now 开销 ~0.05ms/系统，仅在分析时开）
  updateAll(dt: number): void {
    if (!this.profiling) {
      for (const s of this.systems) s.update(dt);
      return;
    }
    for (const s of this.systems) {
      const t0 = performance.now();
      s.update(dt);
      const ms = performance.now() - t0;
      const st = this.stats.get(s.id) ?? { totalMs: 0, count: 0, maxMs: 0, lastMs: 0 };
      st.totalMs += ms;
      st.count++;
      if (ms > st.maxMs) st.maxMs = ms;
      st.lastMs = ms;
      this.stats.set(s.id, st);
    }
  }

  get all(): readonly GameSystem[] {
    return this.systems;
  }
}
