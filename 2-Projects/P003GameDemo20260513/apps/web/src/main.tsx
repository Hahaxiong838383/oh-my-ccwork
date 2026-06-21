import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { KidsHubApp } from './kidshub/KidsHubApp';
import { MobileApp } from './mobile/MobileApp';
import './styles.css';

// 工作台分流：/kidshub-ai 路径，或 kidshub* 专属域名根路径直接进工作台
// （裸连入口 + CF 橙云入口共用同一份 dist）；其余 = 原 demo 域名（不受影响）。
// VITE_KIDSHUB_PUBLIC=1（个人站 my.chenchuan.cc/kidshub-ai/ 部署目标）时
// 构建期钉死工作台分支，不依赖运行时 host/path 判断。
const isKidsHub =
  import.meta.env.VITE_KIDSHUB_PUBLIC === '1' ||
  window.location.pathname.startsWith('/kidshub-ai') ||
  window.location.hostname.startsWith('kidshub');

// 移动端 App（原生壳 WebView / 手机浏览器）：/m 路径优先分流，复用工作台同一份 dist
const isMobileApp = window.location.pathname.startsWith('/m');

// PWA Service Worker 注册策略（根治 WebView SW 缓存旧版 —— D6P10 + P2 反复踩的"老样子"）：
// - /m（原生壳 / 移动在线）：不注册 SW + 注销历史 SW + 清 caches，确保每次加载拿最新（壳是单一在线目标，无需离线缓存）。
// - 其余（工作台 / demo 浏览器）：注册 SW 保留 PWA（autoUpdate + skipWaiting 处理浏览器更新）。
if (isMobileApp) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => {});
  }
  if (typeof caches !== 'undefined') {
    caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
  }
} else {
  import('virtual:pwa-register')
    .then(({ registerSW }) => registerSW({ immediate: true }))
    .catch(() => {});
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isMobileApp ? <MobileApp /> : isKidsHub ? <KidsHubApp /> : <App />}
  </React.StrictMode>,
);
