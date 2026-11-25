'use strict';
const el = id => document.getElementById(id);
const { Room, RoomEvent, Track } = LivekitClient;
let active;
let muted = false;
const segments = new Map();
function status(text) { el('status').textContent = text; }
function displayRoom(connected) {
  document.body.dataset.connected = String(connected);
  el('controls').hidden = !connected;
  el('start').hidden = connected;
  el('connect').disabled = false;
  el('mic').disabled = false;
  el('mic').textContent = '静音';
  el('audio').hidden = true;
  muted = false;
}
function transcript(items, participant) {
  for (const item of items) {
    if (!item.text?.trim()) continue;
    const key = [participant?.identity, item.id].join('/');
    let line = segments.get(key);
    if (!line) {
      const li = document.createElement('li');
      const who = document.createElement('strong');
      who.textContent = participant?.isAgent ? '小可' : '我';
      line = document.createElement('span');
      li.append(who, line); el('lines').append(li);
      segments.set(key, line); el('empty').hidden = true;
    }
    line.textContent = item.text;
  }
}
function ready(room) {
  if (active !== room) return;
  const present = [...room.remoteParticipants.values()].some(p => p.isAgent);
  status(!present ? '已入房，等待小可接听' : muted ? '麦克风已静音' : '小可已接通，可以说话');
}
el('start').onsubmit = async event => {
  event.preventDefault();
  if (active) return;
  el('connect').disabled = true; el('error').textContent = '';
  const room = new Room({stopMicTrackOnMute:true, audioCaptureDefaults:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  active = room;
  room.on(RoomEvent.TranscriptionReceived, (items,p) => { if (active === room) transcript(items,p); });
  room.on(RoomEvent.TrackSubscribed, track => {
    if (active === room && track.kind === Track.Kind.Audio) el('tracks').append(track.attach());
  });
  room.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(node => node.remove()));
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (active === room) el('audio').hidden = room.canPlaybackAudio; });
  for (const event of [RoomEvent.ParticipantConnected,RoomEvent.ParticipantDisconnected,RoomEvent.Reconnected]) room.on(event, () => ready(room));
  room.on(RoomEvent.Reconnecting, () => { if (active === room) status('正在重连'); });
  room.on(RoomEvent.Disconnected, () => {
    if (active !== room) return;
    active = null; displayRoom(false); el('tracks').replaceChildren(); status('通话已结束');
  });
  try {
    status('正在申请房间');
    const res = await fetch('/api/voice/ticket',{method:'POST',headers:{Authorization:'Bearer '+el('device').value.trim()},cache:'no-store',signal:AbortSignal.timeout(12000)});
    if (!res.ok) throw Error([401,403].includes(res.status) ? '设备凭据无效或已撤销' : '签票服务暂不可用');
    const {url,token} = await res.json();
    if (!url?.startsWith('wss://') || !token) throw Error('签票响应缺少安全连接参数');
    status('正在连接北京语音房间');
    el('lines').replaceChildren(); segments.clear(); el('empty').hidden=false;
    await room.connect(url,token);
    await room.localParticipant.setMicrophoneEnabled(true);
    if (active !== room) throw Error('连接已结束');
    displayRoom(true); el('audio').hidden=room.canPlaybackAudio; ready(room);
  } catch(err) {
    await room.disconnect().catch(()=>{}); active=null; displayRoom(false);
    el('tracks').replaceChildren(); status('未连接'); el('error').textContent = err.name==='NotAllowedError' ? '请允许麦克风后重新开始。' : err.message;
  }
};
el('end').onclick = () => active?.disconnect();
el('mic').onclick = async () => {
  const room=active;
  if (!room) return;
  el('mic').disabled=true;
  try { await room.localParticipant.setMicrophoneEnabled(muted); if(active===room){muted=!muted;el('mic').textContent=muted?'恢复麦克风':'静音';ready(room);} }
  catch{el('error').textContent='未能切换麦克风，请检查权限。';}
  finally{el('mic').disabled=false;}
};
el('audio').onclick = () => active?.startAudio().catch(()=>{el('error').textContent='浏览器未允许播放声音。';});
window.addEventListener('pagehide', () => { active?.disconnect(); });
