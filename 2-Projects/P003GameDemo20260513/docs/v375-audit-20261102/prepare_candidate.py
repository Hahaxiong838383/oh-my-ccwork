#!/usr/bin/env python3
"""将48固定候选归档到私有隔离目录；不会运行或发布服务。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

SERVER = '2-Projects/P003GameDemo20260513/apps/server'
TEST_FIXTURES = (
    '2-Projects/P003GameDemo20260513/docs/ark-brain-20261031/snapshot-v1.example.json',
    '4-Assets/contracts/p003-listening-http-v1.fixtures.json',
)
BASE = '9e7aab980114b796e22cc5286a1edf5c44f3b35a'


def verify_candidate_sha(receipt, expected):
    if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{40}', expected):
        raise ValueError('必须完整SHA')
    if not isinstance(receipt, dict) or receipt.get('candidate_sha') != expected:
        raise ValueError('SHA必须精确匹配48回执顶层candidate_sha，不接受baseline或其他字段')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--output-parent', type=Path, required=True)
    args = parser.parse_args()
    raw = args.candidate.read_bytes()
    verify_candidate_sha(json.loads(raw), args.sha)
    git = ['git', '-C', str(args.repo)]
    resolved = subprocess.check_output(git + ['rev-parse', args.sha + '^{commit}'], text=True).strip()
    assert resolved == args.sha
    subprocess.run(git + ['merge-base', '--is-ancestor', BASE, args.sha], check=True)
    parent = args.output_parent.resolve()
    state = (Path.home() / '.local/state').resolve()
    assert parent.is_relative_to(state), '只允许私有state目录'
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='candidate45-' + args.sha[:12] + '-', dir=parent))
    os.chmod(root, 0o700)
    archive = root / 'candidate.tar'
    with archive.open('wb') as out:
        subprocess.run(git + ['archive', args.sha, SERVER, *TEST_FIXTURES], stdout=out, check=True)
    with tarfile.open(archive) as tar:
        # 不接受归档中的链接和越界路径；依赖由核版本后的外部只读路径提供。
        for member in tar.getmembers():
            target = (root / member.name).resolve()
            assert target.is_relative_to(root) and not member.issym() and not member.islnk()
        tar.extractall(root, filter='data')
    files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in (root / SERVER).rglob('*') if p.is_file()}
    for path in TEST_FIXTURES:
        files[path] = hashlib.sha256((root / path).read_bytes()).hexdigest()
    evidence = {'candidate_sha': args.sha, 'baseline': BASE,
                'candidate_receipt_sha256': hashlib.sha256(raw).hexdigest(),
                'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                'source_files_sha256': files, 'verdict': 'NOT_RUN',
                'note': '归档不等于验收；必须继续运行实际HTTP/持久化/授权/TTL/Ark测试'}
    (root / 'PREPARATION.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'root': str(root), 'server': str(root / SERVER),
                      'candidate_sha': args.sha, 'verdict': 'NOT_RUN'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
