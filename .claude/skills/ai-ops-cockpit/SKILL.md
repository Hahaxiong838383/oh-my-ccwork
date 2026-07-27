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

## Review 清单

- 飞书通知：确认 `notify_text` 不含 `question`、`conversation`、`answer`、异常正文。
- 飞书状态语义：确认维护通道可达性不依赖业务聚合 `ok`；每个业务子项单独显示状态和证据。
- 访客日报：确认使用昨日完整自然日、仅 `human` 聚合；消息里没有 IP、UA、referrer、原始数据库行或被排除流量明细。
- CPA/Codex 授权：确认正式 Codex OAuth 授权带 `refresh_token` 时已开启 `auth-auto-refresh-workers`；只记录是否可刷新、服务状态、低成本探测状态，禁止记录 token 正文。
- CPA/Codex 用量：Codex 当前不展示 5 小时额度；`primary_window`/`secondary_window` 只按 `limit_window_seconds` 判定真实周期，菜单栏与告警只使用周额度，禁止按字段槽位硬编码周期名称。
- CPA/xAI 用量：官方费用与预付余额只读 xAI Management API，并隐藏 Management Key；Smart Router `/debug/summary?hours=24` 仅作 provider 级路由观测，`daily_token_limit - tokens_today` 只能叫“路由日预算剩余”，不得冒充官方账单。
- CPA/Codex 充值与重置：巡检只允许读取 `credits`、`rate_limit_reset_credits` 并展示余额/卡数；重置卡属于不可逆消费，AI Ops、Grok、定时任务一律禁止自动调用消费接口。
- CPA/K12：若 `k12-status` 显示激活数为 0，不要误判为调度故障；先查 `last-report.after_total_k12`、`k12-pool`、源包 JWT 过期情况。无 `refresh_token` 的 K12 源包无法 OAuth 续期。
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
