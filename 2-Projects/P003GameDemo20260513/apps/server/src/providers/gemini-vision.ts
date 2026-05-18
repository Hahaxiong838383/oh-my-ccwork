import { z } from 'zod';

const MODEL = 'gemini-3-flash-preview';
const TIMEOUT_MS = 3000;

// D6 P1 hotfix：去掉"儿童"限定。Gemini 看到成年人会判"不符合儿童"→ no_face@0。
// 川哥实测前置摄像头预览清晰、正脸、光线足，但仍返 no_face → 锁定 prompt 偏置。
const VISION_PROMPT = `请分析这张照片中人脸的表情，从以下标签中选一个最贴近的：
- happy (微笑、大笑、开心)
- tired (疲倦、打哈欠、揉眼睛、闭眼)
- curious (好奇、惊讶、睁大眼睛、专注)
- neutral (无明显情绪、面无表情)
- no_face (画面里没有任何人脸)

只要画面里能看到一张人脸（不论年龄性别），就从前 4 个里选一个；
完全看不到人脸时才用 no_face。

返回 JSON：{"label": "<标签>", "confidence": <0.0-1.0>}
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
        max_tokens: 120,
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
