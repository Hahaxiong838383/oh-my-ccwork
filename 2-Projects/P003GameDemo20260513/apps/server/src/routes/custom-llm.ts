import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { FEEDBACK_PERSONA_SUFFIX } from '../prompts.js';
import { buildAiLiteracyGuide } from '../ai-literacy.js';
import { getDevicePromptConfig, buildDeviceBase, deviceAddendum, resolveDeviceIdentity } from '../device-brain-prompt.js';
import { assembleSystemPrompt, buildOnboardingGuide } from '../prompt-orchestrator.js';
import { curriculumKG } from '../curriculum-kg.js';
import { companionKG } from '../companion-kg.js';
import { createGeminiLlmClient, type ChatHistoryTurn } from '../providers/gemini-llm.js';
import { createDeepseekLlmClient } from '../providers/deepseek-llm.js';
import { createMinimaxLlmClient } from '../providers/minimax-llm.js';
import { createRaceLlmClient } from '../providers/race-llm.js';
import { verifyAuthToken } from '../auth-jwt.js';
import { profileStore, needsOnboarding } from '../profile-store.js';
import { extractOnboarding } from '../onboarding-extractor.js';
import { extractAndPersist } from '../memory-extractor.js';
import { conversationStore } from '../conversation-store.js';
import { createParenFilter } from '../paren-filter.js';
import { createExitMarkerStripper } from '../exit-intent.js';
import { buildKnowledgeRecall } from '../xiaoke-kb.js';
import { feedbackStore } from '../feedback-store.js';
import { consumeFeedbackArmed } from '../feedback-arm.js';
import { getPromptOverride } from '../rtc-prompt-override.js';

/**
 * 火山 RTC 实时对话「CustomLLM」回调端点（docs/34 D 方案）。
 *
 * 火山 AIGC-RTC Server 把 ASR 转出的文本 + 对话历史，以 **OpenAI ChatCompletion 格式** POST 到此端点，
 * 我们以 **SSE 流**（text/event-stream + data:[DONE]）返回小可的回复；火山再把文本送 TTS 播给孩子。
 * 即：火山只当「语音 I/O + 编排管道」，**小可的大脑（内置世界观 + AI 安全基座 + 课程护栏 + AI 启蒙 + 自己的 LLM）全留在这里**。
 *
 * 与 WS pipeline 复用同一套大脑常量/函数（ARK_WORLDVIEW_BASE / AI_SAFETY_BASELINE / assembleSystemPrompt /
 * curriculumKG / buildAiLiteracyGuide / streamChat），避免两条入口人设漂移。
 *
 * ⚠️ 待 docs/35 解决：会话 ↔ 记忆映射。火山回调默认不带我们的 accountId/session，
 *    故记忆注入(meta/auth)暂为 null（匿名 + 内置世界观）。落地时拟由 StartVoiceChat 给本端点 Url 带 token/query 透传身份。
 */
const customLlmRoute = new Hono();

type OpenAiMessage = { role: string; content: unknown };

