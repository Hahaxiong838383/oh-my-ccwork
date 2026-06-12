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
  // KidsHub-AI 工作台：下发组装好的完整 system prompt（server 存到当前连接）
  sendSessionConfig(systemPrompt: string): void;
  // KidsHub-AI 工作台：文本直入 LLM 管线（开场触发指令，走完整 LLM→TTS）
  sendChatTrigger(text: string): void;
  unlockAudio(): Promise<void>;
  on(event: VoiceEvent, cb: (data: any) => void): void;
  off(event: VoiceEvent, cb: (data: any) => void): void;
  close(): void;
}

type VoiceEvent =
  | 'asr.partial'
  | 'asr.final'
  | 'llm.delta'
  | 'llm.done'
  | 'tts.audio'
  | 'tts.end'
  | 'tts.sentence_break'
  // 客户端合成事件（非 server 下发）：
  // tts.segment_start = 一个「句边界段」在 AudioContext clock 上真正开播（表情逐句切换的对齐点）
  // tts.playback_end = 本轮所有音频段播放完毕（≠ tts.end 的"合成完毕"，长句两者差秒级）
  | 'tts.segment_start'
  | 'tts.playback_end'
  | 'session.config.ack'
  | 'debug.prompt_assembled'
  | 'avatar.expression'
  | 'error';

