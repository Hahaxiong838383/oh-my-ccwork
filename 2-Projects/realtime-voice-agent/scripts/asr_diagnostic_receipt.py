#!/usr/bin/env python3
"""Offline evidence reader. Never opens a room, changes configuration or exports text/PCM."""
import argparse
import hashlib
import json
import pathlib
import re

ANSI = re.compile(r'\x1b\[[0-9;]*m')
IDENT = r'[A-Za-z0-9_.:-]+'

def field(message, key):
    # Do not parse every arbitrary value with a greedy regex: tracing spans nest.
    hits = re.findall(r'(?<![\w.])' + re.escape(key) + r'=(?:"(' + IDENT + r')"|(' + IDENT + r'))(?=[\s},:]|$)', message)
    values = {a or b for a, b in hits}
    return next(iter(values)) if len(values) == 1 else None

def object_field(message, key):
    match = re.search(r'(?<!\w)' + re.escape(key) + r'=(\{)', message)
    if not match:
        return None
    try:
        value, _ = json.JSONDecoder().raw_decode(message[match.start(1):])
        return value if isinstance(value, dict) else None
    except ValueError:
        return None

def number(value):
    return value if type(value) is int and 0 <= value <= 2**63 - 1 else None

def sanitized_stats(stats):
    out = {}
    for key in ('written', 'taken'):
        v = stats.get(key)
        if isinstance(v, dict):
            out[key] = {k: v[k] for k in ('samples', 'nonzero', 'peak') if number(v.get(k)) is not None}
    for key in ('responses', 'definite', 'empty_definite', 'final_delivered', 'interim_delivered', 'event_receiver_closed', 'invalid_json', 'error_code', 'audio_writes'):
        if number(stats.get(key)) is not None:
            out[key] = stats[key]
    return out

