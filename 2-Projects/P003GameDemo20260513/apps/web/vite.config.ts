import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// HTTPS 必需：手机访问局域网 IP 时，navigator.mediaDevices 仅在
// secure context（HTTPS 或 localhost）下可用。
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: {},
    proxy: {
      // 把 /ws/voice 代理到本地 server 3001（wss → ws 终结），
      // 避免 HTTPS 页面连 ws:// 触发 mixed content 拦截
      '/ws/voice': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  plugins: [
    react(),
    basicSsl(),
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
      },
    }),
  ],
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
