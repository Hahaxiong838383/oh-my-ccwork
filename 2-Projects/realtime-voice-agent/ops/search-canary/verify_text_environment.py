#!/usr/bin/env python3
"""Audit live candidate UTF-8 text configuration without printing configuration values."""
import argparse
import json
import pathlib
import re

TEXT_KEYS = (
    'AGENT_GREETING', 'AGENT_INSTRUCTIONS', 'BACKCHANNEL_HOTWORDS',
    'EXIT_SWALLOW_HOTWORDS', 'INTERRUPT_HOTWORDS', 'P003_DEVICE_ASR_HOTWORDS',
    'VOLC_ASR_HOTWORDS',
)


def escaped_text_keys(environment):
    # systemd EnvironmentFile is not a JSON decoder. A JSON \uXXXX string can
    # reach the process literally and silently break Chinese word matching.
    return [key for key in TEXT_KEYS
            if re.search(r'\\u[0-9a-fA-F]{4}', environment.get(key, ''))]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', required=True, type=int)
    args = parser.parse_args()
    if args.pid <= 0:
        parser.error('pid must be positive')
    raw = pathlib.Path(f'/proc/{args.pid}/environ').read_bytes()
    environment = dict(item.decode('utf-8').split('=', 1)
                       for item in raw.split(b'\0') if b'=' in item)
    bad = escaped_text_keys(environment)
    print(json.dumps({'ok': not bad, 'escaped_text_keys': bad,
                      'checked_keys': [k for k in TEXT_KEYS if k in environment]}))
    raise SystemExit(1 if bad else 0)


if __name__ == '__main__':
    main()
