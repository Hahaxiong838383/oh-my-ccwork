'use strict';

const el = id => document.getElementById(id);
const { Room, RoomEvent, Track, DataPacket_Kind } = LivekitClient;
const inputTopic = 'personal.v1.input';
const outputTopic = 'personal.v1.output';
const relayIdentity = 'personal-text-relay';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const toolLabels = { search: '查询', weather: '天气', clock: '时间', search_cancel: '已取消查询' };
let active;

function status(text) { el('status').textContent = text; }
function error(text = '') { el('error').textContent = text; }
function id() { return crypto.randomUUID().replaceAll('-', ''); }
function isWorker(p) {
  return p?.isAgent && p.identity.startsWith('agent-') && p.attributes['lk.agent.name'] === 'personal-xiaoke';
}
function isTextPeer(p) { return isWorker(p) || p?.identity === relayIdentity; }

function displayRoom(connected) {
  document.body.dataset.connected = String(connected);
  el('controls').hidden = !connected;
  el('compose').hidden = !connected;
  el('start').hidden = connected;
  el('connect').disabled = false;
  el('connect-text').disabled = false;
  el('mic').disabled = false;
  el('audio').hidden = true;
}

function line(who) {
  const li = document.createElement('li');
  const author = document.createElement('strong');
  author.textContent = who;
  li.append(author);
  el('lines').append(li);
  el('empty').hidden = true;
  return li;
}

function voiceLine(session, key) {
  let li = session.voice.get(key);
  if (!li) {
    li = line('小可');
    session.voice.set(key, li);
  }
  return li;
}

function transcript(session, items, participant) {
  const agent = isWorker(participant);
  if (!agent && participant?.identity !== session.room.localParticipant.identity) return;
  for (const item of items) {
    if (!item.text?.trim()) continue;
    const key = [participant.identity, item.id].join('/');
    let segment = session.segments.get(key);
    if (!segment) {
      const turn = agent && /^SG_a(\d+)_\d+$/.exec(item.id);
      const li = turn ? voiceLine(session, participant.identity + '/' + turn[1]) : line(agent ? '小可' : '我');
      segment = document.createElement('span');
      li.insertBefore(segment, li.querySelector('.sources'));
      session.segments.set(key, segment);
    }
    segment.textContent = item.text;
  }
}

function showSources(li, metadata) {
  if (!metadata || li.querySelector('.sources')) return;
  const section = document.createElement('div');
  section.className = 'sources';
  const heading = document.createElement('span');
  const label = Object.hasOwn(toolLabels, metadata.tool) ? toolLabels[metadata.tool] : '';
  const list = document.createElement('ul');
  const urls = new Set();
  const items = Array.isArray(metadata.sources) ? metadata.sources.slice(0, 5) : [];
  for (const source of items) {
    if (typeof source?.url !== 'string') continue;
    let url;
    try { url = new URL(source.url); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || urls.has(url.href)) continue;
    urls.add(url.href);
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = typeof source.title === 'string' && source.title.trim() ? source.title : url.hostname;
    item.append(link);
    if (typeof source.date === 'string' && source.date) {
      const date = document.createElement('small');
      date.textContent = source.date;
      item.append(date);
    }
    list.append(item);
  }
  if (!list.children.length && !label) return;
  heading.textContent = list.children.length ? (label ? label + '来源' : '来源') : label;
  section.append(heading, list);
  li.append(section);
}

function send(session, peer, frame) {
  return session.room.localParticipant.publishData(
    encoder.encode(JSON.stringify({ ...frame, recipient: peer.identity })),
    { reliable: true, topic: inputTopic, destinationIdentities: [peer.identity] }
  );
}

