import { stripThink } from './providers/minimax-llm.js';
import { extractLlmStore, type ExtractProvider } from './extract-llm-store.js';

/**
 * 非流式 LLM 调用，给 memory / onboarding 抽取用。
 *
 * 取数优先级（2026-08-19 起）：
 *   1. 运营台配置（extract_llm_config 表，Worker Brain tab「记忆抽取 LLM」卡）——写入即热生效；
 *   2. 无配置/provider='inherit' → 按 LLM_PROVIDER 映射 env（历史行为）：
 *      - minimax  → api.minimaxi.com（reasoning 模型，content 内联 <think>，用 stripThink 剥离）
 *      - deepseek / race → api.deepseek.com（race 主路同源；2026-08-19 前 race 误落 gemini 死代理，
 *        抽取静默全灭数周，主对话被 doubao 兜底救着所以无人察觉）
 *      - 其它/默认 → GEMINI_PROXY_URL 代理
 * 任何失败返回 null（抽取是旁路，绝不阻断语音主链路）；失败必留痕（[llm-extract] 日志，不打内容）。
 */

export type ResolvedExtractLlm = {
  provider: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  model: string;
  extraBody: Record<string, unknown>;
  source: 'admin' | 'env';
};

/** provider → env 默认三元组（base_url/api_key/model + 附加 body）。 */
function envDefaults(provider: ExtractProvider | string): Omit<ResolvedExtractLlm, 'source' | 'provider'> {
  if (provider === 'minimax') {
    return {
      baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
      apiKey: process.env.MINIMAX_API_KEY,
      model: process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7-highspeed',
      extraBody: {},
    };
  }
  if (provider === 'deepseek') {
    return {
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      extraBody: { thinking: { type: 'disabled' } },
    };
  }
  if (provider === 'volc-ark') {
    return {
      baseUrl: process.env.VOLC_LLM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: process.env.VOLC_LLM_API_KEY,
      model: process.env.VOLC_LLM_MODEL ?? 'doubao-seed-2.0-lite',
      extraBody: {},
    };
  }
  // gemini-proxy / 未知
  return {
    baseUrl: process.env.GEMINI_PROXY_URL,
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_DEFAULT_MODEL ?? 'gemini-2.5-flash-lite',
    extraBody: {},
  };
}

/** 当前生效的抽取 LLM 配置（admin 配置优先 → env 回落）。导出供 admin 展示/测试端点复用。 */
export function resolveExtractLlm(): ResolvedExtractLlm {
  let admin = null;
  try {
    admin = extractLlmStore.get();
  } catch {
    /* 配置层异常不影响抽取（回落 env） */
  }
  if (admin && admin.provider !== 'inherit') {
    const base = envDefaults(admin.provider);
    return {
      provider: admin.provider,
      baseUrl: admin.base_url || base.baseUrl,
      apiKey: admin.api_key || base.apiKey,
      model: admin.model || base.model,
      extraBody: base.extraBody,
      source: 'admin',
    };
  }
  // inherit / 无配置：按主对话 LLM_PROVIDER 映射（race 归 deepseek——主路同源）
  const p = (process.env.LLM_PROVIDER || '').toLowerCase();
  const mapped = p === 'race' ? 'deepseek' : p === 'minimax' || p === 'deepseek' ? p : 'gemini-proxy';
  return { provider: mapped, ...envDefaults(mapped), source: 'env' };
}

export async function callExtractionLlm(
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number; configOverride?: ResolvedExtractLlm } = {},
): Promise<string | null> {
  const cfg = opts.configOverride ?? resolveExtractLlm();
  if (!cfg.baseUrl || !cfg.apiKey) {
    console.log(`[llm-extract] 配置不全: provider=${cfg.provider} source=${cfg.source} baseUrl=${cfg.baseUrl ? 'ok' : '缺'} key=${cfg.apiKey ? 'ok' : '缺'}`);
    return null;
  }
  const body: Record<string, unknown> = {
    stream: false,
    temperature: 0,
    max_tokens: opts.maxTokens ?? 512,
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...cfg.extraBody,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // 失败必留痕（2026-08-19）：抽取上游死透曾静默数周（回填 62 窗零写入才暴露）。只打状态不打内容。
      console.log(`[llm-extract] 上游非 2xx: ${res.status} provider=${cfg.provider} source=${cfg.source}`);
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    return content == null ? null : stripThink(content); // reasoning 模型剥离 <think>；无 think 时 no-op
  } catch (e) {
    console.log(`[llm-extract] 调用失败: ${(e as Error)?.name ?? 'Error'} provider=${cfg.provider} source=${cfg.source}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
