#!/usr/bin/env python3
"""Bounded isolated load with independent procfs I/O samples and durable receipts."""
import argparse, json, os, re, signal, subprocess, time
from pathlib import Path

ROOT = Path('/opt/p003/analytics-staging-20261013')
SERVER = ROOT / 'server'
NODE = '/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node'

def sample():
    cpu = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:]]
    disks = {}
    for line in Path('/proc/diskstats').read_text().splitlines():
        fields = line.split()
        if fields[2] == 'vda': disks['vda'] = [int(x) for x in fields[3:]]
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in ['MemAvailable', 'Dirty', 'Writeback', 'SwapFree']: memory[key] = int(value.split()[0]) * 1024
    return {'at_ms': int(time.time() * 1000), 'cpu': cpu, 'disks': disks, 'memory_bytes': memory}

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(); parser.add_argument('label'); args = parser.parse_args()
    assert re.fullmatch(r'[a-z0-9-]{1,60}', args.label)
    assert Path.cwd().resolve() == SERVER
    out = ROOT / 'evidence' / ('capacity-' + args.label)
    out.mkdir(mode=0o700)  # Never overwrite another attempt.
    before = set((ROOT / 'evidence').glob('load-*.json'))
    snapshots = [sample()]; started = time.monotonic()
    env = dict(os.environ, NO_PROXY='*', HTTP_PROXY='', HTTPS_PROXY='', ALL_PROXY='')
    with (out / 'load.log').open('x') as log:
        process = subprocess.Popen([NODE, '--env-file=.env.stage', 'deploy/analytics-smoke-and-load.mjs', 'load'], cwd=SERVER, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        timed_out = False
        while process.poll() is None:
            if time.monotonic() - started > 390:
                timed_out = True; os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL); process.wait()
                break
            time.sleep(1); snapshots.append(sample())
    (out / 'os-samples.json').write_text(json.dumps(snapshots))
    profiles = []
    if 'analytics-stage-profile' in (SERVER / 'deploy/analytics-stage-ingest.ts').read_text():
        probe = subprocess.run(['fuser', '-n', 'tcp', '3306'], capture_output=True, text=True)
        pids = [int(x) for x in probe.stdout.split() if x.isdigit()]
        assert len(pids) == 1
        pid = pids[0]; assert (Path('/proc') / str(pid) / 'cwd').resolve() == SERVER
        profile = ROOT / 'evidence' / ('sql-profile-' + str(pid) + '.json')
        previous_mtime = profile.stat().st_mtime_ns if profile.exists() else -1
        os.kill(pid, signal.SIGUSR2)
        deadline = time.monotonic() + 10
        while (not profile.exists() or profile.stat().st_mtime_ns == previous_mtime) and time.monotonic() < deadline: time.sleep(.1)
        if profile.exists() and profile.stat().st_mtime_ns != previous_mtime:
            (out / 'sql-profile.json').write_bytes(profile.read_bytes()); profiles.append(profile.name)
    reports = set((ROOT / 'evidence').glob('load-*.json')) - before
    valid = [p for p in reports if re.fullmatch(r'load-\d+\.json', p.name)]
    report = json.loads(valid[0].read_text()) if len(valid) == 1 else None
    if report is not None: (out / 'load.json').write_text(json.dumps(report, indent=2))
    result = {'ok': process.returncode == 0 and report is not None and report.get('ok') is True and not timed_out,
              'label': args.label, 'exit_code': process.returncode, 'timeout': timed_out, 'seconds': time.monotonic() - started,
              'report_file': valid[0].name if len(valid) == 1 else None, 'profiles': profiles, 'os_samples': len(snapshots),
              'real_device_data_used': False, 'production_changed': False}
    (out / 'result.json').write_text(json.dumps(result, indent=2)); print(json.dumps(result))

if __name__ == '__main__': main()
