// Sim 引擎（2026-08-21 从零重写·精简版）
// 职责：实体管理 + step(dt) 驱动系统 + 命令路由 + 事件日志。
// 纯仿真（零 DOM），浏览器/Node 双端复用。

import { World } from './world';
import { findPath } from './pathfinding';
import type { Eid, Pawn, Hostile, Pos, Needs, Health } from './types';
import type { GameSystem } from './systems';
import { ModRegistry } from '../mods/registry';

export interface SimConfig {
  seed?: number;
  pawnCount?: number;
  registry?: ModRegistry;
}

export class Sim {
  world = new World();
  reg: ModRegistry;
  systems: GameSystem[] = [];
  pawns = new Map<Eid, Pawn>();
  hostiles: Hostile[] = [];
  events: { time: number; text: string }[] = [];
  selected: Eid[] = [];            // 框选/点选
  stockpile = { wood: 0, food: 0, ore: 0 };
  time = 0;                        // 游戏秒
  private nextEid = 1;
  private nextHostileId = 1;
  private campId?: string;

  constructor(cfg: SimConfig = {}) {
    this.reg = cfg.registry ?? new ModRegistry();
    this.systems = this.reg.assemble(this);
    for (const sys of this.systems) sys.init?.();
    // 出生鼠 + 初始篝火（依赖引导包是否注册 campfire 建筑）
    const n = cfg.pawnCount ?? 4;
    for (let i = 0; i < n; i++) this.spawnPawn();
    this.ensureCamp();
  }

  // ---- 实体 ----
  spawnPawn(x?: number, y?: number): Eid {
    const eid = this.nextEid++;
    const p: Pawn = {
      eid,
      name: `鼠${eid}`,
      pos: x !== undefined ? { x, y } : this.findSpawn(),
      needs: { food: 90, rest: 90, mood: 60, san: 90 },
      health: { hp: 100, maxHp: 100 },
      job: '闲逛',
      path: [],
      trait: ['strong', 'lazy', 'owl', 'workaholic'][Math.floor(Math.random() * 4)],
    };
    this.pawns.set(eid, p);
    this.events.push({ time: this.time, text: `🐭 ${p.name} 出生` });
    return eid;
  }

  killPawn(eid: Eid, cause = 'unknown'): void {
    const p = this.pawns.get(eid);
    if (!p) return;
    this.events.push({ time: this.time, text: `💀 ${p.name} 死亡（${cause}）` });
    this.pawns.delete(eid);
    this.selected = this.selected.filter((s) => s !== eid);
  }

  private findSpawn(): Pos {
    // 营地中心附近找可站格
    const { x, y } = this.world.spawn;
    for (let r = 0; r < 10; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (this.world.passable(x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
    return { x, y };
  }

  private ensureCamp(): void {
    if (this.campId) return;
    const b = this.world.addBuilding('campfire', this.world.spawn.x, this.world.spawn.y);
    if (b) this.campId = b.id;
  }

  // ---- 命令路由 ----
  issueCommand(type: string, args: Record<string, unknown> = {}, source: 'player' | 'ai' = 'player'): void {
    if (source === 'player') this.lastPlayerAt = this.time;
    if (type === 'move') {
      // 移动：args.eids（框选批量）或 args.eid / selected
      const eids = (args.eids as Eid[] | undefined) ?? (args.eid !== undefined ? [args.eid as Eid] : this.selected);
      const tx = args.x as number, ty = args.y as number;
      for (const eid of eids) {
        const p = this.pawns.get(eid);
        if (!p) continue;
        const path = findPath((x, y) => this.world.passable(x, y), p.pos.x, p.pos.y, tx, ty);
        p.path = path;
        p.job = '移动';
        p.commandCd = 3; // 玩家命令优先：3s 不自主
      }
      return;
    }
    const handler = this.reg.commands.get(type);
    if (handler) handler(this, args);
    else this.events.push({ time: this.time, text: `⚠ 未知命令：${type}` });
  }
  lastPlayerAt = -Infinity;
  playerActive(sec = 3): boolean { return this.time - this.lastPlayerAt <= sec; }

  // ---- 步进 ----
  step(dt: number): void {
    this.time += dt;
    for (const sys of this.systems) sys.update(dt);
  }

  // ---- 工具（系统用） ----
  pathTo(eid: Eid, x: number, y: number): Pos[] {
    const p = this.pawns.get(eid)!;
    return findPath((ax, ay) => this.world.passable(ax, ay), p.pos.x, p.pos.y, x, y);
  }

  campPos(): Pos | undefined {
    const b = this.campId && this.world.buildings.get(this.campId);
    return b ? { x: b.x, y: b.y } : this.world.spawn;
  }
}