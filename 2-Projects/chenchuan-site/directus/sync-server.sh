#!/bin/bash
#
# 轻量 HTTP 同步服务
# 端口 3101，提供一键同步网页 + API
#
# 启动：nohup bash directus/sync-server.sh > /tmp/nas-sync-server.log 2>&1 &
# 停止：kill $(cat /tmp/nas-sync-server.pid)

PORT=3101
PID_FILE="/tmp/nas-sync-server.pid"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMPORT_SCRIPT="$SCRIPT_DIR/import-nas.sh"

echo $$ > "$PID_FILE"
echo "[$(date '+%H:%M')] NAS 同步服务启动 → http://0.0.0.0:$PORT"

# 用 python3 http.server 实现
python3 -c "
import http.server
import json
import subprocess
import urllib.parse
import os

PORT = $PORT
IMPORT_SCRIPT = '$IMPORT_SCRIPT'
NAS_DIR = '/vol1/1000/文件临时缓存'

HTML_PAGE = '''<!DOCTYPE html>
<html>
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<title>NAS 文件同步</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; background: #0e1726; color: #e0e7ef; min-height: 100vh; padding: 24px; }
h1 { font-size: 20px; font-weight: 600; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
.card { background: #172036; border: 1px solid #2a3a5c; border-radius: 10px; padding: 16px; margin-bottom: 12px; }
.card-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #8ab4f8; }
.folder-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #0e1726; border-radius: 6px; margin-bottom: 6px; }
.folder-name { font-size: 14px; }
.folder-count { font-size: 12px; color: #7a8ba8; }
.btn { border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
.btn-sm { padding: 5px 12px; font-size: 12px; }
.btn-primary { background: #3b82f6; color: white; }
.btn-primary:hover { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: wait; }
.btn-full { width: 100%; padding: 12px; font-size: 15px; }
.result { margin-top: 12px; padding: 12px; border-radius: 6px; font-size: 13px; white-space: pre-wrap; max-height: 300px; overflow-y: auto; }
.result.ok { background: #0d2818; border: 1px solid #22543d; color: #68d391; }
.result.err { background: #2d1215; border: 1px solid #c53030; color: #fc8181; }
.result.running { background: #1a1a2e; border: 1px solid #3b82f6; color: #8ab4f8; }
.back { display: inline-block; margin-bottom: 16px; color: #7a8ba8; text-decoration: none; font-size: 13px; }
.back:hover { color: #8ab4f8; }
</style>
</head>
<body>
<a class=\"back\" href=\"http://DIRECTUS_HOST:8055\" target=\"_top\">&larr; 返回 Directus</a>
<h1>&#128193; NAS 文件同步</h1>

<div class=\"card\">
  <div class=\"card-title\">NAS 文件夹</div>
  <div id=\"folders\">加载中...</div>
</div>

<div class=\"card\">
  <button class=\"btn btn-primary btn-full\" id=\"syncAll\" onclick=\"syncAll()\">
    &#128260; 一键同步全部
  </button>
</div>

<div id=\"result\"></div>

<script>
async function loadFolders() {
  const res = await fetch(\"/api/status\");
  const data = await res.json();
  const el = document.getElementById(\"folders\");
  if (!data.folders || data.folders.length === 0) {
    el.innerHTML = \"<p style=color:#7a8ba8>未找到文件夹</p>\";
    return;
  }
  el.innerHTML = data.folders.map(f =>
    \"<div class=folder-row>\" +
      \"<div><span class=folder-name>\" + f.name + \"</span> <span class=folder-count>(\" + f.media + \" 个媒体)</span></div>\" +
      \"<button class=\\'btn btn-primary btn-sm\\' onclick=\\'syncOne(\\\"\" + f.name + \"\\\")\\'>导入</button>\" +
    \"</div>\"
  ).join(\"\");
}

async function syncAll() {
  const btn = document.getElementById(\"syncAll\");
  btn.disabled = true; btn.textContent = \"同步中...\";
  showResult(\"running\", \"正在同步全部文件夹...\");
  try {
    const res = await fetch(\"/api/sync\", { method: \"POST\" });
    const data = await res.json();
    showResult(\"ok\", \"导入: \" + data.imported + \" 个文件\\\\n跳过: \" + data.skipped + \" 个\\\\n\\\\n\" + data.log);
  } catch (e) {
    showResult(\"err\", \"同步失败: \" + e.message);
  }
  btn.disabled = false; btn.textContent = \"\\u{1F504} 一键同步全部\";
  loadFolders();
}

async function syncOne(name) {
  showResult(\"running\", \"正在导入 \" + name + \"...\");
  try {
    const res = await fetch(\"/api/sync?folder=\" + encodeURIComponent(name), { method: \"POST\" });
    const data = await res.json();
    showResult(\"ok\", \"导入: \" + data.imported + \" 个文件\\\\n跳过: \" + data.skipped + \" 个\\\\n\\\\n\" + data.log);
  } catch (e) {
    showResult(\"err\", \"同步失败: \" + e.message);
  }
  loadFolders();
}

function showResult(type, msg) {
  document.getElementById(\"result\").innerHTML = \"<div class=\\'result \" + type + \"\\'>\"+msg+\"</div>\";
}

loadFolders();
</script>
</body>
</html>'''.replace('DIRECTUS_HOST', '192.168.1.115')

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def do_GET(self):
        if self.path == '/' or self.path.startswith('/index'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode())

        elif self.path == '/api/status':
            folders = []
            try:
                for name in sorted(os.listdir(NAS_DIR)):
                    p = os.path.join(NAS_DIR, name)
                    if os.path.isdir(p):
                        exts = {'.mp4','.jpg','.jpeg','.png','.gif','.webp','.pdf','.mov','.avi'}
                        files = [f for f in os.listdir(p) if os.path.splitext(f)[1].lower() in exts]
                        folders.append({'name': name, 'media': len(files)})
            except Exception as e:
                pass
            self.send_json({'folders': folders})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path.startswith('/api/sync'):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            folder = qs.get('folder', [None])[0]

            cmd = ['bash', IMPORT_SCRIPT]
            if folder:
                cmd.append(folder)

            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
                log = result.stdout

                imported = 0
                skipped = 0
                for line in log.split('\n'):
                    if '✓' in line and '导入:' not in line and '登录' not in line:
                        imported += 1
                    if '跳过' in line:
                        skipped += 1

                self.send_json({'status': 'ok', 'imported': imported, 'skipped': skipped, 'log': log})
            except Exception as e:
                self.send_json({'status': 'error', 'message': str(e)}, code=500)
        else:
            self.send_response(404)
            self.end_headers()

    def send_json(self, data, code=200):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

print(f'NAS Sync Server on :{PORT}')
http.server.HTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
"
