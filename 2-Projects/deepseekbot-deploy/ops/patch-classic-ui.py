#!/usr/bin/env python3
"""Pinned, reversible UI compatibility patch for @botharness/ui 1.4.0.
Retains upstream classic components; does not touch bot data or authentication.
"""
import argparse
import hashlib
import os
from pathlib import Path

ORIGINAL_SHA256 = '8e762ceff4968e8d1d1a1744ff66d037ec8578fc6cc8fb97dc0a8a1ffe87c2fe'
DEFAULT_DM = 'bot-50008695e5904fb8b843578655ff992c'
REPLACEMENTS = [
    ('return (0, react.useSyncExternalStore)(subscribeQueries, () => matches("(min-width: 961px)") && !matches("(max-width: 960px)"), () => false);',
     'return false; // mycc: retain the upstream classic chat and sidebar'),
    ('return typeof window !== "undefined" && typeof window.matchMedia === "function" && matches$2("(min-width: 961px)") && !matches$2("(max-width: 760px), (max-width: 1000px) and (max-height: 500px)");',
     'return false; // mycc: retain the Harness brand and message sidebar'),
    ('fullClientLocator(window.location.hash);',
     'fullClientLocator(window.location.hash || "#botharness-open=dm:' + DEFAULT_DM + '");'),
    ('function createChannelSidebarBuiltinTabs(t) {\n\t\t\treturn [',
     'function createChannelSidebarBuiltinTabs(t) {\n\t\t\treturn [{ id: "team", icon: "users", label: "成员与会话", order: 0, scope: "channel" },'),
    ('id: "sessions",\n\t\t\t\t\ticon: "text-quote",',
     'id: "sessions",\n\t\t\t\t\ttab: "team",\n\t\t\t\t\ticon: "text-quote",'),
    ('id: "members",\n\t\t\t\t\ticon: "users",',
     'id: "members",\n\t\t\t\t\ttab: "team",\n\t\t\t\t\ticon: "users",'),
    ('label: t("entry.members"),\n\t\t\t\t\torder: 10,',
     'label: t("entry.members"),\n\t\t\t\t\torder: 9,'),
]
CSS = '''\n/* mycc classic-ui v1: keep full bot names readable in the scrolling list. */
.bh-contact .bh-name, .bh-channel-row .bh-name { white-space:normal; overflow:visible; text-overflow:clip; overflow-wrap:anywhere; }
'''

def patch(original):
    if hashlib.sha256(original).hexdigest() != ORIGINAL_SHA256:
        raise SystemExit('未识别的 UI 文件；拒绝修改。升级插件后请重新评估补丁。')
    text = original.decode()
    for before, after in REPLACEMENTS:
        if text.count(before) != 1:
            raise SystemExit('补丁定位不唯一，未写入。')
        text = text.replace(before, after, 1)
    # Insert into upstream CSS before its first known rule, rather than a runtime DOM script.
    marker = '\n.bh-pinned .bh-name {'
    if text.count(marker) != 1:
        raise SystemExit('CSS 定位不唯一，未写入。')
    return text.replace(marker, CSS + marker, 1).encode()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('client', type=Path)
    parser.add_argument('--restore', action='store_true')
    parser.add_argument('--output', type=Path, help='Generate preview only; leave source unchanged')
    args = parser.parse_args()
    target = args.client.resolve()
    backup = target.with_name('client.js.mycc-original-1.4.0')
    current = target.read_bytes()
    original = backup.read_bytes() if backup.exists() else current
    changed = patch(original)
    if args.output:
        args.output.write_bytes(changed)
        print('预览文件已生成')
        return
    if current not in (original, changed):
        raise SystemExit('目标已被其他修改覆盖，拒绝写入。')
    wanted = original if args.restore else changed
    if current == wanted:
        print('UI 已处于目标状态')
        return
    if not backup.exists():
        with backup.open('xb') as f:
            f.write(original)
        backup.chmod(0o600)
    temporary = target.with_name('client.js.mycc-tmp')
    with temporary.open('wb') as f:
        f.write(wanted)
        f.flush()
        os.fsync(f.fileno())
    temporary.chmod(target.stat().st_mode & 0o777)
    os.replace(temporary, target)
    print('UI 已还原原版' if args.restore else '经典三栏 UI 补丁已应用')
    print('SHA256=' + hashlib.sha256(wanted).hexdigest())

if __name__ == '__main__':
    main()