def build_receipt(binding, rows):
    sn, trace, room = (binding.get(k) for k in ('device_sn', 'trace_id', 'room'))
    if not isinstance(sn, str) or not re.fullmatch(r'BJP003[0-9]{14}', sn):
        raise ValueError('full device_sn required')
    if not isinstance(trace, str) or not re.fullmatch(IDENT, trace):
        raise ValueError('trace_id required')
    if not isinstance(room, str) or not re.fullmatch(r'sn-' + re.escape(sn) + r'-[0-9]+', room):
        raise ValueError('room and device_sn do not match')
    parsed, all_rows = [], []
    for i, row in enumerate(rows, 1):
        msg = row.get('MESSAGE', '')
        if isinstance(msg, list):
            msg = bytes(msg).decode('utf8', 'replace')
        if not isinstance(msg, str):
            continue
        msg = ANSI.sub('', msg)
        all_rows.append((i, row, msg))
        if field(msg, 'room') == room:
            parsed.append((i, row, msg))
    owners = set()
    for _, row, msg in parsed:
        if (field(msg, 'trace') or field(msg, 'trace_id')) == trace and field(msg, 'job_id'):
            if row.get('_PID') and row.get('_SYSTEMD_UNIT'):
                owners.add((row['_PID'], row['_SYSTEMD_UNIT'], field(msg, 'job_id')))
    if len(owners) != 1:
        raise ValueError('unique trace/room/job/process ownership not proven')
    pid, unit, job = next(iter(owners))
    # A room reused by another job/trace is not a unique attribution boundary.
    for _, row, msg in parsed:
        observed_trace = field(msg, 'trace') or field(msg, 'trace_id')
        observed_job = field(msg, 'job_id')
        if (observed_trace and observed_trace != trace) or (observed_job and observed_job != job):
            raise ValueError('room contains another trace or job')
    runtime = binding.get('worker_runtime', {})
    runtime_ok = (isinstance(runtime, dict) and str(runtime.get('pid')) == str(pid)
                  and runtime.get('unit') == unit and isinstance(runtime.get('agent_name'), str)
                  and re.fullmatch(IDENT, runtime['agent_name'])
                  and re.fullmatch(r'[0-9a-f]{64}', str(runtime.get('binary_sha256', '')))
                  and re.fullmatch(r'[0-9a-f]{40}', str(runtime.get('source_sha', ''))))
    safe_runtime = {k: runtime[k] for k in ('agent_name', 'binary_sha256', 'source_sha')} if runtime_ok else None
    connections, finals, closed = [], 0, False
    for i, row, msg in parsed:
        if (row.get('_PID'), row.get('_SYSTEMD_UNIT')) != (pid, unit):
            continue
        if 'asr final received' in msg and field(msg, 'phase') == 'Rtc' and (field(msg, 'trace') or field(msg, 'trace_id')) == trace:
            finals += 1
        if 'job closed' in msg and field(msg, 'job_id') == job:
            closed = True
        if 'asr diagnostic connection summary' not in msg:
            continue
        stats, queue = object_field(msg, 'stats'), object_field(msg, 'queue')
        request, generation = field(msg, 'request_id'), field(msg, 'input_generation')
        if not stats or not queue or not request or not generation or queue.get('phase') != 'rtc':
            continue
        safe = sanitized_stats(stats)
        if any(v is None for v in (safe.get('written', {}).get('samples'), safe.get('responses'), safe.get('final_delivered'))):
            continue
        connections.append({'request_id': request, 'input_generation': generation, 'line': i,
                            'event_sha256': hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest(), 'stats': safe})
    summaries = {}
    for i, row, msg in all_rows:
        if (row.get('_PID'), row.get('_SYSTEMD_UNIT')) != (pid, unit) or 'asr diagnostic input summary' not in msg:
            continue
        generation, stats = field(msg, 'input_generation'), object_field(msg, 'stats')
        msg_room = field(msg, 'room')
        if generation and stats and stats.get('phase') == 'rtc' and (not msg_room or msg_room == room):
            summaries.setdefault(generation, []).append({'line': i, 'event_sha256': hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()})
    generations_complete = bool(connections) and all(len(summaries.get(c['input_generation'], [])) == 1 for c in connections)
    requests_unique = len({c['request_id'] for c in connections}) == len(connections)
    reasons = []
    if not runtime_ok: reasons.append('runtime_binding_missing_or_mismatched')
    if not connections: reasons.append('rtc_connection_summary_missing')
    if not generations_complete: reasons.append('rtc_input_summary_missing_or_ambiguous')
    if not requests_unique: reasons.append('request_summary_ambiguous')
    delivered = sum(c['stats']['final_delivered'] for c in connections
                    if c['stats']['responses'] > 0 and c['stats']['written']['samples'] > 0)
    if finals > delivered: reasons.append('rtc_final_delivery_not_correlated')
    coverage = 'COVERED' if not reasons else 'NOT_COVERED'
    return {'device_sn': sn, 'trace_id': trace, 'room': room, 'job_id': job, 'worker_pid': pid, 'worker_unit': unit,
            'evidence_scope': binding.get('evidence_scope', 'unspecified'),
            'physical_device_participated': None,  # this reader cannot independently assess hardware participation
            'worker_runtime': safe_runtime, 'coverage_reasons': reasons,
            'input_summaries': {k: v[0] for k, v in summaries.items() if len(v) == 1 and any(c['input_generation'] == k for c in connections)},
            'coverage': coverage, 'question_final': finals > 0, 'question_final_count': finals, 'job_closed': closed,
            'result': ('FINAL_OBSERVED' if finals else 'NO_FINAL') if closed else 'RUNNING_OR_INCOMPLETE',
            'asr_root_cause_closed': False, 'original_no_final': 'unlocated', 'connections': connections,
            'note': 'Coverage and final observation do not prove answer audio, Android consumption, or historical fault resolution.'}

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--binding', type=pathlib.Path, required=True)
    ap.add_argument('--journal', type=pathlib.Path, required=True)
    ap.add_argument('--output', type=pathlib.Path, required=True)
    args = ap.parse_args()
    if args.journal.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('use a bounded journal window under 64 MiB')
    binding = json.loads(args.binding.read_text())
    rows = [json.loads(line) for line in args.journal.read_text().splitlines() if line.strip()]
    receipt = build_receipt(binding, rows)
    args.output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: receipt[k] for k in ('device_sn', 'trace_id', 'coverage', 'result')}))
    return 0 if receipt['coverage'] == 'COVERED' and receipt['job_closed'] and receipt['question_final'] else 2

if __name__ == '__main__':
    raise SystemExit(main())
