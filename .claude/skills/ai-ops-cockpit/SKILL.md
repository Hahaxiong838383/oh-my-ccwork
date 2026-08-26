---
name: ai-ops-cockpit
description: AI Ops 运维驾驶舱维护指南。适用于 ops.hahaxiong.top、/vibe/、Grok/OMP、只读工作区、Kuma/Netdata/Dockge/n8n、飞书告警、RackNerd 部署与回归验收。触发词："AI Ops"、"ops.hahaxiong.top"、"vibe 工作台"、"发送给 Grok"、"只读快照"、"运维站"
layer: 项目层
authorization: B区（部署/远端变更需明确 scope）
output_levels: L2
---

# AI Ops Cockpit 维护 Skill

> ⚠️ 本文件有两份副本：`.claude/skills/`（cc 读）与 `.agents/skills/`（codex + grok 读）。
> **两份必须逐字节相同**，改完用 `diff` 确认。2026-08-17 发现它们已双向分叉数周——
> `.agents/` 那份缺 EasyTier 章节且仍写着已被证伪的 `bash -n *.sh`，`.claude/` 那份缺铁律 8–15。
> 谁都没报错，因为**没有任何机制检查两份是否一致**。

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
16. **红灯先问「这东西还在编制内吗」**：长期 DOWN 的监控有三种可能，不是两种——监控坏了 / 服务坏了 / **被监控对象已被有意退役**。定位第一步是拿「最后一次 UP 的日期」去对齐变更记录与备份目录（`/root/*-decommission-*`），比逐段查探测链路快一个数量级。详见下面 IPTV 一节。

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

- ⚠️ **回归会跟 n8n 的定时巡检抢任务锁**：`chenchuan 09:00 / cpa 09:20 / voice 09:40`（CST）。
  撞上时症状是 `/vibe/task/run` 那条断言失败，长得像功能坏了。起回归前先确认没有在跑的任务
  （`vibe-tasks/*.json` 里 `terminal=false` 的条数为 0），或避开整点后 5 分钟。
- ⚠️ **审计断言的窗口必须先排序再切**：`glob.glob()` 返回**无序**列表（连字典序都不是），
  `glob.glob(...)[-N:]` 等于从 900 多个文件里随机挑 N 个，本轮记录常常不在里面。
  必须 `sorted(..., key=os.path.getmtime)[-N:]`。2026-08-17 修掉两处；两处都印出
  `window=实际/总数 matched=n`，**沉默的窗口就是下一个恒绿点**。

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
- 只读快照源要对撞内容不只对撞条数：`/opt/ai-ops-workspaces/<项目>` 是手工推上去的，会和仓库悄悄分叉。2026-08-17 实测 CPA 那份 5 个文件里 4 个内容不同（只有 `go.mod` 相同），而条数看着正常。逐文件 md5 对撞，别只数个数。
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
  `notification_sent_history` 只用于证书到期去重。所以**逐次**「飞书是否送达」服务端**查不到**。
  只能：看 heartbeat 的 `important=1`（Kuma 判定状态变更＝触发通知的条件）+ 直接对同一 webhook
  发测试消息验证通道活着。**别把单次 `important=1` 当"已送达"汇报。**
  - ✅ **但机制本身已实证通了**（2026-08-17，川哥人工确认收到 3 条飞书：cc 直发的演练标记 1 条
    + Kuma 的 DOWN 1 条 + Kuma 的 recovery 1 条）。⇒ **这套 `push → Kuma → 飞书` 的告警链路是活的，
    不要因为"日志里查不到"就判它不可信、更不要另起炉灶重造**。缺的只是逐次投递回执，
    不是机制。要再验就重跑一次演练+人工确认，这是目前唯一的收口方式。
- Kuma v1 无 monitor CRUD API。用 SQLite 直插时：先 `.backup`，照现有同类型行取字段，
  插完 `docker restart ops-uptime-kuma`，再用 heartbeat 表确认真的产生了心跳（"库里有行"≠"在跑"）。

## 接新监控时顺手普查旧监控（这次因此捞出 13 天的洞）

**加监控项要读 `monitor` 表，读的时候把全表状态一起看完**——2026-08-17 就是因为要建
EasyTier 的两条才去读表，才发现**三条「每日 AI 巡检」长期 DOWN**（最久 13 天没人发现）。
只管自己那两条的话，那个洞会继续躺着。一行就能普查：

