r=pathlib.Path('/opt/p003-search-canary-20261021');v=pathlib.Path('/opt/p003-search-verification-20261026');b=pathlib.Path(backup);hf=pathlib.Path('/run/p003-search-canary/health.json');audit=pathlib.Path('/etc/systemd/system/p003-search-worker.service.d/22-text-audit.conf')
def idle():
 h=json.loads(hf.read_text());assert h['registered']and h['jobs']==0 and h['cleanup']['healthy']and h['cleanup']['remaining']==0 and time.time()*1000-h['at_ms']<12000;return h
def window():
 w=json.loads((r/'window.json').read_text());assert set(w['allowlist'])==set(spec['target_sns'])and w['expires_at_ms']==spec['expires_at_ms'];return w
w=window();timer();active=r/'voice-rust-worker';new=v/'voice-rust-worker.r22-http2-new';changes=spec['worker_env_changes']
if step=='r1':
 assert not json.loads((v/'window.json').read_text())['enabled'],'verifier not closed';idle();assert not b.exists();b.mkdir(mode=0o700);assert sha(active)==spec['worker_old_sha256'];assert w['enabled']
 files={n:sha(r/n)for n in ['voice-rust-worker','canary.env','window.json']}
 for n in files:shutil.copy2(r/n,b/n);(b/n).chmod(0o600)
 snap={'backup':str(b),'at_ms':int(time.time()*1000),'files':files,'window':w,'units':{u:unit(u)for u in ['voice-worker-rust','p003-search-worker']},'audit_sha256':sha(audit),'resources':{'memory':subprocess.check_output(['free','-m'],text=True),'load':pathlib.Path('/proc/loadavg').read_text(),'disk_free_bytes':shutil.disk_usage(r).free},'timer':timer(),'health':idle()};assert snap['resources']['disk_free_bytes']>1024**3;mem=dict(l.split(':',1)for l in pathlib.Path('/proc/meminfo').read_text().splitlines());assert int(mem['MemAvailable'].strip().split()[0])>512*1024;replace(b/'manifest.json',json.dumps(snap).encode());record.update(snap)
else:
 snap=json.loads((b/'manifest.json').read_text());assert unit('voice-worker-rust')==snap['units']['voice-worker-rust'];assert sha(audit)==snap['audit_sha256'];assert {**w,'enabled':True}==snap['window']
 if step in ['install','rollback']:
  idle();w['enabled']=False;replace(r/'window.json',json.dumps(w).encode());time.sleep(2);idle()
  want=spec['worker_sha256']if step=='install'else spec['worker_old_sha256'];source=new if step=='install'else b/'voice-rust-worker';assert sha(source)==want
  if step=='install':
   assert sha(active)==spec['worker_old_sha256']and sha(r/'canary.env')==snap['files']['canary.env']
   assets=pathlib.Path(changes['P003_SEARCH_RECEIPTS_DIR']);assets.mkdir(mode=0o755,exist_ok=True)
   for n,h in spec['assets'].items():
    p=v/'assets-r22'/n;assert sha(p)==h
    if(assets/n).exists():assert sha(assets/n)==h
    else:replace(assets/n,p.read_bytes(),0o644)
  subprocess.run(['systemctl','stop','p003-search-worker'],check=True);replace(active,source.read_bytes(),0o755)
  patch_env(r/'canary.env',changes if step=='install'else{k:read_env(b/'canary.env').get(k)for k in changes})
  started=time.time()*1000;subprocess.run(['systemctl','start','p003-search-worker'],check=True)
  for _ in range(25):
   time.sleep(1)
   try:
    h=idle()
    if h['at_ms']>started:break
   except Exception:pass
  else:raise RuntimeError('candidate worker health')
  pid=dict(l.split('=',1)for l in unit('p003-search-worker').splitlines())['MainPID'];assert sha(pathlib.Path('/proc',pid,'exe'))==want
  actual=dict(x.decode().split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x);desired=read_env(r/'canary.env');assert all(actual.get(k)==val for k,val in desired.items())
  record.update({'pid':pid,'sha256':want,'env_sha256':sha(r/'canary.env'),'health':h,'runtime_env_verified':True,'utf8_start_audit_preserved':True})
 elif step in ['open','restore_window']:
  idle();assert sha(active)==(spec['worker_sha256']if step=='open'else spec['worker_old_sha256']);w=window();w['enabled']=True;replace(r/'window.json',json.dumps(w).encode());record['window']=w
 else:raise RuntimeError('unknown phase')
 assert unit('voice-worker-rust')==snap['units']['voice-worker-rust'];record['main_process_unchanged']=True;replace(b/('r22-'+step+'.json'),json.dumps(record).encode())
print(json.dumps(record))
