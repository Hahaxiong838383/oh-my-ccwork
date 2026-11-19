"""Explicit per-pool ASR diagnostic release; no other feature/config changes.
Run on the existing Worker host with: script.py main|listening check|apply|rollback.
Private SPEC.json, reviewed helper and candidate live under the fixed staging path.
"""
from pathlib import Path
import fcntl, hashlib, importlib.util, json, os, subprocess, sys, time

D = Path('/root/p003-asr-three-device-20261116')

def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def atomic(path, data, mode=0o600):
    temp = path.with_name(path.name + '.asr-diag.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists(): temp.unlink()

def main(pool, mode):
    assert pool in ('main', 'listening') and mode in ('check', 'apply', 'rollback')
    assert subprocess.check_output(['hostname'], text=True).strip() == 'voice-worker-hk2'
    os.umask(0o077)
    spec = json.loads((D/'SPEC.json').read_text())
    cp = spec['pools'][pool]; unit_name = cp['unit']; root = Path(cp['root'])
    binary = root/'voice-rust-worker'; envpath = Path(cp['files']['env']['path'])
    unitpath = Path(cp['files']['unit']['path'])
    meta = root/'stop-variants-release.json' if pool == 'main' else None
    before_binary = cp['process_sha256']
    after_binary = spec['binary_sha256'] if pool == 'main' else before_binary
    backup = D/('release-before-'+pool); receipt = D/('RELEASE-'+pool+'.json')
    helper_spec = importlib.util.spec_from_file_location('diag_env', D/'asr_diagnostic_env.py')
    helper = importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helper)
    assert sha(D/'asr_diagnostic_env.py') == spec['helper_sha256']
    assert sha(Path(__file__)) == spec['deployer_sha256']
    with envpath.with_name(envpath.name+'.config.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def unit(name=unit_name):
            return dict(x.split('=', 1) for x in subprocess.check_output(['systemctl','show',name,'-p','MainPID,NRestarts,ActiveState'],text=True).splitlines())
        def process_env(pid):
            return dict(os.fsdecode(x).split('=',1) for x in Path('/proc',pid,'environ').read_bytes().split(b'\0') if b'=' in x)
        state = unit(); assert state['ActiveState']=='active' and state['MainPID']!='0'
        old_env = envpath.read_bytes(); old_meta = meta.read_bytes() if meta else None
        runtime_env = process_env(state['MainPID'])
        expected = after_binary if mode=='rollback' else before_binary
        assert sha(binary)==sha(Path('/proc',state['MainPID'],'exe'))==expected, 'runtime binary drift'
        assert sha(unitpath)==cp['files']['unit']['sha256'], 'service unit drift'
        others={u:unit(u) for u in ['voice-worker-rust','p003-listening-worker','p003-search-worker'] if u!=unit_name}
        cleanup_spec=importlib.util.spec_from_file_location('cleanup','/opt/p003-business-cleanup/reconcile_rooms.py')
        cleanup=importlib.util.module_from_spec(cleanup_spec); cleanup_spec.loader.exec_module(cleanup)
        api=cleanup.RoomAPI(runtime_env['LIVEKIT_URL'],runtime_env['LIVEKIT_API_KEY'],runtime_env['LIVEKIT_API_SECRET'])
        def idle():
            assert not api.post('ListRooms',{}).get('rooms',[]), 'active room: defer, never force close'
            path=Path(runtime_env['P003_SEARCH_CANARY_HEALTH_FILE']) if pool=='listening' else Path('/var/lib/p003-business-cleanup/status.json')
            health=json.loads(path.read_text()); age=time.time()*1000-health['at_ms']
            if pool=='listening': assert health['registered'] and health['jobs']==0 and health['cleanup']['healthy'] and 0<=age<8000, 'canary not idle/healthy'
            else: assert health['healthy'] and health['remaining']==0 and 0<=age<120000, 'cleanup not idle/healthy'
        def unchanged():
            assert unit()==state and envpath.read_bytes()==old_env and sha(binary)==expected, 'concurrent target change'
            assert (meta.read_bytes() if meta else None)==old_meta, 'release metadata drift'
            assert {u:unit(u) for u in others}==others, 'other pool drift'
        def stop():
            subprocess.run(['systemctl','stop',unit_name],check=True,timeout=35)
            assert unit()['MainPID']=='0'
            for _ in range(20):
                owned=[]
                for p in Path('/proc').iterdir():
                    if not p.name.isdigit(): continue
                    try:
                        if any(os.path.basename(a)==b'eot_sidecar.py' for a in (p/'cmdline').read_bytes().split(b'\0')) and unit_name+'.service' in (p/'cgroup').read_text(): owned.append(p.name)
                    except (FileNotFoundError, ProcessLookupError): pass
                if not owned: break
                time.sleep(1)
            else: raise RuntimeError('owned EOT sidecar did not stop')
            sock=Path(runtime_env.get('EOT_SOCK','/nonexistent'))
            if sock.exists(): assert sock.is_socket(); sock.unlink()
        def start(wanted):
            at=time.time();subprocess.run(['systemctl','start',unit_name],check=True,timeout=30)
            for _ in range(60):
                time.sleep(.5); current=unit(); pid=current['MainPID']
                if pid=='0' or current['ActiveState']!='active': continue
                if sha(Path('/proc',pid,'exe'))!=wanted: continue
                logs=subprocess.check_output(['journalctl','-u',unit_name,'_PID='+pid,'--since','@'+str(int(at)),'--no-pager','-o','cat'],text=True)
                if 'registered worker' not in logs or 'panicked' in logs: continue
                if pool=='listening':
                    h=json.loads(Path(runtime_env['P003_SEARCH_CANARY_HEALTH_FILE']).read_text())
                    if not(h['registered'] and h['cleanup']['healthy'] and h['at_ms']>=at*1000): continue
                return current
            raise RuntimeError('worker failed registration/health')
        if mode=='rollback':
            previous=json.loads(receipt.read_text()); assert previous['success']
            old_binary=backup/'binary'; assert sha(old_binary)==before_binary
            restored=helper.restore(old_env,json.loads((backup/'diagnostic-values.json').read_text()))
            if meta: assert sha(meta)==previous['metadata_sha256'], 'metadata changed after release'
            current_binary=binary.read_bytes()
            rollback_result={'pool':pool,'rolled_back':False,'started_ms':int(time.time()*1000)}
            stopped=False; binary_restored=False; env_restored=False; metadata_restored=False
            try:
                unchanged();idle();stopped=True;stop()
                if pool=='main': atomic(binary,old_binary.read_bytes(),0o755);binary_restored=True
                atomic(envpath,restored);env_restored=True
                if meta: atomic(meta,(backup/'metadata').read_bytes());metadata_restored=True
                after=start(before_binary)
                assert envpath.read_bytes()==restored and sha(binary)==before_binary
                assert {u:unit(u) for u in others}==others
                rollback_result.update(rolled_back=True,after=after,other_settings_preserved=True)
            except BaseException as error:
                rollback_result['error_type']=type(error).__name__
                if stopped:
                    try:
                        # Recover the known pre-rollback candidate, never another writer's binary.
                        assert sha(binary)==(before_binary if binary_restored else after_binary), 'binary drift during rollback recovery'
                        if metadata_restored: assert meta.read_bytes()==(backup/'metadata').read_bytes(), 'metadata drift during rollback recovery'
                        _, current_keys=helper.assignments(envpath.read_bytes())
                        _, expected_keys=helper.assignments(restored if env_restored else old_env)
                        assert {k:current_keys.get(k,(None,None))[1] for k in helper.KEYS}=={k:expected_keys.get(k,(None,None))[1] for k in helper.KEYS}, 'diagnostic drift during rollback recovery'
                        stop()
                        if binary_restored: atomic(binary,current_binary,0o755)
                        if env_restored:
                            _, installed=helper.assignments(old_env)
                            atomic(envpath,helper.replace(envpath.read_bytes(),{k:installed.get(k,(None,None))[1] for k in helper.KEYS}))
                        if metadata_restored: atomic(meta,old_meta)
                        rollback_result['recovered_candidate']=start(after_binary)
                    except BaseException as recovery_error:
                        rollback_result['recovery_error_type']=type(recovery_error).__name__
                raise
            finally:
                rollback_result['finished_ms']=int(time.time()*1000)
                atomic(D/('ROLLBACK-'+pool+'.json'),json.dumps(rollback_result,indent=2).encode());print(json.dumps(rollback_result))
            return
        assert sha(envpath)==cp['files']['env']['sha256'], 'baseline env drift; re-audit before proceeding'
        assert sha(D/'worker-candidate')==spec['binary_sha256']
        new_env, env_state=helper.enable(old_env,spec['device_sns'],spec['until_ms'])
        assert helper.restore(new_env,env_state)==old_env
        unchanged();idle()
        if mode=='check': print(json.dumps({'pool':pool,'precheck':True,'idle':True,'device_count':len(spec['device_sns']),'no_runtime_mutation':True}));return
        assert spec['reviewed'] is True, 'release review not recorded'
        assert not receipt.exists() and not backup.exists(), 'prior attempt exists; inspect rather than overwrite'
        backup.mkdir(mode=0o700)
        atomic(backup/'binary',binary.read_bytes(),0o700);atomic(backup/'env',old_env)
        atomic(backup/'diagnostic-values.json',json.dumps(env_state,indent=2).encode())
        if meta: atomic(backup/'metadata',old_meta)
        result={'pool':pool,'started_ms':int(time.time()*1000),'backup':str(backup),'before':state,'device_sns':spec['device_sns'],'until_ms':spec['until_ms']}
        stopped=False; env_written=False; binary_written=False; metadata_written=False
        try:
            unchanged();idle();stopped=True;stop()
            assert envpath.read_bytes()==old_env and sha(binary)==before_binary
            if pool=='main': atomic(binary,(D/'worker-candidate').read_bytes(),0o755);binary_written=True
            atomic(envpath,new_env);env_written=True
            if meta:
                atomic(meta,json.dumps({'build_sha':spec['source_commit'],'binary_sha256':after_binary,'bytes':binary.stat().st_size,'release':'asr-diagnostics-five-20261116'},indent=2).encode());metadata_written=True
            after=start(after_binary); actual=process_env(after['MainPID'])
            assert actual.get(helper.KEYS[0])==','.join(spec['device_sns']) and actual.get(helper.KEYS[1])==str(spec['until_ms'])
            assert envpath.read_bytes()==new_env
            for k,v in runtime_env.items():
                if k.startswith(('P003_','VOLC_','XFYUN_','LLM_','TTS_','AGENT_','WORKER_','LIVEKIT_','EOT_','EXIT_','INTERRUPT_','SESSION_EXIT_')) and k not in helper.KEYS: assert actual.get(k)==v, 'unrelated process env changed: '+k
            assert {u:unit(u) for u in others}==others
            result.update(success=True,after=after,process_sha256=sha(Path('/proc',after['MainPID'],'exe')),disk_sha256=sha(binary),env_sha256=sha(envpath),metadata_sha256=sha(meta) if meta else None,other_pools_unchanged=True)
        except BaseException as error:
            result.update(success=False,error_type=type(error).__name__)
            if stopped:
                stop()
                if binary_written:
                    assert sha(binary)==after_binary,'binary drift during rollback';atomic(binary,(backup/'binary').read_bytes(),0o755)
                if env_written: atomic(envpath,helper.restore(envpath.read_bytes(),env_state))
                if metadata_written: atomic(meta,old_meta)
                result['rollback_runtime']=start(before_binary);result['rolled_back']=True
            raise
        finally:
            result['finished_ms']=int(time.time()*1000);atomic(receipt,json.dumps(result,indent=2).encode());print(json.dumps(result))

if __name__=='__main__': main(*sys.argv[1:])
