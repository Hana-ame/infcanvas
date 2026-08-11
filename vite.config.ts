import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    watch: {
      ignored: ['**/scripts/**', '**/docs/**', '**/README.md'],
    },
  },
  build: {
    target: 'es2022',
  },
});
