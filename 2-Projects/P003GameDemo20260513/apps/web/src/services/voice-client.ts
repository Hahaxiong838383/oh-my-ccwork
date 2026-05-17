export interface VoiceClient {
  connect(url: string): Promise<void>;
  isConnected(): boolean;
  startRecording(): Promise<void>;
  stopRecording(): void;
  playAudioChunk(mp3Base64: string): Promise<void>;
  flushTtsBufferNow(): void;
  bargeIn(): void;
  // D5 P20：sayDirect 第二参 onAudioStart 在第一段 mp3 到达时 fire
  // 让字幕等 TTS 真发声再显示（修字幕提前 TTS）
  sayDirect(text: string, onAudioStart?: () => void): void;
  unlockAudio(): Promise<void>;
  on(
    event: 'asr.partial' | 'asr.final' | 'llm.delta' | 'tts.audio' | 'tts.end' | 'tts.sentence_break' | 'error',
    cb: (data: any) => void,
  ): void;
  off(
    event: 'asr.partial' | 'asr.final' | 'llm.delta' | 'tts.audio' | 'tts.end' | 'tts.sentence_break' | 'error',
    cb: (data: any) => void,
  ): void;
  close(): void;
}

type VoiceEvent = 'asr.partial' | 'asr.final' | 'llm.delta' | 'tts.audio' | 'tts.end' | 'tts.sentence_break' | 'error';

type ServerMessage =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done'; text: string }
  | { type: 'tts.audio'; mp3Base64: string }
  | { type: 'tts.sentence_break' }
  | { type: 'tts.end' }
  | { type: 'error'; code: string; message: string };

