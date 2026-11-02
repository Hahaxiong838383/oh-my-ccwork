import importlib.util,tempfile,pathlib,sqlite3,json
src=str(pathlib.Path(__file__).with_name('listening-window-expire.py'));s=importlib.util.spec_from_file_location('expiry',src);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as folder:
 p=pathlib.Path(folder);db=p/'config.db';d=sqlite3.connect(db);d.executescript('CREATE TABLE runtime_flag(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER,updated_by TEXT,note TEXT);CREATE TABLE listening_settings(id INTEGER,revision INTEGER,value_json TEXT,updated_at INTEGER,updated_by TEXT);CREATE TABLE listening_settings_audit(revision INTEGER PRIMARY KEY,operation TEXT,actor TEXT,at INTEGER,before_json TEXT,after_json TEXT);')
 w={'generation':'test-g1','agent':'p003-search-listening-20261030','expires_at_ms':100,'allowlist':['BJP00326070803800006']}
 for k,v in {**w,'enabled':'1'}.items():d.execute('insert into runtime_flag values(?,?,0,?,?)',('p003.search.canary.'+k,str(v),'test',''))
 d.execute('insert into listening_settings values(1,4,?,0,?)',(json.dumps({'enabled':True,'revision':4,'tuning':{'keep':True}}),'test'));d.commit();d.close()
 assert m.expire_main(db,w,99)=='not_due'
 assert m.expire_main(db,{**w,'generation':'old'},100)=='different_window'
 assert m.expire_main(db,w,100)=='closed';assert m.expire_main(db,w,101)=='closed'
 d=sqlite3.connect(db);assert d.execute('select count(*) from listening_settings_audit').fetchone()[0]==1;v=json.loads(d.execute('select value_json from listening_settings').fetchone()[0]);assert not v['enabled'] and v['revision']==5 and v['tuning']=={'keep':True};d.close()
 path=p/'window.json';path.write_text(json.dumps({**w,'enabled':True}));assert m.expire_worker(path,w,99)=='not_due';assert m.expire_worker(path,{**w,'generation':'old'},100)=='different_window';assert m.expire_worker(path,w,100)=='closed';assert m.expire_worker(path,w,101)=='closed';assert not json.loads(path.read_text())['enabled']
 print('PASS: main/worker early, obsolete generation, expiry, repeat, tuning preservation and audit')
