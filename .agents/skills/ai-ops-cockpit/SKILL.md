---
name: ai-ops-cockpit
description: AI Ops 运维驾驶舱维护指南。适用于 ops.hahaxiong.top、/vibe/、Grok/OMP、只读工作区、Kuma/Netdata/Dockge/n8n、飞书告警、RackNerd 部署与回归验收。触发词："AI Ops"、"ops.hahaxiong.top"、"vibe 工作台"、"发送给 Grok"、"只读快照"、"运维站"
layer: 项目层
authorization: B区（部署/远端变更需明确 scope）
output_levels: L2
---

# AI Ops Cockpit 维护 Skill

## 铁律

1. **不破坏既有功能**：新增功能前后都必须回归 `/vibe/` 的“发送给 Grok”主按钮、`/vibe/tasks`、`/vibe/assets`、`/terminal/`。
2. **secret 不外发**：飞书通知只发状态、模式、任务 ID、耗时和审计入口；禁止发送 question、conversation、answer、错误正文、OAuth URL、Kuma Push URL、Webhook、密码、token。
3. **只读优先**：Grok/OMP 默认只读。真实项目默认只建占位；接入前必须做文件级 allowlist，禁止目录级 `rsync`/`git clone` 整仓暴露。
4. **不要制造假健康**：有限探测只能叫 `readinessScore`/“就绪度”，不能叫“健康分”，也不能用“正常”暗示业务健康。
5. **先验收再通知体验**：本地静态检查 + 线上回归通过后，才告诉川哥体验；未体验 OK 前不 commit/push，除非川哥明确要求。
6. **通道与业务状态分离**：飞书日报的“生产维护通道”只表示限权 SSH/维护调用是否成功，不能复用业务聚合 `ok`。站点进程、实时雷达、Theory Radar、访问统计等子项必须独立展示，避免一个业务异常被误报成通道不可用。
7. **访问统计只发聚合**：个人站日报使用前一完整自然日的 `human` UV/PV；排除 `owner/aiops/prefetch/bot/legacy`，只允许发送日期、UV/PV、人均页数和公开热门路径，禁止发送 IP、UA、referrer 或访问明细。
8. **验收真正消费点**：文件存在、HTTP 200、容器 healthy、模型列表可见都只能算中间证据；必须验证用户实际消费的浏览器页面、终端 TUI、真实模型调用和策略审计记录。
9. **阴性结果必须带正向锚点**：任何“0 泄漏 / 0 错误 / 0 命中 / 全部阻断”前，先证明扫描面非空、测试确实执行、审计记录确实生成；无正向锚点的零结果一律无效。
10. **2GB 主机验收必须分阶段**：`/vibe/` 不得自动加载 `/terminal/`；网页终端最多 1 个客户端。浏览器回归前后必须运行 `scripts/validate-runtime-capacity.sh`，`load1 > 2.50`、`MemAvailable < 300MiB` 或存在活动 OMP 时立即停止，禁止继续叠加真实模型任务。
11. **n8n 内部 POST 的 Origin 必须匹配内部 Host**：请求 `http://ops-inspector:8080/...` 时使用 `Origin: http://ops-inspector:8080`，不能填公网域名；验收必须查询 n8n 最新真实 execution 为 `success`，仅看 workflow active 无效。
12. **飞书成功必须双层判定**：Webhook 只有在 HTTP 为 `2xx` 且响应 JSON 的 `code` 或 `StatusCode` 为 `0` 时才能记为 `sent`；HTTP 200 但业务码非 0、响应不是 JSON、或 Webhook 缺失都必须记为失败。
13. **KPI 日报先给人读懂**：个人站访客日报标题必须明确包含“真实访客”，统计日期、UV、PV、近 7 日与热门页面置于消息前部；`0 UV / 0 PV` 是有效业务结果，不能因数字为零隐藏或误判成任务未执行。
14. **未来时间不能作为正式证据**：若远端主机时间晚于本会话权威日期，未来任务 ID、未来统计日期和未来日志只能用于格式/通道测试，不能证明正式自然日日报；先记录时钟偏差，不擅自修改生产系统时间。
15. **外部发现命令必须有时间边界**：模型发现、网络检索等可能无输出卡住的命令必须设置超时；已有真实模型任务覆盖时，优先使用真实任务结果加确定性配置检查，避免回归脚本无限等待。

