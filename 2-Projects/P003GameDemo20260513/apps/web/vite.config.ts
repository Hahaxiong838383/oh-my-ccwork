import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// HTTPS 必需：手机访问局域网 IP 时，navigator.mediaDevices 仅在
// secure context（HTTPS 或 localhost）下可用。
// VITE_NO_HTTPS=1 时退回 HTTP（localhost 调试/自动化验收用，localhost 本身是 secure context）
const noHttps = process.env.VITE_NO_HTTPS === '1';

// 个人站部署目标（my.chenchuan.cc/kidshub-ai/）：
// - VITE_PUBLIC_BASE 指定子路径 base（默认 '/' = 公司侧独立域名部署，行为不变）
// - VITE_DISABLE_PWA=1 关掉 SW——挂在别人家域名路径下时 PWA SW 会与宿主站
//   （Next.js 个人站）抢缓存/钉旧版，且 demo 不需要离线能力
const publicBase = process.env.VITE_PUBLIC_BASE ?? '/';
const disablePwa = process.env.VITE_DISABLE_PWA === '1';

export default defineConfig({
  base: publicBase,
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
    ...(disablePwa ? [] : [VitePWA({
      registerType: 'autoUpdate',
      // 不自动注入注册脚本；改由 main.tsx 按入口条件注册：/m 原生壳不注册 SW（根治 WebView SW 缓存旧版反复踩）。
      injectRegister: false,
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
        // 体验台主 bundle 含场景美术等 >2MB（火山 RTC SDK 已动态 code-split 成独立 chunk，仅 /m 进房按需加载）；
        // 提高 SW precache 单文件上限，避免 build 因超默认 2MB 失败。mobile(/m)禁 SW，不受影响。
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        // /admin 后台原型子站与主应用 SW 完全隔离：不预缓存其资产（vendor 共
        // ~3MB 且独立迭代），导航也不走 SPA fallback——否则原型更新后用户会被
        // SW 钉在旧版（D6 P10 同款坑），离线时 /admin 还会被劫持成 React 页。
        globIgnores: ['admin/**', 'parent/**'],
        navigateFallbackDenylist: [/^\/admin/, /^\/parent/],
        // D6 P10：川哥手机 PWA SW 缓存旧 JS（P7/P8 版本 reward 路径走 ECO_CHECK
        // 让 legendary 抽中后进生态缸），新 P9 部署后用户感知不到。skipWaiting +
        // clientsClaim 强制新 SW 立即激活并接管所有客户端，下次访问拿最新。
        skipWaiting: true,
        clientsClaim: true,
      },
    })]),
  ],
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
