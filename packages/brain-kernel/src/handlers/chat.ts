import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatMessage } from '@evodesk/shared';
import { z } from 'zod';
import { getLlmConfig } from '../memory/memcell-extractor.js';
import { evaluateGates, buildGateInput } from '../flow/gates.js';
import { recentTasks } from '../memory/memory-db.js';
import { taskComplexity } from '../flow/task-complexity.js';
import {
  buildLlmMessages,
  ChatMessageSchema,
  fireAutoExtractAndPromote,
  fireRecordTask,
  getCurrentFlowState,
  jsonResponse,
  LLM_CHAT_TIMEOUT,
  parseJson,
  persistChatMessages,
  sseSend,
  sseStart,
  stripThinking,
  validateBody,
} from './_shared.js';

const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  sessionId: z.string().min(1),
  model: z.string().optional(),
  stream: z.boolean().optional(),
});

async function processChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await parseJson<unknown>(req);
  const body = validateBody(ChatRequestSchema, raw, res);
  if (!body) return;
  const llmConfig = getLlmConfig();

  if (!llmConfig) {
    jsonResponse(res, 503, { error: 'LLM not configured' });
    fireRecordTask(body.sessionId, body.messages.length, false);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_CHAT_TIMEOUT);

  let llmRes: Response;
  try {
    llmRes = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: body.model ?? llmConfig.model,
        messages: await buildLlmMessages(body.messages),
        max_tokens: llmConfig.maxTokens ?? 4096,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!llmRes.ok) {
    console.error(`[chat] LLM API ${llmRes.status}: ${(await llmRes.text()).slice(0, 500)}`);
    jsonResponse(res, 502, { error: `LLM request failed (${llmRes.status})` });
    fireRecordTask(body.sessionId, body.messages.length, false);
    return;
  }

  const json = await llmRes.json() as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const rawContent = json.choices[0]?.message?.content ?? '';
  const content = stripThinking(rawContent);
  const usage = json.usage;

  if (!content || content.trim().length === 0) {
    console.error('[chat] LLM returned empty content', JSON.stringify(json).slice(0, 300));
    jsonResponse(res, 502, { error: 'LLM returned empty response' });
    fireRecordTask(body.sessionId, body.messages.length, false);
    return;
  }

  const assistantMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant' as const,
    content,
    timestamp: Date.now(),
    sessionId: body.sessionId,
  };

  jsonResponse(res, 200, {
    message: assistantMsg,
    usage: {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    },
  });

  // 持久化：最后一条 user 消息 + assistant 回复
  persistChatMessages(body.sessionId, body.messages, assistantMsg);
  fireAutoExtractAndPromote(body.sessionId, body.messages, content);
  fireRecordTask(body.sessionId, body.messages.length, true, {
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
  });
}

