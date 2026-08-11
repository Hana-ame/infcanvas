// E2E：渲染位置插值（P2）—— delta 500ms 一跳，但 sprite 帧间应渐进移动
// 采样 pawn sprite 的 canvas 坐标 ~2s（rAF 每帧），若插值生效：移动窗口内出现 ≥3 个中间值；
// 若直接跳变：只有 1 个值（或骤变）。
// 用法：先起 server（8082），再 node scripts/e2e/run-e2e.mjs scripts/e2e/remote-interp.mjs
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { spawn, execSync } from 'child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8082;
const VITE_PORT = 5178;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let viteProc = null;
function startVite() {
  viteProc = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  viteProc.unref();
  return sleep(4000);
}
function stopVite() {
  if (viteProc && viteProc.pid) { try { execSync(`kill ${viteProc.pid}`); } catch { /* 已退 */ } viteProc = null; }
}

export const tests = [
  {
    name: 'sprite 帧间渐进移动（插值生效，非 500ms 跳变）',
    fn: async ({ page, ok }) => {
      await startVite();
      await page.goto(`http://localhost:${VITE_PORT}/?remote=ws://127.0.0.1:${PORT}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // 等就绪；vite HMR 偶发整页 reload → 导航后重新等待（最多 40s）
      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        try {
          await page.waitForFunction(() => window.__sim && window.__renderer && window.__sim.status === 'connected', { timeout: 10000 });
          break;
        } catch {
          await sleep(1500);
        }
      } // 等开局动作展开（伐木/走动）
      // 找一个正在移动的 pawn（真实位置跨帧变化），采样其 sprite canvas 坐标
      // 轮询等待「有 pawn 在移动」（开局动作多样化，最长等 25s）
      const tDead = Date.now();
      let moving = [];
      while (Date.now() - tDead < 25000 && moving.length === 0) {
        moving = await page.evaluate(async () => {
          const rs = window.__sim;
          await new Promise((r) => setTimeout(r, 700));
          const hits = [];
          for (const eid of rs.pawns) {
            const a = rs.pawnPositions.get(eid);
            await new Promise((r) => setTimeout(r, 600));
            const b = rs.pawnPositions.get(eid);
            if (a && b && (a.x !== b.x || a.y !== b.y)) hits.push(eid);
          }
          return hits;
        });
      }
      if (moving.length === 0) {
        ok('找到移动中的 pawn（采样前提）', false, '25s 窗口内无 pawn 移动，重试');
        stopVite();
        return;
      }
      const eid = moving[0];
      // 探针：renderNow 应单调递增（播放时钟连续）；g.x 应渐进
      const probe = await page.evaluate(async (eid) => {
        const rs = window.__sim;
        const r = window.__renderer;
        const g = r.pawnSprites.get(eid);
        const nows = [];
        const xs = [];
        await new Promise((res) => {
          let n = 0;
          const tick = () => {
            nows.push(rs.renderNow());
            if (g) xs.push(Math.round(g.x));
            if (++n < 40) requestAnimationFrame(tick); else res();
          };
          requestAnimationFrame(tick);
        });
        const uniq = [...new Set(xs)];
        return { nows: nows.slice(0, 4), nowGrows: nows[nows.length - 1] > nows[0], xs: uniq.slice(0, 12) };
      }, eid);
      console.log('  [probe] renderNow 头4帧:', probe.nows.map((v) => v.toFixed(2)).join(','), '| 递增:', probe.nowGrows, '| g.x 去重:', probe.xs.join(','));
      const samples = await page.evaluate(async (eid) => {
        const r = window.__renderer;
        const g = r.pawnSprites.get(eid);
        if (!g) return [];
        const out = [];
        await new Promise((res) => {
          let n = 0;
          const tick = () => {
            out.push(Math.round(g.x));
            if (++n < 60) requestAnimationFrame(tick); else res();
          };
          requestAnimationFrame(tick);
        });
        return out;
      }, eid);
      const uniq = [...new Set(samples)];
      console.log(`  [stat] eid=${eid} 采样 ${samples.length} 帧, 去重 ${uniq.length} 个, 值=[${uniq.slice(0, 12).join(',')}${uniq.length > 12 ? '…' : ''}]`);
      ok('采样到 ≥ 40 帧', samples.length >= 40, `${samples.length}`);
      ok('移动窗口内出现渐进中间值（≥3 个不同位置）', uniq.length >= 3, `${uniq.length} 个`);
      stopVite();
    },
  },
];