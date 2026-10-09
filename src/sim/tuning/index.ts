/**
 * index.ts —— 数值总表入口（模块化审查 P2 拆分后）。
 *
 * 结构：
 *   §0  运行常数真相源（SIM_DT_SEC / CLIENT_STEP_SEC / ...）——非玩法数值，不进 Tuning
 *   §1  types.ts  —— 全部 interface（TileTuningEntry / BuildingTuningEntry / TechTuningEntry / EnemyTuningEntry / Tuning）
 *   §2  defaults/ —— 出厂数值按玩法域分组（core / food / combat / env / meta）
 *   §3  组装 DEFAULT_TUNING（键顺序镜像 Tuning 接口）
 *
 * 调用方 import 路径零改动：from '../sim/tuning' 自动解析到本 index.ts。
 *
 * 拆分纪律：
 *   - 纯搬家：DEFAULT_TUNING 深比较 === 拆分前快照（契约测试守护）
 *   - golden 指纹逐位不变（纯搬家；指纹变即说明搬家时动了数据）
 */

// ===== §0 运行常数真相源（模块化审查 P1 + P2，2026-10-10）=====
//
// 【原缺陷 · P1】dt 曾有**三套真相源**，各自硬编码、互不相认：
//   · client/main.ts:105-107  `sim.step(0.25)`
//   · client/main.ts:257      `Math.min(0.1, ...)`（渲染帧钳位）
//   · server/game-server.ts   `opts.tickMs ?? 100`
// 而 tuning.ts（数值总表）里**根本没有 dt**。
//
// 【归口规则（本轮起）】
//  - `SIM_DT_SEC` 是**唯一**的理论真实 dt（秒）；"一步推进多少秒"只答它。
//  - client/server 的值一律从它**派生**，禁止再写 0.25 / 0.1 / 100 字面量。
//  - 这些是**运行常数不是玩法数值**：不进 `Tuning` 接口、不参与 `overrideTuning`。
//  - 默认种子/端口同理：出厂缺省值的唯一来源，客户端与服务端两侧共用。
// ============================================================================

/** 理论真实 dt（秒）：模拟步长的**唯一真相源**。服务器按它推进权威模拟。 */
export const SIM_DT_SEC = 0.1;

/** 客户端本地固定步长占几个真实 tick（整数倍，避免分数 tick 漂移）。 */
export const CLIENT_STEP_MULT = 2.5;

/** 客户端本地固定步长（秒）= CLIENT_STEP_MULT × SIM_DT_SEC = 0.25 */
export const CLIENT_STEP_SEC = CLIENT_STEP_MULT * SIM_DT_SEC;

/** 渲染帧墙钟钳位（秒）：单帧最多喂入一个真实 tick 的时长。 */
export const RENDER_DT_CLAMP_SEC = SIM_DT_SEC;

/** 服务器 tick 间隔（ms）= SIM_DT_SEC × 1000。 */
export const SERVER_TICK_MS = SIM_DT_SEC * 1000;

/** 出厂默认世界种子：client 本地 / 服务器 / CLI 三处缺省共用（原 `42` ×3）。 */
export const DEFAULT_SEED = 42;

/** 出厂默认联机端口：CLI 与 createGameServer 缺省共用（原 `8080` ×2）。 */
export const DEFAULT_PORT = 8080;

// ===== §1 Interface re-exports =====
export type { TileTuningEntry, BuildingTuningEntry, TechTuningEntry, EnemyTuningEntry, Tuning } from './types';

// ===== §2+§3 组装 DEFAULT_TUNING =====
import type { Tuning } from './types';
import { world, pawn, needs, build, gathering } from './defaults/core';
import { farming, cooking, medicine } from './defaults/food';
import { social, raid, hunting, combat, fortify } from './defaults/combat';
import { env } from './defaults/env';
import { factions, techs, techPool, bootstrap, events, tiles, buildings, enemies, traits } from './defaults/meta';

/**
 * 出厂数值：所有注释即语义来源。
 *
 * 键顺序镜像 Tuning 接口（§2）：
 *   world → pawn → needs → build → gathering → farming → cooking → medicine →
 *   social → raid → hunting → combat → env → factions → fortify →
 *   techs → techPool → bootstrap → events → tiles → buildings → enemies → traits
 *
 * 拆后行为不变：见 __tests__/tuning-snapshot.test.ts 的深比较契约测试。
 */
export const DEFAULT_TUNING: Tuning = {
  world, pawn, needs, build, gathering,
  farming, cooking, medicine,
  social, raid, hunting, combat, env,
  factions, fortify,
  techs, techPool, bootstrap, events,
  tiles, buildings, enemies,
  traits,
};
