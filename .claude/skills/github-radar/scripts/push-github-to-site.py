#!/usr/bin/env python3
"""github-radar → 个人站(my.chenchuan.cc)「开源风向标」webhook 推送。

读 /tmp/github-radar-data.json（github-radar.py 产出）→ 附 type=github →
POST 站点 /api/radar-webhook（与 theory-radar 共用端点与 token，服务端按 type 分流）。
"""
import json
import os
import sys
import urllib.request

WEBHOOK_URL = os.environ.get("RADAR_WEBHOOK_URL", "https://my.chenchuan.cc/api/radar-webhook")
TOKEN = os.environ.get("RADAR_WEBHOOK_TOKEN", "")
DATA_FILE = "/tmp/github-radar-data.json"


def log(msg: str) -> None:
    print(f"[push-github] {msg}", flush=True)


def main() -> None:
    if not TOKEN:
        log("缺 RADAR_WEBHOOK_TOKEN")
        sys.exit(1)
    try:
        with open(DATA_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001
        log(f"读取 {DATA_FILE} 失败: {e}")
        sys.exit(1)

    categories = data.get("categories") or []
    repo_count = sum(len(c.get("repos") or []) for c in categories)
    if repo_count == 0:
        log("0 个项目，不推送（抓取可能失败）")
        sys.exit(1)

    payload = {
        "type": "github",
        "date": data.get("date"),
        "categories": [
            {
                "label": c.get("label"),
                "repos": [
                    {
                        "name": r.get("name"),
                        "url": r.get("url"),
                        "stars": r.get("stars"),
                        "description": r.get("description"),
                        "language": r.get("language"),
                        "updated": r.get("updated"),
                    }
                    for r in (c.get("repos") or [])
                ],
            }
            for c in categories
        ],
    }

    req = urllib.request.Request(
        WEBHOOK_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
    log(f"webhook 响应: {body}")
    ok = json.loads(body).get("ok")
    if not ok:
        sys.exit(1)
    log(f"推送成功 {repo_count} 个项目，date={data.get('date')}")


if __name__ == "__main__":
    main()