class VoiceClientImpl implements VoiceClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  // 追踪「在途连接」（new WebSocket 已创建但 onopen 未触发）
  // 用于：close() 时能取消在途 ws；onerror/onclose 身份比对，防止 stale 事件误清当前缓存
  private pendingWs: WebSocket | null = null;

  // D5 P20：sayDirect 注册的"TTS 真发声"回调，下次第一段 tts.audio 到达时 fire 然后清空
  private pendingOnAudioStart: (() => void) | null = null;

  private readonly listeners = new Map<VoiceEvent, Set<(data: any) => void>>();

  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sinkGain: GainNode | null = null;

  private captureBuffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private frameTimer: number | null = null;

  private workletLoaded = false;
  private isRecording = false;
  private readonly targetSampleRate = 16_000;

  // 累积整段 mp3 后一次性 decode + 播放（mp3 chunk 独立 decode 边界会有 silence artifact）
  // 第一个 chunk 到达后启动短缓冲定时器，超时或 tts.end 触发整段 decode 播放
  private mp3Buffer: Uint8Array[] = [];
  private mp3FlushTimer: number | null = null;
  private playbackScheduledAt = 0;
  private playbackSources: AudioBufferSourceNode[] = [];
  // 600ms 绝对延迟（不 reset）兜底：正常流靠 server 端 tts.sentence_break 信号优先 flush
  // （每句话标点触发，段是完整一句话，mp3 priming silence 占比 < 2% 不可感）
  // 600ms 仅在「一句话没标点 / sentence_break 信号缺失」边界场景触发兜底
  private readonly mp3FlushDelayMs = 600;

  isConnected(): boolean {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  async connect(url: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.pendingWs = ws;
      // closure 内局部变量：防止 onerror→onclose 双触发重复 reject，
      // 或 resolve 之后 onclose 再次 settle 已结算的 promise
      let settled = false;

      const clearPendingIfSelf = () => {
        if (this.pendingWs === ws) {
          this.pendingWs = null;
          this.connectPromise = null;
        }
      };

      ws.onopen = () => {
        // close() 已被调用 / 已有新 connect 接管 → 当前 ws 不再是 pending，
        // 直接收尾 ws 并丢弃，避免把僵尸连接放进 this.ws
        if (this.pendingWs !== ws) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }
        settled = true;
        this.ws = ws;
        clearPendingIfSelf();
        resolve();
      };

      ws.onerror = () => {
        clearPendingIfSelf();
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket 连接失败'));
        }
      };

      ws.onclose = () => {
        // 握手期断（未 settled）必须 reject 并清缓存，否则 connectPromise 永远 pending 死锁
        if (!settled) {
          settled = true;
          clearPendingIfSelf();
          reject(new Error('WebSocket 连接关闭'));
          return;
        }
        // settled 之后的 onclose：身份比对，防止 stale 连接关闭把活的 this.ws 吹掉
        if (this.ws === ws) {
          this.ws = null;
        }
      };

      ws.onmessage = (evt) => {
        if (typeof evt.data !== 'string') return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(evt.data) as ServerMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case 'asr.partial':
          case 'asr.final':
          case 'llm.delta':
            this.emit(msg.type, msg);
            break;
          case 'tts.audio':
            // voice-client 内部统一播放（任意触发路径：按住说话 / sayDirect / 未来其它）
            // 同时 emit 给外部用于 UI 状态更新（VoiceButton 等）
            void this.playAudioChunk(msg.mp3Base64);
            // D5 P20：第一段音频到达就 fire onAudioStart（让字幕等到这里再显示）
            if (this.pendingOnAudioStart) {
              const cb = this.pendingOnAudioStart;
              this.pendingOnAudioStart = null;
              try { cb(); } catch (err) { console.warn('[voice-client] onAudioStart cb failed', err); }
            }
            this.emit(msg.type, msg);
            break;
          case 'tts.end':
            // 流末立刻 flush 缓冲段，避免末段被 600ms 防抖延迟
            this.flushTtsBufferNow();
            this.emit(msg.type, msg);
            break;
          case 'tts.sentence_break':
            // 句末信号：立刻 flush 当前段（按句切，每段是完整一句话音频，
            // chunk 边界 priming silence 占比小不可感，比 250ms 时间切更稳）
            this.flushTtsBufferNow();
            // D5 P19：emit 给 UI 用于字幕按句推进（修字幕跟 TTS 不同步）
            this.emit('tts.sentence_break', msg);
            break;
          case 'error':
            this.emit('error', msg);
            break;
          case 'llm.done':
            // llm.done 由按钮层可选监听，这里先复用 llm.delta 累积策略。
            this.emit('llm.delta', { text: '' });
            break;
          default:
            break;
        }
      };
    });

    return this.connectPromise;
  }

  async startRecording(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }

    const ctx = this.ensureAudioContext();
    if (!ctx) {
      throw new Error('当前浏览器不支持 AudioContext');
    }

    // iOS Safari: 必须在用户手势中 resume。
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    if (!this.workletLoaded) {
      await this.loadWorkletModule(ctx);
      this.workletLoaded = true;
    }

    // 清资源但不发 audio.end（避免 session.start 之前的错误信号）
    this.cleanupRecordingResources();

    this.captureBuffer = new Float32Array(0);

    // 防御：HTTP 非安全上下文下 navigator.mediaDevices 不存在（getUserMedia 不可用）
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const protocol = typeof window !== 'undefined' ? window.location.protocol : '?';
      throw new Error(
        protocol === 'http:'
          ? '需要 HTTPS 才能用麦克风（当前是 HTTP）。请用 https://... 访问'
          : '当前浏览器不支持麦克风 API',
      );
    }

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.sourceNode = ctx.createMediaStreamSource(this.micStream);
    this.workletNode = new AudioWorkletNode(ctx, 'pcm16-capture');
    this.sinkGain = ctx.createGain();
    this.sinkGain.gain.value = 0;

    this.workletNode.port.onmessage = (evt: MessageEvent<Float32Array<ArrayBufferLike>>) => {
      const chunk = evt.data;
      if (!(chunk instanceof Float32Array) || chunk.length === 0) return;
      this.captureBuffer = appendFloat32(this.captureBuffer, chunk);
    };

    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(this.sinkGain);
    this.sinkGain.connect(ctx.destination);

    this.ws.send(
      JSON.stringify({
        type: 'session.start',
        sampleRate: this.targetSampleRate,
      }),
    );

    this.isRecording = true;
    this.frameTimer = window.setInterval(() => {
      this.flushOneFrame();
    }, 100);
  }

  private cleanupRecordingResources(): void {
    if (this.frameTimer !== null) {
      window.clearInterval(this.frameTimer);
      this.frameTimer = null;
    }

    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode.port.onmessage = null;
      this.workletNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }

    if (this.sinkGain) {
      try {
        this.sinkGain.disconnect();
      } catch {
        // ignore
      }
      this.sinkGain = null;
    }

    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
    }
  }

  stopRecording(): void {
    // 只在真正录过音时才发 audio.end（防止连接刚开就发错误信号）
    const wasRecording = this.isRecording;
    this.isRecording = false;

    if (wasRecording) {
      this.flushOneFrame();
    }

    this.cleanupRecordingResources();

    if (wasRecording && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'audio.end' }));
    }
  }

  /**
   * 累积所有 mp3 chunk，350ms 内没新 chunk 就 flush 整段：
   *   - 把每句话的所有 chunk 拼成一个完整 mp3 再 decode → 无 chunk 边界 silence
   *   - 350ms 防抖：第一段 chunk 到达后等其它 chunk 跟上再统一解码
   *   - 多句话场景：每句 sentence 之间靠新一轮 350ms 触发分段播放，仍丝滑
   *
   * tts.end 直接触发 flush（不等 350ms）让最后一段立刻播。
   */
  async playAudioChunk(mp3Base64: string): Promise<void> {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // ignore
      }
    }

    this.mp3Buffer.push(base64ToUint8Array(mp3Base64));

    // 关键：已有 pending timer 时 NOT reset，让计时自然到期 flush 第一段。
    // 旧版本 clearTimeout + reset 是防抖模式，导致 TTS chunk 持续就永不 flush。
    if (this.mp3FlushTimer !== null) return;

    this.mp3FlushTimer = window.setTimeout(() => {
      this.mp3FlushTimer = null;
      void this.flushMp3Buffer();
    }, this.mp3FlushDelayMs);
  }

  /**
   * 由 tts.end 事件触发整段立刻播放
   */
  flushTtsBufferNow(): void {
    if (this.mp3FlushTimer !== null) {
      window.clearTimeout(this.mp3FlushTimer);
      this.mp3FlushTimer = null;
    }
    void this.flushMp3Buffer();
  }

  private async flushMp3Buffer(): Promise<void> {
    if (this.mp3Buffer.length === 0) return;
    const ctx = this.ensureAudioContext();
    if (!ctx) return;

    const totalLen = this.mp3Buffer.reduce((s, b) => s + b.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let cursor = 0;
    for (const b of this.mp3Buffer) {
      merged.set(b, cursor);
      cursor += b.byteLength;
    }
    this.mp3Buffer = [];

    try {
      const arrayBuffer = merged.buffer.slice(
        merged.byteOffset,
        merged.byteOffset + merged.byteLength,
      ) as ArrayBuffer;
      const buffer = await ctx.decodeAudioData(arrayBuffer);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      const now = ctx.currentTime;
      const startAt = Math.max(now, this.playbackScheduledAt);
      src.start(startAt);
      this.playbackScheduledAt = startAt + buffer.duration;
      this.playbackSources.push(src);
      src.onended = () => {
        const idx = this.playbackSources.indexOf(src);
        if (idx >= 0) this.playbackSources.splice(idx, 1);
      };
    } catch {
      // decode 失败：忽略本段
    }
  }

  bargeIn(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'barge.in' }));
    }
    // 清掉待 flush 的 mp3 buffer
    if (this.mp3FlushTimer !== null) {
      window.clearTimeout(this.mp3FlushTimer);
      this.mp3FlushTimer = null;
    }
    this.mp3Buffer = [];
    // 立刻停掉所有已调度的 audio source
    for (const src of this.playbackSources) {
      try {
        src.stop();
      } catch {
        // ignore
      }
    }
    this.playbackSources = [];
    this.playbackScheduledAt = 0;
  }

  sayDirect(text: string, onAudioStart?: () => void): void {
    this.bargeIn();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[voice-client] sayDirect skipped: websocket not open');
      return;
    }
    console.log('[voice-client] sayDirect →', text);
    // D5 P20：注册"第一段音频到达"回调（覆盖之前 pending，bargeIn 已断旧会话）
    this.pendingOnAudioStart = onAudioStart ?? null;
    this.ws.send(JSON.stringify({ type: 'tts.say', text }));
  }

  async unlockAudio(): Promise<void> {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
        console.log('[voice-client] AudioContext resumed via unlockAudio');
      } catch (err) {
        console.warn('[voice-client] unlockAudio resume failed', err);
      }
    }
  }

  on(event: VoiceEvent, cb: (data: any) => void): void {
    const set = this.listeners.get(event) ?? new Set<(data: any) => void>();
    set.add(cb);
    this.listeners.set(event, set);
  }

  off(event: VoiceEvent, cb: (data: any) => void): void {
    const set = this.listeners.get(event);
    if (set) set.delete(cb);
  }

  close(): void {
    this.stopRecording();
    this.bargeIn();

    // 关掉在途连接（connect 已调用但 onopen 未触发），
    // 否则后续 onopen 会把僵尸连接放进 this.ws
    if (this.pendingWs && this.pendingWs !== this.ws) {
      try {
        this.pendingWs.close();
      } catch {
        // ignore
      }
      this.pendingWs = null;
      // 同步清掉 connectPromise：pendingWs 已被 null，之后 ws.onclose 走身份比对
      // 会失败，无法在那时清理 connectPromise，否则下次 connect 会返回 reject 旧 promise 死链
      this.connectPromise = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.captureBuffer = new Float32Array(0);
  }

  private emit(event: VoiceEvent, data: any): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      cb(data);
    }
  }

  private ensureAudioContext(): AudioContext | null {
    if (this.audioCtx) return this.audioCtx;
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    this.audioCtx = new AC();
    return this.audioCtx;
  }

  private async loadWorkletModule(ctx: AudioContext): Promise<void> {
    const source = `
      class Pcm16CaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (!input || input.length === 0) return true;
          const ch0 = input[0];
          if (!ch0 || ch0.length === 0) return true;
          this.port.postMessage(new Float32Array(ch0));
          return true;
        }
      }
      registerProcessor('pcm16-capture', Pcm16CaptureProcessor);
    `;

    const blob = new Blob([source], { type: 'application/javascript' });
    const moduleUrl = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  }

  private flushOneFrame(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const sourceRate = this.audioCtx?.sampleRate ?? 48_000;
    const sourceFrameSamples = Math.max(1, Math.round(sourceRate / 10));

    if (this.captureBuffer.length < sourceFrameSamples) return;

    const frame = this.captureBuffer.subarray(0, sourceFrameSamples);
    this.captureBuffer = this.captureBuffer.subarray(sourceFrameSamples);

    const resampled = resample(frame, sourceRate, this.targetSampleRate);
    const pcm16 = floatToPcm16(resampled);
    this.ws.send(pcm16.buffer);
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function appendFloat32(
  a: Float32Array<ArrayBufferLike>,
  b: Float32Array<ArrayBufferLike>,
): Float32Array<ArrayBufferLike> {
  if (a.length === 0) return new Float32Array(b);
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function resample(
  input: Float32Array<ArrayBufferLike>,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate) return new Float32Array(input);

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const alpha = pos - left;
    output[i] = input[left] * (1 - alpha) + input[right] * alpha;
  }

  return output;
}

function floatToPcm16(input: Float32Array<ArrayBufferLike>): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function createVoiceClient(): VoiceClient {
  return new VoiceClientImpl();
}

// module-level 单例：让 jumpToScene 等非组件代码也能 bargeIn 中断在途会话。
// VoiceButton 也用这个 getter，保证全局只有一份 ws + audio 状态。
let sharedInstance: VoiceClient | null = null;

export function getSharedVoiceClient(): VoiceClient {
  if (!sharedInstance) sharedInstance = createVoiceClient();
  return sharedInstance;
}

/** 仅测试用：清掉单例（让 unit test 之间互不污染） */
export function __resetSharedVoiceClientForTesting(): void {
  sharedInstance?.close();
  sharedInstance = null;
}