function refresh(session) {
  if (active !== session || !session.connected) return;
  const { room, pending, peer } = session;
  const peers = [...room.remoteParticipants.values()];
  const voice = peers.some(isWorker);
  const text = peer && room.remoteParticipants.get(peer.identity)?.sid === peer.sid;
  el('send').disabled = session.reconnecting || !text || !!pending;
  el('cancel').hidden = !pending || pending.cancelling;
  el('text-status').textContent = pending?.cancelling ? '正在停止…'
    : pending ? '小可正在回复…' : text ? '' : '正在连接文字服务';
  if (session.reconnecting) status('正在重连');
  else if (session.mic && voice) status('小可已接通，可以说话');
  else if (text) status(session.mic ? '文字已接通，正在等待语音' : '小可已接通，可以打字');
  else if (voice) status(session.mic ? '语音已接通' : '麦克风未开启，正在连接文字服务');
  else status('已入房，等待小可接听');
}

function receive(session, data, participant, kind, topic) {
  if (active !== session || topic !== outputTopic || kind !== DataPacket_Kind.RELIABLE
      || !isTextPeer(participant) || session.room.remoteParticipants.get(participant.identity)?.sid !== participant.sid) return;
  let frame;
  try { frame = JSON.parse(decoder.decode(data)); } catch { return; }
  if (!frame || typeof frame.id !== 'string') return;
  if (frame.type === 'voice_result' && isWorker(participant) && /^\d+$/.test(frame.id) && frame.metadata) {
    showSources(voiceLine(session, participant.identity + '/' + frame.id), frame.metadata);
    return;
  }
  if (frame.type === 'ready' && session.hellos.get(participant.sid) === frame.id) {
    session.hellos.delete(participant.sid);
    if (!session.peer || isWorker(participant)) session.peer = participant;
    refresh(session);
    return;
  }
  const pending = session.pending;
  if (!pending || pending.id !== frame.id || pending.peer.sid !== participant.sid) return;
  switch (frame.type) {
    case 'text_result': {
      if (pending.cancelling || typeof frame.text !== 'string' || !frame.text.trim()) return;
      const li = line('小可');
      const content = document.createElement('span');
      content.textContent = frame.text;
      li.append(content);
      showSources(li, frame.metadata);
      break;
    }
    case 'cancelled': break;
    case 'busy': error('小可正忙，请稍后再发。'); break;
    case 'error': error('这次没有收到完整回复，请重试。'); break;
    default: return;
  }
  endPending(session);
}

function endPending(session) {
  clearTimeout(session.pending?.timer);
  session.pending = null;
  refresh(session);
}

function probe(session) {
  if (!session.connected || session.reconnecting) return;
  for (const peer of session.room.remoteParticipants.values()) {
    if (!isTextPeer(peer) || (session.peer?.sid === peer.sid)) continue;
    const hello = id();
    session.hellos.set(peer.sid, hello);
    send(session, peer, { type: 'hello', id: hello }).catch(() => {});
  }
}

