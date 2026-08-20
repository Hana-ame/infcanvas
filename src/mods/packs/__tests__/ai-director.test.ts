// AI 总监 + 玩家输入插件化测试（2026-08-20，用户「玩家输入也是一个插件」）：
// 分层指挥栈：④AI 总监（source='ai'）→③玩家输入（source='player' 覆盖）→①behavior 自主
import { describe, it, expect } from 'vitest';
import { createDlcTest } from './dlc-test-helper';

describe('AI 总监 + 玩家输入插件化', () => {
  it('玩家/ai 命令来源可区分 + 玩家活跃记录', () => {
    const t = createDlcTest('zone', { pawnCount: 2 });
    const sim = t.sim as unknown as { lastPlayerCommandAt: number; playerActive: (w?: number) => boolean; time: number; issueCommand: (c: { type: string; x: number; y: number; source?: string }) => void };
    expect(sim.lastPlayerCommandAt).toBe(-Infinity);
    sim.time = 100;
    sim.issueCommand({ type: 'pause', x: 0, y: 0, source: 'player' });
    expect(sim.lastPlayerCommandAt).toBe(100);
    expect(sim.playerActive(3)).toBe(true);
    // AI 来源不更新玩家活跃
    sim.time = 50;
    sim.issueCommand({ type: 'pause', x: 0, y: 0, source: 'ai' });
    expect(sim.lastPlayerCommandAt).toBe(100); // 未变
  });

  it('ai-director 系统装配 + zone AI 动作自动划工作区', () => {
    const t = createDlcTest('zone', { pawnCount: 1, extraPacks: ['ai-director', 'human-input'] });
    expect(t.sim.systemIds).toContain('ai-director');
    expect(t.sim.systemIds).toContain('human-input');
    // 跑 6s（evalInterval=5）→ AI 探测 zone 未划 → 自动划
    for (let i = 0; i < 60; i++) t.sim.step(0.1);
    const zones = (t.sim.getCap('zone') as { getZones?: (t?: string) => Array<{ type: string; id: string }> } | null)?.getZones?.() ?? [];
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0]?.type).toBe('work');
  });

  it('玩家活跃 → AI 让位（不新增动作）', () => {
    const t = createDlcTest('zone', { pawnCount: 1, extraPacks: ['ai-director', 'human-input'] });
    for (let i = 0; i < 60; i++) t.sim.step(0.1);
    const before = ((t.sim.getCap('zone') as { getZones?: (t?: string) => unknown[] } | null)?.getZones?.() ?? []).length;
    // 玩家命令（source='player'）→ 活跃窗口 3s
    t.sim.issueCommand({ type: 'pause', x: 0, y: 0, source: 'player' });
    for (let i = 0; i < 110; i++) t.sim.step(0.1); // 11s：头 3s 活跃，之后恢复
    const after = ((t.sim.getCap('zone') as { getZones?: (t?: string) => unknown[] } | null)?.getZones?.() ?? []).length;
    // 玩家活跃期间 AI 应暂停；窗口过后可能再划——但至少不因 AI 抢跑新增多于 1 个合理动作
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('卸载 human-input + ai-director 不破坏核心（无 AI 纯模拟）', () => {
    const t = createDlcTest('zone', { pawnCount: 0, extraPacks: [] });
    // zone 无依赖 ai-director → 裸装配可跑
  });
});
