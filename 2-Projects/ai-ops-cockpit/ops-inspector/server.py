import html
import json
import os
import shutil
import sqlite3
import subprocess
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

KUMA_DB = os.environ.get("KUMA_DB", "/kuma/kuma.db")
NETDATA = os.environ.get("NETDATA_URL", "http://netdata:19999")
DISPLAY_HOSTNAME = os.environ.get("DISPLAY_HOSTNAME", "racknerd-54aa08d")


def run(cmd):
    return subprocess.check_output(cmd, text=True, timeout=10).strip()


def docker_ps():
    raw = run(["docker", "ps", "--format", "{{json .}}"])
    items = []
    for line in raw.splitlines():
        if line.strip():
            data = json.loads(line)
            if data.get("Names", "").startswith("ops-"):
                items.append({
                    "name": data.get("Names"),
                    "image": data.get("Image"),
                    "status": data.get("Status"),
                    "state": data.get("State"),
                })
    return sorted(items, key=lambda item: item["name"])


def kuma_status():
    conn = sqlite3.connect(KUMA_DB)
    conn.row_factory = sqlite3.Row
    monitors = conn.execute("select id,name,type,url,hostname,port,active from monitor order by id").fetchall()
    rows = []
    for monitor in monitors:
        heartbeat = conn.execute(
            "select status,msg,ping,time from heartbeat where monitor_id=? order by id desc limit 1",
            (monitor["id"],),
        ).fetchone()
        rows.append({
            "id": monitor["id"],
            "name": monitor["name"],
            "type": monitor["type"],
            "target": monitor["url"] or f"{monitor['hostname']}:{monitor['port']}",
            "active": bool(monitor["active"]),
            "status": None if heartbeat is None else heartbeat["status"],
            "statusText": "UP" if heartbeat and heartbeat["status"] == 1 else "DOWN" if heartbeat and heartbeat["status"] == 0 else "UNKNOWN",
            "msg": None if heartbeat is None else heartbeat["msg"],
            "ping": None if heartbeat is None else heartbeat["ping"],
            "time": None if heartbeat is None else heartbeat["time"],
        })
    conn.close()
    return rows


def netdata_chart(chart):
    url = f"{NETDATA}/api/v1/data?chart={chart}&after=-5&before=0&points=1&format=json"
    with urllib.request.urlopen(url, timeout=10) as response:
        data = json.loads(response.read().decode())
    labels = data.get("labels", [])
    values = data.get("data", [[]])[0]
    return dict(zip(labels, values))


def disk_summary():
    disks = []
    for mount in ["/", "/app", "/kuma"]:
        try:
            usage = shutil.disk_usage(mount)
            disks.append({
                "mount": mount,
                "totalGB": round(usage.total / (1024 ** 3), 2),
                "usedGB": round(usage.used / (1024 ** 3), 2),
                "freeGB": round(usage.free / (1024 ** 3), 2),
                "usedPercent": round((usage.used / usage.total) * 100, 1) if usage.total else None,
            })
        except Exception:
            pass
    try:
        docker_df = json.loads(run(["docker", "system", "df", "--format", "json"]).splitlines()[0])
    except Exception:
        docker_df = None
    return {"mounts": disks, "docker": docker_df}


def host_summary():
    load = os.getloadavg()
    ram = netdata_chart("system.ram")
    return {
        "hostname": DISPLAY_HOSTNAME,
        "containerHostname": run(["hostname"]),
        "kernel": run(["uname", "-r"]),
        "load1": round(load[0], 2),
        "load5": round(load[1], 2),
        "load15": round(load[2], 2),
        "ramMB": {key: round(value, 1) for key, value in ram.items() if key != "time"},
        "diskGB": disk_summary(),
    }