```bash
docker exec ops-uptime-kuma sqlite3 /app/data/kuma.db \
 "select case h.status when 1 then '🟢' when 0 then '🔴' else '🟡' end||' '||m.name
  from monitor m join heartbeat h on h.id=(select id from heartbeat where monitor_id=m.id
  order by time desc limit 1) where m.active=1 order by h.status, m.id;"
```

⚠️ **红的要查「最后一次 UP 是什么时候」再定性**，否则分不清「我刚搞坏的」和「早就坏的」：

```bash
... "select m.id, m.name, (select max(time) from heartbeat where monitor_id=m.id and status=1) from monitor m;"
```

## Kuma 监控判据（2026-08-17 收紧）

`type=http` 只看状态码不看载荷，**天然会造假绿**。当时实测 monitor 1「AI 运维驾驶舱 HTTPS」
的载荷是 `{"ok":false,"downCount":3}`，Kuma 却显示 `200 - OK`——驾驶舱自己的健康端点
本该最先报警。已把 1/2/6/14 改成 `type=keyword`：

| id | keyword | 说明 |
|---|---|---|
| 1 | `"component":"ai-ops-cockpit"` | **刻意不断言 `ok:true`**——那会让任一监控挂掉就重复报警、形成自指环路。这条只证明「拿到的是真载荷不是网关/SPA 外壳」 |
| 2 | `<title>陈川 · AI 原生产品负责人` | 同时去掉了原来的 `300-399`（接受 3xx = 跳到任何地方都算 UP） |
| 6 | `"component":"n8n"` | |
| 14 | `OK` | 载荷就是 2 字节 `OK` |

9/10 维持 `["401"]` 不动——鉴权边界的 401 本身已是足够紧的断言。

- 🔴 **keyword 要写 Kuma 匹配那一层的形态，不是 HTTP 字节层**：Kuma 对
  `application/json` 响应会先 `JSON.parse` 再 `JSON.stringify` 回去才做子串匹配，
  **原始空格在这一步被抹掉**。端点吐的是 `"component": "ai-ops-cockpit"`（有空格），
  keyword 必须写 `"component":"ai-ops-cockpit"`（无空格），否则恒红。
  monitor 16 的 `"ok":true` 也是这个缘故。HTML / text 型不经过再序列化，按原样写。
- 改完必须用**重启时刻之后**的心跳验，且正反两侧都要有信号：那轮我先写错了 keyword，
  1/6 打出 `keyword is not in [...]` 而 2/14/16 是 `keyword is found`——这个对照恰好证明
  判据有区分力。全绿而没见过任何一条红，等于没验过。

## IPTV 已退役（2026-08-05 停栈 / 2026-08-17 AI Ops 侧对齐）

IPTV 全栈在 aliyun-hk 上**是被有意停掉的**（腾内存）：`docker` 已 `disabled+inactive`、
`/opt/stacks` 已移除、nginx snippet 已删、无 systemd unit，备份在
`/root/iptv-decommission-20260805/`（含 `99-iptv-payload.tar.gz`）。

而 AI Ops 侧的探针、监控、回归断言当时**没有跟着退**，于是：

- monitor 13「私人 IPTV 每日 AI 巡检」最后一次 UP 是 `2026-08-04 19:02`，**正好是停栈前一天**；
  之后每天 `alert:0/1`。这是真阳性，但指向一个已经不存在的对象。
- monitor 12 却一直 `status=1 "200 - OK"`——`/ops-health/iptv` 原由 snippet `iptv-private.conf`
  的 `location = /ops-health/iptv { alias /var/lib/iptv-aiops/health.json; }` 提供，
  snippet 删掉后请求落到 SPA 兜底，200 + `text/html`。**同一个退役同时制造了一条真红和一条假绿。**
- `validate-vibe-regression.sh` 因此每天必红，**全量回归连续 11 天拿不到 `OK vibe regression`**，
  而这又挡住了它后面所有断言（见下）。

2026-08-17 已按 K12 先例做退役对齐：server.py 清空 `iptv-api` 的 live 探针 / 每日巡检 /
生产通道 / allowlist，n8n `iptv-daily-aiops-0300` 已 unpublish，Kuma 12/13 `active=0`，
`AI_OPS_READONLY_PROJECTS` 去掉 `iptv-api`（`projectCount` 7→6），只读快照移出到
`/root/aiops-readonly-iptv-retired-20260817/`。

