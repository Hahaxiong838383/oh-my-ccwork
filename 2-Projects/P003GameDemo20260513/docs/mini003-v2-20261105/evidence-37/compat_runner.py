import pathlib,subprocess,tarfile,io,hashlib,os,json,concurrent.futures,time
D=pathlib.Path(__file__).resolve().parent; out=D/'run-candidate-v2-compat';out.mkdir(mode=0o700,exist_ok=False)
repo='/Users/fu-121/.codex/worktrees/p003-auto-enrollment-20261104';pre='2-Projects/P003GameDemo20260513/apps/server';sha='a92bd8f342144d6253cbb9a928925639ffa597cc'
blob=subprocess.check_output(['git','archive',sha,pre+'/src',pre+'/scripts',pre+'/package.json'],cwd=repo)
with tarfile.open(fileobj=io.BytesIO(blob)) as t:t.extractall(out/'archive',filter='data')
root=out/'archive'/pre; (root/'node_modules').symlink_to((pathlib.Path(repo)/pre/'node_modules').resolve(),target_is_directory=True)
tests=['device-enrollment-http','ble-binding-http','pairing']
(out/'inputs.json').write_text(json.dumps({'sha':sha,'archive_sha256':hashlib.sha256(blob).hexdigest(),'files':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file() and 'node_modules' not in p.parts}},indent=2))
def run(n):
 cwd=out/n;cwd.mkdir();env={'PATH':os.environ['PATH'],'TZ':'Asia/Shanghai','LOCAL_AUDIO_GENERATION_PAUSED':'1','HOME':str(cwd)}
 for v in ['DEVICES','ACCOUNTS','PROFILE','PAIRING','CONFIG','MEMORY','TELEMETRY','LOCAL_AUDIO']:env[v+'_DB_PATH']=str(cwd/(v+'.db'))
 env['DEVICE_ENROLLMENT_CONFIG_PATH']=str(cwd/'absent.json');start=time.time()
 with (out/(n+'.log')).open('w') as f:
  r=subprocess.run(['node','--experimental-sqlite','--import',str(root/'node_modules/tsx/dist/loader.mjs'),str(root/'scripts'/(n+'.test.ts'))],cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=60)
 raw=(out/(n+'.log')).read_bytes();return {'test':n,'exit':r.returncode,'seconds':round(time.time()-start,2),'log_sha256':hashlib.sha256(raw).hexdigest(),'tail':raw.decode().splitlines()[-8:]}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex: results=list(ex.map(run,tests))
(out/'result.json').write_text(json.dumps({'candidate':sha,'tests':results,'scope':'37 fixed SHA old v1 HTTP + 12-line BLE routes + pairing regressions; private synthetic DB'},indent=2));print(json.dumps(results,ensure_ascii=False));raise SystemExit(any(x['exit'] for x in results))
