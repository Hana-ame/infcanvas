import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// 多页入口：主游戏 + test/ 最小核心演示。
// test/index.html 是独立测试页，不修改主游戏逻辑；build 后 dist/test/ 可访问。
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    // 2026-08-20 允许任意 Host 访问（用户经 wsl-5173.moonchan.xyz 代理访问——Vite 默认
    // 只放行 localhost/127.0.0.1，代理 Host 会 403 "Blocked request"）
    allowedHosts: true,
    watch: {
      ignored: ['**/scripts/**', '**/docs/**', '**/README.md'],
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: r('index.html'),
        test: r('test/index.html'),
      },
    },
  },
});
