import { createHash, randomBytes } from 'node:crypto';
import type WebSocket from 'ws';
import { feedbackStore } from './feedback-store.js';
import { conversationStore } from './conversation-store.js';
import type { AuthContext } from './auth-jwt.js';
import { createGeminiLlmClient, type GeminiLlmClient, type ChatHistoryTurn } from './providers/gemini-llm.js';
import { createDeepseekLlmClient } from './providers/deepseek-llm.js';
import { createVolcAsrClient, type VolcAsrClient } from './providers/volc-asr.js';
import { createVolcTtsClient, type VolcTtsClient } from './providers/volc-tts.js';
import { createExpressionFilter, stripExpressionTags } from './expression-filter.js';
import { assembleSystemPrompt } from './prompt-orchestrator.js';
import { profileStore } from './profile-store.js';
import { extractMemoryUpdate } from './memory-extractor.js';
import { curriculumKG } from './curriculum-kg.js';
import { buildAiLiteracyGuide, AI_SAFETY_BASELINE } from './ai-literacy.js';

export type SessionMeta = {
  sessionId: string;
  sceneId: string | null;
  nickname: string;
  gender: string;
  age: string;
  tutorialUnitId?: string;
  captureMode: 'feedback' | 'off';
  source: 'card' | 'tutorial';
};

export type ClientMessage =
  | { type: 'session.start'; sampleRate: number }
  | { type: 'audio.chunk'; pcm16: ArrayBuffer }
  | { type: 'audio.end' }
  | { type: 'barge.in' }
  | { type: 'tts.say'; text: string }
  | { type: 'session.config'; systemPrompt: string }
  | { type: 'session.meta'; meta: SessionMeta }
  // 文本直入 LLM 管线（绕过 ASR）：工作台开场触发指令用，走完整 LLM→TTS 流
  | { type: 'chat.trigger'; text: string };

export type ServerMessage =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done'; text: string }
  | { type: 'tts.turn_start'; turn: number }
  | { type: 'tts.turn_discard'; upTo: number }
  // sentenceIndex：本 chunk 所属句（来自 Doubao 350/351 句边界，turn 内 0 起）。前端据此把音频段绑定到 cue 时间窗。
  | { type: 'tts.audio'; mp3Base64: string; turn: number; sentenceIndex: number }
  // 句级 cue（电影字幕）：Doubao event 350 在该句音频前到达，带该句权威文本。前端按 index 建 cueMap。
  | { type: 'tts.cue'; turn: number; index: number; text: string }
  | { type: 'tts.sentence_break'; turn: number }
  | { type: 'tts.end'; turn?: number }
  | { type: 'session.config.ack'; chars: number }
  | { type: 'debug.prompt_assembled'; systemPrompt: string; userText: string }
  // LLM 每句开头用【表情：xxx】（多标记句级），server 按出现顺序解析并带 index（turn 内 0 起）
  | { type: 'avatar.expression'; name: string; index: number }
  | { type: 'error'; code: string; message: string };

const DEFAULT_SYSTEM_PROMPT =
  '你是儿童陪伴机器人小可（K1）。用户是 5-12 岁孩子，叫他"指挥官"。语气温暖、活泼、有耐心。' +
  '日常聊天保持简短自然（30-50 字）；如果指挥官请你讲故事、科普知识、详细解释，可以讲完整（200-500 字，分段叙述）。' +
  '不要刻意凑字数，自然就好。';