- **删断言的同时必须补反向断言**：回归里现在断言 `project.json / live.json / daily.json /
  production.json?id=iptv-api` 全部 404 且 error 文案精确、生产动作端点返 400
  `production action not allowed`。锚是紧邻上方 cpa-smart-router 那组期望非零的断言。
  光删不补 = 下次误恢复没人挡。
- ⚠️ **这些端点对未知项目返回 404，所以不能用 `curl -fsS ... | jq`**（`-f` 会先退出，
  `jq` 根本执行不到）——必须取 `%{http_code}` 再验 body。
- **仍保留未清**：`secrets/iptv-maintenance` 挂载（回归 316/317 断言其存在，且
  `terminal/brain-server.py` 用它做**反向**检查，删了反而变弱）、`/opt/ai-ops-workspaces/iptv-api`
  源目录、仓库 `managed-projects/iptv-api/`。清它们要连带在 aliyun-hk 吊销 `aiops` 密钥，
  属独立的凭据生命周期决定。

## 已知的长期红灯（不是 bug，别去修 AI Ops）

- **monitor 8「个人站每日 AI 巡检」会周期性红**：根因在 aliyun-kr 的 `theory-radar.service`
  ——`RuntimeError: fewer than three arXiv RSS categories were freshly verified`，
  上游 arXiv RSS 抖动触发的 fail-fast 护栏（护栏本身是对的）。2026-07-27~08-17 的 22 天里红了
  6 天。判读方法：看 `latest.json` 的 `production.theoryRadar`，其余子项（process/radar/analytics）
  全绿就说明只是这一项。`theoryRadar.latestPublicReport` 落后当天日期 = 当日报告没发出去。
- 逐段定位一律先读
  `/opt/ai-ops-cockpit/ops-inspector/state/project-daily/<项目>/latest.json`
  和同目录 `jobs/*.json`（保留每日历史，可直接回放哪一段哪天开始断），
  **不要只看 Kuma**——push 心跳的 `msg` 只带 `live.passed/total`，
  `snapshot`/`production`/`task` 哪个失败它一个字都不说，`alert:6/6` 就是这么来的。

## 线上部署模板

```bash
rsync -az 2-Projects/ai-ops-cockpit/ops-inspector/server.py racknerd:/opt/ai-ops-cockpit/ops-inspector/server.py
rsync -az 2-Projects/ai-ops-cockpit/scripts/ racknerd:/opt/ai-ops-cockpit/scripts/
ssh racknerd 'cd /opt/ai-ops-cockpit && chmod +x scripts/*.sh && ./scripts/install-readonly-refresh-cron.sh && DOCKER_BUILDKIT=1 docker compose up -d --build ops-inspector && docker compose ps ops-inspector ops-terminal'
```

## Voice 生产资源实时刷新链（2026-08-26/27）

- **痛点根因**：voice 资源快照此前仅每日 09:40 n8n 巡检采一次（晚上看板还显示早上读数）；且监控对象只有老 `voice-worker`（python 线），rust 主力线完全不在名单；`project-production/.../latest.json` 曾停更一个月。
- **链路**：racknerd cron `*/5`（`/usr/local/bin/aiops-voice-refresh.sh`，flock 防重叠）→ inspector API `POST /vibe/project/production/action`（容器内 token=env `OPS_READ_TOKEN`，头 `x-aiops-read-token`，**Origin 必须带且匹配内部 Host**——教训#11 同款）→ 受限 ssh → 64.90 `/usr/local/sbin/aiops-voice-worker-control inspect` → 落 `state/project-production/realtime-voice-agent/latest.json`（恒 ≤5min 新鲜）。
- **新字段**：`rustMemory{currentMB,peakMB,highMB,maxMB}`（cgroup 四元组，High=软压线回收不杀/Max=硬杀线；判读：接近 High 先查 64.90 `memory.events` 的 high 计数，0=线从未绑定）+ `services.voice-worker-rust` + `okRust` + `logs.warning24hRust`。
- **三跳白名单铁律**：改 64.90 采集端后，racknerd `server.py` 的 `sanitize_production_inspection` 是第二跳白名单（services 元组+字段级），漏加=新字段静默丢；**server.py 是 `build: ./ops-inspector` 进镜像的——rsync 后必须 `docker compose build ops-inspector && up -d`，光 restart 不换代码**。
- 64.90 采集端备份：`aiops-voice-worker-control.bak-20260826-pre-rust`。老 python 线退役时：control 脚本老段一起摘 + **:8081 探针挂在老进程上会一起消失**（live check 会红，先给探针搬家）。