def build_report():
    containers = docker_ps()
    monitors = kuma_status()
    host = host_summary()
    unhealthy = [container for container in containers if "Up" not in container["status"]]
    down = [monitor for monitor in monitors if monitor["active"] and monitor["status"] != 1]
    ok = not unhealthy and not down
    lines = []
    lines.append("AI 运维驾驶舱手动巡检")
    lines.append(f"时间：{time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    lines.append(f"结论：{'✅ 正常' if ok else '⚠️ 需要关注'}")
    lines.append("")
    lines.append(f"主机：{host['hostname']} / Kernel {host['kernel']} / Load {host['load1']}, {host['load5']}, {host['load15']}")
    lines.append(f"内存(MB)：used {host['ramMB'].get('used')} / free {host['ramMB'].get('free')} / cached {host['ramMB'].get('cached')}")
    if host["diskGB"].get("mounts"):
        lines.append("磁盘：" + ", ".join(f"{item['mount']} used {item['usedGB']}GB/{item['totalGB']}GB ({item['usedPercent']}%)" for item in host["diskGB"]["mounts"]))
    lines.append("")
    lines.append("Kuma 监控：")
    for monitor in monitors:
        lines.append(f"- {monitor['statusText']} {monitor['name']}：{monitor['msg'] or ''}")
    lines.append("")
    lines.append("容器：")
    for container in containers:
        lines.append(f"- {container['name']}：{container['status']}")
    return {"ok": ok, "host": host, "monitors": monitors, "containers": containers, "text": "\n".join(lines)}


def ai_context():
    report = build_report()
    active_monitors = [monitor for monitor in report["monitors"] if monitor["active"]]
    return {
        "mode": "read_only_ai_ops_assistant_v0",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "guardrails": [
            "只读分析，不执行重启、删除、升级、改配置。",
            "高危动作必须先解释风险、给出命令草案、等待川哥确认。",
            "结论必须基于当前 JSON 数据，不确定就说不确定。",
        ],
        "questionsSupported": [
            "当前有哪些服务异常？",
            "备份是否正常？",
            "这次告警可能是什么原因？",
            "下一步应该先看哪里？",
        ],
        "summary": {
            "ok": report["ok"],
            "host": report["host"],
            "monitorCount": len(active_monitors),
            "downMonitors": [monitor for monitor in active_monitors if monitor["status"] != 1],
            "unhealthyContainers": [container for container in report["containers"] if "Up" not in container["status"]],
        },
        "kumaMonitors": report["monitors"],
        "containers": report["containers"],
        "reportText": report["text"],
    }


def ai_prompt():
    context = json.dumps(ai_context(), ensure_ascii=False, indent=2)
    return """你是川哥的只读 AI 运维助手。请基于下面 JSON 判断当前 ops.hahaxiong.top 运维驾驶舱状态。

要求：
1. 只能分析和建议，不要执行任何命令。
2. 先给一句总判断，再列异常/风险/下一步。
3. 如果一切正常，也要指出最值得持续观察的 1-3 项。
4. 高危动作只能给建议，不要直接要求执行。

当前只读上下文 JSON：
```json
""" + context + "\n```\n"


def send_feishu(report):
    webhook = os.environ.get("FEISHU_WEBHOOK_URL")
    if not webhook:
        raise RuntimeError("FEISHU_WEBHOOK_URL is not configured")
    payload = json.dumps({"msg_type": "text", "content": {"text": report["text"]}}, ensure_ascii=False).encode()
    request = urllib.request.Request(webhook, data=payload, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read().decode("utf-8", "replace")
    return {"status": response.status, "body": body}


def probe_url(url):
    started = time.time()
    with urllib.request.urlopen(url, timeout=10) as response:
        body = response.read(200).decode("utf-8", "replace")
    return {
        "ok": 200 <= response.status < 300,
        "status": response.status,
        "latencyMs": round((time.time() - started) * 1000),
        "bodyPreview": body,
    }


def health_payload(component):
    if component == "ai":
        report = build_report()
        return {
            "ok": report["ok"],
            "component": "ai-ops-cockpit",
            "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
            "monitorCount": len([item for item in report["monitors"] if item["active"]]),
            "containerCount": len(report["containers"]),
            "downCount": len([item for item in report["monitors"] if item["active"] and item["status"] != 1]),
            "unhealthyCount": len([item for item in report["containers"] if "Up" not in item["status"]]),
        }
    if component == "n8n":
        probe = probe_url("http://n8n:5678/healthz")
        return {
            "ok": probe["ok"] and "ok" in probe["bodyPreview"],
            "component": "n8n",
            "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
            "probe": probe,
        }
    return {"ok": False, "component": component, "error": "unknown component"}


def send_daily_feishu():
    report = build_report()
    report = dict(report)
    report["text"] = "AI 运维驾驶舱每日巡检日报\n" + report["text"]
    result = send_feishu(report)
    return {"ok": True, "feishu": result, "report": report}


def answer_question(question):
    question = (question or "").strip()
    context = ai_context()
    lower = question.lower()
    lines = []
    lines.append("只读回答：")
    if not question:
        lines.append("请先输入问题，例如：当前有哪些异常？备份正常吗？")
    elif any(word in question for word in ["异常", "故障", "down", "不正常", "告警"]):
        down = context["summary"]["downMonitors"]
        unhealthy = context["summary"]["unhealthyContainers"]
        if not down and not unhealthy:
            lines.append("当前没有发现 Kuma DOWN 监控，也没有发现非 Up 的 ops 容器。")
        else:
            if down:
                lines.append("DOWN 监控：" + "；".join(f"{item['name']}({item.get('msg') or ''})" for item in down))
            if unhealthy:
                lines.append("异常容器：" + "；".join(f"{item['name']}({item['status']})" for item in unhealthy))
    elif any(word in question for word in ["备份", "myjavis", "backup"]):
        backups = [item for item in context["kumaMonitors"] if "备份" in item["name"] or "MyJavis" in item["name"]]
        if not backups:
            lines.append("当前上下文里没有找到备份类监控。")
        else:
            for item in backups:
                lines.append(f"{item['name']}：{item['statusText']}，最近消息 {item.get('msg') or '无'}，时间 {item.get('time') or '未知'}。")
    elif any(word in question for word in ["磁盘", "disk", "空间"]):
        mounts = context["summary"]["host"].get("diskGB", {}).get("mounts", [])
        if not mounts:
            lines.append("当前没有采集到磁盘数据。")
        else:
            for item in mounts:
                lines.append(f"{item['mount']}：已用 {item['usedGB']}GB / {item['totalGB']}GB，使用率 {item['usedPercent']}%，剩余 {item['freeGB']}GB。")
    elif any(word in question for word in ["内存", "memory", "ram"]):
        ram = context["summary"]["host"].get("ramMB", {})
        lines.append(f"内存：used {ram.get('used')}MB，free {ram.get('free')}MB，cached {ram.get('cached')}MB。")
    elif any(word in question for word in ["容器", "docker", "服务"]):
        for item in context["containers"]:
            lines.append(f"{item['name']}：{item['status']}")
    else:
        lines.append("当前总状态：" + ("正常" if context["summary"]["ok"] else "需要关注"))
        lines.append("建议复制页面里的 Prompt 给 Grok/OMP 做更深入解释；本站内问答 v0 只做规则化只读回答。")
    lines.append("")
    lines.append("安全边界：我没有执行任何命令，也不会自动重启、删除、升级或改配置。")
    return "\n".join(lines)


def render_ai_page():
    context = ai_context()
    status = "正常" if context["summary"]["ok"] else "需要关注"
    status_class = "ok" if context["summary"]["ok"] else "warn"
    prompt = ai_prompt()
    monitor_rows = []
    for monitor in context["kumaMonitors"]:
        row_class = "ok" if monitor["statusText"] == "UP" else "warn"
        monitor_rows.append(
            f"<tr><td>{html.escape(monitor['name'])}</td><td class='{row_class}'>{monitor['statusText']}</td><td>{html.escape(str(monitor.get('msg') or ''))}</td><td>{html.escape(str(monitor.get('time') or ''))}</td></tr>"
        )
    container_rows = []
    for container in context["containers"]:
        container_rows.append(f"<tr><td>{html.escape(container['name'])}</td><td>{html.escape(container['status'])}</td></tr>")
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 运维助手 v0</title><style>
body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1100px;margin:0 auto;padding:32px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:22px;margin:18px 0;box-shadow:0 20px 60px #0005}}h1{{font-size:34px;margin:0 0 8px}}.muted{{color:#94a3b8}}.ok{{color:#22c55e}}.warn{{color:#f59e0b}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263244;padding:10px;text-align:left}}textarea{{width:100%;min-height:360px;background:#020617;color:#d1d5db;border:1px solid #334155;border-radius:12px;padding:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}button,a.btn{{display:inline-block;background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;text-decoration:none;cursor:pointer;margin-right:8px}}code{{background:#020617;padding:2px 6px;border-radius:6px}}</style></head><body><main>
<h1>AI 运维助手 v0</h1><p class="muted">只读上下文 + Grok/OMP 提示词入口。当前不执行任何运维动作。</p>
<section class="card grid"><div><div class="muted">总状态</div><h2 class="{status_class}">{status}</h2></div><div><div class="muted">主机</div><h2>{html.escape(context['summary']['host']['hostname'])}</h2></div><div><div class="muted">Load</div><h2>{context['summary']['host']['load1']} / {context['summary']['host']['load5']} / {context['summary']['host']['load15']}</h2></div><div><div class="muted">监控数</div><h2>{context['summary']['monitorCount']}</h2></div></section>
<section class="card"><h2>怎么用</h2><p>复制下方提示词，粘到本机 <code>Grok</code> 或 <code>OMP</code> 对话里，即可让 AI 基于当前真实状态做只读分析。</p><button onclick="navigator.clipboard.writeText(document.querySelector('textarea').value)">复制提示词</button><a class="btn" href="/ai/context" target="_blank">查看 JSON</a><a class="btn" href="/ai/prompt" target="_blank">纯文本 Prompt</a><a class="btn" href="/ops-health/ai" target="_blank">健康端点</a></section>
<section class="card"><h2>本机 OMP Bridge 自检</h2><p class="muted">用于确认本机一键问 Grok 的桥接服务是否在线。只访问本机 <code>127.0.0.1:18777</code>，不会把凭据发到服务器。</p><button id="checkBridgeBtn">检测 Bridge</button><span id="bridgeStatus" class="muted">尚未检测</span><pre id="bridgeDetail" style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px"></pre></section>
<section class="card"><h2>站内只读问答 v0</h2><p class="muted">规则化问答，不调用模型、不执行命令。可问：当前有哪些异常？备份正常吗？磁盘空间怎么样？</p><input id="q" style="width:70%;padding:10px;border-radius:10px;border:1px solid #334155;background:#020617;color:#e5e7eb" value="当前有哪些异常？"><button onclick="fetch('/ai/ask?q='+encodeURIComponent(document.getElementById('q').value)).then(r=>r.text()).then(t=>document.getElementById('answer').textContent=t)">规则问答</button><pre id="answer" style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px"></pre></section>
<section class="card"><h2>一键问 OMP / Grok</h2><p class="muted">需要本机先启动 OMP Bridge：<code>python3 /Users/rayman.chen/mycc/2-Projects/ai-ops-cockpit/local-omp-bridge/server.py</code>。Bridge 只监听 127.0.0.1，不把 OMP/Grok 凭据放到服务器。</p><input id="grokq" style="width:70%;padding:10px;border-radius:10px;border:1px solid #334155;background:#020617;color:#e5e7eb" value="请分析当前运维状态，并告诉我最应该关注哪三项。"><button id="askGrokBtn">问 OMP/Grok</button><pre id="grokAnswer" style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px"></pre></section>
<section class="card"><h2>推荐本机命令</h2><p class="muted">为减少 Grok 扫描 mycc 大仓库和 MCP 配置噪音，建议先保存 Prompt 到 /tmp，再从 /tmp 运行。</p><pre style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px">curl -u chuan:你的外层密码 https://ops.hahaxiong.top/ai/prompt -o /tmp/ai-ops-prompt.txt
cd /tmp && grok -p "$(cat /tmp/ai-ops-prompt.txt)" --no-subagents --disable-web-search --max-turns 1
cd /tmp && omp --model xai-oauth/grok-4.3 -p "$(cat /tmp/ai-ops-prompt.txt)"</pre></section>
<section class="card"><h2>AI 提示词</h2><textarea readonly>{html.escape(prompt)}</textarea></section>
<section class="card"><h2>Kuma 监控</h2><table><thead><tr><th>名称</th><th>状态</th><th>消息</th><th>时间</th></tr></thead><tbody>{''.join(monitor_rows)}</tbody></table></section>
<section class="card"><h2>容器</h2><table><thead><tr><th>名称</th><th>状态</th></tr></thead><tbody>{''.join(container_rows)}</tbody></table></section>
<script>
async function checkBridge() {{
  const status = document.getElementById('bridgeStatus');
  const detail = document.getElementById('bridgeDetail');
  status.textContent = '检测中...';
  status.className = 'muted';
  try {{
    const response = await fetch('http://127.0.0.1:18777/health');
    const data = await response.json();
    status.textContent = data.ok ? 'Bridge 在线，可一键问 OMP/Grok' : 'Bridge 返回异常';
    status.className = data.ok ? 'ok' : 'warn';
    detail.textContent = JSON.stringify(data, null, 2);
  }} catch (error) {{
    status.textContent = 'Bridge 不在线';
    status.className = 'warn';
    detail.textContent = '请确认本机 LaunchAgent com.ai-ops.omp-bridge 已启动。\\n' + error;
  }}
}}
document.getElementById('checkBridgeBtn').addEventListener('click', checkBridge);
checkBridge();

document.getElementById('askGrokBtn').addEventListener('click', async () => {{
  const answer = document.getElementById('grokAnswer');
  answer.textContent = '正在调用本机 OMP/Grok...';
  try {{
    const response = await fetch('http://127.0.0.1:18777/ask', {{
      method: 'POST',
      headers: {{'content-type': 'application/json'}},
      body: JSON.stringify({{
        question: document.getElementById('grokq').value,
        prompt: document.querySelector('textarea').value
      }})
    }});
    const data = await response.json();
    answer.textContent = data.stdout || data.error || data.stderr || JSON.stringify(data, null, 2);
  }} catch (error) {{
    answer.textContent = '调用失败：请确认本机 OMP Bridge 已启动。\\n' + error;
  }}
}});
</script></main></body></html>""".encode()


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, code, text, content_type="text/plain; charset=utf-8"):
        body = text.encode() if isinstance(text, str) else text
        self.send_response(code)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/health":
                self._send_json(200, {"ok": True})
            elif path == "/summary":
                self._send_json(200, build_report())
            elif path == "/ops-health/ai":
                self._send_json(200, health_payload("ai"))
            elif path == "/ops-health/n8n":
                self._send_json(200, health_payload("n8n"))
            elif path == "/ai/context":
                self._send_json(200, ai_context())
            elif path == "/ai/prompt":
                self._send_text(200, ai_prompt())
            elif path == "/ai/ask":
                from urllib.parse import parse_qs
                question = parse_qs(urlparse(self.path).query).get("q", [""])[0]
                self._send_text(200, answer_question(question))
            elif path in ("/ai", "/ai/"):
                self._send_text(200, render_ai_page(), "text/html; charset=utf-8")
            elif path == "/send-feishu":
                report = build_report()
                result = send_feishu(report)
                self._send_json(200, {"ok": True, "feishu": result, "report": report})
            elif path == "/send-daily-feishu":
                self._send_json(200, send_daily_feishu())
            else:
                self._send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            traceback.print_exc()
            self._send_json(500, {"ok": False, "error": str(exc)})

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