/** OpenAI content 可能是 string 或 content-parts 数组；火山 ASR 出的是纯文本，这里兜底两种形态。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text ?? '')
          : '',
      )
      .join('');
  }
  return content == null ? '' : String(content);
}

customLlmRoute.post('/chat/completions', async (c) => {
  // 可选鉴权：配了 CUSTOM_LLM_API_KEY 就校验 Bearer（须与火山 CustomLLM.APIKey 一致）；未配则放行（本地验证方便）。
  const requiredKey = process.env.CUSTOM_LLM_API_KEY?.trim();
  if (requiredKey) {
    const auth = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!m || m[1]?.trim() !== requiredKey) {
      return c.json({ error: { message: 'unauthorized', type: 'invalid_request_error' } }, 401);
    }
  }

  let body: { messages?: OpenAiMessage[]; model?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: { message: 'invalid json body' } }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const chat = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const lastUserIdx = chat.map((m) => m.role).lastIndexOf('user');
  const userText = lastUserIdx >= 0 ? extractText(chat[lastUserIdx]!.content) : '';
  const history: ChatHistoryTurn[] = chat
    .slice(0, Math.max(lastUserIdx, 0))
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: extractText(m.content) }));

  // 复用与 WS pipeline 同一个大脑：内置世界观 + AI 安全基座 + 课程护栏 + AI 启蒙门控 + 尾部人设锚点。
  curriculumKG.load();
  const curriculumGuardrail = curriculumKG.buildGuardrail(userText);
  const aiLiteracyGuide = buildAiLiteracyGuide(userText);
  // 从回调 Url 的 ?token= 拿登录态 → accountId → 注入这个孩子的 profile 记忆（昵称/年龄/兴趣/近况/方舟经历）。
  // 无 token / 无效 token → authContext=null → 降级匿名（仅世界观，无个性化记忆）。
  // ?room=sn-<SN>-<ts>（rust worker 传）→ per-device 身份路由：按 SN 反查该设备 brain 账号（多设备防串号）。
  const authContext = resolveDeviceIdentity(
    await verifyAuthToken(c.req.query('token')),
    c.req.query('room'),
  );
  // per-device prompt 配置（Worker Brain 编辑 tab）：设备账号可 override 世界观 / 追加规则；
  // 非设备账号（Web 家长）/异常 → null → base 即默认世界观 + 安全基座（buildDeviceBase 与运营台预览同源）。
  const deviceCfg = authContext ? getDevicePromptConfig(authContext.accountId) : null;
  const base = buildDeviceBase(deviceCfg);
  const profile = authContext ? profileStore.getProfile(authContext.accountId) : null;
  // 工作台「实时对话」双模式（?session=roomId）：用工作台调好的 composed prompt 作 systemPrompt，看 prompt 真实效果。
  // 它自带变量/世界观/场景，故不叠加记忆/onboarding/召回，也不触发 onboarding 抽取（不污染真实 profile）。
  const overridePrompt = getPromptOverride(c.req.query('session'));
  // 吐槽模式（docs/37）：前端点「我要吐槽」arm 过 → 本轮一次性消费走吐槽（落反馈库 + 吐槽人格回应）。
  // 吐槽优先：不走 onboarding 引导、不召回世界观，专注接住孩子的吐槽。
  const isFeedback = authContext ? consumeFeedbackArmed(authContext.accountId) : false;
  const inOnboarding = !overridePrompt && !isFeedback && Boolean(authContext) && needsOnboarding(profile);
  const onboardingGuide = inOnboarding ? buildOnboardingGuide(profile) : null;
  // 世界观知识按需召回（xiaoke-kb，对齐 pipeline）：孩子本轮聊到经济/身世/藏品/生态缸/夜航等才召回；吐槽/override 时不召回。
  const knowledgeRecall = (overridePrompt || isFeedback) ? null : buildKnowledgeRecall(userText);
  // L_companion（对齐 pipeline 的互斥链 K12>AI 启蒙>companion）：RTC 回调无 interim 预热条件 → allowSync
  // 同步算 query 向量（超时上限 400ms，超时/失败降级不注入）。override/吐槽轮不注入。真机验收 2026-07-13 补挂。
  const companionGuardrail = (overridePrompt || isFeedback || curriculumGuardrail || aiLiteracyGuide)
    ? null
    : await companionKG.buildGuardrail(userText, true);
  console.log(`[custom-llm] ${authContext ? '记忆注入 account=' + authContext.accountId : '匿名（无 token）'}${overridePrompt ? ' [override]' : ''}${isFeedback ? ' [feedback]' : ''}${inOnboarding ? ' [onboarding]' : ''}${knowledgeRecall ? ' [kb]' : ''}`);
  // override（工作台调的 prompt）优先：直接用它（自带完整内容）；否则走固定大脑组装。
  let systemPrompt = overridePrompt
    ? overridePrompt
    : assembleSystemPrompt(base, null, authContext, curriculumGuardrail, aiLiteracyGuide, onboardingGuide, knowledgeRecall, companionGuardrail);
  // per-device 附加规则（Worker Brain 编辑 tab）：拼在护栏之后（吐槽后缀仍保持绝对最末）。
  const addendumText = overridePrompt ? '' : deviceAddendum(deviceCfg);
  if (addendumText) systemPrompt += `\n\n${addendumText}`;
  // 吐槽人格放 systemPrompt 最末尾（近因效应，docs/36 同源）：否则被世界观 + 用户字面意图(如"想听故事")盖过，LLM 会去满足请求而非收集吐槽。
  if (isFeedback) systemPrompt += `\n\n${FEEDBACK_PERSONA_SUFFIX}`;
  // 吐槽落库（复用 feedbackStore，进 admin/家长端同一反馈看板；try-catch 不阻断回应）。
  if (isFeedback && authContext && userText.trim()) {
    try {
      feedbackStore.add({
        session_id: authContext.accountId, // RTC 无 WS sessionId，用 accountId（30s 内同 account+text 去重）
        turn_id: Math.floor(Date.now() / 1000), // RTC 无轮次，用秒级时间戳
        source: 'rtc',
        nickname: profile?.nickname ?? '',
        gender: profile?.gender ?? '',
        age: '',
        scene_id: null,
        text: userText,
        ip_hash: '',
        account_id: authContext.accountId,
      });
      console.log(`[custom-llm][feedback] 落库 account=${authContext.accountId} text=${userText.slice(0, 30)}`);
    } catch (e) {
      console.log(`[custom-llm][feedback] 落库失败(不阻断): ${(e as Error)?.message ?? e}`);
    }
  }
  if (inOnboarding && authContext) {
    const convo = [...history, { role: 'user' as const, content: userText }];
    void extractOnboarding(convo, profile)
      .then((patch) => {
        if (patch) {
          console.log(`[custom-llm][onboarding] account=${authContext.accountId} patch=${JSON.stringify(patch)}`);
          profileStore.upsertBasics(authContext.accountId, patch);
        }
      })
      .catch(() => {});
  }

  const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
  const llm =
    provider === 'race'
      ? createRaceLlmClient()
      : provider === 'minimax'
        ? createMinimaxLlmClient()
        : provider === 'deepseek'
          ? createDeepseekLlmClient()
          : createGeminiLlmClient();

  const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? 'xiaoke-ark';

  return streamSSE(c, async (stream) => {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

    // 串行写出，保证 SSE chunk 顺序（writeSSE 是 async，并发写会乱序）。
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = (data: string): void => {
      chain = chain.then(() => stream.writeSSE({ data }));
    };

    // Phase 1(docs/43 §8 F1):RTC 链路补齐对话落库 + 画像/情景记忆抽取——此前只有 WS 链路有,
    // 手机端 /m 的对话既无审计历史也无记忆抽取。累积 assistant 全文,onDone 后 fire-and-forget。
    let assistantText = '';
    const persistTurn = (): void => {
      if (!authContext || overridePrompt || isFeedback) return; // override/吐槽不落库不抽取(不污染真实 profile)
      const finalAssistant = assistantText.trim();
      try {
        conversationStore.add({ account_id: authContext.accountId, session_id: 'rtc', role: 'user', text: userText });
        if (finalAssistant) {
          conversationStore.add({ account_id: authContext.accountId, session_id: 'rtc', role: 'assistant', text: finalAssistant });
        }
      } catch { /* 审计落库失败不阻断 */ }
      if (!finalAssistant || process.env.MEMORY_EXTRACT_ENABLED === '0') return;
      const full = [...history, { role: 'user' as const, content: userText }, { role: 'assistant' as const, content: finalAssistant }];
      const userTurns = full.filter((t) => t.role === 'user').length;
      // 抽取节流分场景（2026-08-19）：设备房(role=device)每轮都抽——唤醒式交互以 1-2 轮短会话为主,
      // %3 取模下几乎永不触发(当日实证建档后三场会话全漏);UNIQUE(account,type,content) 去重兜滑窗重叠,幂等。
      // web RTC(/m 手机端)保持每 3 轮(长会话为主,省调用;末尾 ≤2 轮漏抽窗口是已知局限,docs/43 §8 G2)。
      const everyTurns = authContext.role === 'device' ? 1 : 3;
      if (userTurns % everyTurns === 0) {
        void extractAndPersist(authContext.accountId, full.slice(-6), 'rtc');
      }
    };

    // 括号旁白硬防线(paren-filter,2026-07-03):LLM 输出"（挠了挠头）"类状态机旁白会被火山
    // TTS 原样念出——prompt 禁令压不死,这里在流上剥净(字幕/TTS/记忆抽取都吃干净文本)。
    const parenFilter = createParenFilter();
    // [EXIT] 标记剥离(2026-07-03 生产 E2E 抓到):RTC 链路此前没接(只 WS 有),LLM 输出
    // "[EXIT]再见"会被火山 TTS 念出"EXIT"。RTC 退出走火山自己的挂断,标记剥掉即可。
    const exitStripper = createExitMarkerStripper();

    // OpenAI 规范：首 chunk 带 delta.role=assistant。
    enqueue(chunk({ role: 'assistant', content: '' }, null));
    try {
      await llm.streamChat({
        systemPrompt,
        userText,
        history,
        onDelta: (delta) => {
          const clean = parenFilter.feed(exitStripper.feed(delta).text); // EXIT → 括号 两级串联
          if (!clean) return; // 整个 delta 都在过滤器扣留中
          assistantText += clean;
          enqueue(chunk({ content: clean }, null));
        },
        onDone: () => {
          // 两级过滤器收尾:EXIT 残余 → 括号 feed,再括号 flush(未闭合原样放行,绝不吞正文)
          const tail = parenFilter.feed(exitStripper.flush().text) + parenFilter.flush();
          if (tail) {
            assistantText += tail;
            enqueue(chunk({ content: tail }, null));
          }
          enqueue(chunk({}, 'stop'));
          persistTurn();
        },
        onError: (err) => enqueue(chunk({ content: `（小可有点累了：${err.message}）` }, 'stop')),
      });
    } catch (err) {
      enqueue(chunk({ content: `（小可暂时连不上大脑：${(err as Error)?.message ?? err}）` }, 'stop'));
    }
    enqueue('[DONE]'); // 火山要求的终止符
    await chain;
  });
});

export { customLlmRoute };
