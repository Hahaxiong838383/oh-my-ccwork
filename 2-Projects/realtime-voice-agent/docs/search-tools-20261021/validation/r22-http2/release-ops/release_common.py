# Private remote template. Never prints credentials or environment contents.
import pathlib,json,hashlib,subprocess,time,os,shutil,sqlite3,urllib.request
spec=__SPEC__;step=__STEP__;backup=__BACKUP__
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def replace(p,data,mode=0o600):
 p.parent.mkdir(parents=True,exist_ok=True);t=p.with_name(p.name+'.r22.tmp');t.write_bytes(data);t.chmod(mode);os.replace(t,p)
def read_env(p):return {k:json.loads(v)for k,v in(l.split('=',1)for l in p.read_text().splitlines()if'='in l and not l.startswith('#'))}
def patch_env(p,changes):
 old=read_env(p);seen=set();lines=[]
 for l in p.read_text().splitlines():
  k=l.split('=',1)[0]if'='in l and not l.startswith('#')else None
  if k in changes:
   assert k not in seen,'duplicate environment key';seen.add(k)
   if changes[k]is not None:lines.append(k+'='+json.dumps(changes[k],ensure_ascii=False))
  else:lines.append(l)
 for k,v in changes.items():
  if k not in seen and v is not None:lines.append(k+'='+json.dumps(v,ensure_ascii=False))
 replace(p,('\n'.join(lines)+'\n').encode());new=read_env(p)
 assert all(new.get(k)==v for k,v in old.items()if k not in changes)
 assert all(new.get(k)==v for k,v in changes.items())
def unit(u):return subprocess.check_output(['systemctl','show',u,'-p','MainPID','-p','NRestarts','-p','ActiveState'],text=True)
def timer():
 x=subprocess.check_output(['systemctl','show','p003-search-expire-session13-20261026T031900Z.timer','-p','ActiveState','-p','NextElapseUSecRealtime'],text=True);assert 'ActiveState=active'in x;return x
assert time.time()*1000<spec['expires_at_ms']-300000,'window too near expiry'
record={'step':step,'at_ms':int(time.time()*1000)}
