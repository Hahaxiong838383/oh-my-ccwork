/** Product-approved ASR aliases. Decision text only; never rewrite the transcript. */
export function normalizeArkVocabulary(text:string):string {
 return text.replace(/捕禽卡|古琴卡|抚琴卡|抚琴弹|补签卡/g,'补勤卡').replace(/加组币/g,'家族币');
}
const compact=(s:string)=>s.replace(/[\s，,。？！?!、]/g,'').replace(/^(?:小可)+/,'');
export function incompleteArkCard(text:string):boolean {
 const t=compact(text);
 return /^(?:(?:请问|我|现在|还有|有|多少|几张|的|方舟里|方舟里的|这张|那张|个|张))*[行仙]卡(?:有什么用|有啥用|怎么用|是什么|多少|几张|吗|呢)?$/.test(t);
}
export function unfinishedUtterance(text:string):boolean {
 return /^(?:请问|请告诉|请告诉我|(?:请告诉我)?我(?:现在|还)?(?:有|有几[张枚个]|有多少[张枚个]?)?|现在还|方舟里的补|方舟里的补勤|文章捕|有什么用|展示出来|你还是告诉我|我点哪里|就在|就在你这啊|就是你这|界面是|(?:请问)?方舟里的(?:补|补勤)?)$/.test(compact(text));
}
const resource=(s:string)=>/家族币|金币|加组币/.test(s)?'家族币':/星尘|星辰|企鹅摆件|游戏道具|生态缸/.test(s)?'星尘':/补勤卡|捕禽卡|古琴卡|补签卡|抚琴[卡弹]/.test(s)?'补勤卡':/方舟|专注奖励|进度条|界面.*(?:币|[bB])/.test(s)?'方舟':null;
const external=(s:string)=>/原神|明日方舟|我的世界|别的游戏|其他游戏|翻译|造句|他说|她说|故事|天气|气温|股票|金价/.test(s);
const continuation=(s:string)=>s.length<=28&&/^(?:好|好你帮我|好你帮我换吧|换换快点换|快|我点哪里|展示出来|界面是|就是你这|就在你这啊|就在|就是这个家族|咱俩|这都必须咱俩约定|请问|请告诉|请告诉我|文章捕|方舟里的补|方舟里的补勤|那.*|现在呢|还有呢|可以吗|嗯.*|对.*|是.*)$/.test(compact(s));
/** Assistant text may establish a topic, never facts, price, capabilities or a completed action. */
export function arkDialogueTopic(history:{role:string;content:string}[]):string|null {
 let topic:string|null=null,blocked=false;
 for(const t of history.slice(-8)){
  const s=normalizeArkVocabulary(t.content);
  if(t.role==='user'){
   if(external(s)){topic=null;blocked=true;continue;}
   const r=resource(s);if(r){topic=r;blocked=false;}
   else if(!continuation(s)&&!unfinishedUtterance(s)){topic=null;blocked=true;}
  }else if(t.role==='assistant'&&!blocked&&!topic&&!external(s))topic=resource(s);
 }
 return topic;
}
export function arkConversationQuery(text:string,history:{role:string;content:string}[]):string|null {
 const t=compact(text),topic=arkDialogueTopic(history);
 if(!topic||external(text))return null;
 if(/^(?:好你帮我(?:换吧)?|换换快点换|我点哪里|帮我领(?:取)?(?:吧)?|帮我换(?:吧)?)$/.test(t))return '方舟当前待领取奖励';
 if(topic==='补勤卡'&&/^(?:我)?(?:现在|还)?(?:有)?(?:多少|几)张$/.test(t))return '我有多少补勤卡';
 if(topic==='补勤卡'&&/^(?:条件呢|什么条件|有哪些条件|有什么条件|怎么才能用)$/.test(t))return '补勤卡的用途和使用条件是什么';
 if(t==='界面是')return '方舟当前界面和奖励进度';
 if(/^(?:就是你这|就在你这啊|就是这个家族)$/.test(t)&&topic==='家族币')return '家族币有什么用';
 return null;
}
export function arkConversationPolicy(text:string,history:{role:string;content:string}[]):string {
 const topic=arkDialogueTopic(history),t=compact(text);
 if(/收入|收益/.test(text)&&!/别|不要|不用|停止|结束|不想|退出|再见|拜拜|关房|退下|闭嘴/.test(text))return '【收益问询】这是询问收益，不是结束对话。对象或意思不清时简短确认是在问哪一项收益；不得捏造数量或代领，不告别，不输出设备或退出标记。';
 if(!topic&&/^(?:好你帮我换吧|换换快点换|好你帮我)$/.test(t))return '【对象待确认】用户没有说换什么。用一句话询问想换什么；不是退出请求，不告别，不调灯，不声称已完成。';
 if(/界面.*(?:币|[bB])/.test(text))return '【界面资源】不能直接看到屏幕。若指金币则是家族币，星尘是另一种资源；未说清对象时简短确认，不捏造金额、按钮或商品，不输出设备控制标记。';
 const aliases=text.match(/捕禽卡|古琴卡|抚琴卡|抚琴弹|补签卡|加组币/g);
 if(aliases&&!external(text))return '【本轮识别校正】'+[...new Set(aliases)].map(x=>x+'指'+normalizeArkVocabulary(x)).join('；')+'。按校正后的方舟资源理解，不将其当乐器或陌生道具。话未说完可简短追问，不输出设备或退出标记。';
 if(unfinishedUtterance(text))return '【本轮未说完】用户的话未说完或识别不完整。用一句短话让用户继续，或简短确认具体意思；不要告别、不要结束对话、不要输出任何设备或退出标记。不要擅自补全道具名。';
 if(topic&&/咱俩/.test(t))return '【指代】咱俩指用户和你（小可），不是用户和父母；先正确接住这个指代。可以陪用户商量奖励，但不能替家长决定或兑现。';
 if(topic&&(continuation(text)||resource(normalizeArkVocabulary(text))))return '【方舟能力边界】历史助手声称已兑换、已代领、已展示页面的说法不是事实。小可当前只能介绍/查询，不能代领、兑换或切出游戏页面。家族币和家长约定奖励，小程序可查看已同步资产；不编造尚未实现的兑换按钮。';
 return '';
}
/** Stream-safe suppression of DEV tags only for protected non-command turns. */
export function createArkControlFilter(enabled:boolean){
 let pending='';const prefix='[[DEV:';
 return {feed(chunk:string){if(!enabled)return chunk;pending+=chunk;let out='';
  while(pending){const at=pending.indexOf(prefix);if(at>=0){out+=pending.slice(0,at);pending=pending.slice(at);const end=pending.indexOf(']]');if(end<0){if(pending.length>64)pending='';break;}pending=pending.slice(end+2);continue;}
   let hold=0;for(let n=1;n<prefix.length;n++)if(pending.endsWith(prefix.slice(0,n)))hold=n;
   out+=pending.slice(0,pending.length-hold);pending=pending.slice(pending.length-hold);break;
  }return out;},flush(){const tail=enabled&&prefix.startsWith(pending)||enabled&&pending.startsWith(prefix)?'':pending;pending='';return tail;}};
}
