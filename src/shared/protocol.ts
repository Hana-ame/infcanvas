/**
 * shared/protocol.ts —— 远程协议（阶段④）：稀疏快照 + 命令 + 事件流。
 *
 * 形态：
 *  - server→client：welcome（新连接：seed/tuning/全量状态）> full（周期全量对账 ~5s）
 *    > delta（增量 ~500ms：只带变化的 pawn + 删除名单 + 新事件；hostiles/buildings
 *      数量级小，直接全发）。
 *  - client→server：cmd（type+args，服务端白名单校验后走 issueCommand 同一入口）。
 *
 * 地形策略：无限地图不下发地形——客户端用 welcome 里的 seed+tuning 本地重建 World
 * 纯函数推导 tile；特征余量/冷却属于运行态，随 full 快照的 world 段同步。
 */
import type { BuildingState, Eid, Hostile, LogEvent, PawnState } from '../sim/types';
import type { SaveData } from '../sim/sim-save';
import type { Tuning } from '../sim/tuning';

/** 全量状态（welcome/full 共用体；不含 tuning——welcome 单独带一次） */
export interface FullState {
  time: number;
  stockpile: Record<string, number>;
  pawns: PawnState[];
  hostiles: Hostile[];
  buildings: BuildingState[];
  events: LogEvent[];
  /** 特征运行态（余量/冷却），客户端本地 World 用它回答 featureAt */
  world: SaveData['world'];
}

export interface WelcomeMsg {
  t: 'welcome';
  d: FullState & { seed: number; tuning: Tuning };
}
export interface FullMsg {
  t: 'full';
  d: FullState;
}
export interface DeltaMsg {
  t: 'delta';
  d: {
    time: number;
    stockpile: Record<string, number>;
    /** 只含与上次不同的 pawn（JSON 逐只比较） */
    pawns: PawnState[];
    removedPawns: Eid[];
    hostiles: Hostile[]; // 数量小，直接全量
    buildings: BuildingState[]; // 同上
    newEvents: LogEvent[];
    /** 特征运行态只在 full 里同步；delta 不带（低频变化可容忍 5s 延迟） */
  };
}
export type ServerMsg = WelcomeMsg | FullMsg | DeltaMsg;

export interface CmdMsg {
  t: 'cmd';
  c: { type: string; args?: Record<string, unknown> };
}
export type ClientMsg = CmdMsg;

/** 服务端命令白名单：基础指挥面。新命令要上行必须在此登记（防任意调用注入）。 */
export const SERVER_COMMANDS: readonly string[] = ['move'];

/** move 参数校验：坐标有限且在防御边界内；eids 存在性由 Sim.issueCommand 自行过滤 */
export function validMoveArgs(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  const x = args.x as number;
  const y = args.y as number;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (Math.abs(x) > 30000 || Math.abs(y) > 30000) return false;
  return true;
}
