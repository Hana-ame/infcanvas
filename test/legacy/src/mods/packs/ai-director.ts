// AI 总监玩法包（2026-08-20，用户「ai 作为 dlc 最后一层」设计落地）：
// AI = 调度器，不是"懂所有 DLC 的大包"。各能力包自注册 AI 动作（registerAiAction），
// AI 总监只做：探测在场动作 → 节流收集 → 按紧急度排序 → 逐条以 Command.source='ai'
// 下发（模拟玩家操作，复用同一命令协议）。玩家活跃（human-input 包在场 + 3s 内有
// 玩家命令）→ AI 让位（玩家输入是最后覆盖层）。
// 分层指挥栈（2026-08-20）：
//   ④ AI 总监（本包，模拟玩家）        → issueCommand source='ai'
//   ③ 玩家输入（human-input 包，真人） → issueCommand source='player'（最高优先，覆盖 AI）
//   ② 场指挥（field-command，NPC 指挥链）→ 内层命令下放（受命者征召门优先于 AI？——AI 跳过）
//   ① 行为决策引擎（behavior）自主自决  → 最低层（commandCooldown 挡 AI/玩家命令）
// 执行序：category 'boot' + apply 序在 bootstrap 后（挂清单最末）→ 看完整局面再指挥，
// 命令下一 tick 生效。玩家在场且活跃 → ai-director 不动作（本 tick 让位）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { Command } from '../../sim/types';
import type { ModPack } from '../pack';
import type { AiAction } from '../../sim/mods/registry';

// AI 动作接口：能力包注册，AI 总监调度（类型定义在 registry 同层）

const CFG = {
  evalInterval: 5,     // AI 评估节流（秒）——模拟玩家的"反应速度"
  maxActionsPerEval: 3, // 每次评估最多执行的动作数（防 AI 高频刷屏）
  honorPlayer: true,   // 玩家在场且活跃 → AI 让位
};

class AiDirectorSystem {
  id = 'ai-director';
  private _throttle = 0;
  private actions = new Map<string, AiAction>();

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  // 能力包注册 AI 动作（registerAiAction 走这里）
  registerAction(a: AiAction): void {
    this.actions.set(a.id, a);
  }

  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < CFG.evalInterval) return;
    this._throttle = 0;

    // 玩家让位：human-input 包在场 + 玩家活跃 → AI 不干预（玩家是最后输入）
    if (CFG.honorPlayer) {
      const human = this.ctx.getCap('humanInput') as { playerActive?: () => boolean } | null;
      if (human?.playerActive?.()) return;
    }
    // 无 human-input 包 = headless：看好坏（纯 AI 服）→ 不检查玩家在场

    // 收集可执行动作 → 按 weight 排序 → 执行 top-N
    const ready: AiAction[] = [];
    for (const a of this.actions.values()) {
      try { if (a.probe(this.ctx)) ready.push(a); } catch { /* 探测失败跳过 */ }
    }
    ready.sort((a, b) => b.weight - a.weight);
    let n = 0;
    for (const a of ready) {
      if (n >= CFG.maxActionsPerEval) break;
      const cmd = a.act(this.ctx);
      if (!cmd) continue;
      this.ctx.issueCommand({ ...cmd, source: 'ai' });
      n++;
    }
  }
}

export const aiDirectorPack: ModPack = {
  id: 'ai-director',
  // 前置可选：AI 动作由各能力包自注册（不在场 = 不调度）；但玩家让位检测依赖
  // human-input 的玩家活跃能力 → 显式 require（架构审查 P2-5：消除隐式 getCap 依赖）。
  // 不 require 任何玩法动作包——uninstall 某个 DLC = 它的 aiAction 不在场，AI 自动降级。
  requires: ['human-input'],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'ai-director', label: 'AI 总监', category: 'boot',
      // 恒表尾豁免（架构审查 P1-4）：bootstrap 的"恒表尾"约束语义 = 出生刷人晚于全体系统
      // **init**；本包是 update 尾的全局观察者（刷人后看完整局面再指挥），在 bootstrap 后执行
      // 不违背该语义。显示豁免：boot 组内 apply 序在本包（挂清单最后）→ 排 bootstrap 后。
      // apply 序在 bootstrap 后（本包挂清单最末）→ 刷人后看全局再指挥，命令下一 tick 生效
      ctor: (ctx) => {
        const sys = new AiDirectorSystem(ctx);
        // 灌入池中已有动作 + 设 sink（此后 registerAiAction 实时进系统——架构审查 P1-3）
        for (const a of m.aiActions) sys.registerAction(a);
        m.setAiDirectorSink((a) => sys.registerAction(a));
        ctx.provide('aiDirector', {
          registerAction: (a: AiAction) => sys.registerAction(a),
        });
        return sys;
      },
    });
  },
};