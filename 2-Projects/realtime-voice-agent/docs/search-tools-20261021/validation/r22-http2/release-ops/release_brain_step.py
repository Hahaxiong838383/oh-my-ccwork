r=pathlib.Path('/opt/p003/search-canary-20261021/brain');v=pathlib.Path('/opt/p003/search-verification-r17-20261026/rtc-brain');main=pathlib.Path('/opt/p003/server');b=pathlib.Path(backup)
def flags(root):
 c=sqlite3.connect('file:'+str(root/'data/config.db')+'?mode=ro',uri=True);x=dict(c.execute("select key,value from runtime_flag where key like 'p003.search.%'"));c.close();return x
def mains():return [[p['name'],p['pid'],p['pm2_env']['restart_time']]for p in json.loads(subprocess.check_output(['pm2','jlist'],text=True))]
def healthy():
 h=json.load(urllib.request.urlopen('http://127.0.0.1:3007/health',timeout=3));assert h.get('status')=='ok'and h.get('search')and h.get('tools');return h
def idle():
 h=json.loads((r/'health.json').read_text());assert h['registered']and h['jobs']==0 and h['cleanup']['healthy']and h['cleanup']['pending']==0 and time.time()*1000-h['at_ms']<12000;return h
f=flags(r);assert set(json.loads(f['p003.search.allowlist']))==set(spec['target_sns'])and int(f['p003.search.canary.expires_at_ms'])==spec['expires_at_ms'];timer()
changes={k:read_env(v/'canary.env')[k]for k in spec['brain_env_keys']}
assert changes['VOLC_LLM_BASE_URL']=='https://ark.cn-beijing.volces.com/api/plan/v3'and changes['VOLC_LLM_MODEL']=='doubao-seed-2.1-lite'
if step=='r1':
 mf=flags(main);assert set(json.loads(mf['p003.search.canary.allowlist']))==set(spec['target_sns'])and int(mf['p003.search.canary.expires_at_ms'])==spec['expires_at_ms']and mf['p003.search.canary.enabled']=='1'
 assert f['p003.search.enabled']=='1'and f['p003.search.tools']=='1'
 assert flags(v)['p003.search.enabled']=='0','verifier not closed';idle();healthy();assert not b.exists();b.mkdir(mode=0o700)
 for n,h in spec['old_source'].items():assert sha(r/n)==h,'unexpected candidate source'
 assert sha(r/'bin/search-route-preview')==spec['preview_sha256']
 names=list(spec['source'])+['canary.env','release-status.json','bin/search-route-preview'];old={n:sha(r/n)for n in names}
 for n in names:
  p=b/n;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/n,p);p.chmod(0o600)
 snap={'backup':str(b),'at_ms':int(time.time()*1000),'files':old,'main_flags':flags(main),'candidate_flags':f,'main_processes':mains(),'main_executor_sha256':sha(main/'src/tools/search-executor.ts'),'candidate_unit':unit('p003-search-brain'),'resources':{'memory':subprocess.check_output(['free','-m'],text=True),'load':pathlib.Path('/proc/loadavg').read_text(),'disk_free_bytes':shutil.disk_usage(r).free},'timer':timer(),'health':healthy()};assert snap['resources']['disk_free_bytes']>1024**3;mem=dict(l.split(':',1)for l in pathlib.Path('/proc/meminfo').read_text().splitlines());assert int(mem['MemAvailable'].strip().split()[0])>512*1024;replace(b/'manifest.json',json.dumps(snap).encode());record.update(snap)
else:
 snap=json.loads((b/'manifest.json').read_text());assert f==snap['candidate_flags'];assert mains()==snap['main_processes'];assert sha(main/'src/tools/search-executor.ts')==snap['main_executor_sha256'];assert sha(r/'bin/search-route-preview')==spec['preview_sha256']
 current=flags(main);assert all(current.get(k)==val for k,val in snap['main_flags'].items()if k!='p003.search.canary.enabled')
 def gate(value,expected):
  c=sqlite3.connect(main/'data/config.db');c.execute('begin immediate');now=dict(c.execute("select key,value from runtime_flag where key like 'p003.search.%'"));assert now=={**snap['main_flags'],'p003.search.canary.enabled':expected};c.execute("update runtime_flag set value=? where key='p003.search.canary.enabled'",(value,));c.commit();c.close()
 if step in ['pause','pause_for_rollback']:
  if step=='pause':idle()
  expected_env=snap['files']['canary.env'] if step=='pause' else json.loads((b/'r22-install.json').read_text())['env_sha256'];assert sha(r/'canary.env')==expected_env;gate('0','1');record['main_gate_closed']=True
  if step=='pause_for_rollback':record['existing_sessions']='remain until user exits or original deadline; subsequent rollback requires idle'
 elif step in ['install','rollback']:
  assert current['p003.search.canary.enabled']=='0';idle()
  want=spec['source']if step=='install'else spec['old_source'];source=v if step=='install'else b
  assert all(sha(source/n)==h for n,h in want.items())
  if step=='install':assert sha(r/'canary.env')==snap['files']['canary.env']and all(sha(r/n)==h for n,h in spec['old_source'].items())
  subprocess.run(['systemctl','stop','p003-search-brain'],check=True)
  for n,h in want.items():replace(r/n,(source/n).read_bytes(),0o644)
  env_changes=changes if step=='install'else{k:read_env(b/'canary.env').get(k)for k in spec['brain_env_keys']};patch_env(r/'canary.env',env_changes)
  if step=='install':
   rel=json.loads((b/'release-status.json').read_text());rel.update({'revision':spec['revision'],'verified_at_ms':int(time.time()*1000),'brain_commit':spec['brain_code_commit'],'worker_commit':spec['worker_code_commit'],'worker_sha256':spec['worker_sha256'],'worker_tests':spec['worker_tests'],'brain_tests':spec['brain_tests'],'preview_tests':spec['preview_tests'],'real_device_acceptance':'pending','r22_deployed_at_ms':int(time.time()*1000),'r22_rollback':str(b),'r22_limits':spec['known_limits'],'r22_latency':__LATENCY__});rel.setdefault('source_manifest',{}).update(spec['source']);replace(r/'release-status.json',json.dumps(rel,ensure_ascii=False,indent=2).encode())
  else:replace(r/'release-status.json',(b/'release-status.json').read_bytes())
  subprocess.run(['systemctl','start','p003-search-brain'],check=True)
  for _ in range(25):
   try:record['health']=healthy();break
   except Exception:time.sleep(1)
  else:raise RuntimeError('candidate health')
  assert all(sha(r/n)==h for n,h in want.items());pid=dict(l.split('=',1)for l in unit('p003-search-brain').splitlines())['MainPID'];e=dict(x.decode().split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x);assert all(e.get(k)==val for k,val in env_changes.items()if val is not None)
  record.update({'pid':pid,'source':want,'env_sha256':sha(r/'canary.env'),'runtime_env_verified':True})
 elif step in ['open','restore_gate']:
  healthy();idle();want=spec['source']if step=='open'else spec['old_source'];assert all(sha(r/n)==h for n,h in want.items());gate('1','0');record['reopened_at_ms']=int(time.time()*1000)
 else:raise RuntimeError('unknown phase')
 assert mains()==snap['main_processes'];record['main_processes_unchanged']=True;replace(b/('r22-'+step+'.json'),json.dumps(record).encode())
print(json.dumps(record))
