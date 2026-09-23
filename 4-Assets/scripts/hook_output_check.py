"""PreToolUse hook 输出的「claude 会不会认」校验，供各守门的测试共用。

依据：claude-agent-sdk 0.3.280 二进制里的解析逻辑（2026-09-23 读源码 + codeg(auto) 会话探针实测）。
- 顶层 decision 只认 approve/block；写成 "deny" 会抛「Unknown hook decision type」，整条输出（连
  additionalContext）作废、命令照跑。9-19 的守门就是栽在这里，所有会话的硬红线形同虚设。
- hookSpecificOutput.hookEventName 必须等于事件名；permissionDecision 只认 allow/deny/ask/defer。
"""
import json


def claude_accepts(out, event='PreToolUse'):
    """返回 (ok, 原因)。空输出视为合法（放行）。"""
    if not out.strip():
        return True, ''
    try:
        o = json.loads(out)
    except ValueError:
        return False, '不是 JSON'
    if not isinstance(o, dict):
        return False, '不是 JSON 对象'
    if 'decision' in o and o['decision'] not in ('approve', 'block'):
        return False, f"顶层 decision={o['decision']!r}（只认 approve/block，claude 会抛错、整条作废）"
    h = o.get('hookSpecificOutput')
    if h is not None:
        if h.get('hookEventName') != event:
            return False, f'hookEventName 不是 {event}'
        if 'permissionDecision' in h and h['permissionDecision'] not in ('allow', 'deny', 'ask', 'defer'):
            return False, f"permissionDecision={h['permissionDecision']!r}"
    return True, ''


def denies(out):
    try:
        return (json.loads(out).get('hookSpecificOutput') or {}).get('permissionDecision') == 'deny'
    except (ValueError, AttributeError):
        return False
