import {normalizeArkVocabulary} from './language.js';
import {cstDay,resolvedFactsSchema,type ArkFacts} from './contracts.js';
import {isArkStateQuestion,isOutsideArkQuestion,deferArkDirectReply,isArkGameExchangeQuestion,resolveArkResourceFollowup,answerArkResourceUse,ARK_RESOURCE_USES,ARK_GOLD_ALIAS} from '../xiaoke-kb.js';
import {resolveArkQuestion} from './memory-policy.js';
type Turn={role:string;content:string};
type Auth={accountId:string;role:string}|null;
/** Main may intentionally omit the optional callback key; verified service JWT + explicit SN remain mandatory.
 * Original verified Worker identity is required, even for static direct answers. */
export function arkDirectReplyAllowed(auth:Auth,room:string,override=false,feedback=false):boolean {
 if(override||feedback||auth?.role!=='device'||!process.env.AUTH_JWT_SECRET?.trim()||(!!process.env.ARK_FACTS_PROXY_URL&&!process.env.CUSTOM_LLM_API_KEY?.trim()))return false;
 const mainJwtOnly=!process.env.CUSTOM_LLM_API_KEY?.trim();
 if(mainJwtOnly&&(process.env.SEARCH_CANARY_ROOT||process.env.ARK_FACTS_PROXY_URL||!process.env.ARK_WORKER_ACCOUNT_ID?.trim()))return false;
 const worker=process.env.ARK_FACTS_PROXY_URL?process.env.SEARCH_WORKER_ACCOUNT_ID:(process.env.ARK_WORKER_ACCOUNT_ID??process.env.SEARCH_WORKER_ACCOUNT_ID);
 const sn=/^sn-(BJP003\d{14})-\d{1,20}$/.exec(room)?.[1];
 return !!worker&&auth.accountId===worker&&!!sn&&(process.env.ARK_DIRECT_REPLY_SN_ALLOW??'').split(',').map(s=>s.trim()).includes(sn);
}
const uses=ARK_RESOURCE_USES;
/** Static usage/exchange followups share the same bounded resolver as knowledge recall. */
export function resolveArkUsageQuestion(text:string,history:Turn[]):string|null {
 return resolveArkResourceFollowup(text,history);
}
function stamp(ms:number,now:number){const d=new Date(ms+8*3600000).toISOString();return (cstDay(ms)===cstDay(now)?'今天':d.slice(0,10))+' '+d.slice(11,19);}
function cleanFacts(raw:ArkFacts|undefined):ArkFacts|undefined{
 if(!raw)return undefined;const p=resolvedFactsSchema.safeParse({schema_version:raw.schema_version,assets:raw.assets,progress:raw.progress,...(raw.daily!==undefined?{daily:raw.daily}:{})});return p.success?p.data:undefined;
}
/** A finite factual route, not a second model. The caller must return after sending it. */
export function answerArk(text:string,raw?:ArkFacts,history:Turn[]=[],now=Date.now()):string|null{
 text=normalizeArkVocabulary(text);
 if(isOutsideArkQuestion(text)||deferArkDirectReply(text))return null;
 const knownUse=answerArkResourceUse(text,history);if(knownUse)return knownUse;
 // Mixed unrelated requests remain ordinary conversation instead of losing a question.
 if(text.split(/另外|顺便|[，,；;]/).slice(1).some(part=>/为什么|怎么|什么|多少|吗|呢/.test(part)&&!/家族币|星尘|星辰|金币|补[勤签]卡|宝箱|方舟|奖励|有.*用|用途|还.*多久/.test(part)))return null;
 let q=resolveArkUsageQuestion(text,history)??resolveArkQuestion(text,history)??text;
 if(/^(?:家族币|星尘|星辰|补勤卡|补签卡)[。？！?！]*$/.test(text.trim())&&/金币.*(?:有什么用|用途)/.test([...history].reverse().find(t=>t.role==='user')?.content??''))q=text+'有什么用';
 const exchange=isArkGameExchangeQuestion(q);
 const usage=/(?:有什么用|有啥用|干什么用|做什么用|怎么用|是什么|用途|用处|作用|能干什么|能干嘛|是干嘛的|可以干什么|介绍|能换|兑换)/.test(q)||exchange||/^(?:金币|家族币|星尘|星辰)[。？！?!]*$/.test(q.trim());
 const state=isArkStateQuestion(q);
 const family=/家族币|金币/.test(q),star=/星尘|星辰/.test(q),card=/补勤卡|补签卡/.test(q),coin=/金币/.test(q);
 if(!state&&!(usage&&(family||star||card||coin||exchange)))return null;
 const f=cleanFacts(raw);
 const complaint=/(?:在这|读写台).*(?:待|坐|用).*(?:久|时长).*(?:不给|没有|没).*(?:加|奖励|收益)/.test(q);
 const summary=complaint||/方舟.{0,8}(?:进度|进展)|(?:今天|今日).*(?:使用时长|用了多久|用了多长)/.test(q);
 const earned=state&&/今天|今日|当天/.test(q)&&/赚|获得|收益|所得|收入/.test(q);
 const day=f?.daily,validDay=day&&day.logical_day===cstDay(now)&&day.observed_at_ms<=now&&day.received_at_ms<=now?day:null;
 const dailyParts:string[]=[];
 if(summary){
  dailyParts.push(validDay?.progress_seconds!==null&&validDay?.progress_seconds!==undefined?`截至${stamp(validDay.observed_at_ms,now)}的记录，今天奖励进度已累计${Math.floor(validDay.progress_seconds/60)}分钟${validDay.progress_seconds%60?validDay.progress_seconds%60+'秒':''}；全天总使用时长暂时查不到。`:'今天的累计使用时长和奖励进度时长，我暂时查不到。');
 }
 if(earned||summary){
  const labels:Record<string,[string,string]>={'C-FAMILY-001':['家族币','枚'],'C-STARDUST-001':['星尘',''],'M-CARD-001':['补勤卡','张'],'CHEST-COMMON-001':['普通宝箱','个']};
  const rewards=validDay?.rewards?.filter(r=>!earned||!family||r.item_id==='C-FAMILY-001');
  const known=rewards?.filter(r=>labels[r.item_id]);
  dailyParts.push(known?.length?`今天已同步的发奖记录有${known.map(r=>labels[r.item_id][0]+r.quantity+labels[r.item_id][1]).join('、')}；后续同步可能补齐更多记录。`:'今日收益中已获得的'+(family?'家族币数量':'收益和道具')+'我暂时查不到，不能把钱包余额当成今天获得的数量。');
  if(rewards?.some(r=>!labels[r.item_id]))dailyParts.push('另有已同步的道具记录，具体名称我暂时无法确认。');
  if(earned)return (coin?ARK_GOLD_ALIAS:'')+dailyParts.join('')+'在读写台前有效使用达到奖励门槛，进度条奖励点亮后点击领取，就能获得对应家族币或道具。';
 }
 // Normalize only the decision text; the stored utterance and wallet IDs remain untouched.
 q=q.replace(/金币/g,'家族币');
 const progress=summary||/下一|下次|多久|剩.{0,3}(?:时间|分钟|秒)|奖励|宝箱|方舟.{0,8}(?:进度|进展)|暂停|可领|领取|领到|领了/.test(q);
 const parts:string[]=[...dailyParts,...(coin?[ARK_GOLD_ALIAS]:[])];
 const addAsset=(key:keyof typeof uses,label:string,unit:string)=>{
  const assetQuestion=new RegExp(key==='family_coin'?'家族币.{0,6}(?:多少|几|余额)|(?:多少|几枚).{0,3}家族币':key==='stardust'?'(?:星尘|星辰).{0,6}(?:多少|几|余额)|(?:多少|几).{0,3}(?:星尘|星辰)':'补[勤签]卡.{0,6}(?:多少|几|库存)|(?:多少|几张).{0,3}补[勤签]卡').test(q);
  const exchangeBalance=!exchange||/(?:我(?:现在|目前)?(?:有多少|有几|还有多少|还剩多少)|余额|库存|还剩多少|还有多少)/.test(q);
  if(state&&exchangeBalance&&(!progress||assetQuestion)){
   const a=f?.assets[key];
   parts.push(a&&a.occurred_at_ms<=now+2000&&a.received_at_ms<=now?`截至${stamp(a.occurred_at_ms,now)}的上次同步，${label}是${a.value}${unit}。`:`${label}我暂时查不到，可以看设备上的资源页面。`);
  }
  if(usage)parts.push(uses[key]);
 };
 if(/方舟当前界面/.test(q)){for(const [key,label,unit] of [['family_coin','家族币','枚'],['stardust','星尘',''],['makeup_card','补勤卡','张']] as const){const a=f?.assets[key];if(a&&a.occurred_at_ms<=now&&a.received_at_ms<=now)parts.push(`上次同步的${label}是${a.value}${unit}。`);}parts.push('我只能按已同步状态介绍，不能直接看到屏幕上的具体布局。');}
 if(family)addAsset('family_coin','家族币余额','枚');
 if(star)addAsset('stardust','星尘余额','');
 if(exchange&&!star)parts.push(uses.stardust);
 if(star&&/人民币|现金|现实|提现|肯德基/.test(q))parts.push('星尘不能兑换现实金钱或物品。');
 if(card)addAsset('makeup_card','补勤卡库存','张');
 if(progress&&state&&!exchange&&!(usage&&/爸妈|爸爸|妈妈|父母|家长|亲子|约定/.test(q))){
  const p=f?.progress;
  const fresh=p&&now-p.received_at_ms>=0&&now-p.received_at_ms<=30000&&now-p.captured_at_ms>=-2000&&now-p.captured_at_ms<=30000&&p.logical_day===cstDay(now);
  if(!fresh)parts.unshift('当前待领状态和下一项剩余时间我暂时查不到。人在读写台前有效使用达到阶段门槛，进度条上的奖励会点亮，点击即可领取；小可不能代领。');
  else{
   if(p.status!=='claimable'&&p.claimable_count!==null&&p.claimable_count>0)parts.push(`还有${p.claimable_count}项未领取奖励，请点击进度条上已点亮的奖励领取，小可不能代领。`);
   const kind=p.kind==='currency'?'家族币':p.kind==='chest'?'宝箱':p.kind==='item'?'补勤卡':'奖励';
   const target=/宝箱/.test(q)?'chest':/下[一个次项]{1,3}家族币|家族币.{0,6}(?:还要|还需|多久|领取)|(?:多久|领取).{0,6}家族币/.test(q)?'currency':/补[勤签]卡.{0,6}(?:还要|还需|多久|领取)|(?:多久|领取).{0,6}补[勤签]卡/.test(q)?'item':null;
   const mismatch=target!==null&&target!==p.kind;
   const tail=mismatch?'这不是你问的那一种奖励，那一项的进度我暂时查不到。':'';
   switch(p.status){
    case 'locked':{
     const duration=p.remaining_seconds!%60===0?`${p.remaining_seconds!/60}分钟`:`${p.remaining_seconds}秒`;
     const timer={running:'按本次同步的进度',paused:'计时已暂停',stopped:'计时已停止',unknown:'计时状态暂不明确'}[p.timer_state];
     parts.unshift(`${timer}，下一项是${kind}，还需约${duration}有效使用时间。有效使用达标后，进度条奖励会点亮，再点击领取。${tail}`);break;
    }
    case 'claimable':parts.unshift(`本次同步显示${kind}已可领取，共${p.claimable_count}项奖励；请点击读写台进度条上已点亮的奖励领取，小可不能替你代领或兑换。${tail}`);break;
    case 'claimed':parts.unshift(`本次同步显示${kind}这一项已领取；下一项的时间我暂时查不到。${tail}`);break;
    case 'day_complete':parts.unshift('本次同步显示当天这组奖励已完成，暂时没有下一项倒计时。');break;
    default:parts.unshift('当前待领状态和下一项剩余时间我暂时查不到。人在读写台前有效使用达到阶段门槛，进度条上的奖励会点亮，点击即可领取；小可不能代领。');
   }
  }
 }
 return parts.length?parts.join(''):'这部分方舟数据我暂时查不到，不能据此推算收益或进展。';
}
