// vitest 独立配置（2026-08-21 从零重写）：只跑新 src/，排除旧 test/ 归档
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['test/**', 'node_modules/**'],
    // 全局 setup：给 node 20 补上 WebSocket（见 setup.ts 里的说明）。
    setupFiles: ['src/__tests__/setup.ts'],
  },
});