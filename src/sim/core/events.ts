// 统一事件层（EventBus）—— 所有游戏内事件经由这里流动
// 设计目标：系统之间、系统与 mod 之间解耦；mod 通过订阅事件接入，无需改内核

// 事件类型（P0 核心；mod 可扩展新类型）
export type GameEvent =
  | { type: 'pawn_spawned'; eid: number; x: number; y: number }
  | { type: 'pawn_died'; eid: number; x: number; y: number; cause: string }
  | { type: 'work_completed'; eid: number; work: string; success: boolean; x: number; y: number }
  | { type: 'resource_gained'; eid: number; item: string; amount: number }
  | { type: 'building_built'; x: number; y: number; defId: string }
  | { type: 'raid_started'; count: number }
  | { type: 'raid_ended'; survivors: number }
  | { type: 'pawn_recruited'; eid: number }
  | { type: 'eat'; eid: number }
  | { type: 'rest'; eid: number }
  | { type: 'mood_changed'; eid: number; delta: number }
  | { type: 'social'; eid: number; target: number; tone: 'positive' | 'negative' | 'neutral'; topic?: string };

export type GameEventHandler = (ev: GameEvent) => void;

export class EventBus {
  private handlers = new Map<string, Set<GameEventHandler>>();
  private anyHandlers = new Set<GameEventHandler>();

  on(type: GameEvent['type'], fn: GameEventHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
    return () => this.off(type, fn);
  }

  onAny(fn: GameEventHandler): () => void {
    this.anyHandlers.add(fn);
    return () => this.anyHandlers.delete(fn);
  }

  off(type: GameEvent['type'], fn: GameEventHandler): void {
    this.handlers.get(type)?.delete(fn);
  }

  emit(ev: GameEvent): void {
    this.handlers.get(ev.type)?.forEach((fn) => fn(ev));
    this.anyHandlers.forEach((fn) => fn(ev));
  }
}
