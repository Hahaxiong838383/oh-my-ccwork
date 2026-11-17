import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {appendFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='/opt/p003/archive-t5-20261117/covering-profile-01',file=root+'/analytics-copy.db',out=root+'/result.jsonl';
const emit=x=>appendFileSync(out,JSON.stringify(x)+'\n');
const db=new DatabaseSync(file);db.exec('PRAGMA cache_size=-65536; PRAGMA temp_store=FILE');
const cold=()=>{db.exec('PRAGMA shrink_memory');execFileSync('python3',['-c',"import os;f=os.open("+JSON.stringify(file)+",os.O_RDONLY);os.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED);os.close(f)"]);};
const columns='device_key,event_name,session_digest,clock_suspicious,semantic_json,received_at_ms';
function run(name,index,dimension){
 const sql=`SELECT ${columns} FROM analytics_rollup_fact INDEXED BY ${index} WHERE dimension=? AND day=? ORDER BY device_key,received_at_ms,id_digest`;
 const args=[dimension,'2026-11-17'];emit({name,dimension,plan:db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args)});cold();
 const hash=createHash('sha256');let rows=0;const start=performance.now();for(const row of db.prepare(sql).iterate(...args)){rows++;JSON.parse(row.semantic_json);hash.update(JSON.stringify(row)+'\n');}
 emit({name,dimension,rows,ms:performance.now()-start,sha256:hash.digest('hex'),rss:process.memoryUsage().rss,file_bytes:statSync(file).size});
}
run('baseline-before','sqlite_autoindex_analytics_rollup_fact_1','occurred');
const bytes=statSync(file).size,start=performance.now();
db.exec('CREATE INDEX t5_experiment_cover ON analytics_rollup_fact(dimension,day,device_key,received_at_ms,id_digest,event_name,session_digest,clock_suspicious,semantic_json)');
emit({stage:'index-built',ms:performance.now()-start,added_bytes:statSync(file).size-bytes,total_bytes:statSync(file).size});
run('covering','t5_experiment_cover','occurred');
run('baseline-after','sqlite_autoindex_analytics_rollup_fact_1','occurred');
run('covering','t5_experiment_cover','received');
db.close();emit({stage:'finished',note:'synthetic copied DB only; not production or candidate schema'});
