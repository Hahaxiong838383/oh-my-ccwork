# HK 公网 nginx 配置镜像

> 阿里云 HK 8.218.26.17 上 nginx 配置的代码仓镜像。**真源**在 `aliyun-hk:/etc/nginx/sites-available/multica`,本目录是只读快照 + 变更历史。

## 文件

| File | Mapping |
|------|---------|
| `multica.cli4.hahaxiong.cc.conf` | aliyun-hk:/etc/nginx/sites-available/multica |

## 部署/修改流程

```bash
# 1. 改 → 备份 → 替换 → 测 → reload
ssh aliyun-hk 'sudo cp /etc/nginx/sites-available/multica /etc/nginx/sites-available/multica.bak.$(date +%s)'
# (用 awk/sed/scp 修改)
ssh aliyun-hk 'sudo nginx -t' && ssh aliyun-hk 'sudo systemctl reload nginx'

# 2. 同步回仓
ssh aliyun-hk 'cat /etc/nginx/sites-available/multica' > nginx-relay/multica.cli4.hahaxiong.cc.conf
git add nginx-relay/ && git commit -m "ops(nginx): ..."

# 3. 公网验证
curl -sS -o /dev/null -w "%{http_code}\n" https://multica.cli4.hahaxiong.cc/<path>
```

## 主要路由

```
公网 multica.cli4.hahaxiong.cc (443 HTTPS, Let's Encrypt)
  ├── /settings       → 127.0.0.1:18890 (mini sidecar /oauth-ui 别名, V4 新增)
  ├── /oauth-ui       → 127.0.0.1:18890 (mini sidecar 飞书扫码 UI)
  ├── /api/feishu/    → 127.0.0.1:18890 (mini sidecar API: device flow + force-restart)
  ├── /api/daemon/ws  → 127.0.0.1:18443 (FRP → mini frpc → QNAP backend WS)
  ├── /api/daemon/*   → 同上 (REST)
  ├── /api/*          → 127.0.0.1:18080 (FRP → mini frpc → QNAP frontend 反代 backend)
  ├── /auth/*         → 同上
  ├── /ws             → 同上
  ├── /uploads/*      → 同上
  └── /*              → 同上 (Next.js standalone frontend)
```

## 变更历史

- 2026-05-27 21:31: 加 `/oauth-ui` + `/api/feishu/` 反代 mini sidecar (B 路径 oauth-ui 上线)
- 2026-05-30 16:42: 加 `/settings` 别名(V4 force-restart 配套)