el('start').onsubmit = async event => {
  event.preventDefault();
  if (active) return;
  const textOnly = event.submitter?.id === 'connect-text';
  el('connect').disabled = true;
  el('connect-text').disabled = true;
  error();
  const room = new Room({
    stopMicTrackOnMute: true,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const session = { room, mic: false, segments: new Map(), voice: new Map(), hellos: new Map() };
  active = session;
  room.on(RoomEvent.TranscriptionReceived, (items, p) => { if (active === session) transcript(session, items, p); });
  room.on(RoomEvent.DataReceived, (...args) => receive(session, ...args));
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (active === session && isWorker(participant) && track.kind === Track.Kind.Audio) el('tracks').append(track.attach());
  });
  room.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(node => node.remove()));
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (active === session) el('audio').hidden = room.canPlaybackAudio; });
  room.on(RoomEvent.ParticipantConnected, () => { probe(session); refresh(session); });
  room.on(RoomEvent.ParticipantDisconnected, participant => {
    session.hellos.delete(participant.sid);
    if (session.peer?.sid === participant.sid) session.peer = null;
    if (session.pending?.peer.sid === participant.sid) {
      error('文字服务已断开，本轮结束。');
      endPending(session);
    }
    refresh(session);
  });
  room.on(RoomEvent.Reconnecting, () => { session.reconnecting = true; refresh(session); });
  room.on(RoomEvent.Reconnected, () => { session.reconnecting = false; probe(session); refresh(session); });
  room.on(RoomEvent.Disconnected, () => {
    if (active !== session) return;
    clearInterval(session.probe);
    clearTimeout(session.deadline);
    clearTimeout(session.pending?.timer);
    active = null;
    displayRoom(false);
    el('tracks').replaceChildren();
    status('会话已结束');
  });
  try {
    status('正在申请房间');
    const res = await fetch('/api/voice/ticket', {
      method: 'POST', headers: { Authorization: 'Bearer ' + el('device').value.trim() },
      cache: 'no-store', signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw Error([401, 403].includes(res.status) ? '设备凭据无效或已撤销' : '签票服务暂不可用');
    const { url, token } = await res.json();
    if (!url?.startsWith('wss://') || !token) throw Error('签票响应缺少安全连接参数');
    status('正在连接北京语音房间');
    el('lines').replaceChildren();
    el('empty').hidden = false;
    await room.connect(url, token);
    if (active !== session) return;
    session.connected = true;
    displayRoom(true);
    el('mic').textContent = '开启麦克风';
    el('audio').hidden = room.canPlaybackAudio;
    probe(session);
    refresh(session);
    session.probe = setInterval(() => probe(session), 1100);
    session.deadline = setTimeout(() => {
      if (active !== session || session.peer || [...room.remoteParticipants.values()].some(isWorker)) return;
      error('小可暂时没有接听，请稍后重试。');
      room.disconnect();
    }, 15000);
    if (!textOnly) await toggleMic(session);
  } catch (err) {
    await room.disconnect().catch(() => {});
    if (active === session) active = null;
    displayRoom(false);
    el('tracks').replaceChildren();
    status('未连接');
    error(err.message);
  }
};

async function toggleMic(session) {
  el('mic').disabled = true;
  try {
    const next = !session.mic;
    await session.room.localParticipant.setMicrophoneEnabled(next);
    if (active !== session) return;
    session.mic = next;
    el('mic').textContent = next ? '静音' : '恢复麦克风';
    error();
    refresh(session);
  } catch {
    if (active === session) error('麦克风不可用，可以继续打字。');
  } finally {
    if (active === session) el('mic').disabled = false;
  }
}

el('compose').onsubmit = async event => {
  event.preventDefault();
  const session = active;
  const peer = session?.peer;
  if (!peer || session.pending || session.reconnecting) return;
  const text = el('message').value.trim();
  if (!text) return;
  if (encoder.encode(text).length > 4096) {
    error('这条消息太长，请缩短后发送。');
    return;
  }
  error();
  const request = { id: id(), peer };
  const li = line('我');
  const content = document.createElement('span');
  content.textContent = text;
  li.append(content);
  session.pending = request;
  refresh(session);
  request.timer = setTimeout(() => {
    if (active !== session || session.pending !== request) return;
    send(session, peer, { type: 'cancel', id: request.id }).catch(() => {});
    endPending(session);
    error('等待回复超时，请重试。');
  }, 35000);
  try {
    await send(session, peer, { type: 'text', id: request.id, text, store: el('store').checked });
    if (active !== session) return;
    el('message').value = '';
  } catch {
    if (active !== session) return;
    if (session.pending === request) {
      li.remove();
      el('empty').hidden = el('lines').children.length > 0;
      endPending(session);
    }
    error('消息发送失败，请重试。');
  }
};
el('message').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!el('send').disabled) el('compose').requestSubmit();
  }
};
el('cancel').onclick = async () => {
  const session = active;
  const request = session?.pending;
  if (!request || request.cancelling) return;
  request.cancelling = true;
  refresh(session);
  try { await send(session, request.peer, { type: 'cancel', id: request.id }); }
  catch { if (active === session) error('未能发送停止指令。'); }
  if (active === session && session.pending === request) {
    // Ignore a completion already on the wire once the user has asked to stop.
    endPending(session);
    el('text-status').textContent = '已停止等待本次回复';
  }
};
el('end').onclick = () => active?.room.disconnect();
el('mic').onclick = () => { if (active) toggleMic(active); };
el('audio').onclick = () => active?.room.startAudio().catch(() => error('浏览器未允许播放声音。'));
window.addEventListener('pagehide', () => active?.room.disconnect());