## 证书续期专项

- **公网入口与回源证书分开验收**：先用 DNS、Nginx `proxy_pass`、`Host`、TLS SNI 和访问日志确认请求链。浏览器看到的公网证书不等于后端回源证书；两台机器的到期日、renewal 配置和调度器必须分别检查。
- **HTTP-01 必须命中证书所在主机**：域名已经迁到其他节点时，原节点 HTTP-01 必然失败；仍承担 HTTPS 回源时改用限定 Zone 的 DNS-01，废弃链路才清 server block。
- **unit 名不准猜**：先查 `systemctl list-unit-files`、`list-timers` 和 unit 内容。Ubuntu/Debian 常见 `certbot.timer`，其他镜像可能使用 `certbot-renew.timer`；名称不同不等于没有自动续期。
- **IPv6 故障要最小范围修复**：若 Python/urllib3 因不可达 AAAA 卡住而 `curl -4` 正常，只在 Certbot Python 客户端范围内强制 IPv4；不要全局关闭 IPv6，也不要用 AF_INET-only 沙箱阻断 Nginx 的 `[::]` 配置测试。
- **生产验收闭环**：备份必须放在 Nginx include 目录之外；保存全部证书和站点状态基线；依次验证 targeted dry-run、真实续期、新到期日、其他证书不变、`nginx -t`、reload、公网 E2E、timer enabled/active 和最近 service result。

## 必跑检查

```bash
cd /Users/rayman.chen/mycc
python3 -m py_compile 2-Projects/ai-ops-cockpit/ops-inspector/server.py
bash -n 2-Projects/ai-ops-cockpit/scripts/*.sh
```

修改 Python 生成的 HTML/JS 后，必须抽取最终 `<script>`：

```bash
python3 - <<'PY'
import sys
sys.path.insert(0, '2-Projects/ai-ops-cockpit/ops-inspector')
import server
server.vibe_status_payload = lambda: {"ok": True, "sessions": [], "terminal": {"ok": True}, "omp": {"ok": True}}
server.assets_payload = lambda: {"servers":[{"name":"RackNerd","role":"host","status":"UP","readinessScore":100,"risk":"探测项未见异常（非业务健康结论）","containers":1,"maxDiskUsedPercent":1,"monitorsDown":0}],"workspaces":[{"name":"mycc","path":"/workspace/readonly/mycc","status":"ready_readonly","readinessScore":100,"risk":"只读接入可用","details":""}]}
for name, html in {'vibe': server.render_vibe_page(), 'tasks': server.render_vibe_tasks_page()}.items():
    script = html.split('<script>', 1)[1].split('</script>', 1)[0]
    open(f'/tmp/{name}-aiops.js', 'w').write(script)
PY
node --check /tmp/vibe-aiops.js
node --check /tmp/tasks-aiops.js
```

线上回归：

```bash
ssh racknerd 'cd /opt/ai-ops-cockpit && AI_OPS_REGRESSION_SLEEP=22 scripts/validate-vibe-regression.sh'
```

通过标记：`OK vibe regression`。

真实浏览器验收使用可复现包装器，并强制前后检查服务器容量：

```bash
AI_OPS_BROWSER_AUTH_FILE=/tmp/aiops-browser-auth.json \
AI_OPS_CAPACITY_SSH_TARGET=racknerd \
2-Projects/ai-ops-cockpit/scripts/run-browser-acceptance.sh
```

