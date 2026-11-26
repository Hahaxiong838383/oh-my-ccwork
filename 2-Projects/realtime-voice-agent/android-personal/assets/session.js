'use strict';
(() => {
  const host = window.NightHost;
  const E = LivekitClient.RoomEvent;
  const signalUrl = 'wss://pa.hahaxiong.cc:8666';
  const pendingNative = new Map();
  const encode = new TextEncoder(), decode = new TextDecoder();
  let session = null;
  const model = { phase: 'idle', status: '准备就绪', mine: '', reply: '', muted: false, active: false, paired: !!host?.paired(), level: 0 };
  const show = patch => { Object.assign(model, patch); window.NightView?.render({...model}); };
  const mark = name => host?.event?.(name);
  function countOnce(s, bucket, id, kind) {
    const last = s[bucket];
    if (last === id) return;
    s[bucket] = id; mark(kind);
  }
  const level = v => { model.level = v; if (window.NightView?.level) window.NightView.level(v); else show({level:v}); };
  const valid = s => session === s;
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2,'0')).join('');
  const worker = p => p?.isAgent && p.identity.startsWith('agent-') && p.attributes?.['lk.agent.name'] === 'personal-xiaoke';
  function nativeRequest(s, method) {
    return new Promise((resolve,reject) => {
      const id = uid();
      const timer = setTimeout(() => { pendingNative.delete(id); reject(Error('请求超时，请重试')); }, method === 'ticket' ? 18000 : 90000);
      pendingNative.set(id, {s, resolve, reject, timer});
      try { host[method](id); } catch { settleNative(id, {error:'手机服务不可用'}); }
    });
  }
  function settleNative(id, value) {
    const p = pendingNative.get(id);
    if (!p) return;
    pendingNative.delete(id); clearTimeout(p.timer);
    if (value?.error) {
      const code = String(value.error);
      p.reject(Error(code==='http-401'?'设备凭据无效，请重新配对':code==='http-429'?'签票过于频繁，请稍后重试':'签票失败，请检查网络后重试'));
    } else p.resolve(value);
  }
  function detach(s) {
    if (!s.output) return;
    cancelAnimationFrame(s.output.frame);
    s.output.source?.disconnect(); s.output.analyser?.disconnect();
    for (const node of s.output.track.detach()) { node.pause(); node.remove(); }
    s.output = null; level(0);
  }
  function attach(s, track, peer) {
    if (!valid(s) || !worker(peer) || track.kind !== LivekitClient.Track.Kind.Audio) return;
    detach(s);
    const audio = track.attach();
    audio.autoplay = true; audio.hidden = true;
    document.body.appendChild(audio);
    const source = s.ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    const analyser = s.ctx.createAnalyser(); analyser.fftSize = 1024;
    source.connect(analyser); // Playback uses the attached audio element only.
    const samples = new Float32Array(analyser.fftSize);
    const output = s.output = {track, sid:peer.sid, audio, source, analyser, frame:0};
    let env = 0, audibleAt = 0;
    function measure() {
      if (!valid(s) || s.output !== output) return;
      analyser.getFloatTimeDomainData(samples);
      let power=0; for(const x of samples) power+=x*x;
      const rms=Math.sqrt(power/samples.length);
      const target = audio.paused || audio.muted ? 0 : Math.min(1, Math.max(0,(rms-.003)*8));
      env+=(target-env)*(target>env?.62:.24);
      level(env<.001?0:env);
      const now=performance.now();
      if (target>.025) { if(!s.hadAudio){mark('rx_audio');s.hadAudio=true;} audibleAt=now; if(!s.audible){s.audible=true;refresh(s);} }
      else if(s.audible && now-audibleAt>320){s.audible=false;refresh(s);}
      output.frame=requestAnimationFrame(measure);
    }
    audio.play().catch(()=>{ if (valid(s)) show({status:'系统暂停播放，请重接通话'}); });
    measure(); refresh(s);
  }
  function refresh(s) {
    if (!valid(s) || !s.connected) return;
    let phase, status;
    if (s.reconnecting) {phase='connecting';status='网络中断，正在重连';}
    else if (!s.ready) {phase='connecting';status='等待小可接听';}
    else if (s.cancel) {phase='listening';status='正在打断';}
    else if (s.audible || s.speaking) {phase='speaking';status='小可在说';}
    else if (model.muted) {phase='muted';status='麦克风已静音';}
    else if (s.thinking) {phase='thinking';status='小可正在思考';}
    else {phase='listening';status='小可在听';}
    if(phase!==model.phase || status!==model.status) show({phase,status});
  }
  function syncPeers(s) {
    if (!valid(s) || !s.connected) return;
    const peers=[...s.room.remoteParticipants.values()].filter(worker);
    const ready=peers.some(p=>s.peer?.sid===p.sid);
    if (!ready) {
      if(s.peer){s.parts.clear();s.turn=null;s.segments.clear();s.thinking=false;s.speaking=false;s.audible=false;show({mine:'',reply:''});}
      s.peer=null;s.ready=false;
    }
    for(const p of peers) {
      if(s.peer?.sid===p.sid) continue;
      let id=s.hellos.get(p.sid);
      if(!id){id=uid();s.hellos.set(p.sid,id);}
      send(s,p,'personal.v1.input',{type:'hello',id,recipient:p.identity}).catch(()=>{});
    }
    refresh(s);
  }
  function send(s,p,topic,body) {
    return s.room.localParticipant.publishData(encode.encode(JSON.stringify(body)),{reliable:true,topic,destinationIdentities:[p.identity]});
  }
  function receive(s, data, p, kind, topic) {
    if(!valid(s)||!worker(p)||s.room.remoteParticipants.get(p.identity)?.sid!==p.sid) return;
    let f; try{f=JSON.parse(decode.decode(data));}catch{return;}
    if(topic==='personal.v1.output' && f.type==='ready' && f.voice===true && s.hellos.get(p.sid)===f.id){
      if(!s.ready)mark('connected');s.peer=p;s.ready=true;s.hellos.delete(p.sid);refresh(s);
    } else if(topic==='control' && f.type==='cancel.ack' && f.src==='worker' && s.cancel && s.cancel.seq===f.seq && s.trace===f.trace_id){
      mark('cancel_ack');clearTimeout(s.cancel.timer);s.cancel=null;s.thinking=false;s.speaking=false;refresh(s);
    } else if(topic==='state' && f.k==='speaking' && typeof f.speaking==='boolean'){
      if(!f.speaking && s.bargeCandidate && performance.now()-s.bargeCandidate<3500 && !s.cancel) {
        s.bargeCandidate=0; s.stoppedWhileTalking=performance.now();
      }
      s.speaking=f.speaking;s.thinking=false;refresh(s);
    }
  }
  function transcript(s, items, p) {
    if(!valid(s)) return;
    const agent=worker(p);
    if(!agent && (!p || p.identity!==s.room.localParticipant.identity)) return;
    for(const it of items) {
      if(typeof it.text!=='string' || !it.id) continue;
      if(!agent){
        if(s.segments.has(it.id)) continue;
        if(it.text.trim() && (s.audible || s.speaking) && !s.cancel && s.bargeSeg!==it.id){s.bargeCandidate=performance.now();s.bargeSeg=it.id;}
        if(it.text.trim())countOnce(s,'lastUserCaption',it.id,'tx_caption');
        if(it.final && it.text.trim() && s.stoppedWhileTalking && performance.now()-s.stoppedWhileTalking<4500){
          s.stoppedWhileTalking=0;mark('spoken_interrupt');
        }
        if(it.final){s.segments.add(it.id);if(s.segments.size>128)s.segments.delete(s.segments.values().next().value);}
        show({mine:it.text});
        if(it.final && it.text.trim()){s.thinking=true;refresh(s);}
        continue;
      }
      if(it.text.trim())countOnce(s,'lastReplyCaption',it.id,'rx_caption');
      const m=/^SG_a(\d+)_(\d+)$/.exec(it.id);
      if(m) {
        const turn=Number(m[1]),idx=Number(m[2]);
        if(s.turn!==null && turn<s.turn)continue;
        if(s.turn!==turn){s.turn=turn;s.parts.clear();}
        const prior=s.parts.get(idx);
        if(prior?.final && !it.final)continue;
        s.parts.set(idx,{text:it.text,final:it.final});
        const ordered=[...s.parts.keys()].sort((a,b)=>a-b);
        show({reply:ordered.map(i=>s.parts.get(i).text).join('')});
      } else show({reply:it.text});
      s.thinking=false;refresh(s);
    }
  }
  function finish(s,status='通话已结束') {
    if(!valid(s))return;
    session=null;mark('call_end');
    clearInterval(s.poll);clearTimeout(s.deadline);clearTimeout(s.cancel?.timer);
    for(const [id,req] of pendingNative)if(req.s===s)settleNative(id,{error:'已结束'});
    detach(s); void s.ctx?.close().catch(()=>{});
    void s.room.disconnect().catch(()=>{});
    host?.setCall(false);
    show({phase:'idle',active:false,muted:false,level:0,status});
  }
  function connectionHint(e) {
    const msg=String(e?.message||'');
    if(/(peer|pc |ice|transport)/i.test(msg))return '，媒体网络不可达';
    if(/websocket|signal|server.*reach/i.test(msg))return '，信令未接通';
    if(/time.?out/i.test(msg))return '，连接超时';
    if(/permission|denied|notallowed/i.test(msg))return '，请检查权限';
    if(/is not a function|not defined|supported|undefined/i.test(msg))return '，请更新系统 WebView';
    return '，请重试';
  }
  async function start() {
    if(session||!model.paired)return;
    const room=new LivekitClient.Room({stopMicTrackOnMute:true,audioCaptureDefaults:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    mark('call_start');
    const s=session={room,ctx:new AudioContext(),hellos:new Map(),parts:new Map(),segments:new Set(),turn:null,seq:0,trace:uid()};
    show({phase:'connecting',status:'正在连接',active:true,muted:false,mine:'',reply:''});
    try{
      await s.ctx.resume(); if(!valid(s))return;
      if(!(await nativeRequest(s,'micPermission')))throw Error('需要麦克风权限才能通话');
      if(!valid(s))return;
      host.setCall(true);
      const ticket=await nativeRequest(s,'ticket');
      if(!valid(s))return;
      s.stage='连接语音房间';show({status:'正在连接北京语音房间'});
      if(new URL(ticket.url).origin!==signalUrl || !ticket.token)throw Error('签票地址无效');
      room.on(E.TrackSubscribed,(t,_,p)=>attach(s,t,p));
      room.on(E.TrackUnsubscribed,t=>{if(valid(s)&&s.output?.track===t){detach(s);s.audible=false;refresh(s);}});
      room.on(E.DataReceived,(...args)=>receive(s,...args));
      room.on(E.TranscriptionReceived,(items,p)=>transcript(s,items,p));
      room.on(E.ParticipantConnected,()=>syncPeers(s));
      room.on(E.ParticipantDisconnected,p=>{s.hellos.delete(p.sid);syncPeers(s);});
      room.on(E.Reconnecting,()=>{s.reconnecting=true;refresh(s);});
      room.on(E.Reconnected,()=>{s.reconnecting=false;syncPeers(s);});
      room.on(E.Disconnected,()=>{if(valid(s)&&s.joined){mark('transport_error');finish(s,'房间已断开，可以重新连接');}});
      try {
        await room.connect(ticket.url,ticket.token);
      } catch (e) {
        if (!valid(s) || !/peer|pc connection|ice|transport/i.test(String(e?.message))) throw e;
        show({status:'直连未接通，正在尝试北京中继'});
        await room.connect(ticket.url,ticket.token,{rtcConfig:{iceTransportPolicy:'relay'},peerConnectionTimeout:21000});
      }
      if(!valid(s)){await room.disconnect();return;}
      s.joined=true;s.connected=true;s.stage='打开回放';show({status:'已入房，正在打开回放'}); await room.startAudio();
      if(!valid(s))return;
      s.stage='开启麦克风';show({status:'正在开启麦克风'});
      await room.localParticipant.setMicrophoneEnabled(true);
      if(!valid(s))return;
      mark('mic_on');syncPeers(s);s.poll=setInterval(()=>syncPeers(s),1200);
      s.deadline=setTimeout(()=>{if(valid(s)&&!s.ready)finish(s,'小可接听超时，请重试');},22000);
    }catch(e){if(valid(s))mark('transport_error');if(valid(s))finish(s, e?.message?.includes('凭据')?'设备凭据无效，请重新配对':/权限|超时|签票|已结束/.test(e?.message||'')?e.message:(s.stage||'建立通话')+'失败'+connectionHint(e));}
  }
  async function mute(){
    const s=session;if(!s?.connected||s.toggling)return;
    s.toggling=true;
    try{const enabled=model.muted;await s.room.localParticipant.setMicrophoneEnabled(enabled);if(valid(s)){mark(enabled?'mic_on':'mic_off');show({muted:!enabled});refresh(s);}}
    catch{if(valid(s))show({status:'麦克风切换失败'});}finally{s.toggling=false;}
  }
  async function interrupt(){
    const s=session;if(!s?.peer||s.cancel||s.reconnecting)return;
    const seq=++s.seq;
    const frame={type:'cancel',src:'android',lane:'L2',trace_id:s.trace,seq,ts_ms:Date.now(),payload:{reason:'user_barge'}};
    s.cancel={seq,timer:setTimeout(()=>{if(valid(s)&&s.cancel?.seq===seq){s.cancel=null;refresh(s);show({status:'打断未获确认，可以继续说话'});}},3500)};
    refresh(s);
    try{await send(s,s.peer,'control',frame);}catch{if(valid(s)&&s.cancel?.seq===seq){clearTimeout(s.cancel.timer);s.cancel=null;refresh(s);show({status:'打断发送失败'});}}
  }
  window.Voice={
    start,stop:()=>{if(session)finish(session);},mute,interrupt,
    pair(key){if(session)return;const ok=!!host?.pair(String(key).trim());if(ok)mark('paired');show({paired:ok||!!host?.paired(),status:ok?'设备已配对':'凭据格式无效'});return ok;},
    forget(){if(session)return;host?.forget();show({paired:!!host?.paired(),mine:'',reply:'',status:'已解除本机配对'});},
    onTicket:settleNative,onPermission:settleNative
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden && session) finish(session);});
  window.addEventListener('pagehide',()=>{if(session) finish(session);});
  function setupService() {
    const get=id=>document.getElementById(id), panel=get('service-panel');
    let tick;
    function draw(){
      const summary=host?.diagnostics?.() || '暂无诊断记录';
      const ota=host?.updateStatus?.() || '尚未检查';
      get('diag-summary').textContent=summary;get('ota-status').textContent=ota;
      get('ota-install').hidden=!/已下载|可以安装|待安装/.test(ota);
      get('ota-install').disabled=!!session;
    }
    get('btn-service').onclick=()=>{panel.hidden=!panel.hidden;clearInterval(tick);if(!panel.hidden){draw();tick=setInterval(draw,1500);}};
    get('service-close').onclick=()=>{panel.hidden=true;clearInterval(tick);};
    get('diag-send').onclick=()=>{host?.syncDiagnostics?.();draw();};
    get('ota-check').onclick=()=>{host?.checkUpdate?.();draw();};
    get('ota-install').onclick=()=>{if(!session)host?.installUpdate?.();};
    function badge(){const v=host?.updateStatus?.()||'';get('btn-service').textContent=/已下载|可以安装|待安装/.test(v)?'更新可用':'维护';}
    badge();setInterval(()=>{if(!document.hidden&&!session)badge();},15000);
  }
  setupService();
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>show({})); else show({});
})();
