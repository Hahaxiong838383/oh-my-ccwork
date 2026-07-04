# P003 生产 nginx 配置（归档）

> 归档自 2026-07-04 记忆 tab 部署排障；生产机 aliyun-hk (8.218.26.17)。

## 文件
- `nginx-real.conf` — `kidshub-ai.hahaxiong.cc` 完整 vhost 快照（root `/opt/p003/web/dist`，`/api/` + `/ws/voice` → `127.0.0.1:3001`）
- `nginx-kidshub-ai-correct.conf` — 同域名另一版本（含 acme-challenge + `/admin/vendor/` 缓存 + `/ws/` 3600s 长连）

## 说明
- ⚠️ 这是 **2026-07-04 的配置快照**，线上真相以生产机 `nginx -T` 为准（配置可能已更新）。
- `kidshub-ai.hahaxiong.cc` 与 `p003.hahaxiong.cc` **共用** `/opt/p003/web/dist` + 3001 后端（pm2 `p003-voice`）。
- 另有个人站入口走 3002（pm2 `kidshub-voice`，精简版），非本配置。
- 完整部署拓扑 + SOP 见 skill `p003-deploy-ops`。
