#!/usr/bin/env python3
"""Rewrite selected group stream URLs in a published m3u to HK HLS proxy URLs.

Default: only 海外新闻 / 海外纪录 go through HK jump.
港澳台 keeps direct origin URLs (mainland often plays smoother without extra hop).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import quote


def slugify(name: str) -> str:
    """ASCII-only stable slug so nginx/urllib/players never hit non-ASCII paths."""
    import hashlib

    text = name.strip().lower()
    # map known Chinese names first
    aliases = {
        "凤凰卫视": "phoenix-weishi",
        "凤凰资讯": "phoenix-zixun",
        "凤凰中文": "phoenix-zhongwen",
        "凤凰资讯(备用)": "phoenix-zixun-alt",
        "凤凰资讯-ifeng": "phoenix-zixun-alt",
        "凤凰中文-备用1": "phoenix-zhongwen-b1",
        "凤凰中文-备用2": "phoenix-zhongwen-b2",
        "凤凰香港": "phoenix-hk",
    }
    if name.strip() in aliases:
        return aliases[name.strip()]
    ascii_text = re.sub(r"[^a-z0-9]+", "-", text)
    ascii_text = ascii_text.strip("-")
    if ascii_text and re.fullmatch(r"[a-z0-9\-]+", ascii_text):
        return ascii_text[:80]
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:10]
    return f"ch-{digest}"


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: rewrite-m3u-via-proxy.py <input.m3u> <output.m3u> <proxy-config.json>", file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    cfg = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    token = cfg["token"]
    public_base = cfg["public_base"].rstrip("/")
    # 港澳台默认直连：国内到 txiptv 等源往往比「国内→港→源」更顺
    groups = set(cfg.get("proxy_groups") or ["海外新闻", "海外纪录"])
    groups.discard("")  # safety

    lines = src.read_text(encoding="utf-8", errors="replace").splitlines()
    out = []
    channels = dict(cfg.get("channels") or {})
    current_name = ""
    current_group = ""
    changed = 0
    direct_kept = 0

    for line in lines:
        if line.startswith("#EXTINF"):
            current_name = line.rsplit(",", 1)[-1].strip()
            match = re.search(r'group-title="([^"]*)"', line)
            current_group = match.group(1) if match else ""
            out.append(line)
            continue
        if line.startswith(("http://", "https://")) and current_name:
            if current_group in groups:
                channel_id = slugify(current_name)
                # keep stable mapping; preserve multi-origin list if already set
                existing = channels.get(channel_id)
                if not isinstance(existing, (list, dict)):
                    channels[channel_id] = line.strip()
                proxied = f"{public_base}/{token}/{channel_id}/master.m3u8"
                out.append(proxied)
                changed += 1
            else:
                # strip accidental old proxy URLs back to origin when input already proxied
                out.append(line.strip())
                if "iptv-proxy" not in line:
                    direct_kept += 1
            current_name = ""
            current_group = ""
            continue
        out.append(line)

    cfg["proxy_groups"] = sorted(groups)
    cfg["channels"] = channels
    Path(sys.argv[3]).write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    dst.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "rewritten": changed,
                "directKept": direct_kept,
                "proxyGroups": sorted(groups),
                "channels": len(channels),
                "output": str(dst),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
