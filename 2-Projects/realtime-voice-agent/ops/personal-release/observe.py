"""Sample the personal release on NAS and ECS without printing credentials."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import shlex
import subprocess
import sys


OPS = Path(__file__).resolve().parent.parent
NAS = 'hahaxiong83@192.168.1.115'
WEB_FILES = ('index.html', 'voice.js', 'style.css', 'livekit.js', 'LIVEKIT-LICENSE')
WHITEBOX_FILES = ('/app/whitebox.html', '/app/whitebox.js', '/app/whitebox.css')
# Pre-V3 admin images have a four-file manifest. A V3 server or any V3 asset
# requires all three new files; a partial deployment must fail the sample.
WHITEBOX_PROBE = """server=$1
shift
for path do
    if [ -e "$path" ]; then exec sha256sum "$@"; fi
done
if grep -Fq '/app/whitebox.html' "$server"; then exec sha256sum "$@"; fi
"""
NAS_COMPONENTS = {
    'personal-admin': ('personal-voice-admin-admin-1', ['/app/server.mjs', '/app/index.html', '/app/design.html', '/app/event-property-schema-v1.json']),
    'personal-brain': ('personal-brain-brain-1', ['/app/server.mjs']),
    'personal-worker': ('personal-voice-worker-worker-1', ['/usr/local/bin/voice-rust-worker']),
    'personal-worker-eot': ('personal-voice-worker-worker-1', ['/opt/voice/eot_sidecar.py', '/opt/voice/assets/silero_vad.onnx']),
    'personal-local-speech': ('personal-local-speech', ['/app/server.py']),
}


def fingerprint(files):
    if len(files) == 1:
        return next(iter(files.values()))
    digest = hashlib.sha256()
    for name, value in sorted(files.items()):
        digest.update(name.encode() + b'\0' + bytes.fromhex(value))
    return digest.hexdigest()


def parse_sums(text):
    rows = {}
    for row in text.splitlines():
        value, name = row.split(maxsplit=1)
        name = name.strip()
        if len(value) != 64 or len(bytes.fromhex(value)) != 32 or name in rows:
            raise ValueError('Unexpected sha256sum output')
        rows[name] = value
    return rows


def observe():
    details, images = {}, {}
    edge_names = {'personal-edge-livekit':'bin/livekit-server', 'personal-edge-ticket':'ticket.py',
                  'personal-edge-gateway':'nginx.conf', 'personal-edge-sfu-config':'livekit.yaml'}
    paths = [*edge_names.values(), *('public/talk/' + name for name in WEB_FILES)]
    result = subprocess.check_output([sys.executable, str(OPS/'personal-edge/ecs-run.py'), 'read-release'],
        input='set -eu\ncd /opt/personal-edge\nsha256sum ' + shlex.join(paths), text=True)
    edge = parse_sums(result)
    details.update({key:{path:edge[path]} for key,path in edge_names.items()})
    details['personal-browser'] = {name:edge['public/talk/'+name] for name in WEB_FILES}

    secret = subprocess.check_output(['vw','get','password','飞牛nas登录信息'],stderr=subprocess.DEVNULL).rstrip() + b'\n'
    commands = ['set -eu']
    for component,(container,files) in NAS_COMPONENTS.items():
        sample = ['sha256sum', *files]
        if component == 'personal-admin':
            probe = shlex.join(sample) + '\n' + WHITEBOX_PROBE
            sample = ['sh', '-ec', probe, 'whitebox', '/app/server.mjs', *WHITEBOX_FILES]
        commands += ['echo '+component,
            'docker inspect -f '+shlex.quote('{{.State.Running}} {{.Image}}')+' '+container,
            shlex.join(['docker', 'exec', container, *sample]), 'echo END:'+component]
    model_probe = """from pathlib import Path
import hashlib,json
root=Path('/models')
files=sorted((p for p in root.rglob('*') if p.is_file()), key=lambda p:p.relative_to(root).as_posix())
h=hashlib.sha256()
for p in files:
 with p.open('rb') as f:
  h.update(p.relative_to(root).as_posix().encode()+b'\\0'+hashlib.file_digest(f, 'sha256').digest())
assert len(files)>4
print(json.dumps({'sha256':h.hexdigest(),'count':len(files)}))
"""
    commands.append(shlex.join(['docker','exec','personal-local-speech','python','-c',model_probe]))
    stdout = subprocess.check_output(['ssh','-T','-oBatchMode=yes',NAS,
        'sudo -S -p "" -- sh -c '+shlex.quote('\n'.join(commands))],input=secret).decode().splitlines()
    at=0
    for key,(_,files) in NAS_COMPONENTS.items():
        if stdout[at] != key: raise ValueError('Unexpected component order')
        running,image = stdout[at+1].split()
        if running != 'true': raise RuntimeError('Not running: '+key)
        images[key] = image
        end = stdout.index('END:'+key, at+2)
        details[key] = parse_sums('\n'.join(stdout[at+2:end]))
        expected = set(files)
        if key == 'personal-admin' and expected != set(details[key]):
            expected.update(WHITEBOX_FILES)
        if set(details[key]) != expected: raise RuntimeError('Incomplete evidence: '+key)
        at = end+1
    if len(stdout) != at+1: raise ValueError('Unexpected output after file sampling')
    models = json.loads(stdout[at])
    details['personal-speech-models'] = {'/models (sorted regular-file manifest)':models['sha256']}
    return {'at':datetime.now(timezone.utc).isoformat(timespec='seconds'), 'scope':'personal-voice',
            'components':{key:fingerprint(files) for key,files in details.items()},
            'files':details, 'nas_images':images, 'model_file_count':models['count']}


if __name__ == '__main__':
    print(json.dumps(observe(), ensure_ascii=False, indent=2))
