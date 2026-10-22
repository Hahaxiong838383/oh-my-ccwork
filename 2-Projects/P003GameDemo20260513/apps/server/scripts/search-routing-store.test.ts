import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const m:any=await import('../src/tools/search-routing-store.js').catch(()=>({}));assert.equal(typeof m.RoutingStore,'function','durable versioned routing store required');
const cfg:any=await import('../src/tools/search-routing-config.js');const dir=mkdtempSync(join(tmpdir(),'routing-'));let now=1000;
const s=new m.RoutingStore(join(dir,'routing.db'),()=>now);const a='BJP00326060100100004',b='BJP00326070803800006';
try {
 const first=s.state();assert.equal(first.revision,0);s.saveDraft(cfg.defaultRoutingConfig(),0,'test');
 assert.throws(()=>s.saveDraft(cfg.defaultRoutingConfig(),0,'test'),/revision_conflict/);
 const v=s.publish(1,[a],'test');assert.equal(s.snapshot(a).version,v);assert.equal(s.snapshot(b),null);
 const c=cfg.defaultRoutingConfig();c.weather_enabled=true;s.saveDraft(c,2,'test');now=2000;const v2=s.publish(3,[a,b],'test');assert.notEqual(v,v2);
 assert.equal(s.resolve(a,v).config.weather_enabled,false,'old snapshot stays immutable');now=18001;assert.throws(()=>s.resolve(a,v),/routing_version_stale/);
 assert.throws(()=>s.ack(a,'unpublished','room'),/routing_version/);s.ack(a,v2,'room');assert.equal(s.state().loads[0].version,v2);
 s.rollback(v,4,[a],'test');assert.equal(s.snapshot(a).version,v);assert.equal(s.snapshot(b).version,v2);
 assert.equal(s.state().history.length,3);assert.throws(()=>s.resolve(b,v),/routing_version/);
 for(const patch of [{tools:true},{weather_enabled:'true'},{rules:[{id:'x',enabled:true,priority:1,action:'execute',mode:'regex',triggers:['.*'],exclude:[]}]}])assert.throws(()=>cfg.routingConfigSchema.parse({...cfg.defaultRoutingConfig(),...patch}));
 console.log('routing store: revision CAS, SN scope, immutable version, bounded stale acceptance, ack and rollback passed');
}finally{s.close();rmSync(dir,{recursive:true,force:true});}
