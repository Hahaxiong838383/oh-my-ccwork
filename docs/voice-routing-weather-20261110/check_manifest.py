import argparse,json,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('manifest');p.add_argument('--host',required=True);p.add_argument('--mode',choices=['before','after','backup'],default='before');a=p.parse_args()
m=json.loads(Path(a.manifest).read_text());bad=[]
for e in m['entries']:
 if e['host']!=a.host:continue
 path=Path(e['backup']if a.mode=='backup'else e['path']);want=e['before_sha256']if a.mode!='after'else e['after_sha256'];ok=path.is_file()and hashlib.sha256(path.read_bytes()).hexdigest()==want
 print(json.dumps({'path':str(path),'match':ok}));bad+=[]if ok else[str(path)]
raise SystemExit(1 if bad else 0)
