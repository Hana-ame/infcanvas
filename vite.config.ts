import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// 多页入口：主游戏 + test/ 最小核心演示。
// test/index.html 是独立测试页，不修改主游戏逻辑；build 后 dist/test/ 可访问。
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
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
