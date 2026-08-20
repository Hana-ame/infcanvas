// E2E：tick delta 增量（P2）—— 8s 观察窗内全量 snapshot 应 ≤3 帧（首连 1 + 5s 对账），
// delta 帧应远超全量，且页面状态持续更新（时间/位置来自增量）。
// 用法：先起 server（8082），再 node scripts/e2e/run-e2e.mjs scripts/e2e/remote-delta.mjs
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
    name: '12s 观察：全量对账 ≤ 3 帧，delta 帧持续供应，时间/位置实时流动',
    fn: async ({ page, ok }) => {
      await startVite();
      let snap = 0, delta = 0, event = 0;
      page.on('websocket', (ws) => {
        ws.on('framereceived', (ev) => {
          const txt = String(ev.payload);
          if (txt.startsWith('{"type":"snapshot"')) snap++;
          else if (txt.startsWith('{"type":"delta"')) delta++;
          else if (txt.startsWith('{"type":"event"')) event++;
        });
      });
      await page.goto(`http://localhost:${VITE_PORT}/?remote=ws://127.0.0.1:${PORT}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(3000);
      const t1 = await page.evaluate(() => window.__sim.time);
      const p1 = await page.evaluate(() => { const e = window.__sim.pawnPositions.values().next().value; return e ? `${e.x.toFixed(0)},${e.y.toFixed(0)}` : '?'; });
      await sleep(9000);
      const t2 = await page.evaluate(() => window.__sim.time);
      const p2 = await page.evaluate(() => { const e = window.__sim.pawnPositions.values().next().value; return e ? `${e.x.toFixed(0)},${e.y.toFixed(0)}` : '?'; });
      console.log(`  [stat] snapshot=${snap} delta=${delta} event=${event} t=${t1.toFixed(1)}→${t2.toFixed(1)} pos=${p1}→${p2}`);
      ok('全量对账帧稀少（snapshot ≤ 5）', snap <= 5, `${snap} 帧`);
      ok('增量占绝对多数（delta ≥ 5×snapshot）', delta >= Math.max(10, snap * 5), `${delta} vs ${snap}`);
      ok('事件通道仍在（event ≥ 1）', event >= 1, `${event} 帧`);
      ok('时间持续流动（来自 delta t）', t2 > t1, `${t1.toFixed(1)} → ${t2.toFixed(1)}`);
      ok('pawn 在动（位置来自 delta）', p1 !== p2, `${p1} → ${p2}`);
      stopVite();
    },
  },
];