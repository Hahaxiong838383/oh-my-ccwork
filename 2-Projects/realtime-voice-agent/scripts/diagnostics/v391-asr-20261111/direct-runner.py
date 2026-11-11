import os,subprocess,pathlib,time,json,hashlib
D=pathlib.Path('/root/p003-v391-asr-diagnostics-20261111');r=D/('direct-'+str(time.time_ns()));r.mkdir(mode=0o700)
pid=subprocess.check_output(['systemctl','show','p003-listening-worker','-p','MainPID','--value'],text=True).strip();env={'PATH':'/usr/bin:/bin','HOME':'/root'}
for item in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0'):
 if b'='in item:
  k,v=os.fsdecode(item).split('=',1)
  if k.startswith('VOLC_'):env[k]=v
wav='/root/p003-voice-ab-20261106/normal-short.wav';env.update(P003_SYNTHETIC_ASR_WAV=wav,VOLC_ASR_HOTWORDS='',P003_DEVICE_ASR_HOTWORDS='',VOLC_ASR_BOOSTING_TABLE_ID='',P003_ASR_CONNECT_RECOVERY_V1='1')
result={'wav_sha256':hashlib.sha256(pathlib.Path(wav).read_bytes()).hexdigest(),'folder':str(r),'cases':[],'boundary':'synthetic WAV; same no-hotword config; independent Python wire versus Rust adapter; production unchanged'}
for i in range(3):
 for impl in ['reference','rust']:
  cmd=['/root/voice-venv/bin/python',str(D/'reference-asr.py')]if impl=='reference'else[str(D/'worker-probe'),'stt_volc::tests::diagnostic_live_synthetic_wav','--ignored','--exact','--nocapture']
  with(r/(impl+str(i)+'.log')).open('w')as f:q=subprocess.run(cmd,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=35)
  result['cases'].append({'impl':impl,'round':i,'rc':q.returncode,'log_sha':hashlib.sha256((r/(impl+str(i)+'.log')).read_bytes()).hexdigest()})
  D.joinpath('DIRECT-PROGRESS.json').write_text(json.dumps(result));print(json.dumps(result['cases'][-1]),flush=True)
result['passed']=all(x['rc']==0 for x in result['cases']);D.joinpath('DIRECT-RESULT.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));raise SystemExit(0 if result['passed']else 1)
