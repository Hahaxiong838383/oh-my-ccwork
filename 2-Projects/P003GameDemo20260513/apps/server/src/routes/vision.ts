import { Hono } from 'hono';
import { z } from 'zod';
import { geminiVisionDetect } from '../providers/gemini-vision.js';

const visionRoute = new Hono();

const BodySchema = z.object({
  jpegBase64: z.string(),
});

const MAX_BASE64_LEN = 50000;

visionRoute.post('/expression', async (c) => {
  const startedAt = Date.now();

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request' }, 400);
  }

  const bodyParsed = BodySchema.safeParse(rawBody);
  if (!bodyParsed.success) {
    return c.json({ error: 'bad_request' }, 400);
  }

  const { jpegBase64 } = bodyParsed.data;
  if (jpegBase64.length > MAX_BASE64_LEN) {
    return c.json({ error: 'image_too_large' }, 413);
  }

  try {
    const { label, confidence } = await geminiVisionDetect(jpegBase64);
    return c.json({
      expr: label,
      confidence,
      latencyMs: Date.now() - startedAt,
    });
  } catch {
    return c.json({
      expr: 'no_face',
      confidence: 0,
      latencyMs: Date.now() - startedAt,
    });
  }
});

export { visionRoute };
