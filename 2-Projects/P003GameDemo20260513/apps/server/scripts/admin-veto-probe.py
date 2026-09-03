#!/usr/bin/env python3
# R1 admin 真通道探针：登录 → POST interest-veto 一个不存在的值（不改档案，vetoed=false 即路由活）→ GET brain 看兴趣三态字段
import json, sys, urllib.request
sn = sys.argv[1] if len(sys.argv) > 1 else "BJP00326010100000002"
env = {}
for line in open(".env.local"):
    line = line.rstrip("\n")
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'": v = v[1:-1]
        env[k] = v
req = urllib.request.Request("http://127.0.0.1:3001/api/auth/login", data=json.dumps({"username": env["STUDIO_USER"], "password": env["STUDIO_PASS"]}).encode(), headers={"Content-Type": "application/json"})
tok = json.load(urllib.request.urlopen(req)).get("token", "")
def call(method, path, body=None):
    r = urllib.request.Request(f"http://127.0.0.1:3001{path}", method=method, headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}, data=(json.dumps(body).encode() if body is not None else None))
    try:
        return urllib.request.urlopen(r, timeout=30).status, json.load(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:3001{path}", method=method, headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}, data=(json.dumps(body).encode() if body is not None else None)), timeout=30))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")
st, r = call("POST", f"/api/admin/devices/{sn}/interest-veto", {"value": "__cc_probe__"})
print("veto(不存在值) status=", st, "resp=", r)
st2, r2 = call("POST", f"/api/admin/devices/{sn}/interest-veto", {"value": ""})
print("veto(空值) status=", st2, "resp=", r2)
st3, b = call("GET", f"/api/admin/devices/{sn}/brain")
ints = (b.get("profile") or {}).get("interests") or []
print("brain interests n=", len(ints), "带state=", sum(1 for i in ints if "state" in i), "state分布=", {s: sum(1 for i in ints if i.get("state") == s) for s in ("unverified", "verified", "retracted")})
