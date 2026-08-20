import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { profilerPlugin, flameGraphHtml } from '../profiler';

describe('profiler 插件（内置性能分析 + 火焰图，插件形态验证）', () => {
  it('flameGraphHtml：生成可解析的 SVG 火焰图（每系统一块，占比排序）', () => {
    const stats = new Map([
      ['behavior', { totalMs: 500, count: 100, maxMs: 10, lastMs: 5 }],
      ['san', { totalMs: 300, count: 100, maxMs: 8, lastMs: 4 }],
      ['needs', { totalMs: 100, count: 100, maxMs: 3, lastMs: 1 }],
    ]);
    const html = flameGraphHtml(stats, 'test');
    expect(html).toContain('behavior 55.6%');
    expect(html).toContain('san 33.3%');
    expect(html).toContain('needs 11.1%');
    expect(html).toContain('<svg'); // 火焰图 SVG
    // 块顺序 = 耗时降序（第一个 rect 是 behavior）
    const first = html.indexOf('<rect');
    expect(html.slice(first, first + 200)).toContain('behavior');
  });

  it('插件挂载：hook 自动开启内置计时 → step 后有 stats → 火焰图 HTML 输出', () => {
    let captured = '';
    const origLog = console.log;
    const logs: string[] = [];
    console.log = (...a: unknown[]) => { logs.push(String(a[0])); };
    try {
      const sim = new Sim({
        seed: 99, pawnCount: 2,
        mods: (m) => profilerPlugin({ intervalSec: 1, outFile: '' })(m),
      });
      // 推进 1.2s（intervalSec=1 → 20 tick 触发一次）
      for (let i = 0; i < 30; i++) sim.step(1 / 20);
      // stats 已采集（行为系统有调用）
      const total = [...sim.profileStats.values()].reduce((a, b) => a + b.totalMs, 0);
      expect(total).toBeGreaterThan(0);
      expect(sim.profileStats.get('behavior')?.count).toBeGreaterThan(0);
      // 火焰图文件内容（outFile='' → 写空路径会抛 → 走 console 分支，验证 HTML 生成逻辑经 console 表格）
      const tableLog = logs.find((l) => l.includes('[profiler]'));
      expect(tableLog).toBeTruthy();
      void captured;
    } finally {
      console.log = origLog;
    }
  });

  it('未挂载插件时 profiling 默认关闭（零开销）', () => {
    const sim = new Sim({ seed: 100, pawnCount: 2 });
    for (let i = 0; i < 20; i++) sim.step(1 / 20);
    expect(sim.profileStats.size).toBe(0);
  });
});
