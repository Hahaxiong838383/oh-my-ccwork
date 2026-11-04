#!/usr/bin/env node
/** Trusted initialization/USB tool adapter. Public identity JSON in; signed public statement out. */
import {readFileSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
async function main(){
 const file=process.env.P003_PROVISIONER_CONFIG||join(homedir(),'.config/p003/identity-provisioner.json');
 const st=statSync(file);if(!st.isFile()||st.size>4096||(st.mode&0o077)!==0)throw new Error('secure_config_required');
 const config=JSON.parse(readFileSync(file,'utf8'));
 const url=new URL(config.base_url);
 const loopback=process.argv.length===3&&process.argv[2]==='--allow-loopback'&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname);
 if((url.origin!=='https://kidshub-ai.hahaxiong.cc'&&!loopback)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('invalid_server');
 if(typeof config.provisioning_token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(config.provisioning_token))throw new Error('invalid_tool_config');
 const chunks=[];let bytes=0;
 for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>4096)throw new Error('identity_too_large');chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const fields=['sn','model','device_key_id','identity_public_key_spki'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==fields.length||fields.some(k=>typeof input[k]!=='string'))throw new Error('invalid_identity_input');
 // This adapter is invoked by a trusted device initializer, never distributed with the device APK.
 const response=await fetch(new URL('/v1/device/provisioning/identity',url),{method:'POST',headers:{authorization:'Bearer '+config.provisioning_token,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(15000),redirect:'error'});
 const result=await response.json();
 if(!response.ok||result.ok!==true){process.stderr.write(JSON.stringify({ok:false,status:response.status,error:typeof result.error==='string'?result.error:'provisioning_failed',request_id:result.request_id})+'\n');process.exitCode=1;return;}
 // Only public identity material is emitted; a companion initializer must persist it on this same device.
 process.stdout.write(JSON.stringify({ok:true,sn:input.sn,device_key_id:result.device_key_id,identity_fingerprint:result.identity_fingerprint,identity_statement:result.identity_statement,identity_expires_at_ms:result.identity_expires_at_ms,request_id:result.request_id})+'\n');
}
main().catch(()=>{process.stderr.write('{"ok":false,"error":"provisioning_tool_failed"}\n');process.exitCode=1;});
