// 自杀式 Service Worker（2026-08-23）：p003.hahaxiong.cc 根路径已由体验台(PWA)换为家长端。
// 旧体验台 SW 在用户浏览器里离线回放旧站；其更新检查拿到本文件后：注销自己+清全部缓存+刷新页面。
// 家长端不使用 SW；本文件必须永久保留在 public/（构建自动带入 dist，防 rsync --delete 清掉）。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
    try { await self.registration.unregister(); } catch {}
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => { try { c.navigate(c.url); } catch {} });
  })());
});
