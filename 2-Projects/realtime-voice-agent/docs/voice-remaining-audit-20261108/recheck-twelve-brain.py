import datetime, hashlib, json, pathlib, re, sqlite3
tails=['1794035162','1794035475','1794035701','1794035916','1794036810','1794037285','1794037493','1794038010','1794038616','1794040343','1794041570','1794042077']
out={'collected_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rows':[]}
for root in ['/opt/p003/server','/opt/p003/listening-canary-20261030/brain']:
 p=pathlib.Path(root)/'data/devices.db';c=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True);c.execute('PRAGMA query_only=ON');c.row_factory=sqlite3.Row
 for r in c.execute('SELECT room,session_id,trace_id,status,ttl_s,ms,created_at,note FROM device_session_log WHERE substr(sn,-8)=? AND created_at>=? AND created_at<=? ORDER BY created_at',('02000053',1794034800000,1794042600000)):
  d=dict(r);room=d.pop('room')or'';m=re.fullmatch(r'sn-BJP003\d{6}02000053-(\d+)',room)
  if not m or m[1]not in tails:continue
  note=d.pop('note')or'';d['room_tail']=m[1];d['source']=str(p);d['note_sha256']=hashlib.sha256(note.encode()).hexdigest();d['note_bytes']=len(note.encode());out['rows'].append(d)
 c.close()
out['matches']={t:sum(r['room_tail']==t for r in out['rows'])for t in tails}
out['scope']='Ticket rows only; does not establish client receipt, connect, media, or Worker assignment.'
print(json.dumps(out))
