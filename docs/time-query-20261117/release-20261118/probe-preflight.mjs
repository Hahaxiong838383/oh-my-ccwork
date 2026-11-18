import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {resolve, dirname} from 'node:path';
import {accessSync, constants, statSync} from 'node:fs';

// No identity inserts, schema migration, HTTP requests or secret output here.
export function probePreflight(env, root) {
  const port=Number(env.PORT), secret=env.AUTH_JWT_SECRET, key=env.CUSTOM_LLM_API_KEY?.trim();
  assert(Number.isInteger(port)&&port>0&&port<65536,'valid PORT required');
  assert(typeof secret==='string'&&secret.length>0,'AUTH_JWT_SECRET required');
  assert(env.CLOCK_PROBE_RESULT,'CLOCK_PROBE_RESULT required');
  accessSync(dirname(resolve(root,env.CLOCK_PROBE_RESULT)),constants.W_OK);
  const paths={devices:resolve(root,env.DEVICES_DB_PATH||'data/devices.db'),conversation:resolve(root,env.CONVERSATION_DB_PATH||'data/conversation.db')};
  const schemas={devices:{device_registry:['sn','note','status','account_id','public_id','created_at','updated_at']},conversation:{conversation:['account_id','memory_excluded']}};
  for(const [name,path] of Object.entries(paths)) {
    assert(statSync(path).isFile(),'existing database file required');
    const db=new DatabaseSync(path,{readOnly:true});
    try {
      for(const [table,required] of Object.entries(schemas[name])) {
        const cols=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(x=>x.name));
        assert(required.every(c=>cols.has(c)),'probe schema mismatch: '+name+'.'+table);
      }
    } finally {db.close();}
  }
  return {port,secret,key,paths};
}

export function chatHeaders(key) {
  return {'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})};
}
