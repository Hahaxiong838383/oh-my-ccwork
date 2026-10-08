#!/usr/local/bin/python3
"""Check Grok's four-tier model metadata; --apply repairs it via Codeg's API."""
import argparse
import copy
import json
import os
import re
import runpy
import stat
import tomllib
import urllib.request
from pathlib import Path

MODEL = 'grok-4.7'
TIERS = [
    {'value': 'low', 'label': 'Low'},
    {'value': 'medium', 'label': 'Medium'},
    {'value': 'high', 'label': 'High', 'default': True},
    {'value': 'xhigh', 'label': 'Max'},
]
FRAGMENT = '''reasoning_efforts = [
  { value = "low", label = "Low" },
  { value = "medium", label = "Medium" },
  { value = "high", label = "High", default = true },
  { value = "xhigh", label = "Max" }
]'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Repair metadata via the official Codeg config API.')
    args = parser.parse_args()
    if os.getuid() != 0:
        parser.error('Run on the company Studio as root to read its dedicated Codeg System Keychain item.')
    launcher = Path('/Library/Application Support/Codeg-company-studio/runner.py')
    for path in [launcher.parent, launcher]:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Untrusted deployed launcher path')
    token = runpy.run_path(str(launcher))['credential']()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def api(name, body):
        request = urllib.request.Request(
            'http://127.0.0.1:3080/api/' + name,
            data=json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
        )
        with opener.open(request, timeout=25) as response:
            return json.load(response)

    def current():
        agents = [a for a in api('acp_list_agents', {}) if a.get('agent_type') == 'grok']
        if len(agents) != 1 or not isinstance(agents[0].get('grok_config_toml'), str):
            raise RuntimeError('Expected one installed Grok agent with native config')
        return agents[0]['grok_config_toml']

    raw = current()
    original = tomllib.loads(raw)
    if original.get('models', {}).get('default') != MODEL:
        raise RuntimeError('Unexpected default model; refusing to change another model')
    model = original.get('model', {}).get(MODEL)
    if not isinstance(model, dict) or not model.get('api_key'):
        raise RuntimeError('Configure the personal CPA model and its key in Codeg first')
    if model.get('base_url') != 'https://smart-api.hahaxiong.top/v1' or model.get('api_backend') != 'responses':
        raise RuntimeError('Unexpected provider config; refusing to modify it')
    matches = model.get('reasoning_efforts') == TIERS
    report = {'model': MODEL, 'tiers': [x['value'] for x in TIERS], 'display_labels': [x['label'] for x in TIERS],
              'default_reasoning_effort': original.get('models', {}).get('default_reasoning_effort'),
              'metadata_matches': matches, 'applied': False, 'stale_connections': 0}
    if args.apply and not matches:
        heads = list(re.finditer(r'(?m)^\[model\.(?:"grok-4\.7"|\x27grok-4\.7\x27)\][ \t]*$', raw))
        if len(heads) != 1:
            raise RuntimeError('Unsupported model table spelling; use Codeg advanced config editor')
        start = heads[0].end()
        next_header = re.search(r'(?m)^\[', raw[start + 1:])
        end = start + 1 + next_header.start() if next_header else len(raw)
        section = raw[start:end]
        array = re.search(r'(?ms)^reasoning_efforts[ \t]*=[ \t]*\[(.*?)^\]', section)
        if 'reasoning_efforts' in model:
            if not array:
                raise RuntimeError('Unsupported metadata formatting; use Codeg advanced config editor')
            left, right = start + array.start(), start + array.end()
            candidate = raw[:left] + FRAGMENT + raw[right:]
        else:
            candidate = raw[:start] + '\n' + FRAGMENT + raw[start:]
        expected = copy.deepcopy(original)
        expected['model'][MODEL]['reasoning_efforts'] = TIERS
        if tomllib.loads(candidate) != expected:
            raise RuntimeError('Patch changes unrelated config')
        if current() != raw:
            raise RuntimeError('Config changed concurrently; do not overwrite')
        report['stale_connections'] = api('acp_update_agent_config', {
            'agentType': 'grok', 'grokConfigToml': candidate, 'grokStructured': None,
        })
        if tomllib.loads(current()) != expected:
            raise RuntimeError('Official API readback mismatch')
        report.update(metadata_matches=True, applied=True, unrelated_config_and_credentials_preserved=True)
    if token in json.dumps(report) or model['api_key'] in json.dumps(report):
        raise RuntimeError('Unexpected credential in report')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['metadata_matches'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
