#!/usr/bin/env python3
"""Optionally rewrite selected channels to HK HLS proxy URLs.

Selection (any match → proxy; direct_channel_names always wins):
- proxy_groups: e.g. ["海外新闻"]
- proxy_channel_names: e.g. ["凤凰中文", "RTHK TV 32"]
- direct_channel_names: force origin direct (e.g. channels already OK in mainland)

Default: proxy_groups=[], proxy_channel_names=[] → all direct.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def slugify(name: str) -> str:
    """ASCII-only stable slug so nginx/urllib/players never hit non-ASCII paths."""
    import hashlib

    text = name.strip().lower()
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


def should_proxy(name: str, group: str, groups: set[str], names: set[str], direct: set[str]) -> bool:
    if name in direct:
        return False
    if name in names:
        return True
    if group in groups:
        return True
    return False


def main() -> int:
    if len(sys.argv) < 4:
        print(
            "usage: rewrite-m3u-via-proxy.py <input.m3u> <output.m3u> <proxy-config.json>",
            file=sys.stderr,
        )
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    cfg_path = Path(sys.argv[3])
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    token = cfg["token"]
    public_base = cfg["public_base"].rstrip("/")
    groups = {g for g in (cfg.get("proxy_groups") or []) if g}
    names = {n for n in (cfg.get("proxy_channel_names") or []) if n}
    direct = {n for n in (cfg.get("direct_channel_names") or []) if n}

    lines = src.read_text(encoding="utf-8", errors="replace").splitlines()
    out = []
    channels = dict(cfg.get("channels") or {})
    current_name = ""
    current_group = ""
    changed = 0
    direct_kept = 0
    proxied_names = []

    for line in lines:
        if line.startswith("#EXTINF"):
            current_name = line.rsplit(",", 1)[-1].strip()
            match = re.search(r'group-title="([^"]*)"', line)
            current_group = match.group(1) if match else ""
            out.append(line)
            continue
        if line.startswith(("http://", "https://")) and current_name:
            origin = line.strip()
            # if input already proxied, keep as-is only when still should_proxy
            if "iptv-proxy" in origin:
                # leave proxied URL only if channel still selected; else need origin from map
                channel_id = slugify(current_name)
                if should_proxy(current_name, current_group, groups, names, direct):
                    out.append(origin)
                    changed += 1
                    proxied_names.append(current_name)
                else:
                    mapped = channels.get(channel_id)
                    if isinstance(mapped, str) and mapped.startswith("http") and "iptv-proxy" not in mapped:
                        out.append(mapped)
                    elif isinstance(mapped, list) and mapped:
                        out.append(mapped[0])
                    else:
                        out.append(origin)  # fallback
                    direct_kept += 1
            elif should_proxy(current_name, current_group, groups, names, direct):
                channel_id = slugify(current_name)
                existing = channels.get(channel_id)
                if not isinstance(existing, (list, dict)):
                    channels[channel_id] = origin
                elif isinstance(existing, list) and origin not in existing:
                    channels[channel_id] = [origin] + [x for x in existing if x != origin]
                proxied = f"{public_base}/{token}/{channel_id}/master.m3u8"
                out.append(proxied)
                changed += 1
                proxied_names.append(current_name)
            else:
                out.append(origin)
                direct_kept += 1
            current_name = ""
            current_group = ""
            continue
        out.append(line)

    cfg["proxy_groups"] = sorted(groups)
    cfg["proxy_channel_names"] = sorted(names)
    cfg["direct_channel_names"] = sorted(direct)
    cfg["channels"] = channels
    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    dst.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "rewritten": changed,
                "directKept": direct_kept,
                "proxyGroups": sorted(groups),
                "proxyChannelNames": sorted(names),
                "directChannelNames": sorted(direct),
                "proxiedNow": proxied_names,
                "channels": len(channels),
                "output": str(dst),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
