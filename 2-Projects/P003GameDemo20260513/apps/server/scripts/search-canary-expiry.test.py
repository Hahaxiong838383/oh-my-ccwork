import importlib.util
from pathlib import Path
import tempfile
import sqlite3
import json
spec=importlib.util.spec_from_file_location('expiry',Path(__file__).resolve().parents[1]/'ops/search-canary/expire-window.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as td:
 p=Path(td)/'config.db';db=sqlite3.connect(p)
 db.execute('CREATE TABLE runtime_flag(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER,updated_by TEXT,note TEXT)')
 db.execute("INSERT INTO runtime_flag VALUES ('p003.search.canary.expires_at_ms','9000',0,'test','')");db.commit()
 assert m.close_db(p,9000,8999,True)=='not_due'
 assert m.close_db(p,8000,9000,True)=='different_window'
 assert m.close_db(p,9000,9000,True)=='closed'
 assert m.close_db(p,9000,9001,False)=='closed'
 assert dict(db.execute("select key,value from runtime_flag where key!='p003.search.canary.expires_at_ms'"))=={'p003.search.canary.enabled':'0','p003.search.enabled':'0','p003.search.tools':'0'}
 w=Path(td)/'window.json';w.write_text(json.dumps({'enabled':True,'expires_at_ms':9000,'sn':'synthetic'}))
 assert m.close_worker(w,9000,8999)=='not_due';assert json.loads(w.read_text())['enabled']
 assert m.close_worker(w,8000,9000)=='different_window';assert json.loads(w.read_text())['enabled']
 assert m.close_worker(w,9000,9000)=='closed';assert not json.loads(w.read_text())['enabled']
 assert m.close_worker(w,9000,9001)=='closed'
 db.close()
print('PASS fixed deadline: no early close, idempotent expiry, newer window untouched, three switches closed')
