'use strict';
// Geometry uses separate layouts for wide panels and small screens.
const layouts = {
  chat: [
    {w:854, h:286, nw:138, nh:54,
     nodes:{"asr":[18,122],"router":[188,122],"prompt":[358,122],"llm":[528,122],"tts":[698,122],"recall":[257,34],"style":[453,34],"tools":[188,216],"render":[698,216]},
     edges:[
       ["asr","router",[[156,149],[188,149]]],
       ["router","prompt",[[326,149],[358,149]]],
       ["prompt","llm",[[496,149],[528,149]]],
       ["llm","tts",[[666,149],[698,149]]],
       ["recall","prompt",[[326,88],[326,101],[399,101],[399,122]]],
       ["style","prompt",[[522,88],[522,101],[455,101],[455,122]]],
       ["router","tools",[[257,176],[257,216]]],
       ["tts","render",[[767,176],[767,216]]],
     ]},
    {w:312, h:425, nw:134, nh:50,
     nodes:{"asr":[8,29],"router":[8,105],"prompt":[8,211],"llm":[8,285],"tts":[8,363],"tools":[169,105],"recall":[169,175],"style":[169,247],"render":[169,363]},
     edges:[
       ["asr","router",[[75,79],[75,105]]],
       ["router","prompt",[[75,155],[75,211]]],
       ["prompt","llm",[[75,261],[75,285]]],
       ["llm","tts",[[75,335],[75,363]]],
       ["router","tools",[[142,130],[169,130]]],
       ["recall","prompt",[[169,200],[155,200],[155,227],[142,227]]],
       ["style","prompt",[[169,272],[155,272],[155,246],[142,246]]],
       ["tts","render",[[142,388],[169,388]]],
     ]},
  ],
  feedback: [
    {w:854, h:286, nw:138, nh:54,
     nodes:{"asr":[18,122],"router":[188,122],"context":[358,122],"growth":[528,122],"traits":[698,53],"examples":[698,205],"tools":[188,216]},
     edges:[
       ["asr","router",[[156,149],[188,149]]],
       ["router","context",[[326,149],[358,149]]],
       ["context","growth",[[496,149],[528,149]]],
       ["growth","traits",[[666,149],[681,149],[681,80],[698,80]]],
       ["growth","examples",[[666,149],[681,149],[681,232],[698,232]]],
       ["router","tools",[[257,176],[257,216]]],
     ]},
    {w:312, h:346, nw:134, nh:50,
     nodes:{"asr":[8,29],"router":[8,96],"context":[8,164],"growth":[8,236],"tools":[169,96],"traits":[169,207],"examples":[169,283]},
     edges:[
       ["asr","router",[[75,79],[75,96]]],
       ["router","context",[[75,146],[75,164]]],
       ["context","growth",[[75,214],[75,236]]],
       ["router","tools",[[142,121],[169,121]]],
       ["growth","traits",[[142,261],[155,261],[155,232],[169,232]]],
       ["growth","examples",[[142,261],[155,261],[155,308],[169,308]]],
     ]},
  ],
  weather: [
    {w:854, h:286, nw:138, nh:54,
     nodes:{"asr":[18,122],"router":[188,122],"context":[358,122],"tools":[528,122],"tts":[698,122],"llm":[358,34],"growth":[528,216],"render":[698,216]},
     edges:[
       ["asr","router",[[156,149],[188,149]]],
       ["router","context",[[326,149],[358,149]]],
       ["context","tools",[[496,149],[528,149]]],
       ["tools","tts",[[666,149],[698,149]]],
       ["router","llm",[[257,122],[257,61],[358,61]]],
       ["router","growth",[[257,176],[257,243],[528,243]]],
       ["tts","render",[[767,176],[767,216]]],
     ]},
    {w:312, h:377, nw:134, nh:50,
     nodes:{"asr":[8,29],"router":[8,97],"context":[8,165],"tools":[8,233],"tts":[8,316],"llm":[169,97],"growth":[169,233],"render":[169,316]},
     edges:[
       ["asr","router",[[75,79],[75,97]]],
       ["router","context",[[75,147],[75,165]]],
       ["context","tools",[[75,215],[75,233]]],
       ["tools","tts",[[75,283],[75,316]]],
       ["router","llm",[[142,122],[169,122]]],
       ["router","growth",[[142,122],[155,122],[155,258],[169,258]]],
       ["tts","render",[[142,341],[169,341]]],
     ]},
  ],
  store: [
    {w:854, h:286, nw:138, nh:54,
     nodes:{"asr":[18,122],"router":[188,122],"memory":[358,122],"tts":[698,122],"recall":[358,34],"tools":[188,216],"render":[698,216]},
     edges:[
       ["asr","router",[[156,149],[188,149]]],
       ["router","memory",[[326,149],[358,149]]],
       ["router","recall",[[257,122],[257,61],[358,61]]],
       ["router","tools",[[257,176],[257,216]]],
       ["tts","render",[[767,176],[767,216]]],
     ]},
    {w:312, h:332, nw:134, nh:50,
     nodes:{"asr":[8,29],"router":[8,97],"memory":[8,177],"tts":[8,270],"tools":[169,97],"recall":[169,177],"render":[169,270]},
     edges:[
       ["asr","router",[[75,79],[75,97]]],
       ["router","memory",[[75,147],[75,177]]],
       ["router","tools",[[142,122],[169,122]]],
       ["router","recall",[[142,122],[155,122],[155,202],[169,202]]],
       ["tts","render",[[142,295],[169,295]]],
     ]},
  ],
};
const graphNames = {"asr":"语音识别","router":"意图路由","recall":"长期记忆筛选","style":"说话风格","prompt":"组装输入","llm":"生成回答","tts":"语音合成","render":"手机播放","tools":"工具调用","context":"通话上下文","growth":"反馈归因","traits":"人格特质","examples":"讲法样例","memory":"长期事实"};
const laneLabels = {"chat":["回答前读取","实时回答","分支与交付"],"feedback":["特质变化","同通反馈","分支与写入"],"weather":["可选模型路径","查询与交付","分支与回执"],"store":["可选召回","事实处理","分支与回执"]};
const graphIcons = {
  asr: "<rect x=\"7\" y=\"2\" width=\"6\" height=\"10\" rx=\"3\"/><path d=\"M4 9a6 6 0 0 0 12 0M10 15v3m-4 0h8\"/>",
  router: "<path d=\"M3 10h5c3 0 2-5 6-5h3m-3-3 3 3-3 3M8 10c3 0 2 5 6 5h3m-3-3 3 3-3 3\"/>",
  recall: "<ellipse cx=\"9\" cy=\"4.5\" rx=\"6.5\" ry=\"2.5\"/><path d=\"M2.5 4.5v9c0 1.5 3 3 6.5 3m6.5-12v4M3 9c2 2 5 2.4 8 2.2\"/><circle cx=\"14\" cy=\"13.5\" r=\"3\"/><path d=\"m16.5 16 2 2\"/>",
  style: "<path d=\"M2 5h10m3 0h3M2 14h3m3 0h10\"/><circle cx=\"13.5\" cy=\"5\" r=\"2\"/><circle cx=\"6.5\" cy=\"14\" r=\"2\"/>",
  prompt: "<path d=\"m2 6 8-4 8 4-8 4zM2 10l8 4 8-4M2 14l8 4 8-4\"/>",
  llm: "<rect x=\"4\" y=\"4\" width=\"12\" height=\"12\" rx=\"2.5\"/><path d=\"M7 1v3m6-3v3M7 16v3m6-3v3M1 7h3m-3 6h3m12-6h3m-3 6h3m-11-3h4\"/>",
  tts: "<path d=\"M2 8v4m4-8v12m4-15v18m4-15v12m4-8v4\"/>",
  render: "<rect x=\"5\" y=\"1.5\" width=\"10\" height=\"17\" rx=\"2\"/><path d=\"M8.5 4h3m-2.5 12h2\"/>",
  tools: "<circle cx=\"10\" cy=\"10\" r=\"7.5\"/><path d=\"M2.5 10h15m-7.5-7.5c-4.5 4-4.5 11 0 15m0-15c4.5 4 4.5 11 0 15\"/>",
  context: "<path d=\"M2 3h13v9H7l-4 3V3m5 12h6l3 2V7\"/>",
  growth: "<path d=\"M3 17v-5m6 5V8m6 9v-4M2 9l5-5 4 3 6-5m-5 0h5v5\"/>",
  traits: "<path d=\"M3 15h4v-4h5V5h5\"/><circle cx=\"3\" cy=\"15\" r=\"1.5\"/><circle cx=\"17\" cy=\"5\" r=\"1.5\"/>",
  examples: "<path d=\"M5 3h11v14l-5.5-3L5 17zM8 7h5m-5 3h4\"/>",
  memory: "<ellipse cx=\"10\" cy=\"4\" rx=\"7\" ry=\"2.5\"/><path d=\"M3 4v11c0 1.5 3 3 7 3s7-1.5 7-3V4M3 9c2 2.5 12 2.5 14 0\"/>",
};


