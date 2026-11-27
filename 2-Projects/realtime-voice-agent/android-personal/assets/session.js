'use strict';
(() => {
  const host = window.NightHost;
  const E = LivekitClient.RoomEvent;
  const signalUrl = 'wss://pa.hahaxiong.cc:8666';
  const pendingNative = new Map();
  const encode = new TextEncoder(), decode = new TextDecoder();
  let session = null;
  const model = { phase: 'idle', status: '准备就绪', mine: '', reply: '', muted: false, active: false, paired: !!host?.paired(), level: 0 };
  const SYNC_PHASES = new Set(['idle', 'listening', 'speaking', 'thinking', 'searching', 'muted', 'connecting', 'error']);
  const SYNC_HEX = /^#[0-9A-F]{6}$/;
  const lastSync = { initialized: false, phase: '', muted: false, accent: '' };
  function normalizeAccent(raw) {
    if (typeof raw !== 'string') return '#4F7DF3';
    const s = raw.trim().toUpperCase();
    return SYNC_HEX.test(s) ? s : '#4F7DF3';
  }
  function currentAccent() {
    return normalizeAccent(window.NightView?.accent?.());
  }
  function syncPhase() {
    const p = String(model.phase || 'idle').trim().toLowerCase();
    if (p === 'idle' && !model.active && /(失败|错误|无效|异常|拒绝|超时|断开|权限|error|failed|denied|invalid)/i.test(String(model.status || ''))) {
      return 'error';
    }
    return SYNC_PHASES.has(p) ? p : 'idle';
  }
  function pushSyncState(localAccentPick, forcedAccent, forceSend) {
    if (typeof host?.syncState !== 'function') return;
    const phase = syncPhase();
    const muted = Boolean(model.muted);
    const accent = forcedAccent ? normalizeAccent(forcedAccent) : currentAccent();
    if (!forceSend && !localAccentPick && lastSync.initialized
      && lastSync.phase === phase && lastSync.muted === muted) {
      return;
    }
    lastSync.initialized = true;
    lastSync.phase = phase;
    lastSync.muted = muted;
    lastSync.accent = accent;
    host.syncState(phase, muted, accent, Boolean(localAccentPick));
  }
  const show = patch => { Object.assign(model, patch); window.NightView?.render({...model}); pushSyncState(false); };
  const mark = name => host?.event?.(name);
  function countOnce(s, bucket, id, kind) {
    const last = s[bucket];
    if (last === id) return;
    s[bucket] = id; mark(kind);
  }
  const level = v => { model.level = v; if (window.NightView?.level) window.NightView.level(v); else show({level:v}); };
  const valid = s => session === s;
  // Local lexical estimate for the sentence that is actually being heard.
  // This is not a provider label and never changes the received transcript.
  function cueKind(text) {
    const t = String(text || '').trim();
    if (!t) return 'hush';
    if (/[?？]\s*$/.test(t)) return 'question';
    if (/(吗|呢|是不是|对不对|好不好|多少|几点|什么时候|为什么|怎么|哪里|哪个)\s*[?？]?\s*$/.test(t)) return 'question';
    if (/(失败|错误|不行|不能|危险|小心|抱歉|遗憾|担心|坏了|注意安全)/.test(t)) return 'concern';
    if (/(注意|千万|一定|真的|特别|非常|赶紧|马上|重要|太[好棒]|极了)/.test(t)) return 'emphasis';
    if (/(谢谢|太好|真好|当然|可以|没问题|欢迎|开心|喜欢|棒|好的)/.test(t)) return 'warm';
    return t.replace(/[。！？!?；;…\s]/g, '').length <= 3 ? 'hush' : 'explain';
  }
  function endSpeech(s) {
    s.speech.pending = null;
    s.speech.lastId = null;
    s.speech.lastKind = '';
    window.NightView?.speech?.(null);
  }
  function clearSpeech(s, clearVisible) {
    endSpeech(s);
    s.speech.index = -1;
    s.speechActive = false;
    if (clearVisible && model.reply) show({reply: ''});
  }
  function segmentCue(s, id, text) {
    if (!text.trim()) {
      if (s.speech.lastId === id) endSpeech(s);
      return;
    }
    const kind = cueKind(text);
    if (s.speech.lastId === id && s.speech.lastKind === kind) return;
    s.speech.lastId = id;
    s.speech.lastKind = kind;
    s.speech.pending = {kind, seq: ++s.speech.seq};
  }
  function advanceSpeech(s, now, strength, playing) {
    if (!model.active || !s.connected || s.cancel) return;
    if (playing && strength > 0.025) {
      s.speechActive = true;
      s.lastVoiceAt = now;
      const cue = s.speech.pending;
      if (cue) { s.speech.pending = null; window.NightView?.speech?.(cue); }
    } else if (s.speechActive && now - s.lastVoiceAt > (s.workerDone ? 1200 : 1800)) {
      s.speechActive = false;
      refresh(s);
    }
  }
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
  // Tap the tracks already owned by LiveKit. The silent sink keeps Android's audio
  // graph pulling frames without playing the microphone or doubling the reply.
  function meter(ctx, track) {
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser(), silent = ctx.createGain();
    analyser.fftSize = 1024; silent.gain.value = 0;
    source.connect(analyser); analyser.connect(silent); silent.connect(ctx.destination);
    const data = new Float32Array(analyser.fftSize);
    return {
      read() {
        analyser.getFloatTimeDomainData(data);
        let power = 0;
        for (const x of data) power += x * x;
        return Math.sqrt(power / data.length);
      },
      close() { source.disconnect(); analyser.disconnect(); silent.disconnect(); }
    };
  }
  function stopMicMeter(s) {
    if (s.micMeter) {
      cancelAnimationFrame(s.micMeter.frame);
      s.micMeter.meter?.close(); s.micMeter = null;
    }
    window.NightView?.micLevel?.(0);
  }
  function startMicMeter(s) {
    stopMicMeter(s);
    const local = s.room.localParticipant;
    const input = s.micMeter = { frame: 0, track: null, meter: null };
    function measure() {
      if (!valid(s) || s.micMeter !== input) return;
      const pub = local.getTrackPublication(LivekitClient.Track.Source.Microphone);
      const track = pub?.track?.mediaStreamTrack;
      if (track !== input.track) {
        input.meter?.close(); input.meter = null; input.track = track;
        if (track) {
          try { input.meter = meter(s.ctx, track); } catch { /* RTC levels remain available. */ }
        }
      }
      const energy = input.meter ? input.meter.read() : local.audioLevel || 0;
      const listening = track?.enabled && !pub.isMuted;
      window.NightView?.micLevel?.(listening ? Math.min(1, Math.max(0, (energy - .007) * 10)) : 0);
      input.frame = requestAnimationFrame(measure);
    }
    measure();
  }
  function clearPlaybackPrompt(s) {
    s.retryPlayback?.remove(); s.retryPlayback = null;
  }
  function promptPlayback(s) {
    if (!valid(s) || model.muted || s.retryPlayback) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'top-pill'; button.textContent = '恢复声音';
    s.retryPlayback = button;
    document.getElementById('status-banner').append(button);
    button.onclick = () => {
      const output = s.output;
      // Both calls start within the actual user gesture. startAudio plays the
      // LiveKit-owned elements, while our analyser uses its own AudioContext.
      void s.ctx.resume().catch(() => {});
      void s.room.startAudio().then(() => {
        if (valid(s) && s.output === output && !output?.audio.paused) {
          clearPlaybackPrompt(s); refresh(s);
        }
      }).catch(() => {});
    };
    refresh(s);
  }
  function detach(s) {
    const output = s.output;
    if (!output) return;
    s.output = null; s.audible = false; s.speechActive = false; s.lastVoiceAt = 0;
    cancelAnimationFrame(output.frame);
    output.meter?.close();
    output.audio.onplaying = output.audio.onpause = null;
    output.track.detach(output.audio); output.audio.pause(); output.audio.remove();
    clearPlaybackPrompt(s); level(0);
  }
  function attach(s, track, peer) {
    if (s.output?.track === track && s.output.sid === peer.sid && s.output.audio.isConnected) return;
    detach(s);
    const element = document.createElement('audio');
    element.volume = model.muted ? 0 : 1;
    const audio = track.attach(element);
    audio.muted = model.muted;
    audio.autoplay = true; audio.hidden = true;
    document.body.appendChild(audio);
    let playbackMeter;
    try { playbackMeter = meter(s.ctx, track.mediaStreamTrack); } catch { /* Use LiveKit's speaker level. */ }
    const output = s.output = {track, sid:peer.sid, audio, meter:playbackMeter, frame:0};
    const current = () => valid(s) && s.output === output;
    audio.onplaying = () => { if (current()) { clearPlaybackPrompt(s); refresh(s); } };
    audio.onpause = () => { if (current() && audio.paused) promptPlayback(s); };
    let env = 0, audibleAt = 0, lastPcmAt = -Infinity;
    function measure() {
      if (!valid(s) || s.output !== output) return;
      const now = performance.now();
      const pcm = playbackMeter?.read() || 0;
      if (pcm > .002) lastPcmAt = now;
      // Some Android WebViews play the track while the Web Audio tap stays flat.
      // Preserve short pauses in a working tap before using the remote speaker level.
      const rtcLevel = peer.isSpeaking ? peer.audioLevel || 0 : 0;
      const strength = now - lastPcmAt < 180 ? Math.max(0, pcm - .002) * 8 : rtcLevel * 2;
      const playing = !model.muted && !audio.paused && !audio.muted && audio.readyState >= 2 && !track.isMuted;
      const target = playing ? Math.min(1, strength) : 0;
      env+=(target-env)*(target>env?.62:.24);
      level(env<.001?0:env);
      if (target > .025 && !s.hadAudio) { mark('rx_audio'); s.hadAudio=true; }
      if (target>.025) { audibleAt=now; if(!s.audible){s.audible=true;refresh(s);} }
      else if(s.audible && now-audibleAt>320){s.audible=false;refresh(s);}
      advanceSpeech(s, now, target, playing);
      output.frame=requestAnimationFrame(measure);
    }
    audio.play().catch(() => { if (current() && audio.paused) promptPlayback(s); });
    measure(); refresh(s);
  }
  function refresh(s) {
    if (!valid(s) || !s.connected) return;
    let phase, status;
    if (s.reconnecting) {phase='connecting';status='网络中断，正在重连';}
    else if (s.retryPlayback) {phase='listening';status='播放已暂停';}
    else if (!s.ready) {phase='connecting';status='等待小可接听';}
    else if (s.cancel) {phase='listening';status='正在打断';}
    else if (model.muted) {phase='listening';status='小可已静音，仍在听';}
    else if (s.audible || s.speaking || (s.speechActive && performance.now()-s.lastVoiceAt < 1800)) {phase='speaking';status='小可在说';}
    else if (s.thinking) {phase='thinking';status='小可正在思考';}
    else {phase='listening';status='小可在听';}
    if(phase!==model.phase || status!==model.status) show({phase,status});
  }
  function syncOutput(s, peers, removed) {
    if (!valid(s) || !s.connected) return;
    const peer = peers.find(p => p.sid === s.peer?.sid) || peers[0];
    // The SDK fires Unsubscribed before replacing publication.track. Skip the
    // removed object explicitly if it is still visible during that callback.
    const tracks = [...(peer?.audioTrackPublications.values() || [])]
      .map(publication => publication.track)
      .filter(track => track && track !== removed && track.mediaStreamTrack.readyState !== 'ended');
    const track = tracks.includes(s.output?.track) ? s.output.track : tracks[0];
    if (track) attach(s, track, peer); else detach(s);
  }
  function workers(s) { return [...s.room.remoteParticipants.values()].filter(worker); }
  function syncPeers(s) {
    if (!valid(s) || !s.connected) return;
    const peers=workers(s);
    syncOutput(s,peers);
    const ready=peers.some(p=>s.peer?.sid===p.sid);
    if (!ready) {
      if(s.peer){clearSpeech(s,true);s.parts.clear();s.turn=null;s.segments.clear();s.thinking=false;s.speaking=false;s.audible=false;s.speechActive=false;s.lastVoiceAt=0;show({mine:'',reply:''});}
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
      const previous=s.peer;
      if(!s.ready)mark('connected');
      if(previous && previous.sid!==p.sid){clearSpeech(s,true);s.parts.clear();s.turn=null;}
      s.peer=p;s.ready=true;s.hellos.delete(p.sid);syncOutput(s,workers(s));refresh(s);
    } else if(topic==='personal.v1.output' && f.type==='turn_stopped' && s.peer?.sid===p.sid
      && typeof f.segment==='string' && /^SG_[a-f0-9]{12}$/.test(f.segment)){
      s.stoppedSegment=f.segment;
      if(s.lastUserCaption===f.segment){
        s.thinking=false;refresh(s);
      }
    } else if(topic==='control' && f.type==='cancel.ack' && f.src==='worker' && s.cancel && s.cancel.seq===f.seq && s.trace===f.trace_id){
      mark('cancel_ack');clearTimeout(s.cancel.timer);s.cancel=null;s.thinking=false;s.speaking=false;s.speechActive=false;endSpeech(s);refresh(s);
    } else if(topic==='state' && f.k==='speaking' && typeof f.speaking==='boolean'){
      if(!f.speaking && s.bargeCandidate && performance.now()-s.bargeCandidate<3500 && !s.cancel) {
        s.bargeCandidate=0; s.stoppedWhileTalking=performance.now();
      }
      s.speaking=f.speaking;s.workerDone=!f.speaking;s.thinking=false;refresh(s);
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
        if(it.final && it.text.trim()){s.thinking=it.id!==s.stoppedSegment;refresh(s);}
        continue;
      }
      if(it.text.trim())countOnce(s,'lastReplyCaption',it.id,'rx_caption');
      const m=/^SG_a(\d+)_(\d+)$/.exec(it.id);
      if(m) {
        const turn=Number(m[1]),idx=Number(m[2]);
        if(s.cancelledTurn===turn)continue;
        if(s.turn!==null && turn<s.turn)continue;
        if(s.turn!==turn){
          if(s.turn!==null)clearSpeech(s,true);
          s.turn=turn;s.parts.clear();s.cancelledTurn=null;s.workerDone=false;
        }
        const prior=s.parts.get(idx);
        if(prior?.final && !it.final)continue;
        s.parts.set(idx,{text:it.text,final:it.final});
        const ordered=[...s.parts.keys()].sort((a,b)=>a-b);
        // The worker emits SG_a<turn>_<index> at the played-sample boundary,
        // then sends final or retracts the same segment. Show its text immediately.
        show({reply:ordered.map(i=>s.parts.get(i).text).join('')});
        if (idx >= s.speech.index) {
          s.speech.index = idx;
          segmentCue(s, it.id, it.text);
        }
      } else {
        show({reply:it.text});
        segmentCue(s, it.id, it.text);
      }
      s.thinking=false;refresh(s);
    }
  }
  function finish(s,status='通话已结束') {
    if(!valid(s))return;
    clearSpeech(s,true);session=null;mark('call_end');
    clearInterval(s.poll);clearTimeout(s.deadline);clearTimeout(s.cancel?.timer);
    for(const [id,req] of pendingNative)if(req.s===s)settleNative(id,{error:'已结束'});
    detach(s); clearPlaybackPrompt(s); stopMicMeter(s); void s.ctx?.close().catch(()=>{});
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
    const s=session={room,ctx:new AudioContext(),hellos:new Map(),parts:new Map(),segments:new Set(),turn:null,seq:0,trace:uid(),
      speech:{index:-1,seq:0,pending:null,lastId:null,lastKind:''},workerDone:false,speechActive:false,lastVoiceAt:0};
    room.registerRpcMethod('personal.avatar.v1', async ({callerIdentity,payload}) => {
      const peer = s.peer;
      if (!valid(s) || !s.ready || s.reconnecting || !worker(peer) || callerIdentity !== peer.identity ||
          room.remoteParticipants.get(callerIdentity)?.sid !== peer.sid) throw Error('未知语音会话');
      if (typeof payload !== 'string' || payload.length > 800) throw Error('无效表情请求');
      const request = JSON.parse(payload);
      if (!request || !['inspect','express'].includes(request.op)) throw Error('无效表情操作');
      const result = await window.NightView?.avatarRequest?.(request);
      return JSON.stringify(result || {ok:false,avatar:null});
    });
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
      room.on(E.TrackSubscribed,()=>syncOutput(s,workers(s)));
      room.on(E.TrackUnsubscribed,t=>{syncOutput(s,workers(s),t);refresh(s);});
      room.on(E.ParticipantAttributesChanged,()=>syncPeers(s));
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
      s.joined=true;s.connected=true;s.stage='打开回放';show({status:'已入房，正在打开回放'});
      await room.startAudio().catch(()=>promptPlayback(s));
      if(!valid(s))return;
      s.stage='开启麦克风';show({status:'正在开启麦克风'});
      await room.localParticipant.setMicrophoneEnabled(true);
      if(!valid(s))return;
      startMicMeter(s);mark('mic_on');syncPeers(s);s.poll=setInterval(()=>syncPeers(s),1200);
      s.deadline=setTimeout(()=>{if(valid(s)&&!s.ready)finish(s,'小可接听超时，请重试');},22000);
    }catch(e){if(valid(s))mark('transport_error');if(valid(s))finish(s, e?.message?.includes('凭据')?'设备凭据无效，请重新配对':/权限|超时|签票|已结束/.test(e?.message||'')?e.message:(s.stage||'建立通话')+'失败'+connectionHint(e));}
  }
  function mute() {
    const s = session;
    if (!s) return;
    const muted = !model.muted;
    const audio = s.output?.audio;
    if (audio) {
      audio.volume = muted ? 0 : 1;
      audio.muted = muted;
    }
    if (muted) {
      clearPlaybackPrompt(s);
      s.audible = false;
      endSpeech(s);
      level(0);
    } else if (audio?.paused) {
      audio.play().catch(() => { if (s.output?.audio === audio) promptPlayback(s); });
    }
    show({muted});
    refresh(s);
  }
  async function interrupt(){
    const s=session;if(!s?.peer||s.cancel||s.reconnecting)return;
    const seq=++s.seq;
    const frame={type:'cancel',src:'android',lane:'L2',trace_id:s.trace,seq,ts_ms:Date.now(),payload:{reason:'user_barge'}};
    // The user takes the turn now: stop unspoken captions and the speech
    // expression immediately, before the worker acknowledgement arrives.
    s.cancelledTurn=s.turn;endSpeech(s);s.speaking=false;s.workerDone=false;s.speechActive=false;
    s.cancel={seq,timer:setTimeout(()=>{if(valid(s)&&s.cancel?.seq===seq){s.cancel=null;refresh(s);show({status:'打断未获确认，可以继续说话'});}},3500)};
    refresh(s);
    try{await send(s,s.peer,'control',frame);}catch{if(valid(s)&&s.cancel?.seq===seq){clearTimeout(s.cancel.timer);s.cancel=null;refresh(s);show({status:'打断发送失败'});}}
  }
  window.Voice={
    start,stop:()=>{if(session)finish(session);},mute,interrupt,
    pair(key){
      if(session)return;
      const ok=!!host?.pair(String(key).trim());
      if(ok)mark('paired');
      show({paired:ok||!!host?.paired(),status:ok?'设备已配对':'凭据格式无效'});
      if(ok)pushSyncState(false,currentAccent(),true);
      return ok;
    },
    forget(){if(session)return;host?.forget();show({paired:!!host?.paired(),mine:'',reply:'',status:'已解除本机配对'});},
    onTicket:settleNative,onPermission:settleNative,
    onAccentPick(hex){
      if(typeof hex!=='string')return;
      const norm=hex.trim().toUpperCase();
      if(!SYNC_HEX.test(norm))return;
      pushSyncState(true,norm,true);
    },
    onSyncAccent(hex){
      if(typeof hex!=='string')return;
      const norm=hex.trim().toUpperCase();
      if(!SYNC_HEX.test(norm))return;
      lastSync.accent=norm;
      window.NightView?.setAccent?.(norm,'remote');
    }
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden && session) finish(session);});
  window.addEventListener('pagehide',()=>{if(session) finish(session);});
  function setupService() {
    const get = id => document.getElementById(id);
    const app = get('app'), panel = get('service-panel'), home = get('ota-home'), maintenance = get('btn-service');
    const install = get('ota-install'), check = get('ota-check');
    const phases = {
      idle: '等待检查更新', checking: '正在检查更新', current: '已是最新版本', available: '发现新版本',
      downloading: '正在下载', verifying: '正在校验安装包', ready: '新版已就绪', wait_permission: '等待安装授权',
      preparing_install: '正在准备安装', pending_confirmation: '等待系统确认', installing: '系统正在安装',
      success: '升级成功', cancelled: '已取消安装', error: '更新未完成'
    };
    let snapshot, timer, opener;
    function snapshotFromHost() {
      if (!host?.updateSnapshot) return null;
      try {
        const state = JSON.parse(host.updateSnapshot());
        return state && Object.prototype.hasOwnProperty.call(phases, state.state) ? state : null;
      } catch { return null; }
    }
    function setText(element, value) {
      if (element.textContent !== value) element.textContent = value;
    }
    function bytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
      return (n / 1048576).toFixed(1) + ' MiB';
    }
    const inCall = () => Boolean(session) || app.dataset.active === 'true';
    const hasAmount = value => Number.isSafeInteger(value) && value >= 0;
    function draw() {
      snapshot = snapshotFromHost();
      if (!panel.hidden) setText(get('diag-summary'), host?.diagnostics?.() || '暂无诊断记录');
      home.hidden = !snapshot;
      if (!snapshot) {
        get('ota-transfer').hidden = true; install.hidden = true;
        setText(get('ota-phase'), ''); setText(get('ota-version'), '');
        setText(get('ota-status'), host?.updateStatus?.() || '更新状态暂不可用');
        check.disabled = !host?.checkUpdate;
        return;
      }
      const s = snapshot, kind = s.state, transferring = kind === 'downloading';
      const written = hasAmount(s.downloadedBytes) ? s.downloadedBytes : null;
      const total = hasAmount(s.totalBytes) && s.totalBytes > 0 ? s.totalBytes : null;
      const percent = written !== null && total !== null ? Math.min(100, Math.floor(written * 100 / total))
        : Number.isInteger(s.percent) && s.percent >= 0 && s.percent <= 100 ? s.percent : null;
      const label = phases[kind];
      const homeLabel = transferring && percent !== null ? '正在下载 ' + percent + '%'
        : transferring && written !== null ? '已下载 ' + bytes(written) : label;
      setText(get('ota-home-text'), homeLabel);
      home.setAttribute('aria-label', '应用更新，' + homeLabel);
      home.dataset.tone = ['error', 'cancelled'].includes(kind) ? 'error'
        : ['available', 'ready', 'wait_permission', 'success'].includes(kind) ? 'action'
        : ['idle', 'current'].includes(kind) ? 'quiet' : 'active';
      get('ota-home-progress').hidden = !transferring;
      get('ota-transfer').hidden = !transferring;
      if (transferring) {
        for (const id of ['ota-home-progress', 'ota-progress']) {
          const bar = get(id);
          if (percent === null) bar.removeAttribute('value'); else bar.value = percent;
        }
        const amount = written !== null ? bytes(written) + (total ? ' / ' + bytes(total) : '') : '';
        setText(get('ota-bytes'), [percent === null ? '' : percent + '%', amount].filter(Boolean).join(' · '));
      }
      setText(get('ota-phase'), label);
      const call = inCall();
      const detail = call && ['ready', 'wait_permission'].includes(kind) ? '通话结束后可继续安装。' : String(s.message || '');
      setText(get('ota-status'), detail === label ? '' : detail);
      const installed = s.installedVersionName || (s.installedVersionCode > 0 ? String(s.installedVersionCode) : '');
      const target = s.versionName || (s.versionCode > 0 ? String(s.versionCode) : '');
      const versions = [];
      if (installed) versions.push('当前 ' + installed);
      if (target && s.versionCode > s.installedVersionCode) versions.push('新版 ' + target);
      setText(get('ota-version'), versions.join('  →  '));
      const waiting = kind === 'wait_permission', retryInstall = ['cancelled', 'error'].includes(kind);
      install.hidden = !s.canInstall && !(call && ['ready','wait_permission'].includes(kind));
      install.disabled = call || !s.canInstall;
      setText(install, waiting ? '继续授权安装' : retryInstall ? '重试安装' : '安装新版');
      check.disabled = !host?.checkUpdate || !!s.busy || (kind === 'error' && !s.canRetry) || ['pending_confirmation','installing','preparing_install'].includes(kind);
      setText(check, kind === 'available' ? '立即下载' : kind === 'error' && s.canRetry ? '重试更新' : '检查更新');
    }
    function refresh() {
      clearTimeout(timer);
      if (document.hidden) return;
      draw();
      const fast = ['checking', 'downloading', 'verifying', 'preparing_install', 'pending_confirmation', 'installing'].includes(snapshot?.state);
      timer = setTimeout(refresh, fast ? 350 : panel.hidden ? 2500 : 1100);
    }
    function openPanel(open, trigger) {
      if (open && panel.hidden) opener = trigger || maintenance;
      panel.hidden = !open;
      app.classList.toggle('service-open', open);
      for (const button of [home, maintenance]) button.setAttribute('aria-expanded', String(open));
      refresh();
    }
    home.onclick = () => openPanel(true, home);
    maintenance.onclick = () => openPanel(panel.hidden, maintenance);
    function close() {
      if (!panel.hidden) { openPanel(false); opener?.focus(); }
    }
    get('service-close').onclick = close;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    get('diag-send').onclick = () => { host?.syncDiagnostics?.(); refresh(); };
    check.onclick = () => { if (!check.disabled) { host?.checkUpdate?.(); refresh(); } };
    install.onclick = () => {
      const current = snapshotFromHost();
      if (!inCall() && current?.canInstall) host?.installUpdate?.();
      refresh();
    };
    window.addEventListener('night-open-update', () => { if (!inCall()) openPanel(true); else refresh(); });
    window.addEventListener('night-ota-change', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('pagehide', () => clearTimeout(timer));
    let lastCall = inCall();
    new MutationObserver(() => {
      const next = inCall();
      if (next !== lastCall) { lastCall = next; refresh(); }
    }).observe(app, {attributes: true, attributeFilter: ['data-active']});
    refresh();
  }
  setupService();
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>show({})); else show({});
})();
