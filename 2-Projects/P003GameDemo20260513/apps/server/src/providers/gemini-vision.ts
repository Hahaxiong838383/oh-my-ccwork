import { z } from 'zod';

// D6 P1 速度优化：thinking 模型（gemini-3-flash-preview）reasoning_tokens=112
// 吃掉大半延迟（实测 4-7s）→ 改非 thinking 的 2.5-flash（p95 <1.5s）。
// 跟 LLM (gemini-llm.ts, gemini-3.1-flash-lite-preview) 物理隔离的两个 provider，
// 改这个不影响小可对话 LLM 智商。
const MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 5000;

// D6 P1 V3：删 neutral（川哥反馈"大多数 neutral"让 demo 失去人设感）。
// 12 标签 = 11 表情 + no_face。Gemini 看到任何脸**必须**归到 11 个表情里。
const VISION_PROMPT = `请观察这张照片中人脸的表情，从以下 12 个标签里挑一个**最贴近的**：

【正向情绪】
- happy      嘴角上扬 / 微笑 / 轻松愉快
- excited    瞪眼笑 / 张大嘴 / 兴奋激动

【负向情绪】
- sad        皱眉 / 嘴角下垂 / 眼角下垂 / 难过失落
- tired      闭眼 / 打哈欠 / 眼袋重 / 倦怠 / 揉眼
- bored      撑头 / 目光涣散 / 表情松散没精神
- confused   皱眉歪头 / 嘴角紧 / 一脸困惑
- shy        低头 / 嘴角紧 / 眼神躲闪 / 害羞

【认知 / 思考】
- curious    睁大眼 / 抬眉 / 嘴微张 / 好奇张望
- focused    眼神锐利 / 微皱眉 / 凝视专注做事
- surprised  瞪眼张嘴 / 突然吃惊
- thinking   看向斜上 / 咬唇 / 抚下巴 / 沉思

【兜底】
- no_face    画面里**完全没有人脸**（拍到天花板、桌面、墙壁、衣服等）

**铁律**：
1. 看到任何人脸（不论年龄/性别/距离/角度），**必须从前 11 个里选**，不能因为表情"不明显"就拒绝归类。
2. 表情即便很轻微（嘴角微翘 1 度、眼睛眯一点、眉毛动一下），也要归到**最接近的那一个**。
3. 如果实在拿不准是哪种正面情绪 → 优先 happy；拿不准是哪种思考态 → 优先 curious；拿不准是哪种负面情绪 → 优先 tired。
4. 只有画面**完全没有人脸**时才用 no_face。
5. confidence 反映你对标签的把握度：高置信用 0.8-0.95，没把握用 0.3-0.6，但**仍然要给一个表情标签**。

返回 JSON：{"label": "<标签>", "confidence": <0.0-1.0>}
只返回 JSON，不要其他内容、解释或代码块标记。`;

// D6 P1 V3：12 标签白名单（删 neutral）。
// 跟 apps/web/src/services/expression-snapshot.ts ExpressionLabel union 同步。
const LabelSchema = z.enum([
  'happy',
  'excited',
  'sad',
  'tired',
  'bored',
  'confused',
  'shy',
  'curious',
  'focused',
  'surprised',
  'thinking',
  'no_face',
]);
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
