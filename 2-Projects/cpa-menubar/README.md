# CPA Menu

macOS 顶部菜单栏中的 CPA 账号与用量状态工具。

当前版本：`0.3.1`。

## 当前能力

- 显示 CLIProxyAPI 与 Smart Router 在线状态。
- 浮窗固定为紧凑尺寸，顶部使用“总览 / 账号 / xAI”分区，内容区域独立滚动，不再随账号数量增长。
- 账号页支持“全部 / Plus / K12 / 异常”筛选，异常与低额度账号优先，并可展开查看充值余额和重置卡操作。
- 显示 Codex/XAI 账号数量、脱敏邮箱、套餐、每周剩余额度和重置倒计时；Codex 当前无 5 小时限制，因此隐藏短周期进度条。
- 显示 `cpa-key-policy` API Key 的美元剩余额度；日限额与周限额分别扣除插件原生账本费用后，取两者较小值作为当前真实可用余额。
- 显示 Codex 今日请求数、Token、成功率、平均延迟、首字延迟、推理/缓存 Token，以及 Fast 请求与上游实际命中比例。
- 账号展开区域显示该账号今日请求、Token、最后使用时间、Fast 命中和最近 HTTP 错误；账号关联只使用 CLIProxyAPI 的稳定 auth index，客户端不会收到原始索引。
- 优先通过 xAI Management API 显示本月官方费用、预付余额和查询完整性状态；Management Key 与普通推理/OAuth 凭据分离。
- 同时显示 xAI 经 CPA Smart Router 的近 24 小时请求数、成功率、输入/输出/总 Token，以及内部路由日预算；CPA 数据只用于运维观测，不冒充官方账单。
- 显示充值余额与重置卡数量；仅当官方接口返回可用且适用的重置卡时，才允许经过二次确认消耗 1 张。
- 标记账号是否具备 refresh token；CLIProxyAPI 继续负责正常的 access token 自动刷新与调度。
- 从菜单栏启动 Codex PKCE 登录，授权结果直接写入生产 auth-dir。
- Desktop Token 只保存在远端 `0600` 文件和本机 macOS Keychain。
- 支持 1–30 分钟自动刷新和 macOS 原生开机启动。

## 架构

```text
CPA Menu.app
  ├─ Keychain: Desktop Token
  ├─ HTTPS /desktop/v1/*
  └─ localhost:1455 OAuth callback
          │
          ▼
smart-api.hahaxiong.top / nginx
          │
          ▼
cpa-desktop-bridge :8330
  ├─ 只读扫描 /root/.cli-proxy-api/*.json
  ├─ 使用 access token 查询 wham/usage
  ├─ 每 5 秒读取 CLIProxyAPI 本地 usage queue，脱敏后按小时持久化
  ├─ 可选读取 /etc/xai-management.env，查询 xAI 官方团队账单与预付余额
  ├─ 使用 /etc/cpa-smart-router.env 中的现有本地访问密钥只读查询 /debug/summary
  └─ 仅在 OAuth 完成时原子写入对应 auth JSON
```

Bridge 不返回 access token、refresh token、ID token、Management Key、完整邮箱或 account ID；用量响应采用固定结构并只公开金额、聚合 Token 和状态。CLIProxyAPI Management Key 与 xAI Management Key 都只从远端 `0600` 文件读取，不写入日志或接口响应；usage queue 中的 API Key、Token 指纹、IP、User-Agent、原始错误正文和响应 Header 会在持久化前丢弃。

CLIProxyAPI 请求统计配置位于 `/etc/cpa-cliproxy-management.env`：

```dotenv
CPA_CLIPROXY_MANAGEMENT_KEY=<CLIProxyAPI Management Key>
```

聚合状态写入 `/var/lib/cpa-desktop-bridge/usage.json`，仅保留最近 8 天的小时桶。浮窗当前展示当天 Codex 汇总；xAI 请求级明细暂不接入该视图。

可选的官方账单配置位于 `/etc/xai-management.env`：

```dotenv
XAI_MANAGEMENT_API_KEY=<xAI Console 创建的 Management Key>
XAI_TEAM_ID=<xAI Team ID>
```

未配置时，浮窗会明确显示“官方账单未接入”，并继续展示 CPA 路由统计，不再把路由预算当作官方剩余量。

## 构建与测试

```bash
cd bridge && go test ./... && go vet ./...
cd ../app && swift test && ./scripts/build-app.sh
```

构建产物位于 `app/dist/CPA Menu.app`。`dist/` 和 Swift/Go 构建缓存不应提交。

## 部署

```bash
bridge/deploy/deploy.sh aliyun-jp
app/scripts/configure-production.sh aliyun-jp
app/scripts/install-app.sh
```

部署脚本会保留已有 Desktop Token；首次部署才生成随机 Token。Nginx 原站点配置会备份为 `smart-api.before-cpa-desktop-bridge`，并只新增 `/desktop/v1/` 路由。

## 回滚

```bash
ssh aliyun-jp 'systemctl disable --now cpa-desktop-bridge; rm -f /etc/systemd/system/cpa-desktop-bridge.service; systemctl daemon-reload'
```

移除 `/etc/nginx/sites-enabled/smart-api` 中的 Bridge include 后执行 `nginx -t && systemctl reload nginx`。本机删除 `/Applications/CPA Menu.app`，并在应用设置中先清除 Keychain Token。

## 安全边界

- 不把 Desktop Token、OAuth token、邮箱明文写入 Git、文档、日志或通知。
- Bridge 只监听 `127.0.0.1:8330`，公网入口必须走现有 HTTPS。
- CLIProxyAPI usage queue 只由 Bridge 在本机读取；原始记录不会经公网接口返回。
- OAuth state 与 PKCE verifier 只存在于 Bridge 内存，5 分钟过期。
- 重置卡属于不可逆消耗操作：App 二次确认，Bridge 再校验固定确认词与 `applicable_available_count > 0`。
- auth 文件通过同目录临时文件、`0600` 权限和原子 rename 更新，并保留账号原有 `priority`、`excluded-models`、`prefix`、`proxy_url` 字段。
