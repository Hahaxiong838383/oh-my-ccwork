import { Hono } from 'hono';
import { z } from 'zod';
import { geminiVisionDetect } from '../providers/gemini-vision.js';
import { checkAndCount, getClientIp } from '../guard.js';

const visionRoute = new Hono();

const BodySchema = z.object({
  jpegBase64: z.string(),
});

const MAX_BASE64_LEN = 50000;

visionRoute.post('/expression', async (c) => {
  const startedAt = Date.now();
  console.log('[vision] POST /expression received');

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    console.log('[vision] bad_request: invalid JSON');
    return c.json({ error: 'bad_request' }, 400);
  }

  const bodyParsed = BodySchema.safeParse(rawBody);
  if (!bodyParsed.success) {
    console.log('[vision] bad_request: schema');
    return c.json({ error: 'bad_request' }, 400);
  }

  const { jpegBase64 } = bodyParsed.data;
  console.log(`[vision] jpeg len=${jpegBase64.length}`);
  if (jpegBase64.length > MAX_BASE64_LEN) {
    return c.json({ error: 'image_too_large' }, 413);
  }

  // vision 限额检查（使用共享 getClientIp，支持 Hono c）
  const clientIp = getClientIp(c);
  const visionCheck = checkAndCount('vision', clientIp);
  if (!visionCheck.ok) {
    console.log(`[vision] rate_limited ip=${clientIp}`);
    return c.json({ error: 'rate_limited' }, 429);
  }

  try {
    const { label, confidence } = await geminiVisionDetect(jpegBase64);
    console.log(`[vision] result expr=${label} conf=${confidence.toFixed(2)} ms=${Date.now() - startedAt}`);
    return c.json({
      expr: label,
      confidence,
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.log('[vision] gemini error:', (err as Error)?.message);
    return c.json({
      expr: 'no_face',
      confidence: 0,
      latencyMs: Date.now() - startedAt,
    });
  }
});

export { visionRoute };
