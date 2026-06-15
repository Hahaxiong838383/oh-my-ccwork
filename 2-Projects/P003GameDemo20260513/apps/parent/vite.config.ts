import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5174,
    proxy: {
      // 家长端建档/配网走后端 server（默认 8787）；本地用 PORT 覆盖时同步改 target
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