type ServerMessage =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done'; text: string }
  | { type: 'tts.audio'; mp3Base64: string }
  | { type: 'tts.sentence_break' }
  | { type: 'tts.end' }
  | { type: 'session.config.ack'; chars: number }
  | { type: 'debug.prompt_assembled'; systemPrompt: string; userText: string }
  | { type: 'avatar.expression'; name: string; index: number }
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
  // 播放代际：bargeIn / close 时 +1，作废已调度的 segment_start 定时器和 onended 检测
  private playbackGeneration = 0;
  // 本轮 server 合成流是否已结束（tts.end 已到）——播完检测的前提条件
  private ttsStreamEnded = false;
  // 本轮是否已调度过第一个音频段（第 0 句开播信号只发一次；bargeIn 重置）
  private turnHadSegment = false;
  // 在途 decodeAudioData 计数：decode 期间 buffer 已清、source 未 push，
  // 不挡住的话 tts.end 的立即检查会把"最后一段 decode 中"误判成播完
  private decodingCount = 0;
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

      // 握手超时兜底：某些浏览器（Brave Shields 等）可能让 ws 既不 open 也不 error，
      // connectPromise 永远 pending → 点卡的 await 死锁、一条消息都发不出（server 侧 msgs=0）。
      // 10s 没 open 就 reject，让上层拿到明确错误而不是静默卡死。
      const handshakeTimer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        clearPendingIfSelf();
        reject(new Error('WebSocket 握手超时（10s）——可能被浏览器隐私护盾或网络拦截'));
      }, 10_000);

      const clearPendingIfSelf = () => {
        window.clearTimeout(handshakeTimer);
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
            // D5 P21：onAudioStart 不在这里 fire（mp3 chunk 到达离实际播放还有 350ms 防抖）
            // 移到 flushMp3Buffer 内 src.start() 之后才 fire
            this.ttsStreamEnded = false;
            void this.playAudioChunk(msg.mp3Base64);
            this.emit(msg.type, msg);
            break;
          case 'tts.end':
            // 流末立刻 flush 缓冲段，避免末段被 600ms 防抖延迟
            this.ttsStreamEnded = true;
            this.flushTtsBufferNow();
            this.emit(msg.type, msg);
            // 空回复/出错路径可能没有任何已调度音频段——此刻直接判播完
            this.checkPlaybackEnd();
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
            // 工作台调试流需要完整回答文本，原样再透传一份
            this.emit('llm.done', msg);
            break;
          case 'session.config.ack':
          case 'debug.prompt_assembled':
          case 'avatar.expression':
            this.emit(msg.type, msg);
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
      // timer 兜底 flush 的段是句子的"续段"（半句），不算新句开播
      void this.flushMp3Buffer('timer');
    }, this.mp3FlushDelayMs);
  }

  /**
   * 由 tts.sentence_break / tts.end 事件触发整段立刻播放。
   * 这种"句边界 flush"的段开播 = 新一句开播（表情逐句切换的对齐点）。
   */
  flushTtsBufferNow(): void {
    if (this.mp3FlushTimer !== null) {
      window.clearTimeout(this.mp3FlushTimer);
      this.mp3FlushTimer = null;
    }
    void this.flushMp3Buffer('boundary');
  }

  private async flushMp3Buffer(reason: 'timer' | 'boundary'): Promise<void> {
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

    this.decodingCount += 1;
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
      const generation = this.playbackGeneration;
      src.onended = () => {
        const idx = this.playbackSources.indexOf(src);
        if (idx >= 0) this.playbackSources.splice(idx, 1);
        // 最后一段播完 + 合成流已结束 → 本轮真正说完（avatar endTurn 等用）
        if (generation === this.playbackGeneration) this.checkPlaybackEnd();
      };

      // 句开播信号 segment_start（表情队列/字幕打字机的逐句对齐点）：
      //  1) 本轮第一个段（任何 reason）开播 = 第 0 句开播——600ms 防抖 timer 常比
      //     sentence_break 先偷跑首段，单句轮甚至可能全是 timer 段（一个 boundary 都
      //     没有），只认 boundary 会让第 0 句信号整轮缺失（实测字幕全程空白的根因）
      //  2) boundary 段（sentence_break/tts.end flush）= 该句的【尾段】，它"播完"的
      //     时刻才是下一句开播——在 endAt 对齐 emit。末段会多发一次，下游已自保
      //     （打字机末句原地不动 / 表情队列空 no-op）
      const isFirstSegment = !this.turnHadSegment;
      this.turnHadSegment = true;
      if (isFirstSegment) {
        const delayMs = Math.max(0, (startAt - now) * 1000);
        window.setTimeout(() => {
          if (generation === this.playbackGeneration) this.emit('tts.segment_start', {});
        }, delayMs);
      }
      if (reason === 'boundary') {
        const endDelayMs = Math.max(0, (startAt + buffer.duration - now) * 1000);
        window.setTimeout(() => {
          if (generation === this.playbackGeneration) this.emit('tts.segment_start', {});
        }, endDelayMs);
      }

      // D5 P21：实际 src.start() 已调度——首段播放点真到了，fire pendingOnAudioStart
      // 用 setTimeout 等到 (startAt - now) * 1000 ms 后才 fire（精确对齐 AudioContext clock）
      if (this.pendingOnAudioStart) {
        const cb = this.pendingOnAudioStart;
        this.pendingOnAudioStart = null;
        const delayMs = Math.max(0, (startAt - now) * 1000);
        if (delayMs > 0) {
          window.setTimeout(() => {
            try { cb(); } catch (err) { console.warn('[voice-client] onAudioStart cb failed', err); }
          }, delayMs);
        } else {
          try { cb(); } catch (err) { console.warn('[voice-client] onAudioStart cb failed', err); }
        }
      }
    } catch {
      // decode 失败：忽略本段
    } finally {
      this.decodingCount -= 1;
      // decode 失败的段若是最后一段，这里补一次播完检查（成功路径 source 在场不会误发）
      this.checkPlaybackEnd();
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
    // 代际 +1：作废在途的 segment_start 定时器和旧 source 的 onended 播完检测
    this.playbackGeneration += 1;
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
    this.ttsStreamEnded = false;
    this.turnHadSegment = false;
    // 打断 = 本轮播放强制结束，给 avatar/UI 一个确定的收尾信号；
    // reason 让消费方（如 tutorial 状态机）区分"被掐断"和"自然播完"
    this.emit('tts.playback_end', { reason: 'barge' });
  }

  /**
   * 本轮所有音频真正播完的判定：合成流已结束（tts.end 已到）+ 播放队列清空 + 无待 flush 缓冲。
   * 由每个 source 的 onended 和 tts.end 到达时触发检查；命中后消费掉 ttsStreamEnded 保证幂等。
   */
  private checkPlaybackEnd(): void {
    if (!this.ttsStreamEnded) return;
    if (this.playbackSources.length > 0 || this.mp3Buffer.length > 0 || this.decodingCount > 0) return;
    this.ttsStreamEnded = false;
    this.emit('tts.playback_end', { reason: 'natural' });
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

  sendSessionConfig(systemPrompt: string): void {
    // 抛错而非静默 return：ws 没 open 时静默吞掉 = 点卡毫无反应且 server msgs=0，
    // 无法定位（Brave 实战踩坑）。抛出让上层 catch 显示到调试流。
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`下发失败：WebSocket 未就绪（readyState=${this.ws?.readyState ?? 'null'}）`);
    }
    this.ws.send(JSON.stringify({ type: 'session.config', systemPrompt }));
  }

  sendChatTrigger(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`触发失败：WebSocket 未就绪（readyState=${this.ws?.readyState ?? 'null'}）`);
    }
    // server 端 startLlmAndTts 内部会 bargein，旧轮自动让位
    this.ws.send(JSON.stringify({ type: 'chat.trigger', text }));
  }

  async unlockAudio(): Promise<void> {
    // ensureAudioContext 可能 throw（Brave fingerprinting 护盾对 Web Audio 异常）——
    // 整体 try 兜底，让音频解锁失败绝不阻断后续 ws 下发（语音对话链路不依赖播放解锁成功）
    try {
      const ctx = this.ensureAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
    } catch (err) {
      console.warn('[voice-client] unlockAudio failed (non-fatal)', err);
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
