#!/usr/bin/env python3
"""Minimal hook; source-hash check prevents overwriting concurrent edits."""
import argparse
import hashlib
from pathlib import Path
import shutil
import time

HOOK = '\n# EasyTier Air Manager: isolated extension; monitor runs independently.\nfrom easytier_manager import extend_manager as _extend_easytier_manager\nHandler, HTML_PAGE = _extend_easytier_manager(Handler, HTML_PAGE)\n\n'
ANCHOR = '# ==================== 主入口 ===================='


def patch(source):
    if 'from easytier_manager import extend_manager' in source:
        raise ValueError('already integrated; do not patch twice')
    if source.count(ANCHOR) != 1:
        raise ValueError('main anchor changed')
    return source.replace(ANCHOR, HOOK + ANCHOR)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('manager', type=Path)
    parser.add_argument('--expected-sha256', required=True)
    args = parser.parse_args()
    original = args.manager.read_bytes()
    if hashlib.sha256(original).hexdigest() != args.expected_sha256:
        raise SystemExit('Manager changed concurrently; installation refused')
    result = patch(original.decode('utf-8'))
    compile(result, str(args.manager), 'exec')
    backup = args.manager.with_name(args.manager.name + '.pre-easytier-' + time.strftime('%Y%m%d-%H%M%S'))
    shutil.copy2(args.manager, backup)
    tmp = args.manager.with_suffix('.et-tmp')
    tmp.write_text(result, encoding='utf-8')
    shutil.copymode(args.manager, tmp)
    if args.manager.read_bytes() != original:
        tmp.unlink()
        raise SystemExit('Manager changed during installation; refused')
    tmp.replace(args.manager)
    print('BACKUP=' + str(backup))


if __name__ == '__main__':
    main()
