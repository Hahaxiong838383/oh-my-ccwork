/**
 * JavisVoice SDK(档位 A 薄封装,2026-07-27)。
 *
 * 对外只暴露自有 API 面;传输层(livekit-client)整体 bundle 进产物,
 * 接入方零 npm 依赖、零传输层概念——token/信令地址由 SDK 内部经
 * POST {endpoint}/v1/sessions 自动获取。
 *
 * 移植自 voice-test.html 生产验证逻辑:
 * - audioCaptureDefaults 显式锁定(AEC/降噪/AGC 不随库升级漂移)
 * - 直连中途被掐 → 记住 relay 偏好,切 TURN 中转立即重连(跨境 UDP QoS 实战)
 * - TranscriptionReceived → transcript 事件;DataReceived 指标 → metrics 事件
 */

import { Room, RoomEvent, Track } from "livekit-client";

const DEFAULT_ENDPOINT = "https://voice-api.hahaxiong.cc";
const RELAY_KEY = "javis_voice_relay";

class JavisSession {
  constructor(room, opts) {
    this._room = room;
    this._opts = opts;
    this._handlers = { transcript: [], state: [], metrics: [], warning: [], speaking: [] };
    this._audioEls = [];
    this._metrics = {};
    this._agentAudioTrack = null;
  }

  /**
   * 底层房间对象(公开 API,接口稳定承诺):localParticipant / startAudio() /
   * activeSpeakers 等可放心使用;变更会提前在集成文档同步,不会静默改。
   */
  get room() {
    return this._room;
  }

  /** agent 的远端音频轨(未订阅到时为 null),供电平可视化等取用。 */
  get agentAudioTrack() {
    return this._agentAudioTrack;
  }

  on(event, fn) {
    (this._handlers[event] || (this._handlers[event] = [])).push(fn);
    return this;
  }

  _emit(event, payload) {
    for (const fn of this._handlers[event] || []) {
      try { fn(payload); } catch (e) { console.error("[JavisVoice] handler error", e); }
    }
  }

  /** 静音/恢复麦克风。stopMicTrackOnMute 下 false 会真正释放麦克风设备。 */
  async setMicEnabled(enabled) {
    await this._room.localParticipant.setMicrophoneEnabled(!!enabled);
  }

  /** 结束会话并清理音频元素。 */
  async close() {
    for (const el of this._audioEls.splice(0)) el.remove();
    await this._room.disconnect();
  }
}

async function createSession(opts) {
  const endpoint = (opts.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");
  const resp = await fetch(`${endpoint}/v1/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ participant_name: opts.participantName || "user" }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`JavisVoice: 会话创建失败 HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

/**
 * 建立语音会话。必须在用户手势(点击)调用栈内,否则浏览器拦麦克风/自动播放。
 * @param {{apiKey: string, endpoint?: string, participantName?: string, audioContainer?: HTMLElement}} opts
 * @returns {Promise<JavisSession>}
 */
export async function connect(opts) {
  if (!opts || !opts.apiKey) throw new Error("JavisVoice.connect: 缺少 apiKey");
  const grant = await createSession(opts);

  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    // 闭麦时真正停掉采集轨、释放麦克风设备——常连房间模式下设备侧的
    // 唤醒词识别(webkitSpeechRecognition)才拿得到麦;代价是重新开麦
    // 需重新 getUserMedia(约 +100ms,已授权域无弹窗)
    stopMicTrackOnMute: true,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const session = new JavisSession(room, opts);
  if (grant.warning) session._emit("warning", grant.warning);

  let relay = false;
  try { relay = sessionStorage.getItem(RELAY_KEY) === "1"; } catch (e) { /* SSR/隐私模式 */ }
  const rememberRelay = () => {
    relay = true;
    try { sessionStorage.setItem(RELAY_KEY, "1"); } catch (e) { /* ignore */ }
  };

  room.on(RoomEvent.Reconnecting, () => {
    if (!relay) {
      rememberRelay();
      session._emit("state", "reconnecting");
      room.disconnect().then(() => doConnect());
    } else {
      session._emit("state", "reconnecting");
    }
  });
  room.on(RoomEvent.Reconnected, () => session._emit("state", "connected"));
  room.on(RoomEvent.Disconnected, () => session._emit("state", "disconnected"));

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      session._agentAudioTrack = track;
      const el = track.attach();
      el.autoplay = true;
      (opts.audioContainer || document.body).appendChild(el);
      session._audioEls.push(el);
    }
  });

  room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
    const role = participant && participant.isAgent ? "agent" : "user";
    for (const s of segments) {
      session._emit("transcript", { role, text: s.text, final: !!s.final, id: s.id });
    }
  });

  room.on(RoomEvent.DataReceived, (payload) => {
    try {
      const m = JSON.parse(new TextDecoder().decode(payload));
      if (!m.k) return;
      if (m.k === "speaking") {
        // 服务端权威状态:true=agent 开始播报;false=本轮播报完毕
        // (比前端轮询音频电平准——句间停顿/低音量不会误判)
        session._emit("speaking", { speaking: !!m.speaking });
        return;
      }
      if (m.k === "eou") { session._metrics.eou_ms = m.eou_ms; session._metrics.stt_ms = m.stt_ms; }
      else if (m.k === "llm") session._metrics.ttft_ms = m.ttft_ms;
      else if (m.k === "tts") session._metrics.ttfb_ms = m.ttfb_ms;
      session._emit("metrics", { ...session._metrics });
    } catch (e) { /* 非指标 data 忽略 */ }
  });

  const doConnect = async () => {
    await room.connect(
      grant.url,
      grant.token,
      relay ? { rtcConfig: { iceTransportPolicy: "relay" } } : undefined
    );
    await room.localParticipant.setMicrophoneEnabled(true);
    session._emit("state", "connected");
  };

  try {
    await doConnect();
  } catch (e) {
    if (!relay) {
      // 直连建立失败 → 切 TURN 中转重试一次(并记住,下次直接中转)
      rememberRelay();
      await doConnect();
    } else {
      throw e;
    }
  }
  return session;
}

/**
 * 预热网络层(DNS/TCP/TLS,含信令域):不创建会话、不占 worker 名额、不发声。
 * 幂等可重复调用;建议在唤醒前(页面加载/定时保温)调用。失败静默——预热
 * 本身是尽力而为,不应影响业务流程。
 * @param {{endpoint?: string}} [opts]
 */
export async function prewarm(opts) {
  const endpoint = ((opts && opts.endpoint) || DEFAULT_ENDPOINT).replace(/\/$/, "");
  await fetch(`${endpoint}/healthz`, { cache: "no-store" })
    .then((r) => r.json())
    .then((h) => {
      if (h && h.ws_url) {
        // wss 与 https 同 host 共享 TLS 会话缓存:预热 https 即预热信令握手
        const httpsUrl = String(h.ws_url).replace(/^wss:/, "https:").replace(/^ws:/, "http:");
        return fetch(httpsUrl, { mode: "no-cors", cache: "no-store" }).catch(() => {});
      }
    })
    .catch(() => {});
}

export const version = "1.1.0";
