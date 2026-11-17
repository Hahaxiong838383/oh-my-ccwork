"""双路 speakable TTFT 对比(64.90 上跑,key 从 env 取不落参数)。各 N 发。"""
import json
import os
import subprocess
import sys
import time

N = int(sys.argv[1]) if len(sys.argv) > 1 else 3

ROUTES = [
    ("DeepSeek主路", os.environ["LLM_BASE_URL"], os.environ["LLM_API_KEY"],
     os.environ.get("LLM_MODEL", "deepseek-v4-flash"), "disabled"),
    ("火山兜底路", os.environ["LLM_FALLBACK_BASE_URL"], os.environ["LLM_FALLBACK_API_KEY"],
     os.environ["LLM_FALLBACK_MODEL"], os.environ.get("LLM_FALLBACK_THINKING", "disabled")),
]

for name, base, key, model, think in ROUTES:
    vals = []
    for i in range(N):
        body = json.dumps({
            "model": model, "stream": True, "thinking": {"type": think},
            "messages": [{"role": "user", "content": "用一句话打个招呼"}],
        })
        t0 = time.time()
        p = subprocess.Popen(
            ["curl", "-sS", "-m", "15", "-N", base.rstrip("/") + "/chat/completions",
             "-H", "Content-Type: application/json",
             "-H", "Authorization: Bearer " + key, "-d", body],
            stdout=subprocess.PIPE)
        first = None
        for line in p.stdout:
            line = line.decode(errors="ignore").strip()
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            try:
                d = json.loads(line[6:])
            except Exception:
                continue
            delta = (d.get("choices") or [{}])[0].get("delta") or {}
            if delta.get("content"):
                first = int((time.time() - t0) * 1000)
                break
        p.kill()
        vals.append(first if first else -1)
        time.sleep(0.8)
    ok = [v for v in vals if v > 0]
    med = sorted(ok)[len(ok) // 2] if ok else -1
    print(f"{name} model={model}: 各发={vals}ms 中位={med}ms")
