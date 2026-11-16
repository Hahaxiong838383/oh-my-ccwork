"""Pure two-key environment patch; caller owns backups, atomic install and restart.

No file/network access. Rollback preserves unrelated credentials/configuration,
and refuses if either installed diagnostic assignment has since changed.
"""
import base64
import re
import shlex
import time

KEYS = ('P003_ASR_DIAGNOSTICS_SN_ALLOW', 'P003_ASR_DIAGNOSTICS_UNTIL_MS')
ASSIGNMENT = re.compile(rb'^[ \t]*(?:export[ \t]+)?(' + b'|'.join(k.encode() for k in KEYS) + rb')[ \t]*=')


def assignments(content):
    lines = content.splitlines(keepends=True)
    found = {}
    for i, line in enumerate(lines):
        match = ASSIGNMENT.match(line)
        if match:
            key = match[1].decode('ascii')
            if key in found:
                raise ValueError('duplicate diagnostic assignment')
            # Refuse ambiguous multiline/continuation syntax; never rewrite it.
            shlex.split(line.decode('utf-8'))
            if line.rstrip(b'\r\n').endswith(b'\\'):
                raise ValueError('continued diagnostic assignment')
            found[key] = (i, line)
    return lines, found


def replace(content, desired):
    lines, found = assignments(content)
    for key in KEYS:
        replacement = desired[key]
        if replacement is not None:
            _, check = assignments(replacement)
            if set(check) != {key} or len(replacement.splitlines()) != 1:
                raise ValueError('invalid diagnostic assignment')
        if key in found:
            lines[found[key][0]] = replacement or b''
        elif replacement is not None:
            lines.append(replacement)
    return b''.join(lines)


def enable(content, sns, until_ms, *, now_ms=None):
    now_ms = int(time.time()*1000) if now_ms is None else now_ms
    if (len(sns) != 3 or len(set(sns)) != 3 or
            any(not isinstance(sn, str) or not re.fullmatch(r'BJP003\d{14}', sn) for sn in sns)):
        raise ValueError('three distinct full device SNs required')
    if type(until_ms) is not int or until_ms <= now_ms:
        raise ValueError('future millisecond deadline required')
    if content and not content.endswith(b'\n'):
        raise ValueError('environment must have a terminal newline')
    _, found = assignments(content)
    newline = b'\r\n' if b'\r\n' in content else b'\n'
    values = [','.join(sns), str(until_ms)]
    desired = {k: k.encode()+b'='+v.encode()+newline for k, v in zip(KEYS, values)}
    old = {k: found[k][1] if k in found else None for k in KEYS}
    encode = lambda value: None if value is None else base64.b64encode(value).decode('ascii')
    state = {'version': 1, 'before': {k: encode(old[k]) for k in KEYS},
             'installed': {k: encode(desired[k]) for k in KEYS}}
    return replace(content, desired), state


def restore(content, state):
    if (set(state) != {'version', 'before', 'installed'} or state['version'] != 1 or
            set(state['before']) != set(KEYS) or set(state['installed']) != set(KEYS)):
        raise ValueError('invalid rollback state')
    decode = lambda value: None if value is None else base64.b64decode(value, validate=True)
    before = {k: decode(state['before'][k]) for k in KEYS}
    installed = {k: decode(state['installed'][k]) for k in KEYS}
    _, found = assignments(content)
    if any(k not in found or found[k][1] != installed[k] for k in KEYS):
        raise ValueError('diagnostic configuration drift; refuse rollback')
    return replace(content, before)
