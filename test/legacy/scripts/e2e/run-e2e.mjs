// E2E runner（本地 headless，不走 CDP）
// 依赖：WSL 缓存中的 playwright chromium（~/.cache/ms-playwright/chromium-1234/...）
// 用法：先起 dev server（npx vite --port 5174），再 node scripts/e2e/run-e2e.mjs scripts/e2e/mod-ui.mjs
import { chromium } from '/home/lumin/.claude/skills/playwright-test/node_modules/playwright-core/index.mjs';
import { resolve } from 'path';
import { accessSync } from 'fs';

function findChromium() {
  const dirs = [
    '/home/lumin/.cache/ms-playwright/chromium_headless_shell-1234',
    '/home/lumin/.cache/ms-playwright/chromium_headless_shell-1217',
    '/home/lumin/.cache/ms-playwright/chromium-1234',
    '/home/lumin/.cache/ms-playwright/chromium-1217',
  ];
  for (const d of dirs) {
    for (const c of [d + '/chrome-headless-shell-linux64/chrome-headless-shell', d + '/chrome-linux64/chrome', d + '/chrome-linux/headless_shell']) {
      try { accessSync(c); return c; } catch { /* 下一个 */ }
    }
  }
  return null;
}

const testFile = process.argv[2];
const mod = await import(resolve(testFile));
const exe = findChromium();
if (!exe) { console.error('未找到 playwright chromium，先 npx playwright install chromium'); process.exit(1); }
console.log('chromium:', exe);
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

let passed = 0, failed = 0;
for (const test of mod.tests) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  console.log(`\n── ${test.name} ──`);
  const ok = (label, cond, detail) => {
    if (cond) { passed++; console.log(`  [PASS] ${label}${detail ? ' — ' + detail : ''}`); }
    else { failed++; console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); }
  };
  try {
    await test.fn({ page, ok });
  } catch (e) {
    // 环境噪音：dev 阶段外部文件变化会触发 vite full-reload 销毁页面上下文 —— 重试一次
    if (String(e).includes('Execution context was destroyed') || String(e).includes('navigation')) {
      await page.close();
      const retryPage = await ctx.newPage();
      try {
        await test.fn({ page: retryPage, ok });
      } catch (e2) {
        failed++;
        console.log('  [FAIL] 异常:', String(e2).slice(0, 400));
      }
    } else {
      failed++;
      console.log('  [FAIL] 异常:', String(e).slice(0, 400));
    }
  }
  await ctx.close();
}
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
