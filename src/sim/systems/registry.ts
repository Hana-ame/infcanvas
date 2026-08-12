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
export class SystemRegistry {
  private systems: GameSystem[] = [];

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
  updateAll(dt: number): void {
    for (const s of this.systems) s.update(dt);
  }

  get all(): readonly GameSystem[] {
    return this.systems;
  }
}
