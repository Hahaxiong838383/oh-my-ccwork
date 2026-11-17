"""Build offline clock-only overlays from exact, read-only live file snapshots.

This does not connect, deploy, restart, or modify a database. Unknown source shapes
fail before output. The before hashes are checked again by the release operator.
"""
import argparse
import hashlib
import json
from pathlib import Path


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('source anchor must occur exactly once: ' + before[:100])
    return text.replace(before, after, 1)


def build(snapshot, server, output):
    data = json.loads(snapshot.read_text())
    main = (server / 'src/routes/custom-llm.ts').read_text()
    clock_reply = main[main.index('  const clock = '):main.index('  const staticArkAnswer')]
    runtime = (server / 'src/tools/search-runtime.ts').read_text()
    clock_task = runtime[runtime.index('        const clock='):runtime.index('        if(owner.routing?.weather_enabled')]
    planned, manifest = [], []
    for index, (root, files) in enumerate(data.items()):
        for name, record in files.items():
            original = record['source']
            if hashlib.sha256(original.encode()).hexdigest() != record['sha256']:
                raise ValueError('snapshot hash mismatch: ' + root + '/' + name)
            text = original
            if name == 'src/routes/custom-llm.ts':
                text = "import {resolveClock,answerClock,stripClockTurns} from '../tools/clock-query.js';\n" + text
                text = once(text, 'stripArkDynamicTurns(rawHistory)', 'stripArkDynamicTurns(stripClockTurns(rawHistory))')
                text = once(text, '  const staticArkAnswer', clock_reply + '  const staticArkAnswer')
            elif name == 'src/tools/search-runtime.ts':
                text = "import {resolveClock,answerClock} from './clock-query.js';\n" + text
                text = once(text, 'canSubmit: r => ', "canSubmit: (r,query) => Boolean(process.env.P003_CLOCK_ENABLED!=='0'&&query&&resolveClock(query))||")
                anchor = "        if (!record?.account_id || record.status !== 'active') throw new Error('device_unavailable');\n"
                text = once(text, anchor, anchor + clock_task)
            elif name == 'src/tools/search-tasks.ts':
                for before, after in [
                    ('export type SearchResult = {', 'export type SearchResult = { clock?: {observed_at_ms:number;iana?:string};'),
                    ('canSubmit?: (routing?: TaskRouting) => boolean', 'canSubmit?: (routing?: TaskRouting, query?:string) => boolean'),
                    ('!this.opts.canSubmit(routing)', '!this.opts.canSubmit(routing,query)'),
                    ("current.outcome = result.sources.length ? 'answered'", "current.outcome = result.sources.length || result.clock ? 'answered'"),
                ]:
                    text = once(text, before, after)
            else:
                raise ValueError('unexpected target file: ' + name)
            planned.append((output / str(index) / name, text.encode()))
            manifest.append(dict(pool=root, path=name, before_sha256=record['sha256'], after_sha256=hashlib.sha256(text.encode()).hexdigest()))
        name = 'src/tools/clock-query.ts'
        content = (server / name).read_bytes()
        planned.append((output / str(index) / name, content))
        manifest.append(dict(pool=root, path=name, before_sha256=None, after_sha256=hashlib.sha256(content).hexdigest()))
    # Validate all pools before writing the first output.
    for path, content in planned:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    (output / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot', required=True, type=Path)
    parser.add_argument('--server', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    rows = build(args.snapshot, args.server, args.output)
    print(json.dumps({'files': len(rows), 'mode': 'offline_only'}))
