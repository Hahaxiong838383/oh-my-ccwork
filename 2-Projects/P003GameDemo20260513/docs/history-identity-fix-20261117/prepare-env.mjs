// Execute only inside the private remote release directory. Never print environment values.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
const D='/root/p003-history-identity-fix-20261117',R='/opt/p003/server';
const baseline=JSON.parse(readFileSync(D+'/PREFLIGHT.json','utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const voice=readFileSync(R+'/.env.local','utf8'),analytics=readFileSync(R+'/.env.analytics','utf8');
if(sha(voice)!==baseline.env_sha256||sha(analytics)!==baseline.analytics_env_sha256)throw new Error('environment drift');
const v=parseEnv(voice),a=parseEnv(analytics);
const scope=JSON.parse(v.PARENT_CONVERSATION_SCOPE_JSON||'null');
if(scope?.sn!=='BJP00326081002000031'||scope?.public_id!=='dev_50b5415662259045')throw new Error('scope mismatch');
function put(text,key,value){if(/[\r\n']/.test(value))throw new Error('unsafe env value');const line=key+"='"+value+"'";const re=new RegExp('^'+key+'=.*$','m');return re.test(text)?text.replace(re,()=>line):text.replace(/\s*$/,'')+'\n'+line+'\n';}
if(v.WECHAT_APP_ID&&v.WECHAT_APP_ID!=='wx8b0ce82f18ab2f29')throw new Error('app id mismatch');
let next=put(voice,'WECHAT_APP_ID','wx8b0ce82f18ab2f29');
if(existsSync(D+'/wechat-secret.private')){
 const secret=readFileSync(D+'/wechat-secret.private','utf8').trim();
 if(!/^[A-Za-z0-9_-]{16,256}$/.test(secret))throw new Error('invalid wechat secret');
 next=put(next,'WECHAT_APP_SECRET',secret);
}
let an=put(analytics,'PARENT_CONVERSATION_SCOPE_JSON',JSON.stringify(scope));
an=put(an,'DEVICES_DB_PATH',a.ANALYTICS_DEVICES_DB_PATH||'/opt/p003/server/data/devices.db');
an=put(an,'ACCOUNTS_DB_PATH','/opt/p003/server/data/accounts.db');
writeFileSync(D+'/voice.env.candidate',next,{mode:0o600});
writeFileSync(D+'/analytics.env.candidate',an,{mode:0o600});
console.log(JSON.stringify({app_id:'wx8b0ce82f18ab2f29',has_app_secret:!!parseEnv(next).WECHAT_APP_SECRET,history_scope_reused:true,voice_sha256:sha(next),analytics_sha256:sha(an)}));