async function processChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await parseJson<unknown>(req);
  const body = validateBody(ChatRequestSchema, raw, res);
  if (!body) return;
  const llmConfig = getLlmConfig();

  if (!llmConfig) {
    jsonResponse(res, 503, { error: 'LLM not configured' });
    fireRecordTask(body.sessionId, body.messages.length, false);
    return;
  }

  // Gates 门控检查
  let sseStarted = false;
  const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user');
  if (lastUserMsg) {
    const { state } = getCurrentFlowState();
    const tasks = recentTasks(5);
    const latestTask = tasks[0];
    const complexity = latestTask ? taskComplexity(latestTask) : 0;
    const gateInput = buildGateInput(lastUserMsg.content, complexity, state === 'APATHY');
    const gateResult = evaluateGates(gateInput);

    if (!gateResult.passed) {
      // 硬拦截：Safety/Abort 不通过
      sseStart(res);
      for (const msg of gateResult.blocked) {
        sseSend(res, { type: 'warning', content: msg, timestamp: Date.now() });
      }
      sseSend(res, { type: 'done', content: '', timestamp: Date.now() });
      res.end();
      fireRecordTask(body.sessionId, body.messages.length, false);
      return;
    }

    // 软警告：Complexity/Revision 仍继续，但发 warning
    if (gateResult.warnings.length > 0) {
      sseStart(res);
      sseStarted = true;
      for (const msg of gateResult.warnings) {
        sseSend(res, { type: 'warning', content: msg, timestamp: Date.now() });
      }
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_CHAT_TIMEOUT);

  // H3 修复：客户端断连时 abort 上游 LLM 流，释放资源
  req.on('close', () => controller.abort());
  res.on('close', () => controller.abort());

  let llmRes: Response;
  try {
    llmRes = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: body.model ?? llmConfig.model,
        messages: await buildLlmMessages(body.messages),
        max_tokens: llmConfig.maxTokens ?? 4096,
        temperature: 0.7,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeout);
    const msg = fetchErr instanceof Error ? fetchErr.message : 'Fetch failed';
    console.error(`[chat-stream] fetch error:`, msg);
    if (sseStarted) {
      sseSend(res, { type: 'error', content: msg, timestamp: Date.now() });
      sseSend(res, { type: 'done', content: '', timestamp: Date.now() });
      res.end();
    } else {
      jsonResponse(res, 502, { error: msg });
    }
    fireRecordTask(body.sessionId, body.messages.length, false);
    return;
  } finally {
    clearTimeout(timeout);
  }

  if (!llmRes.ok) {
    const errText = await llmRes.text().catch(() => '');
    console.error(`[chat-stream] LLM API ${llmRes.status}: ${errText.slice(0, 500)}`);
    if (sseStarted) {
      sseSend(res, { type: 'error', content: `LLM stream failed (${llmRes.status})`, timestamp: Date.now() });
      sseSend(res, { type: 'done', content: '', timestamp: Date.now() });
      res.end();
    } else {
      jsonResponse(res, 502, { error: `LLM stream failed (${llmRes.status})` });
    }
    fireRecordTask(body.sessionId, body.messages.length, false);
    return;
  }

  if (!sseStarted) sseStart(res);
  let fullContent = '';
  let streamFailed = false;

  const reader = (llmRes.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let thinkBuf = '';
  let inThinking = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const chunk = JSON.parse(payload) as {
            choices: { delta: { content?: string }; finish_reason?: string | null }[];
          };
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            fullContent += delta;

            // thinking 标签 buffer 拦截（跨 delta 安全）
            thinkBuf += delta;
            if (!inThinking && thinkBuf.includes('<think>')) {
              const before = thinkBuf.split('<think>')[0];
              if (before) sseSend(res, { type: 'text', content: before, timestamp: Date.now() });
              inThinking = true;
              thinkBuf = '';
            } else if (inThinking && thinkBuf.includes('</think>')) {
              const after = thinkBuf.split('</think>').slice(1).join('</think>');
              inThinking = false;
              thinkBuf = '';
              if (after) sseSend(res, { type: 'text', content: after, timestamp: Date.now() });
            } else if (!inThinking) {
              // 跨 delta 安全：检查 thinkBuf 是否以 '<' 开头（可能是不完整的 <think>）
              const TAG_PREFIX = '<think>';
              if (thinkBuf.startsWith('<') && TAG_PREFIX.startsWith(thinkBuf.slice(thinkBuf.lastIndexOf('<')))) {
                // 可能是 <think> 标签的前缀，继续缓冲不发送
              } else {
                sseSend(res, { type: 'text', content: thinkBuf, timestamp: Date.now() });
                thinkBuf = '';
              }
            }
            // inThinking=true 且未遇到 </think> → 继续缓冲，不发送
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } catch (err) {
    streamFailed = true;
    const msg = err instanceof Error ? err.message : 'Stream error';
    sseSend(res, { type: 'error', content: msg, timestamp: Date.now() });
  }

  // 空流也视为失败
  const hasContent = fullContent.trim().length > 0;
  if (!streamFailed && !hasContent) {
    streamFailed = true;
    sseSend(res, { type: 'error', content: 'LLM returned empty response', timestamp: Date.now() });
  }

  sseSend(res, { type: 'done', content: '', timestamp: Date.now() });
  res.end();

  // 只在有实际内容时持久化和提取（strip thinking 后存储）
  const cleanContent = stripThinking(fullContent);
  if (!streamFailed && cleanContent.length > 0) {
    const streamAssistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: cleanContent,
      timestamp: Date.now(),
      sessionId: body.sessionId,
    };
    persistChatMessages(body.sessionId, body.messages, streamAssistantMsg);
    fireAutoExtractAndPromote(body.sessionId, body.messages, cleanContent);
  }
  fireRecordTask(body.sessionId, body.messages.length, !streamFailed);
}

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (url === '/v1/chat' && method === 'POST') {
    await processChat(req, res);
    return true;
  }
  if (url === '/v1/chat/stream' && method === 'POST') {
    await processChatStream(req, res);
    return true;
  }
  return false;
}
