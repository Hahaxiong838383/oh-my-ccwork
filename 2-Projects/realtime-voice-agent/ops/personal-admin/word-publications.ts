import {randomUUID,createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {closeSync,openSync,readFileSync,writeFileSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {Hono} from 'hono';
import {HOTWORD_KINDS,hotwordStore,validateWords,type HotwordKind} from '../../../P003GameDemo20260513/apps/server/src/hotword-store';

type Snapshot={revision:number,at:number|null,words:Partial<Record<HotwordKind,string[]>>};
type Releases={current:Snapshot,history:Snapshot[]};
const initial=():Releases=>({current:{revision:0,at:null,words:{}},history:[]});
function load(file:string):Releases {
  try {
    const r=JSON.parse(readFileSync(file,'utf8'));
    if(!Number.isSafeInteger(r?.current?.revision)||!r.current.words||!Array.isArray(r.history)) throw Error();
    return r;
  } catch(e) {if ((e as NodeJS.ErrnoException).code==='ENOENT') return initial();throw e;}
}
function save(file:string,data:Releases) {
  const temp=file+'.'+randomUUID()+'.tmp', bytes=JSON.stringify(data);
  if(Buffer.byteLength(bytes)>512*1024) throw Error('size');
  const fd=openSync(temp,'wx',0o600);
  try {
    try {writeFileSync(fd,bytes);fsyncSync(fd);} finally {closeSync(fd);}
    renameSync(temp,file);
  } finally {try{unlinkSync(temp);}catch{}}
}
function token(words:string[]){return createHash('sha256').update(JSON.stringify(words)).digest('hex');}

export function wordPublications(file=join(dirname(process.env.PERSONAL_PROVIDERS_FILE||'/run/personal-providers/providers.json'),'interaction.json'),
  receipt='/run/worker-state/words-receipt.json',draftOf:typeof hotwordStore.draftOf=k=>hotwordStore.draftOf(k)) {
  const app=new Hono();
  app.onError((_,c)=>c.json({error:'通话词表暂时无法读取或保存'},503));
  app.get('/',c=>{
    const reg=load(file);
    let last=null;
    try{
      const s=JSON.parse(readFileSync(receipt,'utf8'));
      if(Number.isSafeInteger(s.at)&&((s.revision===null)||Number.isSafeInteger(s.revision)) && typeof s.cloudAsr==='boolean')
        last={at:s.at,revision:s.revision,cloudAsr:s.cloudAsr};
    }catch{}
    const drafts=Object.fromEntries(HOTWORD_KINDS.map(k=>{const d=draftOf(k);return [k,d&&{words:d.words,token:token(d.words)}];}));
    return c.json({...reg,last,drafts});
  });
  app.post('/',async c=>{
    const b=await c.req.json().catch(()=>null);
    if(!b||!Number.isSafeInteger(b.previous)) return c.json({error:'需要当前发布版本'},400);
    const reg=load(file);
    if(b.previous!==reg.current.revision)return c.json({error:'词表版本已变化，请重新对照'},409);
    let words:Snapshot['words'];
    if(b.restore!==undefined) {
      const old=reg.history.find(x=>x.revision===b.restore);
      if(!old)return c.json({error:'该版本不在可恢复记录中'},404);
      words=old.words;
    } else {
      const kind=HOTWORD_KINDS.find(k=>k===b.kind);
      if(!kind) return c.json({error:'词表类型无效'},400);
      const d=draftOf(kind);
      if(!d||b.token!==token(d.words))return c.json({error:'草稿有变化，请重新预览'},409);
      const result=validateWords(kind,d.words);
      if(!result.ok)return c.json({error:result.error},400);
      words={...reg.current.words,[kind]:result.words};
    }
    const current={revision:reg.current.revision+1,at:Date.now(),words};
    save(file,{current,history:[reg.current,...reg.history].slice(0,6)});
    return c.json({revision:current.revision});
  });
  return app;
}
