import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// HTTPS 必需：手机访问局域网 IP 时，navigator.mediaDevices 仅在
// secure context（HTTPS 或 localhost）下可用。
// VITE_NO_HTTPS=1 时退回 HTTP（localhost 调试/自动化验收用，localhost 本身是 secure context）
const noHttps = process.env.VITE_NO_HTTPS === '1';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: noHttps ? undefined : {},
    proxy: {
      // 把 /ws/voice 代理到本地 server 3001（wss → ws 终结），
      // 避免 HTTPS 页面连 ws:// 触发 mixed content 拦截
      '/ws/voice': {
        // 127.0.0.1 钉死 IPv4（server 端 hostname 0.0.0.0 配对，避免 localhost 双栈解析歧义）
        target: 'ws://127.0.0.1:3001',
        ws: true,
        changeOrigin: true,
      },
      // D6 P1: /api 走后端 server（vision endpoint 等）
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    react(),
    ...(noHttps ? [] : [basicSsl()]),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'K1 生态缸',
        short_name: 'K1',
        description: 'K1 飞船舷窗生态缸 · V1.0 Demo',
        theme_color: '#0a1929',
        background_color: '#0a1929',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2,mp3,ogg}'],
        // D6 P10：川哥手机 PWA SW 缓存旧 JS（P7/P8 版本 reward 路径走 ECO_CHECK
        // 让 legendary 抽中后进生态缸），新 P9 部署后用户感知不到。skipWaiting +
        // clientsClaim 强制新 SW 立即激活并接管所有客户端，下次访问拿最新。
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
