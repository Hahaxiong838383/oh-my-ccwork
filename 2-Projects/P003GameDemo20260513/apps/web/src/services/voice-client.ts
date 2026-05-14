export interface VoiceClient {
  connect(url: string): Promise<void>;
  startRecording(): Promise<void>;
  stopRecording(): void;
  playAudioChunk(mp3Base64: string): Promise<void>;
  bargeIn(): void;
  on(
    event: 'asr.partial' | 'asr.final' | 'llm.delta' | 'tts.audio' | 'tts.end' | 'error',
    cb: (data: any) => void,
  ): void;
  close(): void;
}

type VoiceEvent = 'asr.partial' | 'asr.final' | 'llm.delta' | 'tts.audio' | 'tts.end' | 'error';

type ServerMessage =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done'; text: string }
  | { type: 'tts.audio'; mp3Base64: string }
  | { type: 'tts.end' }
  | { type: 'error'; code: string; message: string };

class VoiceClientImpl implements VoiceClient {
  private ws: WebSocket | null = null;

  private readonly listeners = new Map<VoiceEvent, Set<(data: any) => void>>();

  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sinkGain: GainNode | null = null;

  private captureBuffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private frameTimer: number | null = null;

  private workletLoaded = false;
  private readonly targetSampleRate = 16_000;

  private audioQueue: string[] = [];
  private isPlaying = false;
  private currentAudio: HTMLAudioElement | null = null;

  async connect(url: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };

      ws.onerror = () => {
        reject(new Error('WebSocket 连接失败'));
      };

      ws.onclose = () => {
        this.ws = null;
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
          case 'tts.audio':
          case 'tts.end':
            this.emit(msg.type, msg);
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

    this.stopRecording();

    this.captureBuffer = new Float32Array(0);
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

    this.frameTimer = window.setInterval(() => {
      this.flushOneFrame();
    }, 100);
  }

  stopRecording(): void {
    if (this.frameTimer !== null) {
      window.clearInterval(this.frameTimer);
      this.frameTimer = null;
    }

    this.flushOneFrame();

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

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'audio.end' }));
    }
  }

  async playAudioChunk(mp3Base64: string): Promise<void> {
    const dataUrl = `data:audio/mpeg;base64,${mp3Base64}`;
    this.audioQueue.push(dataUrl);
    if (this.isPlaying) return;

    this.isPlaying = true;
    while (this.audioQueue.length > 0) {
      const nextUrl = this.audioQueue.shift();
      if (!nextUrl) continue;

      const audio = new Audio(nextUrl);
      this.currentAudio = audio;

      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        void audio.play().catch(() => resolve());
      });

      this.currentAudio = null;
    }
    this.isPlaying = false;
  }

  bargeIn(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'barge.in' }));
    }

    this.audioQueue = [];
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
  }

  on(event: VoiceEvent, cb: (data: any) => void): void {
    const set = this.listeners.get(event) ?? new Set<(data: any) => void>();
    set.add(cb);
    this.listeners.set(event, set);
  }

  close(): void {
    this.stopRecording();
    this.bargeIn();

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
