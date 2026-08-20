import { defineConfig } from 'vite';

// 单页入口：主游戏（2026-08-21 从零重写——旧 test/ 已归档为历史参考，不再构建入口）
export default defineConfig({
  server: {
    port: 5173,
    allowedHosts: true, // 代理 Host（wsl-5173.moonchan.xyz）访问放行
  },
  build: {
    target: 'es2022',
  },
});