import {cstDay,resolvedFactsSchema,type ArkFacts} from './contracts.js';
import {isArkStateQuestion,isOutsideArkQuestion} from '../xiaoke-kb.js';
import {resolveArkQuestion} from './memory-policy.js';
type Turn={role:string;content:string};
type Auth={accountId:string;role:string}|null;
/** Original verified Worker identity is required, even for static direct answers. */
export function arkDirectReplyAllowed(auth:Auth,room:string,override=false,feedback=false):boolean {
 if(override||feedback||auth?.role!=='device'||!process.env.AUTH_JWT_SECRET?.trim()||!process.env.CUSTOM_LLM_API_KEY?.trim())return false;
 const worker=process.env.ARK_FACTS_PROXY_URL?process.env.SEARCH_WORKER_ACCOUNT_ID:(process.env.ARK_WORKER_ACCOUNT_ID??process.env.SEARCH_WORKER_ACCOUNT_ID);
 const sn=/^sn-(BJP003\d{14})-\d{1,20}$/.exec(room)?.[1];
 return !!worker&&auth.accountId===worker&&!!sn&&(process.env.ARK_DIRECT_REPLY_SN_ALLOW??'').split(',').map(s=>s.trim()).includes(sn);
}
const uses={family_coin:'家族币用来记录你和家长约好的奖励，具体约定由家长设置，不是平台自动兑换或提现。',stardust:'星尘是给小可换装用的资源，具体能换什么以设备页面为准。',makeup_card:'补勤卡用于符合条件的历史航线节点补签，补签后的奖励还需按设备页面提示领取。'};
function stamp(ms:number,now:number){const d=new Date(ms+8*3600000).toISOString();return (cstDay(ms)===cstDay(now)?'今天':d.slice(0,10))+' '+d.slice(11,19);}
function cleanFacts(raw:ArkFacts|undefined):ArkFacts|undefined{
 if(!raw)return undefined;const p=resolvedFactsSchema.safeParse({schema_version:raw.schema_version,assets:raw.assets,progress:raw.progress});return p.success?p.data:undefined;
}
/** A finite factual route, not a second model. The caller must return after sending it. */
export function answerArk(text:string,raw?:ArkFacts,history:Turn[]=[],now=Date.now()):string|null{
 if(isOutsideArkQuestion(text))return null;
 // Mixed unrelated requests remain ordinary conversation instead of losing a question.
 if(text.split(/另外|顺便|[，,；;]/).slice(1).some(part=>/为什么|怎么|什么|多少|吗|呢/.test(part)&&!/家族币|星尘|星辰|金币|补[勤签]卡|宝箱|方舟|奖励|有.*用|用途|还.*多久/.test(part)))return null;
 let q=resolveArkQuestion(text,history)??text;
 if(/^(?:家族币|星尘|星辰|补勤卡|补签卡)[。？！?！]*$/.test(text.trim())&&/金币.*(?:有什么用|用途)/.test([...history].reverse().find(t=>t.role==='user')?.content??''))q=text+'有什么用';
 const usage=/(?:有什么用|干什么用|做什么用|怎么用|是什么|用途|能干什么|可以干什么|介绍)/.test(q);
 const state=isArkStateQuestion(q);
 const family=/家族币/.test(q),star=/星尘|星辰/.test(q),card=/补勤卡|补签卡/.test(q),coin=/金币/.test(q);
 if(!state&&!(usage&&(family||star||card||coin)))return null;
 const f=cleanFacts(raw);
 if(state&&/今天|今日|当天/.test(q)&&/赚|获得|收益|所得|收入/.test(q))return '今日收益我暂时查不到，不能把钱包余额当成今天获得的数量。';
 if(coin&&!family&&!star)return '你说的金币是家族币，还是星尘？家族币记录和家长约好的奖励，星尘用于给小可换装。';
 const progress=/下一|下次|多久|剩.{0,3}(?:时间|分钟|秒)|奖励|宝箱|方舟.{0,8}(?:进度|进展)|暂停|可领|领取|领到|领了/.test(q);
 const parts:string[]=[];
 const addAsset=(key:keyof typeof uses,label:string,unit:string)=>{
  const assetQuestion=new RegExp(key==='family_coin'?'家族币.{0,6}(?:多少|几|余额)|(?:多少|几枚).{0,3}家族币':key==='stardust'?'(?:星尘|星辰).{0,6}(?:多少|几|余额)|(?:多少|几).{0,3}(?:星尘|星辰)':'补[勤签]卡.{0,6}(?:多少|几|库存)|(?:多少|几张).{0,3}补[勤签]卡').test(q);
  if(state&&(!progress||assetQuestion)){
   const a=f?.assets[key];
   parts.push(a&&a.occurred_at_ms<=now+2000&&a.received_at_ms<=now?`截至${stamp(a.occurred_at_ms,now)}的上次同步，${label}是${a.value}${unit}。`:`${label}我暂时查不到，可以看设备上的资源页面。`);
  }
  if(usage)parts.push(uses[key]);
 };
 if(family)addAsset('family_coin','家族币余额','枚');
 if(star)addAsset('stardust','星尘余额','');
 if(card)addAsset('makeup_card','补勤卡库存','张');
 if(progress&&state){
  const p=f?.progress;
  const fresh=p&&now-p.received_at_ms>=0&&now-p.received_at_ms<=30000&&now-p.captured_at_ms>=-2000&&now-p.captured_at_ms<=30000&&p.logical_day===cstDay(now);
  if(!fresh)parts.unshift('当前奖励进度我暂时查不到，请看设备上的奖励页面。');
  else{
   const kind=p.kind==='currency'?'家族币':p.kind==='chest'?'宝箱':p.kind==='item'?'补勤卡':'奖励';
   const target=/宝箱/.test(q)?'chest':/家族币.{0,6}(?:还要|还需|多久|领取)|(?:多久|领取).{0,6}家族币/.test(q)?'currency':/补[勤签]卡.{0,6}(?:还要|还需|多久|领取)|(?:多久|领取).{0,6}补[勤签]卡/.test(q)?'item':null;
   const mismatch=target!==null&&target!==p.kind;
   const tail=mismatch?'这不是你问的那一种奖励，那一项的进度我暂时查不到。':'';
   switch(p.status){
    case 'locked':{
     const duration=p.remaining_seconds!%60===0?`${p.remaining_seconds!/60}分钟`:`${p.remaining_seconds}秒`;
     const timer={running:'按本次同步的进度',paused:'计时已暂停',stopped:'计时已停止',unknown:'计时状态暂不明确'}[p.timer_state];
     parts.unshift(`${timer}，下一项是${kind}，还需约${duration}有效使用时间。达到条件后是否需要领取，以设备页面为准。${tail}`);break;
    }
    case 'claimable':parts.unshift(`本次同步显示${kind}已可领取，共${p.claimable_count}项奖励；这不是到账数量，请按设备页面提示领取。${tail}`);break;
    case 'claimed':parts.unshift(`本次同步显示${kind}这一项已领取；下一项的时间我暂时查不到。${tail}`);break;
    case 'day_complete':parts.unshift('本次同步显示当天这组奖励已完成，暂时没有下一项倒计时。');break;
    default:parts.unshift('当前奖励进度我暂时查不到，请看设备上的奖励页面。');
   }
  }
 }
 return parts.length?parts.join(''):'这部分方舟数据我暂时查不到，不能据此推算收益或进展。';
}
