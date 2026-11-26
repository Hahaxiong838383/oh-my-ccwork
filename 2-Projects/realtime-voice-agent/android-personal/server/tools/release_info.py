#!/usr/bin/env python3
"""看发布目录会对外产生什么（不改任何东西）。

    python3 tools/release_info.py --publish /vol1/1000/mobile/night

输出：
  * 目录里所有符合 xiaoke-night-<versionCode>.apk 的文件与真实 sha256；
  * 服务端此刻会返回的 latest.json；
  * 命名不合规、web 侧不会认的文件（避免"传上去了但客户端看不到"）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time

APK_RE = re.compile(r"^xiaoke-night-(?P<vc>[1-9][0-9]{0,9})\.apk$")


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", default="/vol1/1000/mobile/night")
    args = ap.parse_args()
    directory = args.publish
    if not os.path.isdir(directory):
        print(f"目录不存在：{directory}")
        return 2
    good, other = [], []
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        m = APK_RE.match(name)
        if m:
            good.append((int(m.group("vc")), name, path))
        elif name != "release.json" and not name.startswith("."):
            other.append(name)
    if not good:
        print("没有可用 APK → 对外 latest.json 和 APK 都是 404（这是正确行为）")
    else:
        print(f"{'versionCode':>11}  {'大小':>12}  {'修改时间':<16}  sha256")
        for vc, name, path in good:
            st = os.stat(path)
            print(
                f"{vc:>11}  {st.st_size:>12}  "
                f"{time.strftime('%m-%d %H:%M', time.localtime(st.st_mtime)):<16}  {sha256_of(path)[:32]}…"
            )
        vc, name, path = good[-1]
        st = os.stat(path)
        manifest = {
            "schema": 1,
            "channel": "night",
            "versionCode": vc,
            "versionName": str(vc),
            "apkUrl": f"/mobile/night/{name}",
            "packageName": "cc.hahaxiong.xiaoke.night",
            "url": f"https://pa.hahaxiong.cc:8666/mobile/night/{name}",
            "size": st.st_size,
            "apkBytes": st.st_size,
            "apkSha256": sha256_of(path),
            "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
        }
        manifest["sha256"] = manifest["apkSha256"]
        rel = os.path.join(directory, "release.json")
        if os.path.exists(rel):
            try:
                raw = json.load(open(rel, encoding="utf-8"))
                if isinstance(raw, dict):
                    if isinstance(raw.get("versionName"), str):
                        manifest["versionName"] = raw["versionName"]
                    if isinstance(raw.get("notes"), str):
                        manifest["notes"] = raw["notes"][:2000]
            except Exception as exc:
                print(f"release.json 读不了：{exc}")
        print("\n对外 latest.json 将是：")
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
    if other:
        print("\n下列文件不会被 web 侧识别（命名必须是 xiaoke-night-<数字>.apk）：")
        for name in other:
            print(f"  - {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
