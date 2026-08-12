// 性能分析插件（证明框架可插拔扩展：不改内核、纯 mod 挂载即得火焰图）
// 用法：
//   - 代码挂载：new Sim({ mods: (m) => profilerPlugin({ outFile: 'profiler.html' })(m) })
//   - server：MODS_DIR 放 .mod.json 包，或 ?mods= 指向本文件（ESM 源码通道）
// 机制：registerHook('step:after') 周期性读取 Sim 内置的 registry.profileStats
//       （enableProfiling 自动开启）→ 生成 SVG 火焰图 HTML（统计型：x 轴=耗时占比）
// 输出：console 表格 + 火焰图文件（浏览器可直接打开）
import type { ModRegistry } from '../sim/mods/registry';

export interface ProfilerOpts {
  intervalSec?: number; // 生成周期（秒，默认 5）
  outFile?: string;     // 火焰图输出路径（Node 可用；浏览器环境跳过写文件）
  sampleEvery?: number; // 采样间隔 tick（默认 1 = 全量计时）
}

// 火焰图 HTML（统计型单层：每个系统一块色块，宽度 = totalMs 占比）
export function flameGraphHtml(stats: ReadonlyMap<string, { totalMs: number; count: number; maxMs: number; lastMs: number }>, title: string): string {
  const rows = [...stats.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
  const total = rows.reduce((a, [, s]) => a + s.totalMs, 0);
  if (total <= 0) return `<html><body><h2>${title}</h2><p>无数据（需 enableProfiling）</p></body></html>`;
  const W = 960;
  const barH = 44;
  let y = 0;
  let blocks = '';
  for (const [id, st] of rows) {
    const w = Math.max(2, (st.totalMs / total) * W);
    const pct = ((st.totalMs / total) * 100).toFixed(1);
    // 稳定色：id 散列 → 暖色系（与敌人着色同思路）
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
    const hue = Math.abs(h) % 60; // 0-59 → 红橙黄区间
    const color = `hsl(${hue}, 75%, 55%)`;
    blocks +=
      `<g><rect x="0" y="${y}" width="${w}" height="${barH}" fill="${color}" rx="3">` +
      `<title>${id}\n累计 ${st.totalMs.toFixed(1)}ms (${pct}%)\n调用 ${st.count} 次\n平均 ${(st.totalMs / Math.max(1, st.count)).toFixed(3)}ms/次\n峰值 ${st.maxMs.toFixed(1)}ms</title></rect>` +
      `<text x="6" y="${y + barH / 2 + 4}" font-size="13" fill="#111" font-family="system-ui">${id} ${pct}%</text></g>`;
    y += barH + 4;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;background:#1a1a1a;color:#eee;padding:20px;">
<h2>${title}</h2>
<p>总耗时 ${total.toFixed(0)}ms · 系统 ${rows.length} 个 · 悬停色块查看明细</p>
<svg width="${W}" height="${y}" xmlns="http://www.w3.org/2000/svg">${blocks}</svg>
</body></html>`;
}

// 插件工厂：注册 step:after hook，周期性生成火焰图
export function profilerPlugin(opts: ProfilerOpts = {}): (m: ModRegistry) => void {
  const intervalSec = opts.intervalSec ?? 5;
  const outFile = opts.outFile ?? 'profiler-flame.html';
  return (m: ModRegistry): void => {
    let acc = 0;
    let lastTitle = '';
    m.registerHook('step:after', ({ sim }) => {
      // 首次触发自动开启内置计时（幂等）
      const s = sim as unknown as { enableProfiling(on?: boolean): void; profileStats: ReadonlyMap<string, { totalMs: number; count: number; maxMs: number; lastMs: number }>; logEvent(t: string): void };
      s.enableProfiling?.(true);
      acc += 1; // 每 tick 计数（dt 不确定，用 tick 数近似）
      if (acc < intervalSec * 20) return; // 20Hz 步进 ≈ intervalSec 秒
      acc = 0;
      const stats = s.profileStats;
      const title = `infcanvas 性能火焰图 @t=${(sim as unknown as { time: number }).time?.toFixed(0) ?? '?'}s`;
      // console 表格（Node 直接看）
      const rows = [...stats.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
      if (rows.length > 0) {
        const table: Record<string, string>[] = rows.map(([id, st]) => ({
          系统: id,
          累计ms: st.totalMs.toFixed(1),
          占比: ((st.totalMs / Math.max(0.001, [...stats.values()].reduce((a, b) => a + b.totalMs, 0))) * 100).toFixed(1) + '%',
          调用: String(st.count),
          平均ms: (st.totalMs / Math.max(1, st.count)).toFixed(3),
          峰值ms: st.maxMs.toFixed(1),
        }));
        console.log(`\n[profiler] ${title}`);
        console.table(table);
      }
      // 写火焰图文件（Node 环境；浏览器环境跳过）
      const html = flameGraphHtml(stats, title);
      if (typeof process !== 'undefined' && process.versions?.node) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require('node:fs') as typeof import('node:fs');
          fs.writeFileSync(outFile, html);
          console.log(`[profiler] 火焰图已写入 ${outFile}`);
        } catch (e) { console.warn('[profiler] 写文件失败:', (e as Error).message); }
      } else if (html !== lastTitle) {
        s.logEvent?.('🔥 性能分析已生成（见 console）');
      }
      lastTitle = title;
    });
  };
}
