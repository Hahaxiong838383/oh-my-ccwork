#!/usr/bin/env python3
"""Check the live Codeg agent installer; restore compatible web builds after replacement."""
import hashlib
import html.parser
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

HOME = Path.home()
APP = HOME / ".local/share/codeg"
WEB = APP / "web"
BASE = "http://127.0.0.1:3080"
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
DATA = Path("/data/home-studio")
PROBE = Path(__file__).with_name("probe.js")
RPCS = ("acp_prepare_npx_agent", "acp_download_agent_binary")


def get(path):
    with HTTP.open(BASE + path, timeout=12) as response:
        return response.read()


class Scripts(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        src = dict(attrs).get("src", "")
        if tag == "script" and re.fullmatch(r"/_next/static/chunks/[\w.~%-]+\.js", src):
            self.paths.append(src)


def assets(root):
    page = get("/settings/agents")
    if page != (root / "settings/agents.html").read_bytes():
        raise RuntimeError("Served settings page differs from the local deployment")
    parser = Scripts()
    parser.feed(page.decode())
    found = {}
    for path in dict.fromkeys(parser.paths):
        blob = (root / path[1:]).read_bytes()
        for kind, marker in (("transport", b'"WebTransport",0,'), ("api", b'"acpPrepareNpxAgent",0,')):
            if marker in blob:
                if kind in found:
                    raise RuntimeError("Ambiguous active " + kind)
                found[kind] = path
    paths = [found["api"], found["transport"], "/sw.js"]
    result = {p: get(p).decode() for p in paths}
    for p, source in result.items():
        if (root / p[1:]).read_text() != source:
            raise RuntimeError("Served file differs from disk: " + p)
    return paths, result


def browser(paths, sources, version, check_worker=False):
    """Use disposable Firefox storage and serve only the two active bundles locally."""
    api, transport, sw = paths
    scripts = ''.join('<script src="' + path + '"></script>' for path in (api, transport))
    document = '<!doctype html><meta charset=utf-8>' + scripts + '<script src="/probe.js"></script>'
    files = {api: sources[api], transport: sources[transport], "/probe.js": PROBE.read_text()}
    if check_worker:
        params = {"version": version, "hashes": {p: digest(sources[p]) for p in (api, transport)}}
        files["/worker-probe.js"] = "const expected = " + json.dumps(params) + ";\n" + PROBE.with_name("worker-probe.js").read_text()
        document = '<!doctype html><meta charset=utf-8><script src="/worker-probe.js"></script>'
    result = None
    armed = False

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            path = self.path.split("?")[0]
            mime = "text/javascript"
            if path == "/":
                body, mime = document, "text/html"
            elif path in ("/index.html", "/workspace", "/login"):
                body, mime = "<!doctype html><title>Test</title>", "text/html"
            elif path == sw:
                body = sources[sw] if armed else "self.addEventListener('install',()=>self.skipWaiting());"
            elif path in files:
                body = files[path]
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body.encode())

        def do_POST(self):
            nonlocal result, armed
            if self.path == "/arm":
                armed = True
            elif self.path == "/result":
                result = self.rfile.read(min(int(self.headers["Content-Length"]), 1024)).decode()
            else:
                self.send_error(404)
                return
            self.send_response(204)
            self.end_headers()

    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server, tempfile.TemporaryDirectory(
        prefix="codeg-check-", dir=HOME / "snap/firefox/common"
    ) as profile:
        server.timeout = 0.25
        # Firefox's own HTTP prefetch and background services are unnecessary for a loopback probe.
        (Path(profile) / "user.js").write_text('user_pref("network.prefetch-next", false);\n'
                                               'user_pref("browser.shell.checkDefaultBrowser", false);\n'
                                               'user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
        proc = subprocess.Popen(["/usr/bin/firefox", "--headless", "--no-remote", "--profile", profile,
                                 f"http://127.0.0.1:{server.server_port}/"],
                                start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 45
            while result is None and time.monotonic() < deadline and proc.poll() is None:
                server.handle_request()
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
    if result is None:
        raise RuntimeError("Firefox did not return a behavioral result")
    return result


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def once(src, old, new):
    if new in src:
        return src
    if src.count(old) != 1:
        raise RuntimeError("Unknown bundle layout; automatic repair skipped")
    return src.replace(old, new, 1)


def repair_timeouts(paths, candidate):
    api, transport, _ = paths
    for rpc in RPCS:
        pattern = r'\.call\("' + rpc + r'",\{[^{}\n]+?\}(?:,\{timeoutMs:900000\})?\)'
        matches = re.findall(pattern, candidate[api])
        if len(matches) != 1:
            raise RuntimeError("Unsupported API wrapper for " + rpc)
        call = matches[0]
        if not call.endswith(",{timeoutMs:900000})"):
            candidate[api] = candidate[api].replace(call, call[:-1] + ",{timeoutMs:900000})")
    begin = 'h=window.setTimeout(()=>c.abort(),l);'
    listener = """
const installEvents=(e==="acp_prepare_npx_agent"||e==="acp_download_agent_binary")&&t?.taskId?this.handlers.get("app://agent-install"):null;
const refreshInstallTimeout=event=>{
  if(event?.task_id!==t.taskId)return;
  window.clearTimeout(h);
  h=window.setTimeout(()=>c.abort(),l);
};
installEvents?.add(refreshInstallTimeout);
"""
    original = 'try{r=await fetch('
    candidate[transport] = once(candidate[transport], begin + original, begin + listener + original)
    candidate[transport] = once(candidate[transport], 'finally{window.clearTimeout(h)}if(401===r.status)',
                                'finally{installEvents?.delete(refreshInstallTimeout);window.clearTimeout(h)}if(401===r.status)')


def repair_worker(paths, candidate, version):
    api, transport, sw = paths
    src = candidate[sw]
    # Normalize our previous two-file hotfix before generating the current asset list.
    src = re.sub(r'^  const agentUpgradeChunk = "[^"]+"\n  const upgradeChunks = new Set\(\[agentUpgradeChunk, "[^"]+"\]\)\n  for \(const path of upgradeChunks\) referenced.add\(path\)\n', '', src, flags=re.M)
    src = src.replace('fetch(path, upgradeChunks.has(path) ? { cache: "reload" } : undefined)', 'fetch(path)')
    start, end = '  // codeg local asset refresh begin\n', '  // codeg local asset refresh end\n'
    if start in src:
        if src.count(start) != 1 or src.count(end) != 1:
            raise RuntimeError("Incomplete previous worker repair")
        left, right = src.split(start)
        src = left + right.split(end)[1]
    hashes = json.dumps({p: digest(candidate[p]) for p in (api, transport)})
    target = '  if (self.registration.active?.scriptURL === self.location.href) {'
    refresh = start + '  const upgradeHashes = ' + hashes + '\n' + '''
  if (self.registration.active?.scriptURL === self.location.href && BUILD === VERSION_TO_REPAIR) {
    const entries = await Promise.all(Object.entries(upgradeHashes).map(async ([path, hash]) => {
      const response = await fetch(path, {cache: "reload"})
      const bytes = await response.clone().arrayBuffer()
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
      if (!response.ok || Array.from(digest, b => b.toString(16).padStart(2,"0")).join("") !== hash)
        throw Error("Codeg install asset changed during refresh")
      return [path, response]
    }))
    const cache = await caches.open(ASSETS_CACHE)
    for (const [path, response] of entries) await cache.put(path, response)
    return
  }
'''.replace('VERSION_TO_REPAIR', json.dumps(version)) + end
    src = once(src, target, refresh + target)
    anchor = '  const assets = await Promise.all('
    src = once(src, anchor, '  for (const path of Object.keys(upgradeHashes)) referenced.add(path)\n' + anchor)
    candidate[sw] = once(src, '      const response = await fetch(path)\n',
                          '      const response = await fetch(path, path in upgradeHashes ? {cache:"reload"} : undefined)\n')


def write_atomic(path, text):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        temp = Path(f.name)
        try:
            os.fchmod(f.fileno(), path.stat().st_mode & 0o777)
            f.write(text.encode())
            f.flush()
            os.fsync(f.fileno())
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def validate(paths, sources, version):
    result = browser(paths, sources, version)
    if result != "PASS":
        raise RuntimeError(result)
    if "refreshInstallTimeout" in sources[paths[1]]:
        result = browser(paths, sources, version, check_worker=True)
        if result != "PASS":
            raise RuntimeError(result)


def maintain(root, version):
    paths, before = assets(root)
    candidate = before.copy()
    result = browser(paths, before, version)
    if result.startswith("TIMEOUT REGRESSION:"):
        repair_timeouts(paths, candidate)
    elif result != "PASS":
        raise RuntimeError(result)
    if "refreshInstallTimeout" in candidate[paths[1]]:
        repair_worker(paths, candidate, version)
    changed = [p for p in paths if candidate[p] != before[p]]
    if not changed:
        if "refreshInstallTimeout" in before[paths[1]]:
            result = browser(paths, before, version, check_worker=True)
            if result != "PASS":
                raise RuntimeError(result)
        print("PASS both install RPCs and progress isolation; no changes", flush=True)
        return
    validate(paths, candidate, version)
    if not os.path.ismount("/data"):
        raise RuntimeError("/data is unavailable for repair backup")
    backup = DATA / "maintenance/codeg-upgrade-check"
    backup.mkdir(mode=0o700, parents=True, exist_ok=True)
    snapshot = Path(tempfile.mkdtemp(dir=backup, prefix=time.strftime("%Y%m%d-%H%M%S-")))
    for p in changed:
        dest = snapshot / p[1:]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(before[p])
    written = []
    try:
        for p in changed:
            dest = root / p[1:]
            if not root.samefile(WEB) or dest.read_text() != before[p]:
                raise RuntimeError("Web deployment changed during validation")
            write_atomic(dest, candidate[p])
            written.append(p)
        final_paths, served = assets(root)
        if final_paths != paths or served != candidate:
            raise RuntimeError("Deployed resource mismatch")
        validate(paths, served, version)
    except Exception:
        for p in reversed(written):
            if (root / p[1:]).read_text() == candidate[p]:
                write_atomic(root / p[1:], before[p])
        raise
    print("REPAIRED and verified; originals:", snapshot, flush=True)


def main():
    pid = subprocess.check_output(["systemctl", "--user", "show", "codeg-server", "-p", "MainPID", "--value"], text=True).strip()
    if not (Path("/proc") / pid / "exe").samefile(HOME / ".local/bin/codeg-server"):
        raise RuntimeError("Codeg update is staged; waiting for the new server process")
    version = json.loads((APP / "cli" / f"endpoint-{pid}.json").read_text())["version"]
    print("Checking Codeg", version, "PID", pid, flush=True)
    # Pin the directory inode while the updater is free to swap web/ and web.bak/.
    fd = os.open(WEB, os.O_DIRECTORY)
    try:
        maintain(Path(f"/proc/self/fd/{fd}"), version)
    finally:
        os.close(fd)
    token = (APP / "token").read_text().strip()
    req = urllib.request.Request(BASE + "/api/acp_preflight", data=b'{"agentType":"deepseek","forceRefresh":true}',
                                 headers={"Authorization":"Bearer " + token, "Content-Type":"application/json"})
    with HTTP.open(req, timeout=30) as response:
        checks = {c["check_id"]: c["status"] for c in json.load(response)["checks"]}
    if any(checks.get(k) != "pass" for k in ("node_available", "npm_available", "node_version")):
        raise RuntimeError("Codeg Node/npm preflight failed")
    service_env = dict(os.fsdecode(item).split("=", 1) for item in
                       (Path("/proc") / pid / "environ").read_bytes().split(b"\x00") if b"=" in item)
    node = shutil.which("node", path=service_env["PATH"])
    npm = shutil.which("npm", path=service_env["PATH"])
    if not node or not npm:
        raise RuntimeError("Missing Node/npm in the Codeg service PATH")
    subprocess.run([node, "-e", 'if(typeof require("node:zlib").createZstdCompress!=="function")process.exit(1)'],
                   env=service_env, check=True)
    configured_cache = subprocess.check_output([npm, "config", "get", "cache"], text=True,
                                               cwd=HOME, env=service_env, timeout=12).strip()
    cache = Path(configured_cache) / "_cacache"
    if not os.path.ismount("/data") or cache.resolve(strict=True) != DATA / "artifacts/codeg/npm-content-cache" or not os.access(cache, os.W_OK):
        raise RuntimeError("npm content cache mount, path or permissions changed")
    print("PASS Codeg Node/npm preflight, zstd and data disk cache")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        message = str(exc)
        print("FAILED:", message, file=sys.stderr, flush=True)
        if shutil.which("notify-send"):
            subprocess.run(["notify-send", "-u", "critical", "Codeg 升级检查未通过", message], timeout=8, check=False)
        sys.exit(1)
