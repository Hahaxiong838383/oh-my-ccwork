#!/usr/bin/env python3
"""Offline-only release/restore rehearsal using actual read-only live snapshots.
Usage: python3 scripts/listening-release-prepare.py STATE_DIRECTORY NEW_OUTPUT_DIRECTORY
No SSH, production writes, dependency install, environment or service changes.
"""
import base64,hashlib,json,os,pathlib,shutil,subprocess,sys,time,difflib
sha=lambda b:hashlib.sha256(b).hexdigest()
state,out=map(lambda x:pathlib.Path(x).resolve(),sys.argv[1:])
project=pathlib.Path(__file__).resolve().parents[1]
repo=pathlib.Path(subprocess.check_output(['git','-C',str(project),'rev-parse','--show-toplevel'],text=True).strip())
if out.exists() or str(out).startswith('/opt/') or repo==out or repo in out.parents:raise SystemExit('Use NEW isolated output outside repository and /opt')
out.mkdir(mode=0o700);os.umask(0o077)
first=json.loads((state/'38-live-private.json').read_text());second=json.loads((state/'38-live-routing-private.json').read_text())
assets=json.loads((state/'38-live-assets-private.json').read_text())
files={**first['files'],**second['files'],**{k:v for k,v in assets['files'].items() if pathlib.Path(k).suffix in ['.mjs','.cjs','.mts']}};server_prefix='/opt/p003/server/';html='/opt/p003/web/dist/admin/index.html'
# Explicit listening-only file allowlist. Preserve ahead-of-branch providers/search/package/lock.
paths=['src/index.ts','src/routes/device-session.ts','src/routes/listening-admin.ts','src/routes/listening.ts',*sorted(str(p.relative_to(project)) for p in (project/'src').glob('listening-*.ts'))]
changes=[];live=out/'live';candidate=out/'candidate';payload=out/'payload';backup=out/'restore';diff=[]
for root in [live,candidate,payload,backup]:root.mkdir()
for absolute,v in files.items():
 if not v.get('exists',True) or 'base64' not in v:continue
 if absolute.startswith(server_prefix):relative='server/'+absolute[len(server_prefix):]
 elif absolute==html:relative='web/dist/admin/index.html'
 else:continue
 raw=base64.b64decode(v['base64']);assert sha(raw)==v['sha256']
 for root in [live,candidate]:
  p=root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw);p.chmod(int(v.get('mode','0o644'),8))
for name in [*paths,'@admin']:
 target=html if name=='@admin' else server_prefix+name
 relative='web/dist/admin/index.html' if name=='@admin' else 'server/'+name
 source=repo/'2-Projects/P003GameDemo20260513/apps/web/public/admin/index.html' if name=='@admin' else project/name
 raw=source.read_bytes();prior=files.get(target);before=prior.get('sha256') if prior and prior.get('exists',True) else None
 if before==sha(raw):continue
 if before:
  old=base64.b64decode(prior['base64']);p=backup/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(old);p.chmod(int(prior['mode'],8))
  diff.extend(difflib.unified_diff(old.decode().splitlines(True),raw.decode().splitlines(True),fromfile='live/'+relative,tofile='candidate/'+relative))
 for root in [candidate,payload]:
  p=root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw);p.chmod(int(prior['mode'],8) if before else 0o644)
 changes.append({'target':target,'relative':relative,'before_sha256':before,'after_sha256':sha(raw),'before_mode':prior.get('mode') if before else None,'after_mode':prior.get('mode') if before else '0o644','source':str(source.relative_to(repo))})
# Rehearsal is file operations in a disposable clone, not a production deployment.
trial=out/'rehearsal';shutil.copytree(live,trial)
def fingerprint(root):return {str(p.relative_to(root)):sha(p.read_bytes()) for p in root.rglob('*') if p.is_file()}
def guard(root,field):
 for c in changes:
  p=root/c['relative'];actual=sha(p.read_bytes()) if p.exists() else None
  if actual!=c[field]:raise RuntimeError('precondition_drift:'+c['relative'])
def replace(root,c,src,mode):
 p=root/c['relative'];p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_name(p.name+'.p003-stage');tmp.write_bytes(src.read_bytes());tmp.chmod(int(mode,8));os.replace(tmp,p)
original=fingerprint(trial);guard(trial,'before_sha256')
# Demonstrate that concurrent file drift blocks all writes before the batch starts.
probe=next(c for c in changes if c['before_sha256']);probe_file=trial/probe['relative'];saved=probe_file.read_bytes();probe_file.write_bytes(saved+b'\n// isolated concurrent edit\n')
try:guard(trial,'before_sha256');raise AssertionError('drift not rejected')
except RuntimeError:pass
probe_file.write_bytes(saved);guard(trial,'before_sha256')
for c in changes:replace(trial,c,payload/c['relative'],c['after_mode'])
guard(trial,'after_sha256');after=fingerprint(trial)
# Restore requires exact candidate hash, never overwrites a subsequent release.
for c in changes:
 if c['before_sha256']:replace(trial,c,backup/c['relative'],c['before_mode'])
 else:(trial/c['relative']).unlink()
assert fingerprint(trial)==original,'restore did not match actual live snapshot'
for c in changes:
 if c['before_sha256']:assert oct((trial/c['relative']).stat().st_mode&0o777)==c['before_mode']
preserved=[k for k in original if k not in {c['relative'] for c in changes}]
assert all(after[k]==original[k] for k in preserved)
(out/'listening.patch').write_text(''.join(diff))
manifest={'kind':'offline_candidate_actual_live_restore_not_deployed','created_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'observed_at_utc':[first['observed_at_utc'],second['observed_at_utc']],
 'brain_commit':subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip(),'snapshots':{n:sha((state/n).read_bytes()) for n in ['38-live-private.json','38-live-routing-private.json','38-live-assets-private.json']},
 'files':changes,'unchanged_files_preserved':len(preserved),'rehearsal':{'preflight_drift_rejected':True,'apply_hashes_match':True,'restore_hashes_and_modes_match':True,'unrelated_files_preserved':True},
 'excludes':['production environment','databases and WAL','node_modules','package.json/package-lock.json','search-canary deployment','nginx','analytics','production service state'],
 'source_of_restore':'actual live bytes captured over strict SSH; not Git baseline'}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'output':str(out),'changed_files':len(changes),'manifest_sha256':sha((out/'manifest.json').read_bytes()),'rehearsal':manifest['rehearsal']}))
