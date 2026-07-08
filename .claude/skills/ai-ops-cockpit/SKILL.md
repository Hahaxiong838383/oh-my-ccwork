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
- 资产页：确认页面文案为“就绪度”，JSON 字段为 `readinessScore`，没有 `healthScore`。
- 只读快照：确认非 `mycc` 真实项目是占位；如要接入，必须先列文件级 allowlist。
- 待办闭环：确认 `/vibe/tasks` 的“转待办”能写入 `/vibe/todos`，只保存脱敏摘要和任务 ID。
- 巡检联动：确认 `/vibe/action/n8n-inspect` 不接收用户正文，不外发 question/answer，只触发内部巡检摘要。
- cron：确认包含 `flock -n /tmp/aiops-readonly-refresh.lock`，避免重叠刷新。
- Git：只 stage AI Ops 相关文件；不要吞 `.claude/skills/evomap-assets/*.json`、`.claude/skills/scheduler/history.md` 等无关脏改。

## 线上部署模板

```bash
rsync -az 2-Projects/ai-ops-cockpit/ops-inspector/server.py racknerd:/opt/ai-ops-cockpit/ops-inspector/server.py
rsync -az 2-Projects/ai-ops-cockpit/scripts/ racknerd:/opt/ai-ops-cockpit/scripts/
ssh racknerd 'cd /opt/ai-ops-cockpit && chmod +x scripts/*.sh && ./scripts/install-readonly-refresh-cron.sh && DOCKER_BUILDKIT=1 docker compose up -d --build ops-inspector && docker compose ps ops-inspector ops-terminal'
```
