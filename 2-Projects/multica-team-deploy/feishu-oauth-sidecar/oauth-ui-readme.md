# OAuth UI 说明

## 功能
- 新增 `GET /oauth-ui`：返回内嵌静态页面（`oauth-ui.html`）
- 页面调用既有接口：
  - `POST /api/feishu/device/start`
  - `GET /api/feishu/device/status?multica_user_id=...`
- 支持 `?multica_user_id=` 自动发起授权流程

## 部署
1. 在 `feishu-oauth-sidecar` 目录执行：
```bash
go build ./...
go test ./...
bash deploy-mini.sh
```
2. 验证：
```bash
curl -i http://mini:18090/oauth-ui
```

## Nginx 反代示例（HK relay）
```nginx
location = /oauth-ui {
    proxy_pass http://mini:18090/oauth-ui;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 用法
- 手动输入用户 ID：
  `https://multica.cli4.hahaxiong.cc/oauth-ui`
- 预填并自动开始：
  `https://multica.cli4.hahaxiong.cc/oauth-ui?multica_user_id=user-123-abc`
