import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 家长端部署在 /parent/ 子路径（nginx alias），资源引用必须带 /parent/ 前缀，
  // 否则 /assets/* 会被根 location 的 SPA fallback 返回 index.html（白屏）。
  base: '/',  // 2026-08-23 家长端升根路径（p003.hahaxiong.cc 即家长端；/parent/* 由 nginx 301 兼容）
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
