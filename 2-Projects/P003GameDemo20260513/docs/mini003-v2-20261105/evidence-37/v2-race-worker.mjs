import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import net from 'node:net';
const [root,config]=process.argv.slice(2);if(!realpathSync(root).includes('/verification-37/run-'))throw new Error('private archive required');
for(const k of Object.keys(process.env))if(k!=='PATH')delete process.env[k];Object.assign(process.env,JSON.parse(readFileSync(config,'utf8')));process.chdir(process.env.AUDIT37_CWD);
net.Socket.prototype.connect=function(){throw new Error('outbound forbidden');};globalThis.fetch=async()=>{throw new Error('outbound forbidden');};console.log=console.warn=console.error=()=>{};
const {getDeviceEnrollmentStore}=await import(pathToFileURL(join(root,'src/device-enrollment-store.ts')).href);const store=getDeviceEnrollmentStore();
process.on('message',m=>{try{const r=store.confirm(m.account,m.challenge,m.signature,()=>{throw new Error('v2 config must not be read');});process.send({id:m.id,status:200,owner:r.account_id,binding_id:r.binding_id});}catch(e){process.send({id:m.id,status:e.status??500,error:e.error??e.code??'unexpected'});}});process.send({ready:true});
