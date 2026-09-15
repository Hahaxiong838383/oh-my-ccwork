# CPA Menu

macOS 顶部菜单栏中的 CPA 账号与用量状态工具。

当前版本：`0.3.7`。

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
- xAI 页面分别显示两个 OAuth 订阅账号的官方周额度、重置时间、Build/Chat/Imagine 分项、额外用量状态，以及今日请求、Token、成功率、最近使用、主要模型和授权刷新状态。
- xAI 总览只保留一条“订阅池平均剩余”进度条，按已同步订阅账号等权计算，并同时显示最低账号余量和最近重置时间；Management API 账单与 CPA 路由只显示紧凑指标，不再各自模拟额度。
- 账号级订阅额度读取 xAI CLI Billing；CPA Token、内部日预算和 Management API 团队账单继续分层展示，不再互相冒充。接口缺少百分比但明确返回空周周期时，会标记“暂无计量，按 0% 已用显示”。
- 显示充值余额与重置卡数量；只要官方 `available_count` 大于 0 即允许经过二次确认发起使用，最终按官方返回的 `reset`、`nothing_to_reset`、`no_credit` 或 `already_redeemed` 显示结果。
- 标记账号是否具备 refresh token；CLIProxyAPI 继续负责正常的 access token 自动刷新与调度。
- “添加订阅”统一提供 Codex 与 xAI Grok 两种 OAuth 登录；Codex 保留 PKCE 回调，xAI 使用官方设备码流程并自动轮询完成状态。
- 对已停用、无刷新能力且已过期、或上游明确返回 401/403 的账号显示“移除无效账号”；App 经过 destructive 二次确认，Bridge 再实时校验后把 auth JSON 原子移动到 `/root/.cli-proxy-api-removed/<UTC时间>/`，不会永久删除凭据。
- xAI 设备码只在当前授权弹层短时显示，可复制或重新打开 `accounts.x.ai`，不会写入 Keychain、UserDefaults、磁盘或普通日志。
- 最终授权结果仍由 CLIProxyAPI 官方流程写入生产 auth-dir，CPA Menu 和 Bridge 不自行保存 xAI OAuth 凭据。
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
  ├─ 使用每张 xAI OAuth 查询 CLI Billing 周额度、产品分项与额外用量
  ├─ 可选读取 /etc/xai-management.env，查询 xAI API 官方团队账单与预付余额
  ├─ 使用 /etc/cpa-smart-router.env 中的现有本地访问密钥只读查询 /debug/summary
  ├─ 代理 CLIProxyAPI Management xAI 设备码登录，只返回授权所需白名单字段
  └─ Codex OAuth 完成时原子写入 auth JSON；xAI auth 文件由 CLIProxyAPI 官方流程写入
```

Bridge 不返回 access token、refresh token、ID token、Management Key、完整邮箱或 account ID；用量响应采用固定结构并只公开金额、聚合 Token 和状态。CLIProxyAPI Management Key 与 xAI Management Key 都只从远端 `0600` 文件读取，不写入日志或接口响应；usage queue 中的 API Key、Token 指纹、IP、User-Agent、原始错误正文和响应 Header 会在持久化前丢弃。

CLIProxyAPI 请求统计配置位于 `/etc/cpa-cliproxy-management.env`：

```dotenv
CPA_CLIPROXY_MANAGEMENT_KEY=<CLIProxyAPI Management Key>
```

聚合状态写入 `/var/lib/cpa-desktop-bridge/usage.json`，仅保留最近 8 天的小时桶。浮窗展示当天 Codex 汇总，并按 CLIProxyAPI auth index 将 xAI 请求归属到对应 OAuth 账号。

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
- xAI 授权 URL 必须是 `https://accounts.x.ai`，设备码和临时 state 不持久化；Bridge 不透传上游错误正文。
- 重置卡属于不可逆消耗操作：App 二次确认，Bridge 再校验固定确认词与实时 `available_count > 0`；只有官方返回 `reset` 才提示已扣卡，`nothing_to_reset` 必须明确提示未消耗。
- 无效账号移除必须使用固定确认词 `REMOVE_INVALID_ACCOUNT`；低额度、429、网络错误和健康账号不得移除。隔离目录权限为 `0700`、文件为 `0600`，Bridge 不返回真实文件名或路径。
- auth 文件通过同目录临时文件、`0600` 权限和原子 rename 更新，并保留账号原有 `priority`、`excluded-models`、`prefix`、`proxy_url` 字段。
