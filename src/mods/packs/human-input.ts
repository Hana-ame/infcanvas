// 玩家输入玩法包（2026-08-20，用户「玩家输入也是一个插件，试试？」）：
// 玩家 = 一个玩法包（human-input），不再是内核预设。设计动机：
//   架构上"谁在下命令"与"命令路由"解耦——玩家/AI/脚本三方共用同一命令协议
//   （Command.source），人类玩家只是众多输入源里优先级最高的一个。
// 本包职责（纯输入面，零玩法逻辑）：
//   ① 持有输入源（本地事件 / 远程 WebSocket 命令）→ 转成 Command 下发
//   ② 记录玩家活跃状态（sim.lastPlayerCommandAt 由 issueCommand 维护）→ AI 让位依据
//   ③ 提供 cap('humanInput')：查询玩家是否在场/活跃 / 命令录制（脚本可重放 → AI 教学）
// 卸载本包 = 无人类玩家（headless 服务器纯 AI/纯模拟，命令仍可经 issueCommand 直达，
// 只是 source 缺省 'player' 的语义变成"程序输入"）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { Command } from '../../sim/types';
import type { ModPack } from '../pack';

const CFG = {
  activeWindow: 3,     // 玩家活跃窗口（秒）——窗口内 AI 让位
  maxRecorded: 500,    // 命令录制上限（回放/教学用）
};

class HumanInputSystem {
  id = 'human-input';
  private recorded: Command[] = [];
  private recording = false;
  private replayIdx = 0;
  private replayInterval = 0.5; // 回放节流（秒）
  private replayTimer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    // 回放（录制命令按间隔重放 = 让 AI 学习人类操作序列）
    if (this.replayIdx < this.recorded.length) {
      this.replayTimer += dt;
      if (this.replayTimer >= this.replayInterval) {
        this.replayTimer = 0;
        const cmd = this.recorded[this.replayIdx]!;
        this.ctx.issueCommand({ ...cmd, source: 'player' }); // 重放 = 玩家来源（触发让位）
        this.replayIdx++;
      }
    }
  }

  // 玩家是否在场（本地/远程连接存在 = 有真人在操纵）
  playerPresent(): boolean { return true; } // 包装配 = 玩家通道在

  // 玩家是否活跃（最近有 player 来源命令）
  playerActive(): boolean { return this.ctx.playerActive?.(CFG.activeWindow) ?? false; }

  startRecording(): void { this.recording = true; this.recorded = []; this.replayIdx = 0; }
  stopRecording(): Command[] { this.recording = false; return this.recorded; }
  record(cmd: Command): void {
    if (this.recording && this.recorded.length < CFG.maxRecorded) this.recorded.push(cmd);
  }
  replay(): void { this.replayIdx = 0; this.replayTimer = 0; }
  get recordedCount() { return this.recorded.length; }
}

export const humanInputPack: ModPack = {
  id: 'human-input',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'human-input', label: '玩家输入', category: 'boot',
      // before 'bootstrap'？不——人类输入应在 bootstrap 后（刷人后玩家才操作）。category 'boot'
      // + apply 序在 bootstrap 后（本包挂清单最末）→ 执行 = 全体系统 → bootstrap 刷人 → human-input
      ctor: (ctx) => {
        const sys = new HumanInputSystem(ctx);
        // 能力让渡：AI 总监/其他包查询"玩家在不在/活跃否"决定是否让位
        ctx.provide('humanInput', {
          playerPresent: () => sys.playerPresent(),
          playerActive: () => sys.playerActive(),
          startRecording: () => sys.startRecording(),
          stopRecording: () => sys.stopRecording(),
          replay: () => sys.replay(),
          get recordedCount() { return sys.recordedCount; },
        });
        return sys;
      },
    });
  },
};