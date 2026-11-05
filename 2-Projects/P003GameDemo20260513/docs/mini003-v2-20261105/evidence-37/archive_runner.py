#!/usr/bin/env python3
"""37 私有固定 SHA 归档验收；不读取未提交实现、不修改源树、不安装依赖。"""
import argparse,hashlib,json,pathlib,re,subprocess,tarfile,io,datetime,os
p=argparse.ArgumentParser();p.add_argument('--sha',required=True);p.add_argument('--label',required=True);p.add_argument('--cases',default='');a=p.parse_args()
assert re.fullmatch('[0-9a-f]{40}',a.sha)
assert re.fullmatch('[a-z0-9-]{1,50}',a.label)
D=pathlib.Path(__file__).resolve().parent
repo=pathlib.Path('/Users/fu-121/.codex/worktrees/p003-auto-enrollment-20261104')
prefix='2-Projects/P003GameDemo20260513/apps/server'
assert subprocess.check_output(['git','rev-parse',a.sha+'^{commit}'],cwd=repo,text=True).strip()==a.sha
out=D/('run-'+a.label);out.mkdir(mode=0o700,exist_ok=False)
blob=subprocess.check_output(['git','archive',a.sha,prefix+'/src',prefix+'/package.json'],cwd=repo)
with tarfile.open(fileobj=io.BytesIO(blob)) as t:t.extractall(out/'archive',filter='data')
root=out/'archive'/prefix
(root/'node_modules').symlink_to((repo/prefix/'node_modules').resolve(),target_is_directory=True)
script=D/'v2-contract.mjs'
inputs={str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((root/'src').rglob('*')) if f.is_file()}
manifest={'sha':a.sha,'archive_sha256':hashlib.sha256(blob).hexdigest(),'script_sha256':hashlib.sha256(script.read_bytes()).hexdigest(),'race_worker_sha256':hashlib.sha256((D/'v2-race-worker.mjs').read_bytes()).hexdigest(),'files':inputs,'scope':'selected real Hono routes + real isolated SQLite + SMS verify; no main/public/SMS delivery/device'}
(out/'inputs.json').write_text(json.dumps(manifest,indent=2)+'\n')
env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'TZ':'Asia/Shanghai'}
with (out/'runner.log').open('w') as log:
 r=subprocess.run(['node','--experimental-sqlite','--import',str(root/'node_modules/tsx/dist/loader.mjs'),str(script),str(root),str(out/'result.json'),a.cases],env=env,cwd=out,stdout=log,stderr=subprocess.STDOUT,timeout=90)
print(json.dumps({'sha':a.sha,'label':a.label,'exit_code':r.returncode,'result':str(out/'result.json')},ensure_ascii=False))
raise SystemExit(r.returncode)
