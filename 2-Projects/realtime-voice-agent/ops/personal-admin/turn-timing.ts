import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const stages=['commit','asr_final','speakable','first_audio','post_filler_audio'] as const;
type Stage=typeof stages[number];
type Sample={at:number,room:string,turn:number}&Record<Stage,number|null>;

export function recentTurnTimings(dir='/run/worker-state') {
  const byTurn=new Map<string,Sample>();
  for (const file of ['turn-timing.previous','turn-timing.jsonl']) {
    let raw:string;
    try {raw=readFileSync(join(dir,file),'utf8');} catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT') continue;throw e;}
    for(const line of raw.split('\n')){
      let v;try{v=JSON.parse(line);}catch{continue;}
      if(!v||!Number.isSafeInteger(v.at)||v.at<Date.now()-7*86400000||!Number.isSafeInteger(v.turn)||v.turn<1
        ||typeof v.room!=='string'||!/^pv-[a-f0-9]{32}$/.test(v.room)||!stages.includes(v.stage)||!Number.isSafeInteger(v.ms)||v.ms<0)continue;
      const key=v.room+'/'+v.turn;
      const row=byTurn.get(key)??{at:0,room:v.room,turn:v.turn,commit:null,asr_final:null,speakable:null,first_audio:null,post_filler_audio:null};
      row.at=Math.max(row.at,v.at);
      row[v.stage as Stage]=v.ms;
      byTurn.set(key,row);
    }
  }
  return {items:[...byTurn.values()].filter(row=>row.commit!==null).sort((a,b)=>b.at-a.at).slice(0,40)};
}
