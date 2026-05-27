# feishu-oauth-sidecar

multica 的飞书 OAuth side-car（Go），通过 HTTP 调用 mini 上已验证的 5 个脚本。

## 启动

```bash
go build -o feishu-oauth-sidecar
PORT=18090 \
SCRIPTS_DIR=~/lark_multi_user \
MAPPING_FILE=~/multica-user-homes/user_mapping.json \
ALLOWED_ORIGINS=* \
./feishu-oauth-sidecar
```

环境变量：

- `PORT`：监听端口，默认 `18090`
- `SCRIPTS_DIR`：脚本目录，默认 `~/lark_multi_user`
- `MAPPING_FILE`：mapping JSON 文件，默认 `~/multica-user-homes/user_mapping.json`
- `USER_HOMES_DIR`：用户 HOME 目录，默认 `dirname(MAPPING_FILE)`
- `ALLOWED_ORIGINS`：CORS 白名单，逗号分隔，默认 `*`

## API

### 1) 发起 Device Flow

```bash
curl -sS -X POST http://127.0.0.1:18090/api/feishu/device/start \
  -H 'Content-Type: application/json' \
  -d '{"multica_user_id":"test-user-001"}' | jq
```

### 2) 完成 OAuth（最多阻塞 200s）

```bash
curl -sS -X POST http://127.0.0.1:18090/api/feishu/device/complete \
  -H 'Content-Type: application/json' \
  -d '{"multica_user_id":"test-user-001","device_code":"<device_code>"}' | jq
```

### 3) 查询绑定状态

```bash
curl -sS "http://127.0.0.1:18090/api/feishu/device/status?multica_user_id=test-user-001" | jq
```

### 4) 健康检查

```bash
curl -sS http://127.0.0.1:18090/healthz | jq
```

## launchd 部署（mini）

1. 构建并部署：

```bash
bash ./deploy-mini.sh
```

2. 查看状态：

```bash
ssh mini 'launchctl print gui/$(id -u)/com.multica.feishu-oauth | head -80'
```

3. 查看日志：

```bash
ssh mini 'tail -n 200 ~/Library/Logs/feishu-oauth-sidecar.log'
```

## 关键实现约束

- stderr 与 stdout 分离捕获，stdout 专用于 JSON 解析。
- 过滤 `[WARN]` / `[lark-cli]` 行，规避 lark-cli proxy 警告污染。
- `start` 30s 超时，`complete` 200s，`status` 10s。
- 每 IP 每分钟 60 次限流。
