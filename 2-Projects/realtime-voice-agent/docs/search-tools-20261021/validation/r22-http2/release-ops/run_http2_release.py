"""Supervised one-step release. Prints only the templates' redacted records."""
from pathlib import Path
import json,sys,subprocess,datetime,hashlib
D=Path(__file__).parent;sys.path.insert(0,str(D.parent));from remote import command
host,step=sys.argv[1:3];assert host in ['brain','worker'];assert step in ['r1','pause','pause_for_rollback','install','open','rollback','restore_gate','restore_window']
spec=json.loads((D/'release-http2-spec.json').read_text());corrected='--corrected-measurement'in sys.argv
ready_path=D/('release-http2-corrected-ready.json'if corrected else'release-http2-ready.json')
session_path=D/'release-http2-session.json'
if '--compile-only'in sys.argv:
 backup='/tmp/not-executed';summary={}
else:
 ready=json.loads(ready_path.read_text());assert ready['ready']and ready['release_spec_sha256']==hashlib.sha256((D/'release-http2-spec.json').read_bytes()).hexdigest()
 assert json.loads((D/'http2-cross-ready.json').read_text())['passed']and json.loads((D/'http2-expiry-ready.json').read_text())['passed']
 assert json.loads((D/'http2-expiry-brain-close.json').read_text())['closed']and json.loads((D/'http2-expiry-worker-close.json').read_text())['closed']
 if not session_path.exists():
  assert step=='r1';stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');session={'label':'R22-http2-'+stamp,'measurement':'corrected'if corrected else'original','spec_sha256':ready['release_spec_sha256'],'ready_sha256':hashlib.sha256(ready_path.read_bytes()).hexdigest()};session_path.write_text(json.dumps(session,indent=2));session_path.chmod(0o600)
 session=json.loads(session_path.read_text());assert session['measurement']==('corrected'if corrected else'original')and session['spec_sha256']==ready['release_spec_sha256']and session['ready_sha256']==hashlib.sha256(ready_path.read_bytes()).hexdigest()
 backup=('/opt/p003/backups/'if host=='brain'else'/opt/p003-search-canary-20261021/backups/')+session['label'];summary=ready['summary']
source=(D/'release_common.py').read_text()+(D/('release_brain_step.py'if host=='brain'else'release_http2_worker_step.py')).read_text()
for a,b in {'__SPEC__':repr(spec),'__STEP__':repr(step),'__BACKUP__':repr(backup),'__LATENCY__':repr(summary)}.items():source=source.replace(a,b)
compile(source,'release-'+host+'-'+step,'exec')
if '--compile-only'in sys.argv:print(json.dumps({'host':host,'step':step,'compiled':True,'executed':False}));sys.exit(0)
out=D/('release-http2-'+host+'-'+step+'.json');assert not out.exists(),'step record exists; inspect current remote state before any retry'
p=subprocess.run(command(host,'python3 -'),input=source,text=True,capture_output=True,timeout=90)
(D/('release-http2-'+host+'-'+step+'.stderr')).write_text(p.stderr)
if p.returncode:
 (D/('release-http2-'+host+'-'+step+'-failed.stdout')).write_text(p.stdout);raise SystemExit('release step failed or observation unknown; no automatic retry')
v=json.loads(p.stdout);out.write_text(json.dumps(v,indent=2));out.chmod(0o600);print(json.dumps(v))
