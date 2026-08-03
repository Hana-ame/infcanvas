// 系统注册表 —— 所有 sim 系统挂在这里，mod 可新增系统、可排序
import type { Sim } from '../sim';
import type { EventBus } from '../core/events';

export interface GameSystem {
  id: string;
  // 每帧 tick（dt 秒）
  update(dt: number): void;
  // 可选：初始化（订阅事件）
  init?(bus: EventBus): void;
}

export class SystemRegistry {
  private systems: GameSystem[] = [];

  register(s: GameSystem): this {
    this.systems.push(s);
    return this;
  }

  insertBefore(targetId: string, s: GameSystem): this {
    const idx = this.systems.findIndex((x) => x.id === targetId);
    if (idx === -1) this.systems.push(s);
    else this.systems.splice(idx, 0, s);
    return this;
  }

  initAll(bus: EventBus): void {
    for (const s of this.systems) s.init?.(bus);
  }

  updateAll(dt: number): void {
    for (const s of this.systems) s.update(dt);
  }

  get all(): readonly GameSystem[] {
    return this.systems;
  }
}
