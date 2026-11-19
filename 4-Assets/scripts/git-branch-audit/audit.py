#!/usr/bin/env python3
"""Inspect remote heads, registered tasks and observed releases, without fetching."""
import argparse
import base64
import hashlib
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REGISTRY = 'tasks/git-branch-register.json'


def git(*args):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_NO_LAZY_FETCH='1',
               GIT_TERMINAL_PROMPT='0')
    return subprocess.check_output(['git', *args], text=True, env=env, timeout=90)


def github_get(endpoint, field):
    origin = git('remote', 'get-url', 'origin').strip()
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([\w.-]+/[\w.-]+?)(?:\.git)?', origin)
    if not match:
        raise ValueError('本地缺 Git 对象；请在巡检之外同步仓库后重试')
    return subprocess.check_output(
        ['gh', 'api', '--method', 'GET', 'repos/'+match[1]+'/'+endpoint, '--jq', field],
        text=True, timeout=45).strip()


def remote_registry(sha):
    if subprocess.run(['git', 'cat-file', '-e', sha+'^{commit}'], stderr=subprocess.DEVNULL).returncode == 0:
        return git('show', sha+':'+REGISTRY)
    content = github_get('contents/'+REGISTRY+'?ref='+sha, '.content')
    return base64.b64decode(content).decode()


def reachable(commit, tip):
    result = subprocess.run(['git', 'merge-base', '--is-ancestor', commit, tip], stderr=subprocess.DEVNULL)
    if result.returncode in (0, 1):
        return result.returncode == 0
    return github_get('compare/'+commit+'...'+tip+'?per_page=1', '.status') in ('identical', 'ahead')


def proof_matches(proof, commit, fingerprint):
    if proof.get('kind') == 'p003-server-manifest':
        from p003_live import manifest_paths
        digest = hashlib.sha256()
        for path in sorted(manifest_paths()):
            blob = subprocess.check_output(['git', 'show', commit+':2-Projects/P003GameDemo20260513/apps/server/'+path])
            digest.update(path.encode()+b'\0'+hashlib.sha256(blob).digest())
        return digest.hexdigest() == fingerprint
    else:
        if not re.fullmatch(r'[0-9a-f]{40}:[^\0\r\n]+', proof['object']):
            raise ValueError('无效的取证文件 Git 对象名')
        raw = subprocess.check_output(['git', 'show', proof['object']])
        if proof.get('kind') == 'file':
            return (proof['object'].startswith(commit + ':')
                     and hashlib.sha256(raw).hexdigest() == fingerprint)
        else:
            node = json.loads(raw)
            for key in proof.get('keys', []):
                node = node[key]
            return (node['source_commit'] == commit
                     and node[proof['digest_key']] == fingerprint)


def audit(records, refs, observations):
    heads = {ref[11:]: sha for ref, sha in refs.items() if ref.startswith('refs/heads/')}
    branches = records['branches']
    if records['default_branch'] not in heads or not isinstance(branches, dict):
        raise ValueError('远端主分支或任务登记缺失')
    issues = []
    for name in sorted(heads):
        if name == records['default_branch']:
            continue
        item = branches.get(name)
        if not item or not item.get('task', '').strip():
            issues.append(f'无任务登记 {name}')
            continue
        state = item['state']
        print(f'{name:<49} {heads[name][:10]}  {state}  {item["task"]}')
        if state in ('done', 'archived'):
            issues.append(f'任务已完成，远端分支仍在 {name}')
        elif state not in ('active', 'keep') or (state == 'keep' and not item.get('until')):
            issues.append(f'处置状态或保留条件缺失 {name}')
    for name, item in branches.items():
        if item['state'] == 'archived' and (not item.get('archive_commit')
                or refs.get(item.get('archive_ref')) != item['archive_commit']):
            issues.append(f'归档标签无法还原登记的提交 {name}')
        if item['state'] in ('active', 'keep') and name not in heads:
            issues.append(f'登记分支在远端缺失 {name}')

    releases = records['releases']
    if observations is None:
        if releases:
            issues.append('未采集现网指纹，发布映射未验')
    else:
        when = datetime.fromisoformat(observations['at'])
        age = datetime.now(timezone.utc) - when
        if not timedelta(0) <= age <= timedelta(hours=24):
            issues.append('实机样本时间异常或已超过 24 小时')
        actual = observations['components']
        for name in sorted(set(actual) | set(releases)):
            if name not in releases:
                issues.append(f'线上组件未登记 {name}')
            elif not actual.get(name) or actual[name] != releases[name]['sha256']:
                issues.append(f'线上指纹缺失或与发布记录不符 {name}')
    for name, release in releases.items():
        commit = release.get('source_commit', '')
        source_head = refs.get(release.get('source_ref', ''))
        if (not re.fullmatch('[0-9a-f]{40}', commit) or not source_head
                or release.get('maintainer_branch') not in heads
                or not re.fullmatch('[0-9a-f]{64}', release.get('sha256', ''))):
            issues.append(f'发布缺少可定位的提交、来源引用、维护分支或指纹 {name}')
            continue
        if not reachable(commit, source_head):
            issues.append(f'无法验证发布提交可由远端来源找回 {name} {commit[:10]}（检查来源或同步本地对象）')
        if not release.get('proof') or not proof_matches(release['proof'], commit, release['sha256']):
            issues.append(f'发布证据缺失，或与登记的产物和提交不一致 {name}')
    for issue in issues:
        print('待处理', issue)
    print(f'远端分支 {len(heads)}，登记发布组件 {len(releases)}，待处理 {len(issues)}')
    return 1 if issues else 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--registry', type=Path, help='显式使用本地拟议登记表；默认读取远端默认分支对应的登记')
    obs = p.add_mutually_exclusive_group()
    obs.add_argument('--observed', type=Path, help='实机 JSON 样本')
    obs.add_argument('--p003-live', action='store_true', help='通过已配置的只读 SSH 取证入口采样')
    args = p.parse_args()
    os.environ.update(GIT_NO_LAZY_FETCH='1', GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
    rows = git('ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*', 'refs/tags/*').splitlines()
    primary = next((r.split()[1] for r in rows if r.startswith('ref: refs/heads/') and r.endswith('\tHEAD')), None)
    if not primary:
        raise ValueError('无法确定远端默认分支')
    refs = {r: h for h, r in (row.split('\t') for row in rows if not row.startswith('ref: '))}
    registry = json.loads(args.registry.read_text() if args.registry else
                          remote_registry(refs[primary]))
    if registry['default_branch'] != primary.removeprefix('refs/heads/'):
        raise ValueError('登记的默认分支与远端 HEAD 不一致')
    observations = None
    if args.p003_live:
        from p003_live import observe
        observations = observe()
    elif args.observed:
        observations = json.loads(args.observed.read_text())
    return audit(registry, refs, observations)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as err:
        print('巡检未完成（连接、输入或本地 Git 对象需核对）', type(err).__name__, str(err)[:230], file=sys.stderr)
        sys.exit(2)
