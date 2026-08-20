// 剧本事件玩法包（2026-08-14 完全插件化：events 迁出内核）
// 背景：原内核 SYSTEM_DEFS 的"剧本事件"（SCRIPTED_EVENTS + mods.events + LLM 事件源）。
//   完全插件化裁决迁出——剧本事件是叙事玩法，非引擎骨架。事件定义（SCRIPTED_EVENTS）仍
//   在 defs/events（数据），本包只负责装配 EventSystem 实例；mod 追加事件走 mods.events
//   （registry 装配面），LLM 叙事源走 sim.llmEventProvider（可空）。
// 装配：id 已在 SYSTEM_DEFS 表登记（类别推导执行序），无需 before 锚点。
import type { ModRegistry } from '../../sim/mods/registry';
import { EventSystem } from '../../sim/systems/eventSystem';
import { SCRIPTED_EVENTS } from '../../sim/defs/events';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const eventsPack: ModPack = {
  id: 'events',
// 依赖（2026-08-15 显式化）：无硬前置——流浪者招人走引擎 spawnPawn
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'events', label: '剧本事件', category: 'world',
      ctor: (s: Sim) => new EventSystem(s, [...SCRIPTED_EVENTS, ...s.mods.events], s.llmEventProvider),
    });
  }
};