浏览器验收顺序固定为：普通页面 → 单独 `/terminal/` → 确认 OMP 清零 → 任务刷新/终止。不要让网页终端 OMP 与网页任务 OMP 并行。

## Brain / Hands 与策略门专项验收

- **隔离 OMP 配置**：每个独立 agent/profile 除 `models.yml` 外，还必须创建权限 `0600` 的最小 `config.yml`，至少包含 `setupVersion: 1` 与 `startup.setupWizard: false`；最终以真实浏览器终端未进入 Provider Setup Wizard 为准。
- **容器 stdin**：通过 heredoc 向容器内脚本喂输入时，`docker exec` 必须带 `-i`；同时输出执行计数或固定成功锚点，避免“脚本零执行但退出码为 0”的假绿。
- **Inspect 字段语义**：Docker `SecurityOpt` 等字段按语义解析，兼容 `no-new-privileges:true` 这类带状态后缀的实际返回；不要只精确匹配文档示例字符串。
- **真实模型与审计**：真实只读任务必须核对模型输出和 Tool Policy audit 的 `task/project/workflow/tool/decision`；若模型读错路径或审计字段缺失，不能判定通过。
- **策略负向矩阵**：至少覆盖未授权、write、未知项目、未知 workflow、绝对路径、路径穿越、敏感文件、软链接；每项既验拒绝结果，也验对应审计记录。
- **生产一致性**：部署后比较本地与远端核心源码 SHA256；只比镜像标签、文件时间或容器启动时间不足以证明生产代码一致。
- **测试现场清理**：软链接、临时敏感文件和浏览器配置必须使用 trap/finally 清理；secret 临时文件权限必须为 `0600`，结束后复核不存在。
- **资源现场清理**：浏览器关闭后，`ops-terminal` 与 `ops-brain` 中活动 OMP 必须均为 0；只看浏览器成功文案不足以证明子进程已退出。
- **契约值变更要搜索全部消费点**：连接数、阈值、路径或状态语义变化后，必须用 `rg` 搜索实现、回归脚本、自监控、文档中的旧常量；本轮把终端上限从 2 改为 1 后，旧回归仍断言 2，证明只改生产配置会制造测试漂移。
- **n8n 单机导入流程**：普通单机模式不支持 `import:workflow --activeState=fromJson`；使用“停止 n8n → 备份 SQLite/工作流 → import → publish → 启动 n8n”，最终等待真实 cron 触发并查询 `execution_entity` 最新状态。Schedule Trigger 的 CLI 手动 execute 不能替代定时消费点验收。
- **告警返回值按真实协议验收**：飞书通知成功可表现为 HTTP 状态 `200`，重复故障为 `deduped`，并带 `incident/recovery` 事件；不要脆弱断言固定字符串 `sent`。故障、去重、恢复三态都要结合持久化状态与真实返回验证。
- **飞书业务码**：HTTP `2xx` 只是传输成功；必须解析响应 JSON 并确认 `code/StatusCode=0`。无效 JSON、非零业务码、Webhook 缺失都要进入失败状态和测试覆盖。
- **回归脚本阻塞**：禁止把无超时的 `models find`、外部搜索等发现命令放入全量回归关键路径；用真实推理验模型，用 `models.yml` 等确定性来源验配置。

## Review 清单

