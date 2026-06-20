/**
 * 会话元数据（需求2）：与 prompt 解耦的"当前会话是谁、在哪个场景、要不要捕获反馈"。
 * server 按 captureMode 决定是否把孩子 ASR 转写落进反馈库。sceneId=card5 或引导 kidshub 单元 → 'feedback'。
 */
export interface SessionMeta {
  sessionId: string;
  sceneId: string | null;
  nickname: string;
  gender: string;
  age: string;
  tutorialUnitId?: string;
  captureMode: 'feedback' | 'off';
  source: 'card' | 'tutorial';
}

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
  // 需求2：下发会话元数据（sceneId/nickname/captureMode），与 config 解耦
  sendSessionMeta(meta: SessionMeta): void;
  // KidsHub-AI 工作台：文本直入 LLM 管线（开场触发指令，走完整 LLM→TTS）
  sendChatTrigger(text: string): void;
  // 需求3：小可语速（TTS 播放速率）1 / 1.5 / 2；立即对后续音频段生效
  setPlaybackRate(rate: number): void;
  unlockAudio(): Promise<void>;
  /** 唤醒即时确认音（本地 AudioContext 合成柔和双音，<50ms，掩盖云端 LLM+TTS 延迟）。复用已解锁的 ctx，未解锁则静默 */
  playCue(): void;
  /** 电影字幕：当前音频播放时刻对应的整句文本（rAF 每帧取，无则 null） */
  getCurrentSubtitleCue(): string | null;
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
  // 句级 cue（电影字幕）：server 据 Doubao 350 下发，带该句权威文本 + index
  | 'tts.cue'
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
  | { type: 'tts.turn_start'; turn: number }
  | { type: 'tts.turn_discard'; upTo: number }
  | { type: 'tts.audio'; mp3Base64: string; turn: number; sentenceIndex?: number }
  | { type: 'tts.cue'; turn: number; index: number; text: string }
  | { type: 'tts.sentence_break'; turn: number }
  | { type: 'tts.end'; turn?: number }
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

  // 问题2（docs/24）：唤醒确认音 —— 预存小可音色短语（public/cue/cue-1..N.mp3），随机播不连续重复。
  // null=未懒加载；[]=加载过但无文件（此时 playCue 降级回本地合成音）。
  private cueAudioBuffers: AudioBuffer[] = [];
  private cueLoadStarted = false;
  private lastCueAudioIdx = -1;

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
  // server 轮次：bargeIn 后丢弃当前及更旧 turn 的在途 tts.audio，避免旧场景续播。
  private currentTurn = 0;
  private discardTurnAtOrBelow = -1;
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

  // 需求3：小可语速（TTS 播放速率）。1=正常，1.5/2=加速。注意 Web Audio playbackRate 会同时升调，
  // 加速时音色偏尖（无音高保持，时间拉伸需第三方库，demo 接受此权衡）。
  private playbackRate = 1;

  // 修复(team 2026-06-19)：decode 串行链——保证音频段严格按 flush 顺序 decode+schedule，
  // 杜绝并发 decodeAudioData 完成乱序抢占 playbackScheduledAt（段重叠/错位 → "同段音量忽大忽小"根因）。
  private decodeChain: Promise<void> = Promise.resolve();
  // 固定 TTS 增益总线：source → ttsGain → destination，统一音量 + 防多段瞬时叠加削波。
  private ttsGain: GainNode | null = null;

  // —— 电影字幕式句级 cue（C2 2026-06-19）——
  // cueText: 句 index → 该句权威文本（来自 server tts.cue / Doubao 350）。
  // cueWindow: 句 index → 该句在 AudioContext 时钟上的真实播放窗 {startAt,endAt}（音频段排播时绑定）。
  // 字幕层用 rAF 读 ctx.currentTime 查当前落在哪句 → 整句显示，无打字机/无逐字（真同步）。
  private cueText = new Map<number, string>();
  private cueWindow = new Map<number, { startAt: number; endAt: number }>();
  // 当前正在缓冲的音频 chunk 所属句 index（tts.audio.sentenceIndex）。flush 成段时绑定到该句的时间窗。
  private bufferingSentenceIndex = 0;
  // 行级单调钳制：同一 cue 内分行只前进不回退（cue 早期 endAt 还在扩展会让比例分行抖动→回退）。
  private lastCueIdx = -1;
  private lastLineIdx = -1;

  isConnected(): boolean {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  async connect(url: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    // Step 4：已登录则把 token 带进 WS（浏览器原生 WS 不能加 Authorization header → 走 query）；
    // 未登录 / 无 token → finalUrl=url 不变，退回现有匿名连接（向后兼容）。
    let finalUrl = url;
    try {
      const token = window.sessionStorage.getItem('kidshub.token');
      if (token) {
        const u = new URL(url, window.location.origin);
        u.searchParams.set('token', token);
        finalUrl = u.toString();
      }
    } catch {
      // sessionStorage / URL 解析异常 → 退回原 url（不阻断连接）
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(finalUrl);
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
        this.currentTurn = 0;
        this.discardTurnAtOrBelow = -1;
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
          case 'tts.turn_start':
            this.observeTurn(msg.turn);
            break;
          case 'tts.turn_discard':
            this.discardTurnAtOrBelow = Math.max(this.discardTurnAtOrBelow, msg.upTo);
            break;
          case 'tts.cue':
            if (this.shouldDiscardTtsTurn(msg.turn)) return;
            // 句开始（Doubao 350）：记录该句权威文本，等其音频段排播时绑定时间窗
            this.cueText.set(msg.index, msg.text);
            this.emit('tts.cue', msg);
            break;
          case 'tts.audio':
            if (this.shouldDiscardTtsTurn(msg.turn)) return;
            // voice-client 内部统一播放（任意触发路径：按住说话 / sayDirect / 未来其它）
            // 同时 emit 给外部用于 UI 状态更新（VoiceButton 等）
            // D5 P21：onAudioStart 不在这里 fire（mp3 chunk 到达离实际播放还有 350ms 防抖）
            // 移到 flushMp3Buffer 内 src.start() 之后才 fire
            // 记录本 chunk 所属句：flush 成段时绑定到该句 cue 时间窗
            if (typeof msg.sentenceIndex === 'number') this.bufferingSentenceIndex = msg.sentenceIndex;
            this.ttsStreamEnded = false;
            void this.playAudioChunk(msg.mp3Base64);
            this.emit(msg.type, msg);
            break;
          case 'tts.end':
            if (this.shouldDiscardTtsTurn(msg.turn)) return;
            // 流末立刻 flush 缓冲段，避免末段被 600ms 防抖延迟
            this.ttsStreamEnded = true;
            this.flushTtsBufferNow();
            this.emit(msg.type, msg);
            // 空回复/出错路径可能没有任何已调度音频段——此刻直接判播完
            this.checkPlaybackEnd();
            break;
          case 'tts.sentence_break':
            if (this.shouldDiscardTtsTurn(msg.turn)) return;
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

    // PTT 互斥(team 修复 2026-06-19)：录音前停掉所有 TTS 播放——录音与播放不同时存在，
    // 避免 getUserMedia 激活系统音频会话 ducking 时压低正在播的小可声音(三件套已关但系统层仍可能 duck)。
    this.stopAllPlayback();
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
        // 音量修复（川哥 2026-06-13）：关闭 AEC/降噪/AGC。「按住说话」是 PTT——孩子说话时
        // 小可不出声，无回声风险；但 echoCancellation 会让浏览器申请进系统「通信模式」，对
        // 扬声器输出做 ducking（把小可 TTS 当回声压低）→ 录一次音后小可回复音量骤降。关掉三
        // 件套即阻止进入通信模式，绕过系统级音量压制（gemini 根因分析：桌面 85%/移动 95%）。
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
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

  private flushMp3Buffer(reason: 'timer' | 'boundary'): void {
    if (this.mp3Buffer.length === 0) return;
    // 同步拼接 + 清 buffer：保证「入队顺序 = flush 顺序」，后续串行 decode 严格按此序推进。
    const totalLen = this.mp3Buffer.reduce((s, b) => s + b.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let cursor = 0;
    for (const b of this.mp3Buffer) {
      merged.set(b, cursor);
      cursor += b.byteLength;
    }
    this.mp3Buffer = [];
    const generation = this.playbackGeneration;
    const isFirstSegment = !this.turnHadSegment;
    this.turnHadSegment = true;
    // 本段所属句 index（buffer 内 chunk 共享同一句——flush 在 Doubao 句边界触发，不混句）
    const segmentSentenceIndex = this.bufferingSentenceIndex;
    this.decodingCount += 1;
    // 串行链：上一段 decode+schedule 完才轮到本段，playbackScheduledAt 按序推进，
    // 消除并发 decodeAudioData 乱序完成抢占排队时间轴（段重叠/错位）。
    this.decodeChain = this.decodeChain
      .then(() => this.decodeAndSchedule(merged, reason, generation, isFirstSegment, segmentSentenceIndex))
      .catch(() => {
        /* 单段 decode 失败不断链，后续段照常播 */
      })
      .finally(() => {
        this.decodingCount -= 1;
        this.checkPlaybackEnd();
      });
  }

  private async decodeAndSchedule(
    merged: Uint8Array,
    reason: 'timer' | 'boundary',
    generation: number,
    isFirstSegment: boolean,
    sentenceIndex: number,
  ): Promise<void> {
    if (generation !== this.playbackGeneration) return;
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    const arrayBuffer = merged.buffer.slice(
      merged.byteOffset,
      merged.byteOffset + merged.byteLength,
    ) as ArrayBuffer;
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    if (generation !== this.playbackGeneration) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // 需求3：应用语速（同时升调，demo 接受）。effDur = 真实播放时长 = buffer.duration / rate
    src.playbackRate.value = this.playbackRate;
    // 接固定 ttsGain 总线（非直连 destination）：统一音量 + 防多段叠加削波。
    src.connect(this.ensureTtsGain(ctx));

    const now = ctx.currentTime;
    const startAt = Math.max(now, this.playbackScheduledAt);
    src.start(startAt);
    const effDur = buffer.duration / this.playbackRate;
    this.playbackScheduledAt = startAt + effDur;
    this.playbackSources.push(src);

    // 电影字幕 cue 绑定：把本句在 AudioContext 时钟上的真实播放窗记到 cueWindow。
    // 一句可能由多段（boundary + 600ms timer 续段）组成 → startAt 取最早、endAt 取最晚（扩展）。
    {
      const prev = this.cueWindow.get(sentenceIndex);
      this.cueWindow.set(sentenceIndex, {
        startAt: prev ? Math.min(prev.startAt, startAt) : startAt,
        endAt: prev ? Math.max(prev.endAt, startAt + effDur) : startAt + effDur,
      });
    }
    src.onended = () => {
      const idx = this.playbackSources.indexOf(src);
      if (idx >= 0) this.playbackSources.splice(idx, 1);
      // 最后一段播完 + 合成流已结束 → 本轮真正说完（avatar endTurn 等用）
      if (generation === this.playbackGeneration) this.checkPlaybackEnd();
    };

    // 句开播信号 segment_start（表情队列/字幕逐句对齐点）。保留现状 durationMs；
    // 修复1（字幕 rAF 进度驱动）会改成带 startAt/endAt 段时间轴。
    if (isFirstSegment) {
      const delayMs = Math.max(0, (startAt - now) * 1000);
      window.setTimeout(() => {
        if (generation === this.playbackGeneration)
          this.emit('tts.segment_start', { durationMs: Math.round(effDur * 1000) });
      }, delayMs);
    }
    if (reason === 'boundary') {
      const endDelayMs = Math.max(0, (startAt + effDur - now) * 1000);
      window.setTimeout(() => {
        if (generation === this.playbackGeneration)
          this.emit('tts.segment_start', { durationMs: Math.round(effDur * 1000) });
      }, endDelayMs);
    }

    // D5 P21：src.start() 已调度——首段播放点真到了，fire pendingOnAudioStart（对齐 AudioContext clock）
    if (this.pendingOnAudioStart) {
      const cb = this.pendingOnAudioStart;
      this.pendingOnAudioStart = null;
      const delayMs = Math.max(0, (startAt - now) * 1000);
      if (delayMs > 0) {
        window.setTimeout(() => {
          try {
            cb();
          } catch (err) {
            console.warn('[voice-client] onAudioStart cb failed', err);
          }
        }, delayMs);
      } else {
        try {
          cb();
        } catch (err) {
          console.warn('[voice-client] onAudioStart cb failed', err);
        }
      }
    }
  }

  private ensureTtsGain(ctx: AudioContext): GainNode {
    if (this.ttsGain) return this.ttsGain;
    const gain = ctx.createGain();
    gain.gain.value = 0.9; // 略降防多段瞬时叠加削波（clip）
    gain.connect(ctx.destination);
    this.ttsGain = gain;
    return gain;
  }

  bargeIn(): void {
    this.discardTurnAtOrBelow = Math.max(this.discardTurnAtOrBelow, this.currentTurn);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'barge.in' }));
    }
    // 清掉待 flush 的 mp3 buffer
    if (this.mp3FlushTimer !== null) {
      window.clearTimeout(this.mp3FlushTimer);
      this.mp3FlushTimer = null;
    }
    this.mp3Buffer = [];
    this.stopAllPlayback();
    // 打断 = 本轮播放强制结束，给 avatar/UI 一个确定的收尾信号；
    // reason 让消费方（如 tutorial 状态机）区分"被掐断"和"自然播完"
    this.emit('tts.playback_end', { reason: 'barge' });
  }

  /**
   * 停掉所有在播 / 在调度的 TTS 音频（不发 server barge.in）。
   * bargeIn 与 startRecording(PTT 互斥) 复用：代际 +1 作废在途 segment_start 定时器、
   * 旧 source onended、decode 串行链上的旧段。
   */
  private stopAllPlayback(): void {
    this.playbackGeneration += 1;
    for (const src of this.playbackSources) {
      try {
        src.stop();
      } catch {
        // ignore
      }
    }
    this.playbackSources = [];
    this.playbackScheduledAt = 0;
    this.decodeChain = Promise.resolve();
    this.ttsStreamEnded = false;
    this.turnHadSegment = false;
    // 清电影字幕 cue：新一轮重建（bargeIn/PTT 互斥都经此）
    this.cueText.clear();
    this.cueWindow.clear();
    this.bufferingSentenceIndex = 0;
    this.lastCueIdx = -1;
    this.lastLineIdx = -1;
  }

  /**
   * 电影字幕：返回「当前 AudioContext 播放时刻」该显示的字幕行，无则 null。
   * 1) 取 startAt<=now 中 startAt 最大的句（=最近开播的句，gap 不闪）；
   * 2) Doubao 偶把多句合一个 cue（整段）→ 把该 cue 文本按句标点切「行」，在 cue 的真实音频窗
   *    [startAt,endAt] 内按字数比例分配子窗，返回 now 落在的那一行 → 长 cue 也一行行显示而非整段静止；
   * 3) endAt grace：超末窗 + 2s 仍没收尾信号 → 返 null 兜底（防最后一行无限残留）。
   */
  getCurrentSubtitleCue(): string | null {
    const ctx = this.audioCtx;
    if (!ctx) return null;
    const now = ctx.currentTime;
    let bestIdx = -1;
    let bestStart = -Infinity;
    let maxEnd = -Infinity;
    for (const [idx, win] of this.cueWindow) {
      if (win.endAt > maxEnd) maxEnd = win.endAt;
      // 跳过空文本句（350 无 text 的兜底句仍推进 index，但不显示，保持上一非空行）
      const t = this.cueText.get(idx);
      if (!t) continue;
      if (win.startAt <= now + 0.001 && win.startAt > bestStart) {
        bestStart = win.startAt;
        bestIdx = idx;
      }
    }
    if (bestIdx < 0) return null;
    // 末窗 grace 兜底：远超最后音频窗仍在查 → 不再钉住（收尾交给 playback_end 清空）
    if (now > maxEnd + 2) return null;

    const win = this.cueWindow.get(bestIdx)!;
    const text = this.cueText.get(bestIdx)!;
    const lines = splitCueLines(text);
    if (lines.length <= 1) {
      this.lastCueIdx = bestIdx;
      this.lastLineIdx = 0;
      return text;
    }

    // 在该 cue 的真实音频窗内按字数比例分行；返回 now 落在的行（超末行则保持末行）
    const span = Math.max(0.001, win.endAt - win.startAt);
    const totalChars = lines.reduce((n, l) => n + l.length, 0) || 1;
    let acc = 0;
    let lineIdx = lines.length - 1;
    for (let k = 0; k < lines.length; k++) {
      acc += lines[k].length;
      const lineEnd = win.startAt + (acc / totalChars) * span;
      if (now < lineEnd) {
        lineIdx = k;
        break;
      }
    }
    // 单调钳制：同 cue 内行号只进不退（早期 endAt 扩展致比例抖动时不回跳上一行）
    if (bestIdx !== this.lastCueIdx) {
      this.lastCueIdx = bestIdx;
      this.lastLineIdx = lineIdx;
    } else if (lineIdx < this.lastLineIdx) {
      lineIdx = this.lastLineIdx;
    } else {
      this.lastLineIdx = lineIdx;
    }
    return lines[lineIdx];
  }

  private observeTurn(turn: number): boolean {
    if (!Number.isFinite(turn)) return false;
    this.currentTurn = Math.max(this.currentTurn, turn);
    return true;
  }

  private shouldDiscardTtsTurn(turn: number | undefined): boolean {
    if (turn === undefined) return false;
    if (!this.observeTurn(turn)) return true;
    return turn <= this.discardTurnAtOrBelow;
  }

  /**
   * 本轮所有音频真正播完的判定：合成流已结束（tts.end 已到）+ 播放队列清空 + 无待 flush 缓冲。
   * 由每个 source 的 onended 和 tts.end 到达时触发检查；命中后消费掉 ttsStreamEnded 保证幂等。
   */
  private checkPlaybackEnd(): void {
    if (!this.ttsStreamEnded) return;
    if (this.playbackSources.length > 0 || this.mp3Buffer.length > 0 || this.decodingCount > 0) return;
    this.ttsStreamEnded = false;
    // 本轮播完即发收尾（CanvasHost 据此停 cue 驱动 + 延迟清字幕，最后一行已 setSubtitle 停住）；
    // 同步清本轮 cue map，防下一轮 index 从 0 起撞旧窗导致跨轮串字幕（codex P1）。
    this.emit('tts.playback_end', { reason: 'natural' });
    this.cueText.clear();
    this.cueWindow.clear();
    this.bufferingSentenceIndex = 0;
    this.lastCueIdx = -1;
    this.lastLineIdx = -1;
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

  sendSessionMeta(meta: SessionMeta): void {
    // best-effort：meta 是辅助上下文，ws 没就绪时静默跳过（不像 config 抛错），
    // 下次切卡/切步会重发。绝不因 meta 发送失败影响语音主链路。
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'session.meta', ...meta }));
  }

  sendChatTrigger(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`触发失败：WebSocket 未就绪（readyState=${this.ws?.readyState ?? 'null'}）`);
    }
    // server 端 startLlmAndTts 内部会 bargein，旧轮自动让位
    this.ws.send(JSON.stringify({ type: 'chat.trigger', text }));
  }

  setPlaybackRate(rate: number): void {
    // 容错：只接受正常范围，非法值兜回 1
    this.playbackRate = rate > 0 && rate <= 4 ? rate : 1;
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

  /**
   * 唤醒即时确认音：本地 AudioContext 合成柔和上扬双音（叮-咚 E5→A5），<50ms 延迟。
   * 唤醒命中后立即播放，衔接云端 connect+录音+LLM+TTS 的延时空窗（需求1）。
   * 复用已解锁的 ctx；ctx 未 running（无用户手势解锁）→ 静默不播，绝不抛错阻断主流程。
   */
  playCue(): void {
    try {
      const ctx = this.ensureAudioContext();
      if (!ctx || ctx.state !== 'running') return;

      // 问题2：懒加载预存小可音色短语（public/cue/cue-1..N.mp3），首次触发一次（cueLoadStarted 去重并发，team grok/gpt）。
      if (!this.cueLoadStarted) {
        this.cueLoadStarted = true;
        const names = ['cue-1', 'cue-2', 'cue-3', 'cue-4', 'cue-5'];
        void Promise.allSettled(
          names.map((n) =>
            fetch(`/cue/${n}.mp3`)
              .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('404'))))
              .then((b) => ctx.decodeAudioData(b))
              .then((buf) => {
                this.cueAudioBuffers.push(buf);
              }),
          ),
        ).then(() => {
          // 全失败（离线/文件缺）→ 复位允许下次唤醒重试，防永久降级合成音（team gemini #6）
          if (this.cueAudioBuffers.length === 0) this.cueLoadStarted = false;
        });
      }

      // 有预存人声 → 随机播 1 条（不连续重复上一条，降低重复感，需求2）
      if (this.cueAudioBuffers.length > 0) {
        let idx = Math.floor(Math.random() * this.cueAudioBuffers.length);
        if (this.cueAudioBuffers.length > 1 && idx === this.lastCueAudioIdx) {
          idx = (idx + 1) % this.cueAudioBuffers.length;
        }
        this.lastCueAudioIdx = idx;
        const src = ctx.createBufferSource();
        src.buffer = this.cueAudioBuffers[idx];
        const g = ctx.createGain();
        g.gain.value = 1;
        g.connect(ctx.destination);
        src.connect(g);
        src.start();
        return;
      }

      // 降级：预存人声未就绪 / 全缺 → 本地合成柔和上扬双音（叮-咚 E5→A5）
      const now = ctx.currentTime;
      const bus = ctx.createGain();
      bus.gain.value = 1;
      bus.connect(ctx.destination);
      const notes = [
        { f: 660, t: 0, d: 0.12 },
        { f: 880, t: 0.1, d: 0.18 },
      ];
      for (const n of notes) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = n.f;
        osc.connect(g);
        g.connect(bus);
        const start = now + n.t;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.linearRampToValueAtTime(0.16, start + 0.02); // 柔起
        g.gain.exponentialRampToValueAtTime(0.0008, start + n.d); // 柔落
        osc.start(start);
        osc.stop(start + n.d + 0.03);
      }
    } catch {
      /* 即时音失败不影响主流程 */
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

/**
 * 把一个 cue 文本切成「字幕行」：先按句末标点(。！？!?…)+换行切句；
 * 若单句仍很长(>22字，如一句含多逗号)再按逗号/顿号/分号切，使每行适合单屏显示。
 * 切行只为「长 cue 分行显示」，时间由调用方按字数比例分配到真实音频窗（不靠猜速度）。
 */
function splitCueLines(text: string): string[] {
  const clean = text.replace(/\n+/g, '\n').trim();
  if (!clean) return [];
  const enders = new Set(Array.from('。！？!?…\n'));
  const sub = new Set(Array.from('，、；,;'));
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    if (enders.has(clean[i])) {
      let j = i + 1;
      while (j < clean.length && enders.has(clean[j])) j++;
      const s = clean.slice(start, j).replace(/\n/g, '').trim();
      if (s) sentences.push(s);
      start = j;
      i = j - 1;
    }
  }
  const tail = clean.slice(start).replace(/\n/g, '').trim();
  if (tail) sentences.push(tail);

  const LONG = 22;
  const lines: string[] = [];
  for (const s of sentences) {
    if (s.length <= LONG) {
      lines.push(s);
      continue;
    }
    // 长句再按逗号切，但把过短碎片并回上一行，避免一行只有两三个字
    let seg = '';
    for (let i = 0; i < s.length; i++) {
      seg += s[i];
      if (sub.has(s[i]) && seg.length >= 8) {
        lines.push(seg);
        seg = '';
      }
    }
    if (seg) {
      if (seg.length < 6 && lines.length > 0) lines[lines.length - 1] += seg;
      else lines.push(seg);
    }
  }
  return lines.length ? lines : [clean];
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

// 需求2：本次页面会话 id（同一访问内稳定），StudioPage / TutorialManager 发 meta 共用，
// 便于后端按 session 去重 + 关联同一孩子的多条吐槽。
let kidsHubSessionId: string | null = null;
export function getKidsHubSessionId(): string {
  if (!kidsHubSessionId) {
    try {
      kidsHubSessionId = crypto.randomUUID();
    } catch {
      kidsHubSessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    }
  }
  return kidsHubSessionId;
}

/** 仅测试用：清掉单例（让 unit test 之间互不污染） */
export function __resetSharedVoiceClientForTesting(): void {
  sharedInstance?.close();
  sharedInstance = null;
}
