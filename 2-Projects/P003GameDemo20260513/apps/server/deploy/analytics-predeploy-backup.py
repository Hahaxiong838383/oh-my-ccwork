#!/usr/bin/env python3
"""Read-only production baseline and root-only pre-change snapshot (no DB restore)."""
import hashlib, json, os, shutil, sqlite3, subprocess, tarfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

root = Path('/opt/p003/server')
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
base = Path('/opt/p003/server/backups/analytics-releases')
base.mkdir(parents=True, exist_ok=True, mode=0o700)
dest = base / ('analytics-predeploy-' + stamp)
dest.mkdir(mode=0o700)
protected = dest / 'protected'
protected.mkdir(mode=0o700)
def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
def run(args):
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout
files = list((root / 'src').rglob('*'))
files = [p for p in files if p.is_file()]
files += [root/'package.json', root/'package-lock.json', root/'tsconfig.json',
          Path('/opt/p003/web/dist/admin/index.html'), Path('/etc/nginx/sites-enabled/kidshub-ai')]
archive = dest / 'source-only.tar.gz'
with tarfile.open(archive, 'w:gz') as tar:
    for p in files:
        tar.add(p, arcname=str(p).lstrip('/'), recursive=False)
os.chmod(archive, 0o600)
# Existing credentials never enter source archives/manifests or printed output.
for p in [root/'.env.local', Path('/root/.pm2/dump.pm2')]:
    if p.is_file():
        q = protected / p.name
        shutil.copyfile(p, q)
        os.chmod(q, 0o600)
(protected/'crontab.txt').write_text(subprocess.run(['crontab','-l'],capture_output=True,text=True).stdout)
os.chmod(protected/'crontab.txt', 0o600)
db_meta = {}
for name in ['devices.db','config.db']:
    source = root/'data'/name
    if not source.is_file():
        raise FileNotFoundError(source)
    target = protected/name
    a = sqlite3.connect('file:'+quote(str(source))+'?mode=ro', uri=True, timeout=3)
    b = sqlite3.connect(target, timeout=3)
    try:
        a.backup(b, pages=128, sleep=0.05)
        assert b.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        db_meta[name] = {'bytes':target.stat().st_size,'sha256':sha(target),'integrity_check':'ok'}
    finally:
        b.close(); a.close()
    os.chmod(target,0o600)
processes = json.loads(run(['pm2','jlist']))
pm = [{k:v for k,v in {'name':x['name'],'pid':x['pid'],'status':x['pm2_env']['status'],
      'restarts':x['pm2_env']['restart_time'],'uptime_ms':x['pm2_env']['pm_uptime'],
      'rss_bytes':x['monit']['memory'],'cpu':x['monit']['cpu']}.items()} for x in processes]
state = {'captured_at_utc':stamp,'pm2':pm,'pm2_root_enabled':run(['systemctl','is-enabled','pm2-root']).strip(),
         'free_disk_bytes':shutil.disk_usage(root).free,'analytics_db_preexisting':(root/'data/analytics.db').exists(),
         'nginx_sha256':sha(Path('/etc/nginx/sites-enabled/kidshub-ai'))}
manifest = {'schema_version':1,'backup_path':str(dest),'source_archive_sha256':sha(archive),
            'files':{str(p):sha(p) for p in files},'protected_database_backups':db_meta,
            'notes':['Credentials and PM2 dump are root-only under protected, not in source archive.',
                     'Rollback must not restore entire devices.db/config.db or delete analytics accepted data.']}
for n,obj in [('manifest.json',manifest),('state.json',state)]:
    q=dest/n; q.write_text(json.dumps(obj,indent=2)+'\n'); os.chmod(q,0o600)
print(json.dumps({'backup_path':str(dest),'source_files':len(files),'archive_bytes':archive.stat().st_size,
                 'source_archive_sha256':manifest['source_archive_sha256'],'database_integrity':'ok',
                 'analytics_db_preexisting':state['analytics_db_preexisting'],'pm2':pm},sort_keys=True))
