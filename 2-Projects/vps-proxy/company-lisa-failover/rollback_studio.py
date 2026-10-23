#!/usr/bin/env python3
"""Explicit root rollback. Stops on concurrent production config changes."""
import hashlib,json,os,pathlib,pwd,subprocess,sqlite3
ROOT=pathlib.Path('/Users/fu-121/xray/company-lisa-failover')
CONFIG=pathlib.Path('/Users/fu-121/xray/config.json')
PLIST=pathlib.Path('/Library/LaunchDaemons/com.company.lisa-failover.plist')

DB=pathlib.Path('/Users/fu-121/Library/Application Support/Codeg-company-studio/codeg.db')

def idle():
    c=sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True)
    try:active=list(c.execute("SELECT id FROM conversation WHERE status='in_progress'"))
    finally:c.close()
    if active:raise RuntimeError('ACTIVE_CODEG_TURNS')

def main():
    if os.geteuid()!=0:raise RuntimeError('root_required')
    manifest=json.loads((ROOT/'manifest.json').read_text())
    current=CONFIG.read_bytes();backup=(ROOT/'backup-config.json').read_bytes()
    if hashlib.sha256(current).hexdigest()!=manifest['candidate_sha256']:raise RuntimeError('config_changed_refuse_rollback')
    if hashlib.sha256(backup).hexdigest()!=manifest['baseline_sha256']:raise RuntimeError('backup_changed_refuse_rollback')
    idle()
    result=subprocess.run(['/bin/launchctl','bootout','system/com.company.lisa-failover'],capture_output=True)
    if result.returncode:raise RuntimeError('controller_stop_failed')
    try:
        idle()
        if CONFIG.read_bytes()!=current:raise RuntimeError('config_changed_after_controller_stop')
    except BaseException:
        # Controller's on-disk config-hash guard prevents mutation on foreign config.
        restored=subprocess.run(['/bin/launchctl','bootstrap','system',str(PLIST)],capture_output=True)
        if restored.returncode:raise RuntimeError('rollback_aborted_controller_restore_failed')
        raise
    user=pwd.getpwnam('fu-121');tmp=CONFIG.with_name('config.rollback-'+str(os.getpid()))
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(backup);f.flush();os.fsync(f.fileno())
    os.chown(tmp,user.pw_uid,user.pw_gid);os.replace(tmp,CONFIG)
    subprocess.run(['/bin/launchctl','kickstart','-k','system/com.xray.proxy.studio'],check=True,capture_output=True)
    if PLIST.exists():PLIST.unlink()
    print('ORIGINAL_CONFIG_RESTORED; verify real user path before declaring recovery')

if __name__=='__main__':main()
