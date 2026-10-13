// Stage-only numeric diagnosis. Never included in the production entrypoint.
import assert from 'node:assert/strict';
import {writeSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AnalyticsStore} from '../src/analytics/store.js';
import {pruneAnalytics,rollupDirtyDaysWithStatus} from '../src/analytics/rollup.js';

const root='/opt/p003/analytics-staging-20261013/server';
assert.equal(resolve(process.cwd()),root);
assert.equal(process.env.ANALYTICS_DB_PATH,root+'/data/analytics.db');
assert.ok(['prune','rollup','full'].includes(process.argv[2]));
let sequence=0;
const log=(value:Record<string,unknown>)=>writeSync(1,JSON.stringify({at_ms:Date.now(),...value})+'\n');
const label=(sql:string)=>({verb:sql.trim().split(/\s+/)[0],table:/\b(?:FROM|INTO|UPDATE)\s+(analytics_\w+)/i.exec(sql)?.[1]??'other'});
const exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;
DatabaseSync.prototype.exec=function(sql:string){
  const id=++sequence,start=performance.now();log({id,phase:'begin',...label(sql)});
  try{return exec.call(this,sql);}finally{log({id,phase:'end',duration_ms:performance.now()-start});}
};
DatabaseSync.prototype.prepare=function(sql:string){
  const statement=prepare.call(this,sql);
  return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);
    if(typeof value!=='function')return value;
    return (...args:unknown[])=>{
      const id=++sequence,start=performance.now();log({id,phase:'begin',method:String(key),...label(sql)});
      if(key==='iterate'){
        const iterable=Reflect.apply(value,target,args);let rows=0;
        return (function*(){try{for(const row of iterable){rows++;if(rows%50000===0)log({id,phase:'progress',rows,duration_ms:performance.now()-start});yield row;}}
          finally{log({id,phase:'end',rows,duration_ms:performance.now()-start});}})();
      }
      try{return Reflect.apply(value,target,args);}finally{log({id,phase:'end',duration_ms:performance.now()-start});}
    };
  }});
} as typeof DatabaseSync.prototype.prepare;
log({phase:'store_open',pid:process.pid});
if(process.argv[2]==='full'){
  await import('../scripts/analytics-rollup.js');
  log({phase:'closed'});
}else{
  const store=new AnalyticsStore(process.env.ANALYTICS_DB_PATH);
  try{
    log({phase:'maintenance_begin',mode:process.argv[2]});
    const result=process.argv[2]==='prune'?pruneAnalytics(store):rollupDirtyDaysWithStatus(store);
    log({phase:'maintenance_end',result});
  }finally{store.close();log({phase:'closed'});}
}
