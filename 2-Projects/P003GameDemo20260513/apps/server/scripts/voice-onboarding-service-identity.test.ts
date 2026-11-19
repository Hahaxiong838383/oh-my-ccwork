import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SignJWT} from 'jose';
import {createVoiceOnboardingRoute} from '../src/routes/voice-onboarding.js';
// Deployment uses an existing main Worker identity, which differs from the SDK fixture default.
test('configured service identity is required before parsing or opening a store',async()=>{
 const oldSecret=process.env.AUTH_JWT_SECRET,oldAccounts=process.env.VOICE_ONBOARDING_WORKER_ACCOUNTS;
 process.env.AUTH_JWT_SECRET='onboarding-identity-isolated-test-secret';
 process.env.VOICE_ONBOARDING_WORKER_ACCOUNTS='existing-main-worker';
 let opens=0;
 const app=createVoiceOnboardingRoute(()=>{opens++;throw new Error('store must not open');});
 const sign=(accountId:string,role='device',secret=process.env.AUTH_JWT_SECRET!,exp='1h')=>new SignJWT({accountId,role}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime(exp).sign(new TextEncoder().encode(secret));
 const request=async(token:string)=>{
  const r=await app.request('/v2/step',{method:'POST',headers:{'content-type':'application/json','x-p003-worker-token':token},body:'{}'});
  return {status:r.status,body:await r.json()};
 };
 try{
  assert.deepEqual(await request(await sign('existing-main-worker')),{status:400,body:{error:'invalid_request',memory_write:'none'}});
  for(const token of [await sign('worker-service'),await sign('different-device'),await sign('existing-main-worker','parent'),await sign('existing-main-worker','device','wrong-signing-key'),await sign('existing-main-worker','device',process.env.AUTH_JWT_SECRET!,'0s'),'']){
   assert.deepEqual(await request(token),{status:403,body:{error:'worker_unauthorized',memory_write:'none'}});
  }
  assert.equal(opens,0);
 }finally{
  if(oldSecret===undefined)delete process.env.AUTH_JWT_SECRET;else process.env.AUTH_JWT_SECRET=oldSecret;
  if(oldAccounts===undefined)delete process.env.VOICE_ONBOARDING_WORKER_ACCOUNTS;else process.env.VOICE_ONBOARDING_WORKER_ACCOUNTS=oldAccounts;
 }
});
