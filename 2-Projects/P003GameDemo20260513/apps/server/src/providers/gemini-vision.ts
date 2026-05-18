import { z } from 'zod';

// D6 P1 速度优化：thinking 模型（gemini-3-flash-preview）reasoning_tokens=112
// 吃掉大半延迟（实测 4-7s）→ 改非 thinking 的 2.5-flash（p95 <1.5s）。
// 跟 LLM (gemini-llm.ts, gemini-3.1-flash-lite-preview) 物理隔离的两个 provider，
// 改这个不影响小可对话 LLM 智商。
const MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 5000;

// D6 P1 hotfix v2：实测 Gemini 对自然状态人脸偏 neutral/no_face，导致 demo
// 几乎拿不到 happy/curious/tired → 无前缀。改 prompt"偏向找表情"。
const VISION_PROMPT = `请观察这张照片中人脸的表情，从以下标签里挑一个**最贴近的**：

- happy   嘴角上扬 / 微笑 / 大笑 / 表情轻松愉快
- tired   闭眼 / 打哈欠 / 眼袋重 / 表情倦怠 / 揉眼
- curious 睁大眼睛 / 抬眉 / 嘴微张 / 专注盯着什么 / 惊讶
- neutral 面部完全放松、眉眼嘴都没动作
- no_face 画面里完全没有人脸（拍到天花板、桌面、墙壁、衣服等）

**重要规则**：
1. 只要画面里能看到任何一张人脸（不论年龄、性别、距离、角度），就**优先**在 happy/tired/curious/neutral 4 个里选。
2. 哪怕表情很轻微（嘴角微翘 / 眼睛微眯 / 略抬眉），也尽量归到 happy/tired/curious 中**最贴近的一个**。
3. 只有四个表情标签**都明显不符**时才用 neutral。
4. 只有画面**完全没有人脸**时才用 no_face。

返回 JSON：{"label": "<标签>", "confidence": <0.0-1.0>}
confidence 反映你对标签的把握度。
只返回 JSON，不要其他内容、解释或代码块标记。`;

const LabelSchema = z.enum(['happy', 'tired', 'curious', 'neutral', 'no_face']);
const VisionOutSchema = z.object({
  label: LabelSchema,
  confidence: z.number().min(0).max(1),
});

type VisionOut = z.infer<typeof VisionOutSchema>;

const FALLBACK: VisionOut = { label: 'no_face', confidence: 0 };

export async function geminiVisionDetect(jpegBase64: string): Promise<VisionOut> {
  const proxyUrl = process.env.GEMINI_PROXY_URL;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!proxyUrl || !apiKey) {
    throw new Error('GEMINI_PROXY_URL / GEMINI_API_KEY 未配置');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${proxyUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        temperature: 0,
        max_tokens: 4096,
        // Vertex 原生关 thinking：thinking_budget=0 完全禁用 reasoning。
        // 代理 400 报错明示：reasoning_effort 和 thinking_config 不能同时传，
        // 此处只保留 thinking_config（最彻底关 thinking）。
        extra_body: {
          google: {
            thinking_config: { thinking_budget: 0 },
          },
        },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${jpegBase64}`,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Vision 请求失败 status=${res.status} ${errText.slice(0, 240)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };

    console.log('[vision] gemini full response:', JSON.stringify(data).slice(0, 800));
    const rawContent = data.choices?.[0]?.message?.content;
    console.log('[vision] gemini raw content:', JSON.stringify(rawContent)?.slice(0, 300));
    const modelJson = extractModelJson(rawContent);
    console.log('[vision] gemini parsed JSON:', JSON.stringify(modelJson));
    const parsed = VisionOutSchema.safeParse(modelJson);
    if (!parsed.success) {
      console.log('[vision] zod fallback to no_face, reason:', parsed.error.message.slice(0, 200));
    }
    return parsed.success ? parsed.data : FALLBACK;
  } finally {
    clearTimeout(timer);
  }
}

function extractModelJson(content: unknown): unknown {
  const text = normalizeModelContent(content);
  if (!text) return null;

  const cleaned = stripJsonCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function normalizeModelContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();

  if (Array.isArray(content)) {
    const texts = content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const rec = part as Record<string, unknown>;
        return typeof rec.text === 'string' ? rec.text : '';
      })
      .filter(Boolean);
    return texts.join('\n').trim();
  }

  return '';
}

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}
