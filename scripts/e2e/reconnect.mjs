// E2E：remote 模式断线重连（P1 补强）
// 自管生命周期：起 vite(5178) + server → kill server（模拟宕机）→ 重启 → 断言页面自动恢复
// 用法：node scripts/e2e/run-e2e.mjs scripts/e2e/reconnect.mjs
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8083;
const VITE_PORT = 5178;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srvPid = () => {
  try { return execSync(`ss -ltnp | grep :${PORT} | grep -oP 'pid=\\K[0-9]+'`).toString().trim(); }
  catch { return null; }
};
function startServer(wait = 4) { // 幂等：已在跑则不重复 spawn
  if (srvPid()) return;
  const proc = spawn('npx', ['tsx', 'src/server/index.ts', String(PORT), '7', '2'], {
    cwd: ROOT, // 项目根（脚本在 scripts/e2e/）
    detached: true, stdio: 'ignore',
  });
  proc.unref();
  return sleep(wait * 1000);
}
// 自起 dev server（5174/5175 常被其它项目占用，用专用端口 5178）
let viteProc = null;
function startVite() {
  viteProc = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });
  viteProc.unref();
  return sleep(4 * 1000);
}
function stopVite() {
  if (viteProc && viteProc.pid) { try { execSync(`kill ${viteProc.pid}`); } catch { /* 已退 */ } viteProc = null; }
}
function stopServer() {
  const pid = srvPid();
  if (pid) { try { execSync(`kill ${pid}`); } catch { /* 已退 */ } return sleep(1500); }
  return null;
}

export const tests = [
  {
    name: 'kill/重启 server → 自动重连恢复',
    fn: async ({ page, ok }) => {
      await startVite();
      await startServer(5);
      await page.goto(`http://localhost:${VITE_PORT}/?remote=ws://127.0.0.1:${PORT}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(3500);
      const t1 = await page.evaluate(() => window.__sim.time);
      ok('初始连接', /^connected$/.test(await page.evaluate(() => window.__sim.status)), `t=${t1.toFixed(1)}`);

      // 宕机：kill server → 看门狗（≤5s 无消息）主动判定断线 → hint
      stopServer();
      await sleep(4000);
      const s2 = await page.evaluate(() => ({ s: window.__sim.status, t: window.__sim.time, hint: document.getElementById('remote-hint')?.textContent ?? '' }));
      ok('断线被检测（reconnecting + hint）', s2.s === 'reconnecting' && s2.hint.length > 0, s2.hint);
      const frozen = Math.abs(s2.t - t1) < 1.5;
      ok('模拟时间冻结', frozen, `t=${s2.t.toFixed(1)}`);

      // 恢复：重启 server → 重连成功 → hint 清除 + 时间前进
      await startServer(6);
      await sleep(6000);
      const s3 = await page.evaluate(() => ({ s: window.__sim.status, t: window.__sim.time, hint: document.getElementById('remote-hint')?.textContent ?? '' }));
      ok('重连成功', s3.s === 'connected' && s3.hint.length === 0, `t=${s3.t.toFixed(1)}`);
      // server 重启 = 新世界（P1 无持久化，时间重置属预期）；验证连接恢复后时间重新向前走
      await sleep(2500);
      const t4 = await page.evaluate(() => window.__sim.time);
      ok('模拟时间重新前进', t4 > s3.t, `${s3.t.toFixed(1)} → ${t4.toFixed(1)}`);
      stopServer();
      stopVite();
    },
  },
];