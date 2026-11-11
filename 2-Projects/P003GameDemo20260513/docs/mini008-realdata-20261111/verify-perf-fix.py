"""Run only synthetic, isolated tests against an explicit server source directory."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--server', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--main-scripts', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
args = parser.parse_args()
root, out = args.server.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
node = '/Users/fu-121/.local/node-v24/bin/node'
loader = str(root / 'node_modules/tsx/dist/loader.mjs')
results = []


def run(name, command, extra=None, expected=0):
    cwd = tempfile.mkdtemp(prefix='mini008-perf-regression-')
    env = {**os.environ, 'SERVER_UNDER_TEST': str(root), **(extra or {})}
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, timeout=120)
    log = out / (name + '.log')
    log.write_bytes(result.stdout + result.stderr)
    results.append({'test': name, 'exit_code': result.returncode, 'expected_exit': expected,
                    'log': str(log), 'isolated_cwd': cwd})
    print(name, result.returncode, flush=True)


for name in ['mini008-dashboard', 'telemetry', 'ark-state', 'ark-runtime', 'ark-proxy', 'ark-history']:
    run(name, [node, '--import', loader, str(root / f'scripts/{name}.test.ts')])
run('main-independent', [node, '--import', loader, str(args.main_scripts.resolve() / 'main-independent.mts')])
run('focus-perf', [node, str(root / 'scripts/mini008-focus-perf.mts')],
    {'PERF_REPORT': str(out / 'perf-queryplan.json'), 'PERF_BASELINE': str(args.baseline.resolve())})
run('main-usage-perf', [node, str(args.main_scripts.resolve() / 'main-usage-perf.mts')])
run('ark-resource-known-failure', [node, '--import', loader, str(root / 'scripts/ark-resource.test.ts')], expected=1)
run('tsc-known-failure', [node, str(root / 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', str(root / 'tsconfig.json')], expected=2)
(out / 'RESULTS.json').write_text(json.dumps({'server': str(root), 'results': results}, indent=2) + '\n')
assert all(r['exit_code'] == r['expected_exit'] for r in results), 'unexpected regression result; inspect logs'
