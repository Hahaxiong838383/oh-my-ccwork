import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {ArkStore} from '../src/ark/store.js';
import {startSharedQuery} from './storage-shared-query-client.js';
const root=realpathSync(mkdtempSync(join(tmpdir(),'p003-t5-query-ipc-')));
let service:Awaited<ReturnType<typeof startSharedQuery>>|undefined;
try{
 writeFileSync(join(root,'config.json'),JSON.stringify({synthetic:true,continuous_ark:true,devices:1,receiver_pid:process.pid}));
 new ArkStore(join(root,'ark.db')).close();
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address()as any).port;await new Promise<void>(r=>server.close(()=>r()));
 // Degraded startup is a production-supported state; it cannot turn a dead child into success.
 service=await startSharedQuery(root,'http://127.0.0.1:'+port,'0'.repeat(64));
 const started=performance.now(),query=service.query('killed-query'),closed=once(service.child,'exit');service.child.kill('SIGTERM');
 await assert.rejects(query,/exited|disconnected|closed|EPIPE/);await closed;assert(performance.now()-started<2000);
 await assert.rejects(service.query('after-exit'),/disconnected/);
 await assert.rejects(service.stop(),/exited/);
 console.log('shared query IPC: pending death and later calls fail closed');
}finally{service?.child.kill('SIGTERM');rmSync(root,{recursive:true,force:true});}
