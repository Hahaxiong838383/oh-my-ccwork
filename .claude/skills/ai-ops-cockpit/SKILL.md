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
for f in 2-Projects/ai-ops-cockpit/scripts/*.sh; do bash -n "$f" || echo "SYNTAX ${f}"; done
```

⚠️ **别写回 `bash -n .../*.sh`**：`bash -n` 只解析第一个文件，其余全变成位置参数
`$1 $2 …`。2026-08-05 在这 14 个脚本上实测——把 `update-omp.sh` 换成语法错文件，
`bash -n scripts/*.sh` 照样 **exit 0**，逐文件循环才抓到。`node --check a.mjs b.mjs`
同坑（`python3 -m py_compile` 反而会全查）——**是不是真批量，每个工具契约不同，
从 `cmd f1 f2` 的外形看不出来**。

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

## Review 清单

- 飞书通知：确认 `notify_text` 不含 `question`、`conversation`、`answer`、异常正文。
- 飞书状态语义：确认维护通道可达性不依赖业务聚合 `ok`；每个业务子项单独显示状态和证据。
- 访客日报：确认使用昨日完整自然日、仅 `human` 聚合；消息里没有 IP、UA、referrer、原始数据库行或被排除流量明细。
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

## EasyTier 组网监控（2026-08-17 接入）

野草云 HK 中继（`207.57.124.191` / 组网 `10.10.10.1`）已交给本驾驶舱值守。
**形式是 aiops 当告警总线，不当探针**——探测留在组网内部，**VPS 上零改动、
本项目代码/Caddy/容器零改动**，只在 Kuma 库里加了两个监控项（数据）。

| Kuma id | 名称 | 类型 |
|---|---|---|
| 17 | EasyTier 中继端口 野草云HK | port `207.57.124.191:443`，interval 60s / retries 2 |
| 18 | EasyTier 组网探针 家侧linux-lan | push，interval 600s / retries 2 |

两条都绑 `notification_id=1`（飞书运维告警）。喂 18 的是 linux-lan 上的
`~/easytier-watch.sh`（cron `*/10`）。**判读必须两条一起看**：
`17🟢 18🔴` = 中继活着但组网坏 **或探针那台机自己坏了**；
`17🔴 18🟢` = 供应商封了 443 但已建立的 p2p 还通。

- ⚠️ **push 路径不带 `/kuma` 前缀**：Caddyfile 的豁免是 `not path /api/push/*`，匹配**原始路径**；
  而 `handle_path /kuma*` 会剥前缀 ⇒ `/kuma/api/push/<token>` 反被网关 401。正确路径会拿到
  Kuma 自己的 `{"ok":false,"msg":"Monitor not found or not active."}`。
  现有其他 push 监控都是 racknerd 本机内部推的，没走过公网，所以这个坑之前没暴露。
- ⚠️ **Kuma 不记录通知发送成败**：全量容器日志里 `Feishu` 出现 **0 次**，
  `notification_sent_history` 只用于证书到期去重。所以「飞书是否送达」服务端**无直接证据**。
  只能：看 heartbeat 的 `important=1`（Kuma 判定状态变更＝触发通知的条件）+ 直接对同一 webhook
  发测试消息验证通道活着。**别把 `important=1` 当"已送达"汇报。**
- Kuma v1 无 monitor CRUD API。用 SQLite 直插时：先 `.backup`，照现有同类型行取字段，
  插完 `docker restart ops-uptime-kuma`，再用 heartbeat 表确认真的产生了心跳（"库里有行"≠"在跑"）。

## ⚠️ 既存故障：IPTV 健康端点空壳 200 + Kuma 假绿（未修）

2026-08-17 接 EasyTier 监控时顺带发现，**与该次改动无关，已存在 12 天**：

- `https://kidshub-ai.hahaxiong.cc/ops-health/iptv` 返回 `200` 但 `Content-Type: text/html`
  ——吐的是 SPA 外壳不是健康 JSON，`jq` 解析不了。
- ⇒ `scripts/validate-vibe-regression.sh` **第 204 行必然失败**（`live.json?id=iptv-api` 的 jq 断言），
  全量回归拿不到 `OK vibe regression`。**在修好前，该脚本对任何改动都会红**，
  别把它当成新改动引入的回归。失败点之前（1–203 行）覆盖的 `/vibe/`、`tasks`、`todos`、
  `assets`、terminal 主流程仍会正常通过，可据此判断主流程是否被碰坏。
- ⇒ **Kuma monitor 12「私人 IPTV M3U 就绪度」却一直 `status=1 "200 - OK"`**——HTTP 型监控
  只看状态码不看载荷，**是个假绿**。真实信号在 monitor 13「私人 IPTV 每日 AI 巡检」，
  最后一次 UP 是 `2026-08-04 19:02`，之后 21 条 DOWN。
- 修的时候**要连 monitor 12 的判据一起改**（加 keyword 或换成 json 断言），
  否则修好了仍然靠假绿判断。

## 线上部署模板

```bash
rsync -az 2-Projects/ai-ops-cockpit/ops-inspector/server.py racknerd:/opt/ai-ops-cockpit/ops-inspector/server.py
rsync -az 2-Projects/ai-ops-cockpit/scripts/ racknerd:/opt/ai-ops-cockpit/scripts/
ssh racknerd 'cd /opt/ai-ops-cockpit && chmod +x scripts/*.sh && ./scripts/install-readonly-refresh-cron.sh && DOCKER_BUILDKIT=1 docker compose up -d --build ops-inspector && docker compose ps ops-inspector ops-terminal'
```
