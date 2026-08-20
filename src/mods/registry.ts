// ModRegistry（2026-08-21 从零重写·精简插件化）
// 注册表：系统 def + 建筑 def + 敌人 def + 命令 + AI 动作。
// 挂载：mount(pack) → 拓扑排序 → apply 逐一执行 → 收集系统 def。
// Sim 装配：按 CATEGORY_ORDER × 注册序实例化系统。

import type { Sim } from '../sim/sim';
import { CATEGORY_ORDER, topoSort, registerPack, type ModPack, type SystemDef } from './pack';
import type { GameSystem } from '../sim/systems';

export interface BuildingDef {
  id: string;
  name: string;
  emoji: string;            // 图标（HUD 按钮 + 渲染）
  hp: number;
  passable: boolean;        // 小人能否经过
  costWood?: number;
  tags?: string[];
  /** 每 tick 若小人停留在此格的效果（可选：如 篝火 +san / 农田产出） */
  effect?: (sim: Sim, x: number, y: number, dt: number) => void;
}

export interface EnemyDef {
  id: string;
  name: string;
  emoji: string;
  hp: number;
  dmg: number;
  speed: number;
}

export type CommandHandler = (sim: Sim, args: Record<string, unknown>) => void;

export interface AiAction {
  id: string;
  weight: number;
  /** 探测：该 DLC 在场且有需求 */
  probe: (sim: Sim) => boolean;
  /** 产出命令（模拟玩家操作） */
  act: (sim: Sim) => { type: string; args: Record<string, unknown> } | null;
}

export class ModRegistry {
  systemDefs = new Map<string, SystemDef>();   // 按 id（Sim 装配时按类别序重排）
  buildings = new Map<string, BuildingDef>();
  enemies = new Map<string, EnemyDef>();
  commands = new Map<string, CommandHandler>();
  aiActions: AiAction[] = [];
  mounted = new Set<string>();

  // ---- 注册方法（玩法包 apply 内调用） ----
  registerSystem(def: SystemDef): this { this.systemDefs.set(def.id, def); return this; }
  registerBuilding(def: BuildingDef): this { this.buildings.set(def.id, def); return this; }
  registerEnemy(def: EnemyDef): this { this.enemies.set(def.id, def); return this; }
  registerCommand(type: string, fn: CommandHandler): this { this.commands.set(type, fn); return this; }
  registerAiAction(a: AiAction): this {
    if (!this.aiActions.some((x) => x.id === a.id)) this.aiActions.push(a);
    return this;
  }

  // ---- 挂载 ----
  mount(pack: ModPack): this {
    for (const sub of pack.subpacks ?? []) this.mount(sub); // DLC 里加 DLC
    registerPack(pack);
    for (const p of topoSort([pack])) {
      if (this.mounted.has(p.id)) continue;
      p.apply(this);
      this.mounted.add(p.id);
    }
    return this;
  }

  mountMany(packs: ModPack[]): this {
    for (const p of packs) this.mount(p);
    return this;
  }

  // ---- Sim 装配：类别序 × 注册序 ----
  assemble(sim: Sim): GameSystem[] {
    const order: SystemDef[] = [];
    for (const cat of CATEGORY_ORDER) {
      for (const def of this.systemDefs.values()) {
        if (def.category === cat) order.push(def);
      }
    }
    // 兜底：声明类别不在表内的追加（防御性）
    const known = new Set(order.map((d) => d.id));
    for (const def of this.systemDefs.values()) {
      if (!known.has(def.id)) order.push(def);
    }
    return order.map((def) => def.ctor(sim));
  }
}