- 飞书通知：确认 `notify_text` 不含 `question`、`conversation`、`answer`、异常正文。
- 飞书状态语义：确认维护通道可达性不依赖业务聚合 `ok`；每个业务子项单独显示状态和证据。
- 访客日报：确认使用昨日完整自然日、仅 `human` 聚合；消息里没有 IP、UA、referrer、原始数据库行或被排除流量明细。
- 访客日报可读性：确认标题明确、日期和 UV/PV 在前 6 行；零流量仍显示 `0 UV / 0 PV`，不能省略。
- 时间证据：确认任务日期不晚于当前权威日期；若远端时钟超前，相关记录只标为测试证据并单独告知。
- 证书拓扑：确认公网 TLS 终止节点与 HTTPS 回源节点，分别记录证书到期日和自动续期入口。
- 证书调度：以实际 unit/cron 证据为准，至少验证 enabled、active、最近一次退出码和 targeted dry-run。
- 证书隔离：只允许目标 renewal 配置和目标证书变化；其他证书的序列号、到期日和哈希必须与操作前一致。
- CPA/Codex 授权：确认正式 Codex OAuth 授权带 `refresh_token` 时已开启 `auth-auto-refresh-workers`；只记录是否可刷新、服务状态、低成本探测状态，禁止记录 token 正文。
- CPA/Codex 用量：Codex 当前不展示 5 小时额度；`primary_window`/`secondary_window` 只按 `limit_window_seconds` 判定真实周期，菜单栏与告警只使用周额度，禁止按字段槽位硬编码周期名称。
- CPA/xAI 用量：官方费用与预付余额只读 xAI Management API，并隐藏 Management Key；Smart Router `/debug/summary?hours=24` 仅作 provider 级路由观测，`daily_token_limit - tokens_today` 只能叫“路由日预算剩余”，不得冒充官方账单。
- CPA/Codex 充值与重置：巡检只允许读取 `credits`、`rate_limit_reset_credits` 并展示余额/卡数；重置卡属于不可逆消费，AI Ops、Grok、定时任务一律禁止自动调用消费接口。
- CPA/K12：K12 已于 2026-08-12 完全退役；AI Ops 不再暴露 `k12-status` 或 `k12-rotate`，只读快照也不得包含历史 K12 脚本、部署单元或运维文档。若再次发现相关入口，按退役资源残留处理，不能自动恢复。
- CPA 维护通道：安装/权限验收只断言限权命令可达、核心 service/port 正常和模型目录可读；真实推理属于独立业务探针，必须记录状态但不能因上游瞬时 408/5xx 把维护通道安装误判为失败。
- 资产页：确认页面文案为“就绪度”，JSON 字段为 `readinessScore`，没有 `healthScore`。
- 只读快照：确认非 `mycc` 真实项目是占位；如要接入，必须先列文件级 allowlist。
- 待办闭环：确认 `/vibe/tasks` 的“转待办”能写入 `/vibe/todos`，只保存脱敏摘要和任务 ID。
- 状态流转：确认 `/vibe/todos/update` 只允许 `open/doing/done`，且不写入 Grok 原文。
- 待办通知：确认 `/vibe/todos/notify` 只发待办 ID、状态、模式和入口，不发标题/摘要/question/answer。
- 巡检联动：确认 `/vibe/action/n8n-inspect` 不接收用户正文，不外发 question/answer，只触发内部巡检摘要。
- 详情/搜索：确认 `/vibe/todos` 搜索和状态筛选可用，`/vibe/todos/detail?id=...` 只展示脱敏摘要与任务元信息。
- 告警上下文：确认 `/vibe/kuma-context.json` 和 `/vibe/report.json` 可返回 JSON，且不包含 secret/token。
- cron：确认包含 `flock -n /tmp/aiops-readonly-refresh.lock`，避免重叠刷新。
- Git：只 stage AI Ops 相关文件；不要吞 `.claude/skills/evomap-assets/*.json`、`.claude/skills/scheduler/history.md` 等无关脏改。

## 线上部署模板

```bash
rsync -az 2-Projects/ai-ops-cockpit/ops-inspector/server.py racknerd:/opt/ai-ops-cockpit/ops-inspector/server.py
rsync -az 2-Projects/ai-ops-cockpit/scripts/ racknerd:/opt/ai-ops-cockpit/scripts/
ssh racknerd 'cd /opt/ai-ops-cockpit && chmod +x scripts/*.sh && ./scripts/install-readonly-refresh-cron.sh && DOCKER_BUILDKIT=1 docker compose up -d --build ops-inspector && docker compose ps ops-inspector ops-terminal'
```
