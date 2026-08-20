// vitest 独立配置（2026-08-21 从零重写）：只跑新 src/，排除旧 test/ 归档
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['test/**', 'node_modules/**'],
  },
});
