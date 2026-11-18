# home-studio Xray 双节点分流验收

2026-11-18 20:35（北京时间）。仅调整本机主服务 xray.service，生产代理入口为 127.0.0.1:10808。Air、公司独立中继各自继续运行。

## 生产配置

主节点 admin-LISA-DMIT-11443 使用 131.143.181.60:11443，备节点 admin-ZGO-LISA-12443 使用 38.49.38.237:12443。配置只保留这两个 VLESS 出站以及 direct、block 两个动作。23 条业务规则保留原顺序和匹配条件，13 条代理规则共用同一主备组，10 条直连或拦截规则逐条比对一致。旧控制器定时器已停止并禁用，旧控制器专用的三个探测入站及对应规则已移除。

Xray 使用内置 leastPing，候选列表只有主节点，备节点作为 fallbackTag。burstObservatory 对主节点做端到端探测，生产参数为 30 秒间隔、2 个样本、8 秒超时。切换和回切作用于新连接。隔离测试使用同版 Xray、相同主备和分流配置，加快采样，在测试主节点链路上断开、恢复 TCP 转发。platform.claude.com 在主、备、回主三个阶段均返回 200，日志分别命中预期节点。

## 生产入口逐域名核验

通过本机 10808 请求每个域名，按客户端源端口和目标域名匹配本次 Xray access.log。下表 39 行的实际出站均为 admin-LISA-DMIT-11443。范围包括[官方网络要求](https://code.claude.com/docs/en/network-config#network-access-requirements)中列明的固定主机和两类通配主机的具体样本，并补测本机 CLI 与历史日志中的相关地址。HTTP 为无凭据探测；401、403 等表示对端已返回响应。API 另用 GET /v1/models，返回 401 及 Anthropic 的缺少 API key 错误。

| 域名 | HTTP |
|---|---:|
| `api.anthropic.com` | 405 |
| `claude.ai` | 403 |
| `claude.com` | 200 |
| `platform.claude.com` | 200 |
| `sso.claude.com` | 200 |
| `mcp-proxy.anthropic.com` | 404 |
| `downloads.claude.ai` | 403 |
| `storage.googleapis.com` | 400 |
| `registry.npmjs.org` | 200 |
| `bridge.claudeusercontent.com` | 426 |
| `abc.frame.claudeusercontent.com` | 404 |
| `github.com` | 200 |
| `raw.githubusercontent.com` | 301 |
| `chromium-review.googlesource.com` | 200 |
| `http-intake.logs.us5.datadoghq.com` | 403 |
| `browser-intake-us5-datadoghq.com` | 403 |
| `formulae.brew.sh` | 200 |
| `code.claude.com` | 302 |
| `anthropic.com` | 301 |
| `a-api.anthropic.com` | 403 |
| `assets-proxy.anthropic.com` | 403 |
| `statsig.anthropic.com` | 无响应，公共 DNS 返回 NXDOMAIN |
| `console.anthropic.com` | 301 |
| `docs.claude.com` | 301 |
| `docs.anthropic.com` | 301 |
| `assets.claude.ai` | 403 |
| `support.claude.com` | 302 |
| `status.claude.com` | 200 |
| `releases.claude.com` | 404 |
| `cdn.growthbook.io` | 200 |
| `o1158394.ingest.us.sentry.io` | 404 |
| `sentry.io` | 302 |
| `api.datadoghq.com` | 404 |
| `www.anthropic.com` | 200 |
| `support.anthropic.com` | 301 |
| `slack.mcp.claude.com` | 无响应，公共 DNS 返回 NXDOMAIN |
| `gmail.mcp.claude.com` | 无响应，公共 DNS 返回 NXDOMAIN |
| `gcal.mcp.claude.com` | 无响应，公共 DNS 返回 NXDOMAIN |
| `microsoft365.mcp.claude.com` | 200 |

4 个无 HTTP 响应的域名逐一重试并查询 Google Public DNS，均返回 NXDOMAIN，正对照 api.anthropic.com 返回 A 记录。

## 本机回滚入口

变更前主服务配置保存在 `/usr/local/etc/xray/config.json.bak-before-admin-pair-20261118-203214`（root 独读）。需要恢复时，以 root 将备份按 root:xray、0640 安装回原配置路径，执行 Xray 配置校验，重启 xray.service 后重新启用并启动 lisa-failover-controller.timer。