// 需求1（川哥 2026-06-13）：吐槽模式人格后缀。captureMode='feedback' 时追加在场景 prompt 后，
// 让小可对孩子的吐槽/建议共情+感谢+不过度承诺（对齐 card5「KidsHub 情绪回应」四正面态口径）。
const FEEDBACK_PERSONA_SUFFIX =
  '【KidsHub 吐槽模式】指挥官刚刚分享了一个吐槽 / 建议 / 想法，你现在要以"认真倾听并回应孩子心声"的小可身份回应：' +
  '先真诚感谢、用夸奖或共情肯定他愿意说出来，让他感到被重视；再明确告诉他——这个点子已经被收进 KidsHub，' +
  '我们都会认真看、会想办法去改进或实现。严禁过度承诺：绝不能说"马上改""一定改""明天就做出来"这类无法兑现的话，' +
  '只说"我们会认真看 + 努力想办法"。反馈口径仅限四个正面态：已收到 / 评估中 / 已采纳 / 进金点子库。' +
  '语气温暖童趣、口语化，每次回复 30-50 字。可顺势鼓励"还有别的想法也继续告诉我哦"。';
const FEEDBACK_IP_SALT = process.env.FEEDBACK_IP_SALT?.trim() || randomBytes(16).toString('hex');

// P0.1 L0 会话记忆：保留最近 N 轮（user+assistant）滑动窗口，防 prompt 膨胀拖 TTFT。
// 仅会话级（VoicePipeline 实例成员），连接断开即丢、不跨会话（这是 L0 Working Memory；
// 跨会话画像是 L1，走 profile-store 注入，见 docs/18 P0.2）。
const MAX_HISTORY_TURNS = 8;
// P0.1 字符预算（team #5）：长回复（讲故事 200-500 字）累积会拖 TTFT / 触发网关上下文超限。
// 轮数之外再设总字符上限，超限按轮（user+assistant）丢最旧。儿童对话短，3000 字符约覆盖近几轮。
const MAX_HISTORY_CHARS = 3000;
// P1.2 每累积 N 轮对话，异步抽取一次画像更新写 profile-store（出主链路，仅登录用户）。
const EXTRACT_EVERY_TURNS = 3;

export class VoicePipeline {
  private readonly ws: WebSocket;
  private readonly ipHash: string;
  private asr: VolcAsrClient | null = null;
  private tts: VolcTtsClient | null = null;
  private readonly llm: GeminiLlmClient & { abort?: () => void };
  private activeTurn = 0;
  private feedbackTurnId = 0;
  // P0.1 L0 会话记忆：本连接多轮对话滑动窗口（最近 MAX_HISTORY_TURNS 轮 user+assistant）。
  private history: ChatHistoryTurn[] = [];
  // P1.2 距上次画像抽取的轮数计数（每 EXTRACT_EVERY_TURNS 轮触发一次异步抽取）。
  private turnsSinceExtract = 0;
  // KidsHub-AI 工作台下发的完整 system prompt（组装在前端做，server 只存只用）
  private sessionSystemPrompt: string | null = null;
  private sessionMeta: SessionMeta | null = null;
  // 需求1 修复（grok CRITICAL）：audio.end 时快照本轮 meta，防 ASR 异步 final 期间
  // sessionMeta 被新 sendSessionMeta 覆盖（吐槽漏落库 / 人格用错）。onFinal 落库+人格都用此快照。
  // sessionMeta 整体替换不 mutate，引用快照即冻结本轮值。
  private capturedTurnMeta: SessionMeta | null = null;
  // Step 4：WS 握手鉴权后的身份（邀请码登录用户）。匿名连接为 null，feedback 落库带 account_id 用。
  private readonly authContext: AuthContext | null;

  constructor(ws: WebSocket, clientIp: string, authContext: AuthContext | null = null) {
    this.ws = ws;
    this.ipHash = hashIp(clientIp);
    this.authContext = authContext;
    // 按 LLM_PROVIDER 工厂切换：'deepseek' 走 DeepSeek 官方（个人站部署），默认 gemini（公司侧零影响）
    const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
    const rawClient = provider === 'deepseek' ? createDeepseekLlmClient() : createGeminiLlmClient();
    this.llm = rawClient as GeminiLlmClient & { abort?: () => void };
    // L_curriculum：连接时预热 KG（幂等，读 ~4MB JSON）。避免首个 ASR final 时才同步加载拖 TTFT。
    curriculumKG.load();
  }

  handleClientMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case 'session.start':
        this.startAsr(msg.sampleRate);
        return;
      case 'audio.chunk':
        if (!this.asr) {
          this.sendError('ASR_NOT_READY', 'ASR 未启动');
          return;
        }
        this.asr.feed(Buffer.from(msg.pcm16));
        return;
      case 'audio.end':
        // 快照本轮 meta（冻结此刻 captureMode/sessionId/nickname/sceneId），ASR final 异步到达时用它
        this.capturedTurnMeta = this.sessionMeta;
        this.asr?.finishAudio();
        return;
      case 'barge.in':
        this.bargein();
        this.send({ type: 'tts.turn_discard', upTo: this.activeTurn - 1 });
        return;
      case 'tts.say':
        console.log('[pipeline] tts.say received:', msg.text.slice(0, 30));
        this.speakDirect(msg.text);
        return;
      case 'session.config':
        this.sessionSystemPrompt = msg.systemPrompt;
        this.send({ type: 'session.config.ack', chars: msg.systemPrompt.length });
        return;
      case 'session.meta':
        this.sessionMeta = msg.meta;
        return;
      case 'chat.trigger':
        console.log('[pipeline] chat.trigger received:', msg.text.slice(0, 30));
        // 开场白/触发指令恒用普通人格（card 切换 captureMode 永远 off，不该吐槽人格）
        this.startLlmAndTts(msg.text, false, this.sessionMeta);
        return;
      default:
        this.sendError('BAD_MESSAGE', '未知客户端消息');
    }
  }

  bargein(): void {
    this.activeTurn += 1;

    if (typeof this.llm.abort === 'function') {
      this.llm.abort();
    }

    if (this.tts) {
      this.tts.close();
      this.tts = null;
    }
  }

  close(): void {
    this.bargein();
    this.asr?.close();
    this.asr = null;
  }

  private async startAsr(sampleRate: number): Promise<void> {
    try {
      this.asr?.close();
      this.asr = createVolcAsrClient();
      await this.asr.start({
        sampleRate,
        onPartial: (text) => {
          this.send({ type: 'asr.partial', text });
        },
        onFinal: (text) => {
          this.send({ type: 'asr.final', text });
          this.captureConversation('user', text, this.capturedTurnMeta ?? this.sessionMeta);
          this.maybeCaptureUserInput(text);
          if (text.trim()) {
            // ASR 路径吐槽人格用本轮快照判定（与落库一致），不读可能已被覆盖的 sessionMeta
            const turnMeta = this.capturedTurnMeta ?? this.sessionMeta;
            const isFeedback = turnMeta?.captureMode === 'feedback';
            this.startLlmAndTts(text, isFeedback, turnMeta);
          } else {
            // 用户没说话 → 立刻发 tts.end，让 client 重置 voiceStatus 到 idle
            this.send({ type: 'tts.end' });
          }
        },
        onError: (err) => {
          this.sendError('ASR_ERROR', err.message);
        },
      });
    } catch (err) {
      this.sendError('ASR_START_FAILED', toError(err).message);
    }
  }

  private maybeCaptureUserInput(text: string): void {
    const finalText = text.trim();
    if (!finalText) return;

    // 用本轮快照（audio.end 冻结），不受 ASR 异步 final 期间 sessionMeta 被覆盖影响
    const meta = this.capturedTurnMeta ?? this.sessionMeta;
    if (meta?.captureMode !== 'feedback') {
      console.log('[feedback] capture_skip', { captureMode: meta?.captureMode ?? 'off' });
      return;
    }

    try {
      const item = feedbackStore.add({
        session_id: meta.sessionId,
        turn_id: ++this.feedbackTurnId,
        source: meta.source,
        nickname: meta.nickname,
        gender: meta.gender,
        age: meta.age,
        scene_id: meta.sceneId,
        text: finalText,
        ip_hash: this.ipHash,
        account_id: this.authContext?.accountId ?? null,
      });
      console.log('[feedback] capture_ok', { sceneId: item.scene_id, len: item.text.length });
    } catch (err) {
      console.error('[feedback] capture_fail', {
        sessionId: meta.sessionId,
        message: toError(err).message,
      });
    }
  }

  private captureConversation(role: 'user' | 'assistant', text: string, meta: SessionMeta | null, tokens = 0): void {
    const finalText = text.trim();
    if (!finalText || !meta) return;

    try {
      conversationStore.add({
        account_id: this.authContext?.accountId ?? null,
        session_id: meta.sessionId,
        role,
        text: finalText,
        tokens,
      });
    } catch (err) {
      console.error('[conversation] capture_fail', {
        sessionId: meta.sessionId,
        role,
        message: toError(err).message,
      });
    }
  }

  private async startLlmAndTts(userText: string, feedbackMode: boolean, turnMeta: SessionMeta | null): Promise<void> {
    const finalText = userText.trim();
    if (!finalText) return;

    this.bargein();
    const turn = this.activeTurn;
    let endSent = false;
    this.send({ type: 'tts.turn_start', turn });

    // 整个流程任何环节失败都必须发 tts.end，前端不能卡 thinking
    const ensureEnd = () => {
      if (endSent || turn !== this.activeTurn) return;
      endSent = true;
      this.send({ type: 'tts.end', turn });
    };

    try {
      // 错误后断开 TTS 输入流并防止 onAudio 继续吐音频包（codex P1 finding）
      const closeTtsAfterError = () => {
        if (this.tts) {
          this.tts.close();
          this.tts = null;
        }
      };

      // 句级 cue（电影字幕）：Doubao 350 句开始信号带文本，在该句音频前到达。
      // currentSentenceIndex 标记后续 audio 归属哪句；前端据此把段绑定到 cue 时间窗。
      let currentSentenceIndex = -1;
      try {
        this.tts = createVolcTtsClient();
        await this.tts.start({
          onSentenceStart: (text) => {
            if (turn !== this.activeTurn || endSent) return;
            currentSentenceIndex += 1;
            this.send({ type: 'tts.cue', turn, index: currentSentenceIndex, text });
          },
          onAudio: (chunk) => {
            if (turn !== this.activeTurn || endSent) return;
            // sentenceIndex<0 兜底成 0：极少数 audio 早于首个 350 到达时归第 0 句
            const sentenceIndex = currentSentenceIndex < 0 ? 0 : currentSentenceIndex;
            this.send({ type: 'tts.audio', mp3Base64: chunk.toString('base64'), turn, sentenceIndex });
          },
          onSentenceBreak: () => {
            // 句末标点信号 → 让客户端 flush 当前段播放，实现字幕与 TTS 同步
            if (turn !== this.activeTurn || endSent) return;
            this.send({ type: 'tts.sentence_break', turn });
          },
          onSentenceEnd: () => {
            if (turn !== this.activeTurn) return;
            if (endSent) return;
            endSent = true;
            this.send({ type: 'tts.end', turn });
          },
          onError: (err) => {
            this.sendError('TTS_ERROR', err.message);
            ensureEnd();
            closeTtsAfterError();
          },
        });
      } catch (err) {
        this.sendError('TTS_START_FAILED', toError(err).message);
        this.tts = null;
        ensureEnd();
        return;
      }

      // 需求1：吐槽模式 → 追加吐槽回应人格（共情+感谢+不过度承诺）。feedbackMode 由调用方传入：
      // ASR 路径用本轮快照(capturedTurnMeta)判定，chat.trigger 开场白恒 false。普通对话维持原 prompt。
      // AI 启蒙双层「常驻层」(docs/22 §9)：身份安全红线拼在 base(session/default 人格都带)，
      // 兜底门控漏判 / 多轮闪烁 / KV-cache(team 四发共识)；静态文本不破坏 assembleSystemPrompt 的门控 baseline。
      const baseSystemPrompt = `${this.sessionSystemPrompt ?? DEFAULT_SYSTEM_PROMPT}\n\n${AI_SAFETY_BASELINE}`;
      const withFeedback = feedbackMode
        ? `${baseSystemPrompt}\n\n${FEEDBACK_PERSONA_SUFFIX}`
        : baseSystemPrompt;
      // P0.2 后端 Prompt Orchestrator：追加「关于这个孩子」user_memory 区块（登录用 profile-store
      // 权威，匿名用本轮 meta）。下方 debug.prompt_assembled 会回发含此块的完整 prompt（所见即所发）。
      // L_curriculum（docs/20）：内存匹配孩子话里的课程概念（<10ms，不拖 TTFT），命中则注入先修护栏。
      const curriculumGuardrail = curriculumKG.buildGuardrail(finalText);
      // AI 启蒙双层「门控层」(docs/22 §9)：命中 AI 话题才注入生动启蒙引导；闲聊返 null 不注入、不稀释人格。
      const aiLiteracyGuide = buildAiLiteracyGuide(finalText);
      const systemPrompt = assembleSystemPrompt(withFeedback, turnMeta, this.authContext, curriculumGuardrail, aiLiteracyGuide);
      // 工作台调试流依赖：回发本轮真实使用的 prompt（所见即所发）
      this.send({ type: 'debug.prompt_assembled', systemPrompt, userText: finalText });

      // 句级多标记：每 feed/flush 可能返回多个 expressions，按本轮 turn 累加 index 发 avatar.expression
      const exprFilter = createExpressionFilter();
      let exprIndex = 0;
      const emitFiltered = (piece: { text: string; expressions: string[] }) => {
        for (const name of piece.expressions) {
          this.send({ type: 'avatar.expression', name, index: exprIndex++ });
        }
        if (piece.text) {
          this.send({ type: 'llm.delta', text: piece.text });
          this.tts?.feed(piece.text);
        }
      };

      await this.llm.streamChat({
        systemPrompt,
        userText: finalText,
        history: this.history,
        onDelta: (delta) => {
          if (turn !== this.activeTurn) return;
          emitFiltered(exprFilter.feed(delta));
        },
        onDone: (fullText, usage) => {
          if (turn !== this.activeTurn) return;
          // 兜底：整条回复只有标记/标记未闭合时，缓冲区剩余在这里放行
          emitFiltered(exprFilter.flush());
          const assistantText = stripExpressionTags(fullText).text;
          this.captureConversation('assistant', assistantText, turnMeta, usage?.totalTokens ?? 0);
          // P0.1 本轮入会话历史（user + assistant），滑动窗口裁最近 MAX_HISTORY_TURNS 轮。
          // 用 strip 后的干净文本；只在本轮有效（turn===activeTurn，被打断的轮不入队）。
          // TODO(P1)：chat.trigger 开场白/feedback 吐槽轮的 userText 非孩子真实语音，是否计入待优化。
          this.history.push({ role: 'user', content: finalText });
          this.history.push({ role: 'assistant', content: assistantText });
          // 轮数裁剪
          if (this.history.length > MAX_HISTORY_TURNS * 2) {
            this.history = this.history.slice(-MAX_HISTORY_TURNS * 2);
          }
          // 字符预算裁剪（team #5）：超总字符上限则按轮丢最旧，防长回复累积拖 TTFT / 网关超限。
          let histChars = this.history.reduce((n, t) => n + t.content.length, 0);
          while (this.history.length > 2 && histChars > MAX_HISTORY_CHARS) {
            const dropped = this.history.splice(0, 2);
            histChars -= dropped.reduce((n, t) => n + t.content.length, 0);
          }
          // P1.2 每 N 轮异步抽取画像写 profile-store（出主链路 fire-and-forget，失败不影响语音）。
          // 仅登录用户（有持久档案）；改名/兴趣等更新落真相源 → admin/体验台多端打通。
          this.turnsSinceExtract += 1;
          const acctId = this.authContext?.accountId;
          // 隐私/应急开关（team）：MEMORY_EXTRACT_ENABLED=0 可关抽取（正式版合规未就位时兜底）。默认开。
          const extractOn = process.env.MEMORY_EXTRACT_ENABLED !== '0';
          if (acctId && extractOn && this.turnsSinceExtract >= EXTRACT_EVERY_TURNS) {
            this.turnsSinceExtract = 0;
            const snapshot = this.history.slice(-EXTRACT_EVERY_TURNS * 2);
            void (async () => {
              try {
                const current = profileStore.getProfile(acctId);
                if (!current) return; // 没建档不抽（建档是家长端的事）
                const patch = await extractMemoryUpdate(snapshot, current);
                if (patch) {
                  profileStore.updateMemoryFields(acctId, patch);
                  console.log(`[memory] account=${acctId} 画像更新: ${Object.keys(patch).join(',')}`);
                }
              } catch (err) {
                console.log('[memory] 抽取失败(不影响语音):', String((err as Error)?.message ?? err));
              }
            })();
          }
          this.send({ type: 'llm.done', text: assistantText });
          this.tts?.finish();
        },
        onError: (err) => {
          this.sendError('LLM_ERROR', err.message);
          ensureEnd();
          closeTtsAfterError();
        },
      });
    } catch (err) {
      // streamChat 同步 throw（如 env 缺失）走这里，避免 unhandled rejection
      this.sendError('LLM_FATAL', toError(err).message);
      ensureEnd();
      if (this.tts) {
        this.tts.close();
        this.tts = null;
      }
    }
  }

  private async speakDirect(text: string): Promise<void> {
    const finalText = text.trim();
    if (!finalText) {
      this.send({ type: 'tts.end' });
      return;
    }

    // 先中断正在进行的会话，避免语音叠加
    this.bargein();
    const turn = this.activeTurn;
    let endSent = false;
    this.send({ type: 'tts.turn_start', turn });

    const ensureEnd = () => {
      if (endSent || turn !== this.activeTurn) return;
      endSent = true;
      this.send({ type: 'tts.end', turn });
    };

    const closeTtsAfterError = () => {
      if (this.tts) {
        this.tts.close();
        this.tts = null;
      }
    };

    let currentSentenceIndex = -1;
    try {
      if (!this.tts) {
        this.tts = createVolcTtsClient();
      }
      await this.tts.start({
        onSentenceStart: (text) => {
          if (turn !== this.activeTurn || endSent) return;
          currentSentenceIndex += 1;
          this.send({ type: 'tts.cue', turn, index: currentSentenceIndex, text });
        },
        onAudio: (chunk) => {
          if (turn !== this.activeTurn || endSent) return;
          const sentenceIndex = currentSentenceIndex < 0 ? 0 : currentSentenceIndex;
          this.send({ type: 'tts.audio', mp3Base64: chunk.toString('base64'), turn, sentenceIndex });
        },
        onSentenceBreak: () => {
          if (turn !== this.activeTurn || endSent) return;
          this.send({ type: 'tts.sentence_break', turn });
        },
        onSentenceEnd: () => {
          if (turn !== this.activeTurn || endSent) return;
          endSent = true;
          this.send({ type: 'tts.end', turn });
        },
        onError: (err) => {
          this.sendError('TTS_ERROR', err.message);
          ensureEnd();
          closeTtsAfterError();
        },
      });
    } catch (err) {
      this.sendError('TTS_START_FAILED', toError(err).message);
      this.tts = null;
      ensureEnd();
      return;
    }

    this.tts.feed(finalText);
    this.tts.finish();
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  }

  private sendError(code: string, message: string): void {
    this.send({ type: 'error', code, message });
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function hashIp(ip: string): string {
  return createHash('sha256')
    .update(`${FEEDBACK_IP_SALT}${ip}`)
    .digest('hex');
}
