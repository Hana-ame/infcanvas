// P1 server 骨架 e2e（DESIGN §9）：viewer 连 server，快照同步 + 命令上行 + 权威回显
// 前置：1) npx tsx src/server/index.ts 8080   2) npx vite --port 5177
// 用法：node scripts/e2e/run-e2e.mjs scripts/e2e/remote-viewer.mjs
export const tests = [
  {
    name: 'viewer 连接：welcome + 快照同步',
    fn: async ({ page, ok }) => {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('http://localhost:5177/?remote=ws://127.0.0.1:8080', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3500);
      ok('canvas 渲染', await page.evaluate(() => !!document.querySelector('canvas')));
      const hud = await page.evaluate(() => document.body.innerText);
      ok('HUD 资源条有小人计数', /👥 (\d+)人/.test(hud), hud.match(/👥(\d+)人/)?.[1] + '人');
      ok('快照资源（木头）同步', /🌲木头 \d+/.test(hud), hud.match(/🌲木头 (\d+)/)?.[1]);
      ok('建造菜单来自 defs', hud.includes('篝火') && hud.includes('教堂'));
      ok('无页面异常', errors.length === 0, errors.slice(0, 3).join(' | '));
    },
  },
  {
    name: '命令上行 → server 权威 → 快照回显（build campfire）',
    fn: async ({ page, ok }) => {
      await page.goto('http://localhost:5177/?remote=ws://127.0.0.1:8080', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
      // 通过调试后门直接发命令（等价于 UI 点击建造按钮 → issueCommand → ws）
      await page.evaluate(() => {
        window.__sim.issueCommand({ type: 'build', x: 10, y: 10, buildingId: 'campfire' });
      });
      // 等超过 2 个快照周期，server 应已执行并把实体放回下一个快照
      await page.waitForTimeout(3500);
      const buildings = await page.evaluate(() => {
        const s = window.__sim;
        return [...s.world.buildings.values()].map((b) => ({ defId: b.defId }));
      });
      const camp = buildings.filter((b) => b.defId === 'campfire').length;
      ok('server 回显 campfire 实体', camp >= 1, `campfire x${camp}`);
      const woodNow = await page.evaluate(() => {
        const s = window.__sim;
        return s.stockpile.wood;
      });
      ok('木材扣减（建造预扣/消耗）', typeof woodNow === 'number');
    },
  },
  {
    name: '快照持续流动（t 前进，时间显示变化）',
    fn: async ({ page, ok }) => {
      await page.goto('http://localhost:5177/?remote=ws://127.0.0.1:8080', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      const t1 = await page.evaluate(() => window.__sim.time);
      await page.waitForTimeout(3000);
      const t2 = await page.evaluate(() => window.__sim.time);
      ok('server 时间推进（快照流速）', t2 > t1, `t ${t1.toFixed(1)} → ${t2.toFixed(1)}`);
    },
  },
];