const byId = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const array = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const dated = value => finite(value) && value > 0 ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '时间缺测';
const humanRoute = {model:'模型生成', feedback:'讲法反馈', memory_action:'更新记忆', memory:'据证回答', style:'风格控制', weather:'天气查询', search:'联网搜索', clock:'当前时间', direct:'直接回答', search_cancel:'取消查询', capabilities:'能力说明'};
const toolOutcomes = new Map([['with_sources','有来源'], ['without_sources','未附来源'], ['handled','已处理']]);
function toolOutcome(value){return toolOutcomes.get(value)||value||'结果缺测';}
const moduleInfo = new Map([...document.querySelectorAll('[data-atlas-module]')].map(a => [a.dataset.atlasModule,a.dataset]));
const state = {rooms:[], totalRooms:0, detail:null, turn:null, module:'router', roomRequest:0, listRequest:0};
const sessionPage = 25;
const turnPage = 20;

function evidence(t, id) {
  const timing = t.timing || {};
  const memories = array(t.memories);
  const growth = array(t.growth);
  const attributed = array(t.attributedGrowth);
  const related = [...new Map([...growth, ...attributed].filter(Boolean).map(g=>[g.id,g])).values()];
  const selected = array(t.recall?.items);
  const result = (status, short, why, raw=null, records=[]) => ({status, short, why, raw, records});
  const miss = reason => result('miss','缺测',reason || '这条回复没有可核对的模块回执。');
  const hit = (short, why, raw, records) => result('hit',short,why,raw,records);
  const change = (short, why, raw, records) => result('change',short,why,raw,records);
  const activeRoute = humanRoute[t.route] || t.route;
  const meta = moduleInfo.get(id);
  if (!meta) return miss();
  if (meta.state === '公司参考' || meta.state === '私人版关闭') return result('off',meta.state,meta.state === '公司参考' ? '公司机制仅供架构对照，私人版没有本轮执行回执。' : '该机制在私人版关闭。');
  if (id === 'router') return t.route ? hit(activeRoute,'从这条回复持久化的处理分支读取。',{replyId:t.reply.id,route:t.route}) : miss('历史回复没有记录实际处理分支。');
  if (id === 'recall' || id === 'traces' || id === 'grounded' || id === 'prompt') {
    if (!t.recall) return miss('没有这条回复对应的记忆使用回执。');
    if (id === 'grounded' && !(t.route==='memory' && t.recall.mode==='direct' && selected.length)) return miss('没有可证明本轮直接据证命中的完整记录。');
    if (id==='prompt' && t.recall.mode!=='model') return miss('本轮没有模型输入层回执。');
    const direct=t.recall.mode==='direct';
    const label=direct ? (selected.length?'直接引用 '+selected.length+' 条':'直接分支 · 0 条') : '选入 '+selected.length+' 条';
    const why=direct ? '记忆使用回执来自直接回答分支。条目数量只表示本轮记录的事实引用。' : '记忆使用回执记录了送入模型的事实条数。完整提示及模型如何使用这些事实仍缺测。';
    return hit(label,why,{replyId:t.reply.id,mode:t.recall.mode,count:selected.length},selected.map(m=>({type:'memory',item:m})));
  }
  if(id==='style')return t.style ? hit(t.style,'读取本轮实际记录的风格策略。',{replyId:t.reply.id,style:t.style}) : miss('缺少本轮生效风格，不能从当前配置倒推。');
  if(id==='llm')return t.route==='model' ? hit('已生成回答','成功完成模型生成，并保存了右侧回复。',{replyId:t.reply.id,route:t.route}) : miss('本轮没有可验证的普通模型生成回执。');
  if(id==='tools')return t.tool ? hit(humanRoute[t.tool.tool]||t.tool.tool||'工具回执','按回复标识关联的工具执行记录。',{id:t.tool.id,replyId:t.reply.id,tool:t.tool.tool,outcome:t.tool.outcome,sourceCount:t.tool.sourceCount,turnMs:t.tool.turnMs,at:t.tool.at,sources:array(t.tool.sources).flatMap(s=>safeURL(s.url)?[{title:s.title,url:s.url}]:[])},[{type:'tool',item:t.tool}]) : miss('没有与当前回复精确关联的工具回执。历史相邻查询不并入。');
  if(id==='memory'||id==='extract')return memories.length ? change('写入 '+memories.length+' 条','下列当前事实的来源标识指向本轮主人的原话。完整抽取队列耗时缺测。',{replyId:t.reply.id,sourceMessage:t.user?.id,count:memories.length},memories.map(m=>({type:'memory',item:m}))) : miss('没有可以从本轮原话定位的当前事实条目；不能从空列表倒推抽取结果。');
  if(['growth','traits','examples','context','undo'].includes(id)) {
    let list=related;
    if(id==='traits')list=list.filter(g=>g.module==='trait');
    if(id==='examples')list=list.filter(g=>g.rule==='explicit_style_feedback');
    if(id==='undo')list=list.filter(g=>finite(g.revokedAt));
    if(!list.length)return miss('没有能关联这条回复和明确反馈的对应事件。');
    const records=list.map(g=>({type:'growth',item:g}));
    if(id==='context')return hit('同通反馈关联','事件同时保留被评价的回复和反馈原话。',{replyId:t.reply.id,eventIds:list.map(g=>g.id)},records);
    return change(list.length+' 条事件','核对下列事件中的原回答、反馈原话和撤回状态。登记样例后，后续是否实际选入仍需另有回执。',{replyId:t.reply.id,eventIds:list.map(g=>g.id)},records);
  }
  const stage={asr:'asr_final',control:'commit',tts:'first_audio',audio:'post_filler_audio'};
  if(id==='timing')return Object.values(stage).some(field=>finite(timing[field]))||finite(timing.speakable)
    ? hit('阶段采样','时间通过房间和 Worker 轮次精确关联。两个计时起点在图中分组显示。',timing) : miss('当前回复缺少可关联的 Worker 时间采样。');
  if(stage[id]){
    const value=timing[stage[id]];
    return finite(value)?hit(value+' ms',({asr:'相对于判停参考点的识别定稿时间。',control:'相对于判停参考点的提交时间。',tts:'Worker 自该轮开始到发出首段 PCM，可能包含衔接语。',audio:'Worker 自该轮开始到衔接语后音频的采样。'})[id],{replyId:t.reply.id,workerTurn:t.voiceTurn,event:stage[id],ms:value,at:timing.at}):miss('该回复没有可关联的此阶段采样。');
  }
  if(id==='render'||id==='avatar')return miss('没有与此回复对齐的手机实际播放或画面回执。');
  return miss();
}

