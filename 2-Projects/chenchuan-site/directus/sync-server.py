#!/usr/bin/env python3
"""
NAS 文件同步服务 — 端口 3101
提供网页面板 + API，一键从 NAS 导入文件到 Directus
"""

import http.server
import json
import subprocess
import urllib.parse
import os
import sys

PORT = 3101
NAS_DIR = '/vol1/1000/文件临时缓存'
IMPORT_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'import-nas.sh')
MEDIA_EXTS = {'.mp4', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.mov', '.avi'}

HTML = r"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NAS 文件同步</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0e1726;color:#e0e7ef;min-height:100vh;padding:24px}
h1{font-size:20px;font-weight:600;margin-bottom:20px}
.card{background:#172036;border:1px solid #2a3a5c;border-radius:10px;padding:16px;margin-bottom:12px}
.card-title{font-size:14px;font-weight:600;margin-bottom:12px;color:#8ab4f8}
.folder-row{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#0e1726;border-radius:6px;margin-bottom:6px}
.folder-name{font-size:14px;font-weight:500}
.folder-count{font-size:12px;color:#7a8ba8;margin-left:8px}
.btn{border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.2s}
.btn-sm{padding:5px 12px;font-size:12px}
.btn-primary{background:#3b82f6;color:white}
.btn-primary:hover{background:#2563eb}
.btn-primary:disabled{opacity:0.5;cursor:wait}
.btn-full{width:100%;padding:12px;font-size:15px}
.result{margin-top:12px;padding:12px;border-radius:6px;font-size:13px;white-space:pre-wrap;max-height:300px;overflow-y:auto}
.result.ok{background:#0d2818;border:1px solid #22543d;color:#68d391}
.result.err{background:#2d1215;border:1px solid #c53030;color:#fc8181}
.result.running{background:#1a1a2e;border:1px solid #3b82f6;color:#8ab4f8}
.back{display:inline-block;margin-bottom:16px;color:#7a8ba8;text-decoration:none;font-size:13px}
.back:hover{color:#8ab4f8}
</style></head><body>
<a class="back" href="http://192.168.1.115:8055">&larr; 返回 Directus</a>
<h1>NAS 文件同步</h1>
<div class="card">
  <div class="card-title">NAS 文件夹</div>
  <div id="folders">加载中...</div>
</div>
<div class="card">
  <button class="btn btn-primary btn-full" id="syncAll" onclick="syncAll()">一键同步全部</button>
</div>
<div id="result"></div>
<script>
async function loadFolders(){
  const r=await fetch("/api/status");const d=await r.json();const el=document.getElementById("folders");
  if(!d.folders||d.folders.length===0){el.innerHTML="<p style='color:#7a8ba8'>未找到文件夹</p>";return}
  el.innerHTML=d.folders.map(f=>"<div class='folder-row'><div><span class='folder-name'>"+f.name+"</span><span class='folder-count'>("+f.media+" 个媒体)</span></div><button class='btn btn-primary btn-sm' onclick='syncOne(\""+f.name+"\")'>导入</button></div>").join("")}
async function syncAll(){
  const b=document.getElementById("syncAll");b.disabled=true;b.textContent="同步中...";showResult("running","正在同步...");
  try{const r=await fetch("/api/sync",{method:"POST"});const d=await r.json();showResult("ok","导入: "+d.imported+" 个\n跳过: "+d.skipped+" 个\n\n"+d.log)}
  catch(e){showResult("err","失败: "+e.message)}
  b.disabled=false;b.textContent="一键同步全部";loadFolders()}
async function syncOne(name){
  showResult("running","正在导入 "+name+"...");
  try{const r=await fetch("/api/sync?folder="+encodeURIComponent(name),{method:"POST"});const d=await r.json();showResult("ok","导入: "+d.imported+" 个\n跳过: "+d.skipped+" 个\n\n"+d.log)}
  catch(e){showResult("err","失败: "+e.message)}
  loadFolders()}
function showResult(t,m){document.getElementById("result").innerHTML="<div class='result "+t+"'>"+m+"</div>"}
loadFolders()
</script></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path == '/' or self.path.startswith('/index'):
            self._html(HTML)
        elif self.path == '/api/status':
            folders = []
            try:
                for name in sorted(os.listdir(NAS_DIR)):
                    p = os.path.join(NAS_DIR, name)
                    if os.path.isdir(p):
                        files = [f for f in os.listdir(p) if os.path.splitext(f)[1].lower() in MEDIA_EXTS]
                        folders.append({'name': name, 'media': len(files)})
            except Exception:
                pass
            self._json({'folders': folders})
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
                imported = sum(1 for line in log.split('\n') if '✓' in line and '登录' not in line and '文件夹' not in line)
                skipped = sum(1 for line in log.split('\n') if '跳过' in line)
                self._json({'status': 'ok', 'imported': imported, 'skipped': skipped, 'log': log})
            except Exception as e:
                self._json({'status': 'error', 'message': str(e)}, code=500)
        else:
            self.send_response(404)
            self.end_headers()

    def _json(self, data, code=200):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def _html(self, html):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(html.encode())


if __name__ == '__main__':
    print(f'NAS Sync Server → http://0.0.0.0:{PORT}')
    http.server.HTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
