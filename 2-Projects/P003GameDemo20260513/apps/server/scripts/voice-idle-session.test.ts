import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { SignJWT, decodeJwt } from 'jose';
const dir=mkdtempSync(join(tmpdir(),'voice-idle-session-'));
for (const [key,file] of Object.entries({CONFIG_DB_PATH:'config.db',DEVICES_DB_PATH:'devices.db',PROFILE_DB_PATH:'profile.db'})) process.env[key]=join(dir,file);
const SN='BJP00326110799999901';
Object.assign(process.env,{AUTH_JWT_SECRET:'test-only-secret',LIVEKIT_API_KEY:'test-key',LIVEKIT_API_SECRET:'test-only-livekit-key-32-bytes-long',DEVICE_SN_ALLOW:SN,DEVICE_SESSION_RPM:'100',P003_SEARCH_ENABLED:'0'});
const {configStore}=await import('../src/config-store.js');
const {deviceSessionRoute,assertTokenMatchesResponse}=await import('../src/routes/device-session.js');
const app=new Hono();app.route('/v1/device',deviceSessionRoute);
const credential=await new SignJWT({kind:'p003-device'}).setSubject(SN).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('test-only-secret'));
async function ticket(extra:Record<string,unknown>={}) {
  const r=await app.request('/v1/device/session',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${credential}`},body:JSON.stringify({device_sn:SN,trace_id:'idle-policy-synthetic',...extra})});
  assert.equal(r.status,200);const body=await r.json() as any;
  const claims=decodeJwt(body.token) as any;
  return {body,meta:JSON.parse(claims.roomConfig.agents[0].metadata)};
}
test('client payload cannot create idle authority; no policy stays absent',async()=>{
  const {body,meta}=await ticket({voice_idle:{timeout_ms:5000,revision:'forged'}});
  assert.equal(meta.voice_idle,undefined);
  assert.equal(body.voice_idle,undefined);
});
test('the ticket and response carry the same explicit server policy and revision',async()=>{
  assert.notEqual(configStore.setValue(SN,'voice.session_idle_timeout_ms',300000),null);
  const {body,meta}=await ticket({voice_idle:{timeout_ms:5000,revision:'forged'}});
  assert.deepEqual(meta.voice_idle,{timeout_ms:300000,revision:configStore.effectiveSnapshot(SN).revision});
  assert.deepEqual(body.voice_idle,meta.voice_idle);
  assert.doesNotThrow(()=>assertTokenMatchesResponse(body.token,body));
});
test('post-sign self-check rejects policy value/revision mismatch and unexpected metadata',async()=>{
  const {body}=await ticket();
  assert.throws(()=>assertTokenMatchesResponse(body.token,{...body,voice_idle:{timeout_ms:5000,revision:'forged'}} as any),/voice_idle/);
  assert.throws(()=>assertTokenMatchesResponse(body.token,{...body,voice_idle:null} as any),/voice_idle/);
});
test('clearing the explicit policy removes it from later tickets without rewriting old tickets',async()=>{
  assert.notEqual(configStore.setValue(SN,'voice.session_idle_timeout_ms',0),null);
  const {meta,body}=await ticket();assert.equal(meta.voice_idle,undefined);assert.equal(body.voice_idle,undefined);
});