function schemaFor(t) {
  if(array(t.growth).length || t.route==='feedback')return 'feedback';
  if(['weather','clock','search','search_cancel'].includes(t.tool?.tool) || ['weather','clock','search','search_cancel'].includes(t.route))return 'weather';
  if(['memory','memory_action'].includes(t.route) || array(t.memories).length)return 'store';
  return 'chat';
}
function hrefModule(id) {return '#m-'+encodeURIComponent(id);}
function graphicLink(id,markup,label,attrs='') {
  return '<a href="'+hrefModule(id)+'" data-module="'+esc(id)+'" aria-label="'+esc(label)+'" '+attrs+'><title>'+esc(label)+'</title>'+markup+'</a>';
}
function wire(points) {
  const path=points.map(([x,y],i)=>(i?'L':'M')+x+' '+y).join(' ');
  const [x,y]=points.at(-1),[p,q]=points.at(-2),length=Math.hypot(x-p,y-q);
  const dx=(x-p)/length,dy=(y-q)/length,u=x-dx*6,v=y-dy*6;
  return '<path class="gw" d="'+path+'"/><path d="M'+(u-dy*3)+' '+(v+dx*3)+' L'+x+' '+y+' L'+(u+dy*3)+' '+(v-dx*3)+'"/>';
}
function renderFlow(t){
  const kind=schemaFor(t);
  const pictures=layouts[kind].map(({w,h,nw,nh,nodes,edges},i)=>{
    const stage=i?'<rect class="glane" x="160" y="2" width="150" height="'+(h-5)+'" rx="10"/><text class="gcap" x="10" y="18">本轮主线</text><text class="gcap" x="172" y="18">依据与分支</text>':
      '<rect class="glane" x="1" y="4" width="852" height="94" rx="9"/><rect class="glane glow" x="1" y="203" width="852" height="79" rx="9"/>'+laneLabels[kind].map((n,j)=>'<text class="gcap" x="16" y="'+[25,116,222][j]+'">'+esc(n)+'</text>').join('');
    const states=Object.fromEntries(Object.keys(nodes).map(id=>[id,evidence(t,id)]));
    const lines=edges.map(([a,b,pts])=>'<g class="ge ge-'+(states[a].status==='miss'||states[b].status==='miss'?'miss':states[b].status)+'">'+wire(pts)+'</g>').join('');
    const boxes=Object.entries(nodes).map(([id,[x,y]])=>{
      const e=states[id],sub=String(e.short),label=graphNames[id];
      return graphicLink(id,'<g transform="translate('+x+','+y+')"><rect class="gbox" width="'+nw+'" height="'+nh+'" rx="7"/><g class="gicon" transform="translate(11,10) scale(.84)">'+graphIcons[id]+'</g><text class="gname" x="34" y="24">'+esc(label)+'</text><text class="gsub" x="12" y="'+(nh-9)+'">'+esc(sub.length>10?sub.slice(0,9)+'…':sub)+'</text></g>',label+' · '+sub,'class="gn gn-'+e.status+(state.module===id?' selected':'')+'" data-graph-module="'+id+'"');
    }).join('');
    return '<svg class="gcanvas g-'+(i?'narrow':'wide')+'" viewBox="0 0 '+w+' '+h+'" role="group" aria-label="本轮运行机制图">'+stage+lines+boxes+'</svg>';
  });
  byId('map').innerHTML=pictures.join('')+'<div class="glegend"><span><i class="lg-hit"></i>两端有回执</span><span><i class="lg-change"></i>记录到变化</span><span><i class="lg-miss"></i>缺测</span></div>';
}
function chartFrame(eyebrow,title,metric,unit,plot,footer) {
  return '<header class="xc-head"><div><div class="xc-kicker">'+esc(eyebrow)+'</div><h3>'+esc(title)+'</h3></div>'+(metric!=null?'<span class="xc-metric">'+esc(metric)+' <small>'+esc(unit)+'</small></span>':'')+'</header><div class="xc-stage">'+plot+'</div><p class="xc-caption">'+esc(footer)+'</p>';
}
function textAt(x,y,value,cls='xc-small',align='start') {return '<text x="'+x+'" y="'+y+'" class="'+cls+'" text-anchor="'+align+'">'+esc(value)+'</text>';}
function plotSVG(w,h,body,label){return '<svg viewBox="0 0 '+w+' '+h+'" role="group" aria-label="'+esc(label)+'" class="xc-plot xc-'+(w>400?'wide':'narrow')+'">'+body+'</svg>';}
const rectHit=(x,y,w,h)=>'<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="transparent"/>';
function renderTime(t){
  const tm=t.timing||{};
  const groups=[['判停参考点',[['识别定稿','asr_final','asr'],['判停提交','commit','control']]],['Worker 开始本轮',[['首句可播','speakable','timing'],['首段 PCM','first_audio','tts'],['衔接后音频','post_filler_audio','audio']]]];
  const plot=[550,310].map(w=>{
    const lo=w<400?79:99,hi=w-58;let y=16,body='';
    for(const [name,stages] of groups){
      const values=stages.map(s=>tm[s[1]]).filter(finite);
      const max=Math.max(1,...values);body+=textAt(0,y,name,'xc-lane-label');
      if(values.length)body+=textAt(hi,y,'0 – '+max+' ms','xc-axis','end');
      y+=19;
      for(const [title,key,module] of stages){
        const val=tm[key];
        let row=rectHit(0,y-12,w,21)+textAt(0,y+3,title,'xc-small');
        if(finite(val)){const x2=lo+(hi-lo)*Math.max(0,val)/max;row+='<line x1="'+lo+'" y1="'+y+'" x2="'+x2+'" y2="'+y+'" class="bar" stroke-width="5" stroke-linecap="round"/><circle cx="'+x2+'" cy="'+y+'" r="3.4" fill="#d5e8bb"/>'+textAt(x2+5,y+4,val+'','xc-timeval');}
        else row+=textAt(lo,y+3,'···　缺测','xc-dim');
        body+=graphicLink(module,row,title+' · '+(finite(val)?val+' 毫秒':'缺测'),'data-chart-module="'+module+'"');y+=22;
      }
      y+=12;
    }
    body+=graphicLink('render',rectHit(0,y-11,w,24)+textAt(0,y+3,'手机实播','xc-small')+textAt(lo,y+3,'···　缺少端侧回执','xc-dim'),'手机实际播放缺测','data-chart-module="render"');
    return plotSVG(w,y+12,body,'语音阶段时延，分组使用各自的时间原点');
  }).join('');
  byId('timeChart').innerHTML=chartFrame('第 '+t.ordinal+' 轮 · 语音时序','从识别到发出声音',finite(tm.first_audio)?tm.first_audio:null,'ms',plot,'两组分别从各自的零点计时。首段 PCM 可能是衔接语，设备实际出声单列。');
}
function safeURL(raw){try{const u=new URL(raw);return (u.protocol==='http:'||u.protocol==='https:')&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function shortText(value,limit=27){const s=String(value??'');return s.length>limit?s.slice(0,limit-1)+'…':s;}
function effectDiagram(t){
  const events=[...array(t.growth),...array(t.attributedGrowth)];
  const numeric=events.find(g=>g.module==='trait' && g.from!=null && g.to!=null && String(g.from).trim() && String(g.to).trim() && Number.isFinite(Number(g.from)) && Number.isFinite(Number(g.to)));
  if(numeric){
    const before=Number(numeric.from),after=Number(numeric.to),delta=after-before;
    const plot=[550,310].map(w=>{
      const x0=37,x1=w*.54,x2=w-13,lo=Math.min(before,after),span=Math.abs(delta)||1;
      const pos=v=>delta===0?62:95-(v-lo)/span*49;
      const y0=pos(before),y1=pos(after);
      const tick=v=>Number(v.toFixed(4)).toString();
      const axis=[lo,...(delta?[Math.max(before,after)]:[])].map(v=>textAt(x0-4,pos(v)+3,tick(v),'xc-axis','end')+'<path d="M'+x0+' '+pos(v)+' H'+x2+'" class="xc-gridline"/>').join('');
      const path='<path d="M'+x0+' '+y0+' H'+x1+' V'+y1+' H'+x2+'" class="xc-step"/><circle cx="'+x0+'" cy="'+y0+'" r="4" class="xc-step-dot"/><circle cx="'+x1+'" cy="'+y1+'" r="4" class="xc-step-dot"/>';
      const link=(msg,label,x,y,role)=>msg?.id?'<a href="#inspector" data-chart-module="growth" data-jump="'+esc(msg.id)+'" data-session="'+esc(msg.session||state.detail.room)+'" data-target-module="growth" aria-label="'+esc(label)+'">'+rectHit(x-3,15,Math.min(128,w/3),111)+textAt(x,y,label,'xc-lane-label')+textAt(x,123,role,'xc-small')+'</a>':'';
      return plotSVG(w,135,axis+path+link(numeric.reply,tick(before),x0+5,Math.max(15,y0-11),'被评价的回答')+link(numeric.feedback,tick(after),x1+5,Math.max(15,y1-11),'反馈原话'),'基于事件前后值的特质变化');
    }).join('');
    return chartFrame('人格成长 · 关联事件',numeric.dimension||'特质变化',(delta>0?'+':'')+Number(delta.toFixed(4)),'',plot,numeric.revokedAt?'此事件已撤回。图中值为发生时记录。':'纵轴是该事件的局部刻度。点前后值可查看被评价的回答与反馈。');
  }
  const tool=t.tool,hasMemory=!!t.recall||array(t.memories).length,hasGrowth=events.length>0;
  let nodes,detail,title;
  if(tool){title='本轮工具的结果';nodes=[['router','本轮原话',t.user?'已定位':'缺测'],['tools',humanRoute[tool.tool]||tool.tool||'工具执行',toolOutcome(tool.outcome)],['tools','查询来源',finite(tool.sourceCount)?tool.sourceCount+' 条':'缺测']];detail='点查询环节可以查看原话、回执标识、可用来源和耗时。';}
  else if(hasGrowth){title='讲法反馈的归因';nodes=[['context','原回答','按标识关联'],['growth','明确反馈',events.length+' 项事件'],['examples','后续采用','缺测']];detail='右侧原话与回执列出实际关联。后续样例是否用到需另有回执。';}
  else if(hasMemory){title='本轮事实依据';nodes=[['router','本轮原话',t.user?'已定位':'缺测'],['recall','读取事实',t.recall?array(t.recall.items).length+' 条':'缺测'],['memory','写入事实',array(t.memories).length?array(t.memories).length+' 条':'缺测']];detail='读取和写入分别核对。本轮只有已关联的事实才可点回来源。';}
  else return chartFrame('后续影响','记忆与成长',null,'','<p class="xc-missing">暂无能关联到这条回复的记忆或成长回执。</p>','缺少事件时保留缺测，不推算特质变化。');
  const plot=[550,310].map(w=>{const gap=10,pad=3,cw=(w-2*pad-2*gap)/3;const body=nodes.map(([module,a,b],i)=>{const x=pad+i*(cw+gap);let cell='<rect class="xc-box" x="'+x+'" y="30" width="'+cw+'" height="57" rx="6"/>'+textAt(x+cw/2,53,shortText(a,7),'xc-box-title','middle')+textAt(x+cw/2,74,shortText(b,9),'xc-box-sub','middle');if(i<2)cell+='<path d="M'+(x+cw)+' 60h'+gap+'" class="xc-wire"/>';return graphicLink(module,cell,a+' · '+b,'data-chart-module="'+module+'"');}).join('');return plotSVG(w,110,body,title);}).join('');
  return chartFrame(tool?'工具调用':'记忆与成长',title,null,'',plot,detail);
}
function quoteLink(message, caption, module) {
  if(!message?.id)return '';
  return '<button type="button" data-jump="'+esc(message.id)+'" data-session="'+esc(message.session||state.detail.room)+'" data-target-module="'+esc(module)+'">'+esc(caption)+'</button>';
}
function recordView(record){
  const v=record.item;
  if(record.type==='tool'){
    const sources=array(v.sources).map(s=>{const url=safeURL(s.url);return url?'<a href="'+esc(url)+'" rel="noopener noreferrer" target="_blank">'+esc(s.title||'查看来源')+' ↗</a>':'';}).join('');
    return '<div class="record"><b>'+esc(humanRoute[v.tool]||v.tool||'工具')+'</b>　'+esc(toolOutcome(v.outcome))+'<p>'+esc(finite(v.turnMs)?v.turnMs+' ms':'耗时缺测')+' · '+esc(finite(v.sourceCount)?v.sourceCount+' 条来源':'来源数缺测')+'</p>'+sources+'<span class="sourceid">回执 '+esc(v.id||'缺测')+'</span></div>';
  }
  if(record.type==='memory'){
    if(v.id===null)return '<div class="record">旧版本已退役，原值和来源正文已收起。</div>';
    return '<div class="record"><b>'+esc(v.topic||'事实')+'</b>　'+esc(v.value)+'<p>'+esc(v.source?.text||'来源原话缺测')+'</p>'+quoteLink(v.source,'定位来源原话','memory')+'<span class="sourceid">事实 '+esc(v.id||'缺测')+'</span></div>';
  }
  return '<div class="record"><b>'+esc(v.dimension||v.module)+'</b>　'+esc(v.from??'缺测')+' → '+esc(v.to??'缺测')+(v.revokedAt?' · 已撤回':'')+
    '<p>原回答　'+esc(v.reply?.text||'缺测')+'</p><p>反馈　'+esc(v.feedback?.text||'缺测')+'</p>'+quoteLink(v.reply,'定位原回答','growth')+quoteLink(v.feedback,'定位反馈原话','growth')+'<span class="sourceid">事件 '+esc(v.id||'缺测')+'</span></div>';
}
function renderInspector(t){
  const id=state.module, meta=moduleInfo.get(id), ev=evidence(t,id);
  const label={miss:'缺测',hit:'已记录',change:'变化回执',off:'配置状态'}[ev.status];
  const msg=(caption,m)=>'<dt>'+caption+'</dt><dd>'+esc(m?.text||'原话缺测')+(m?.id?'<div class="sourceid">'+esc(dated(m.at))+' · '+esc(m.id)+'</div>':'')+'</dd>';
  const receipts=ev.raw?'<details class="raw"><summary>查看原始回执</summary><pre>'+esc(JSON.stringify(ev.raw,null,2))+'</pre></details>':'';
  const rule='<details class="rule"><summary>这个机制如何工作</summary><dl>'+[['触发','trigger'],['输入','input'],['输出','output'],['核实','evidence']].map(([k,v])=>'<dt>'+k+'</dt><dd>'+esc(meta[v])+'</dd>').join('')+'</dl></details>';
  byId('inspector').innerHTML='<header class="inspect-head"><span class="chip">'+label+'</span><small>第 '+esc(t.ordinal)+' 轮的依据</small><h2>'+esc(meta.name)+'</h2></header><dl class="quotes">'+msg('主人',t.user)+msg('小可',t.reply)+'</dl><section class="result"><strong>'+esc(ev.short)+'</strong><p>'+esc(ev.why)+'</p>'+ev.records.map(recordView).join('')+'</section>'+receipts+rule;
}
function renderMatrix(t) {
  const turns=state.detail.turns;
  const index=turns.findIndex(x=>x.reply.id===t.reply.id);
  const start=Math.max(0,Math.min(index-1,turns.length-4));
  const window=turns.slice(start,start+4);
  const modules=[...new Set(['router','recall','style','tools','llm','timing','memory','growth','examples',state.module])];
  const head=window.map(x=>'<th scope="col"'+(x===t?' class="current"':'')+'>第 '+esc(x.ordinal)+' 轮</th>').join('');
  const rows=modules.map(id=>'<tr><th scope="row">'+esc(graphNames[id]||moduleInfo.get(id).name)+'</th>'+window.map(x=>{
    const e=evidence(x,id),selected=x===t&&id===state.module;
    return '<td><button type="button" data-module="'+esc(id)+'" data-select-reply="'+esc(x.reply.id)+'" aria-pressed="'+selected+'" class="matrix-'+e.status+(selected?' current':'')+'">'+esc(e.short)+'</button></td>';
  }).join('')+'</tr>').join('');
  byId('matrixBody').innerHTML='<table><thead><tr><th scope="col">机制</th>'+head+'</tr></thead><tbody>'+rows+'</tbody></table>';
  byId('turnMatrix').hidden=false;
}
function renderAtlas(turn) {
  document.querySelectorAll('[data-atlas-module]').forEach(a=>{
    const id=a.dataset.atlasModule;
    const badge=a.querySelector('.at-status');
    const ev=turn?evidence(turn,id):null;
    const text=ev ? (ev.status==='off'?'缺测 · '+ev.short:ev.short) : a.dataset.state;
    badge.textContent=text;
    badge.className='at-status at-'+(ev?.status||'off');
    a.setAttribute('aria-current',String(!!turn && id===state.module));
    a.title=ev?ev.why:a.dataset.name;
  });
}
function render(t) {
  if(!t?.reply || !moduleInfo.has(state.module))return;
  state.turn=t;
  byId('turnTag').textContent='第 '+t.ordinal+' 轮 · '+(humanRoute[t.route]||t.route||'路由缺测');
  byId('turnSelect').value=t.reply.id;
  renderFlow(t);renderInspector(t);renderTime(t);renderMatrix(t);
  byId('effectChart').innerHTML=effectDiagram(t);
  renderAtlas(t);
  const u=new URL(location.href);
  u.searchParams.set('room',state.detail.room);u.searchParams.set('reply',t.reply.id);u.searchParams.set('module',state.module);u.hash='';
  history.replaceState(null,'',u);
}
function scrollEvidence(){
  const panel=byId('inspector');
  if(matchMedia('(max-width:850px)').matches)panel.scrollIntoView({block:'start'});
  panel.focus({preventScroll:true});
}
function setStatus(message, auth=false){
  const status=byId('status');status.hidden=!message;status.textContent=message;
  if(auth){const a=document.createElement('a');a.href='/';a.textContent=' 返回后台登录';status.append(a);}
}
async function api(path){
  const resp=await fetch('/api/whitebox/rooms'+path,{credentials:'same-origin',cache:'no-store'});
  if(!resp.ok){const error=new Error(resp.status===401?'登录已过期。':resp.status===404?'未找到这通私人通话。':'后台读取失败（'+resp.status+'）。');error.status=resp.status;throw error;}
  return resp.json();
}
function fail(error){
  state.turn=null;state.detail=null;renderAtlas(null);byId('turnMatrix').hidden=true;byId('matrixBody').replaceChildren();byId('turnSelect').replaceChildren();byId('online').hidden=true;byId('map').replaceChildren();byId('inspector').replaceChildren();byId('timeChart').replaceChildren();byId('effectChart').replaceChildren();
  if(error.status===401){state.rooms=[];byId('rooms').replaceChildren();byId('rooms').disabled=true;byId('moreRooms').hidden=true;}
  setStatus(error.message||'通话读取失败。',error.status===401);
}
function option(value,label){
  const o=document.createElement('option');o.value=value;o.textContent=label;return o;
}
function roomOptions(id){
  const s=byId('rooms');
  s.replaceChildren(...state.rooms.map(r=>option(r.session,dated(r.lastAt)+' · '+String(r.session).slice(-8)+' · '+r.messages+' 条消息')));
  if(id && !state.rooms.some(r=>r.session===id))s.append(option(id,'通话 '+id));
  if(id)s.value=id;s.disabled=!s.options.length;
  byId('moreRooms').hidden=state.rooms.length>=state.totalRooms;
}
async function listRooms(append=false) {
  const request=++state.listRequest;
  const currentId=state.detail?.room||new URL(location.href).searchParams.get('room');
  if(!append){++state.roomRequest;state.detail=null;state.turn=null;renderAtlas(null);byId('online').hidden=true;byId('turnMatrix').hidden=true;setStatus('正在读取私人通话记录…');}
  try{
    const page=await api('?limit='+sessionPage+'&offset='+(append?state.rooms.length:0));
    if(request!==state.listRequest)return;
    if(!Array.isArray(page.items))throw Error('通话列表格式无效。');
    const currentRooms=append?state.rooms:[];
    state.rooms=[...new Map([...currentRooms,...page.items].map(r=>[r.session,r])).values()];state.totalRooms=page.total;
    roomOptions(append?(state.detail?.room||byId('rooms').value):currentId);
    if(!append){
      const params=new URL(location.href).searchParams;
      const id=currentId||state.rooms[0]?.session;
      if(!id){setStatus('暂无已保存的私人通话。');return;}
      await showRoom(id,0,params.get('reply'),params.get('module'),true);
    }
  }catch(error){if(request===state.listRequest)fail(error);}
}
async function showRoom(id,offset=0,anchor=null,module='router',seek=false){
  const request=++state.roomRequest;
  state.turn=null;renderAtlas(null);byId('online').hidden=true;byId('turnMatrix').hidden=true;setStatus('正在读取通话与回执…');roomOptions(id);
  try{
    let page,found;
    do{
      page=await api('/'+encodeURIComponent(id)+'?limit='+turnPage+'&offset='+offset);
      if(request!==state.roomRequest)return;
      if(page.room!==id||!Array.isArray(page.turns))throw Error('通话详情格式无效。');
      found=anchor?page.turns.find(t=>t.reply?.id===anchor||t.user?.id===anchor):null;
      if(found||!seek||!anchor||!page.turns.length||offset+page.turns.length>=page.total)break;
      offset+=page.turns.length;
    }while(true);
    state.detail=page;state.turn=null;
    if(anchor && !found){
      setStatus('来源原话缺测，无法关联到此通已保存的回答。');
      const browse=document.createElement('button');
      browse.type='button';browse.textContent='查看这通的其他回答';
      browse.onclick=()=>void showRoom(id);
      byId('status').append(' ',browse);
      return;
    }
    const selected=found||page.turns.at(-1);
    state.module=moduleInfo.has(module)?module:'router';
    if(!selected){setStatus('这通通话尚无已保存的回复。');return;}
    byId('turnSelect').replaceChildren(...page.turns.map(t=>option(t.reply.id,'第 '+t.ordinal+' 轮 · '+shortText(t.user?.text||t.reply.text,39))));
    byId('older').disabled=page.offset+page.turns.length>=page.total;byId('newer').disabled=page.offset<=0;
    byId('online').hidden=false;render(selected);
    setStatus('');
  }catch(error){if(request===state.roomRequest)fail(error);}
}
async function jump(id,session,module){
  const t=state.detail?.room===session && state.detail.turns.find(x=>x.reply?.id===id||x.user?.id===id);
  if(t){state.module=module;render(t);scrollEvidence();return;}
  await showRoom(session,0,id,module,true);
  if(state.turn?.reply?.id===id||state.turn?.user?.id===id)scrollEvidence();
}
document.addEventListener('click',e=>{
  const trigger=e.target.closest('[data-module],[data-atlas-module],[data-jump]');
  if(!trigger)return;
  e.preventDefault();
  if(!state.turn){setStatus('先选择有已保存回复的通话，再查看当轮依据。');return;}
  if(trigger.dataset.jump){void jump(trigger.dataset.jump,trigger.dataset.session,trigger.dataset.targetModule);return;}
  const id=trigger.dataset.module||trigger.dataset.atlasModule;
  if(!moduleInfo.has(id))return;
  const target=trigger.dataset.selectReply ? state.detail.turns.find(t=>t.reply.id===trigger.dataset.selectReply) : state.turn;
  if(!target)return;
  state.module=id;render(target);scrollEvidence();
});
byId('rooms').addEventListener('change',e=>void showRoom(e.target.value));
byId('turnSelect').addEventListener('change',e=>{const t=state.detail?.turns.find(x=>x.reply?.id===e.target.value);if(t){setStatus('');render(t);}});
byId('older').onclick=()=>{const d=state.detail;if(d)void showRoom(d.room,d.offset+d.turns.length,null,state.module);};
byId('newer').onclick=()=>{const d=state.detail;if(d)void showRoom(d.room,Math.max(0,d.offset-turnPage),null,state.module);};
byId('refresh').onclick=()=>void listRooms();
byId('moreRooms').onclick=()=>void listRooms(true);
void listRooms();
