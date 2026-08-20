// P2-7: work priority（2026-08-20，RimWorld 风格职业优先级）
// 设计：每个小人有职业优先级列表 → 影响决策抽卡权重
// 玩家通过 assign 命令指派职业 → 指派的职业卡 utilityFixed 加成
// 未指派的鼠按默认权重抽卡。高优先级职业的卡 utility 额外 +10。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

const CFG = {
  assignedJobBonus: 10,  // 指派职业的 utility 加成
  priorityCheckInterval: 5, // 优先级影响评估 5s 一次
};

// 职业优先级系统：指派职业的 utility +10 加成（影响决策抽卡权重）
// 被动：behavior 系统通过 ctx.getCap("workPriority") 查询加成
// 5s 节流（优先级不频繁变化）
class WorkPrioritySystem {
  id = 'work-priority';
  private _throttle = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < CFG.priorityCheckInterval) return;
    this._throttle = 0;
    // work-priority 是被动的：behavior 系统抽卡时通过 ctx.getCap('workPriority')
    // 查询小人的职业优先级 → 调整 utility。这里只做轻量检查。
    // 实际影响在 cardSystem.decide() 中读取。
  }
}

export const workPriorityPack: ModPack = {
  id: 'work-priority',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'work-priority', label: '职业优先级', category: 'ai',
      ctor: (ctx) => {
        const sys = new WorkPrioritySystem(ctx);
        ctx.provide('workPriority', {
          getBonus: (eid: number) => {
            const st = ctx.pawnStates.get(eid);
            return st?.assignedJob ? CFG.assignedJobBonus : 0;
          },
        });
        return sys;
      },
    });
  },
};