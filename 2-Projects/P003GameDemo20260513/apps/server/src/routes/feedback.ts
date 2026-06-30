import { Hono } from 'hono';
import { z } from 'zod';
import {
  FEEDBACK_ADOPTION_KINDS,
  FEEDBACK_EMOTIONS,
  FEEDBACK_STATUSES,
  feedbackStore,
  type FeedbackItem,
} from '../feedback-store.js';
import { getTokenRole, getTokenUser, isValidToken } from './auth.js';

const feedbackRoute = new Hono();

// PATCH body：所有字段 optional；adoptionKind 三态（缺/null/枚举值），用 nullable.optional 表达
// 2026-06-30 修：theme 由硬编码 z.enum(FEEDBACK_THEMES) 改 z.string()——主题词表已动态化（ADR-06，
// feedback_themes 表 admin 可增删改名），enum 会拒 admin 新增的主题（如「方法」），导致 Issue 看板
// 把卡片改成新主题时 400 bad_request。store 层 normalizeTheme 已兜底（trim + 空兜「未分类」）。
// emotion 词表仍硬编码（无管理页），保留 z.enum 严格校验。
const PatchBodySchema = z
  .object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    note: z.string().optional(),
    theme: z.string().min(1).max(40).optional(),
    emotion: z.enum(FEEDBACK_EMOTIONS).optional(),
    adoptionKind: z.enum(FEEDBACK_ADOPTION_KINDS).nullable().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.note !== undefined ||
      value.theme !== undefined ||
      value.emotion !== undefined ||
      value.adoptionKind !== undefined,
    { message: 'status / note / theme / emotion / adoptionKind 至少提供一个' },
  );

// PATCH /:id/parent body：parent_id 必填（string|null）。string=合并到该父；null=解除合并。
const PatchParentBodySchema = z.object({
  parent_id: z.string().min(1).nullable(),
});

type FeedbackPublicItem = Omit<FeedbackItem, 'ip_hash'>;

feedbackRoute.use('*', async (c, next) => {
  const token = getAuthorizedToken(c.req.header('authorization'));
  if (!token || !isValidToken(token)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  // 只读门控（真防线）：guest 仅可 GET（看反馈）；改状态/备注（PATCH）一律 403。
  if (c.req.method !== 'GET' && getTokenRole(token) !== 'admin') {
    return c.json({ ok: false, error: 'forbidden_readonly', message: '游客账号只读，无编辑权限' }, 403);
  }
  await next();
});

feedbackRoute.get('/', (c) => {
  return c.json({
    ok: true,
    items: feedbackStore.list().map(toPublicItem),
  });
});

feedbackRoute.patch('/:id', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }

  const parsed = PatchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }

  const token = getAuthorizedToken(c.req.header('authorization'));
  const updatedBy = token ? getTokenUser(token) ?? 'admin' : 'admin';
  const item = feedbackStore.updateStatus(c.req.param('id'), {
    status: parsed.data.status,
    note: parsed.data.note,
    theme: parsed.data.theme,
    emotion: parsed.data.emotion,
    adoptionKind: parsed.data.adoptionKind,
    updatedBy,
  });

  if (!item) {
    return c.json({ ok: false, error: 'not_found' }, 404);
  }

  return c.json({ ok: true, item: toPublicItem(item) });
});

/**
 * PATCH /:id/parent  body { parent_id: string | null }
 * - admin only（中间件已校验）
 * - 改 childId 的 parent_feedback_id
 * - 失败场景（拒嵌套）→ 400 + 具体 error code
 */
feedbackRoute.patch('/:id/parent', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }

  const parsed = PatchParentBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request', message: 'parent_id 必填（string|null）' }, 400);
  }

  const token = getAuthorizedToken(c.req.header('authorization'));
  const updatedBy = token ? getTokenUser(token) ?? 'admin' : 'admin';
  const childId = c.req.param('id');

  try {
    const item = feedbackStore.setParent(childId, parsed.data.parent_id, updatedBy);
    if (!item) {
      return c.json({ ok: false, error: 'not_found' }, 404);
    }
    console.log(`[feedback] parent updated child=${childId} parent=${parsed.data.parent_id ?? 'null'} by=${updatedBy}`);
    return c.json({ ok: true, item: toPublicItem(item) });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'merge_failed';
    return c.json({ ok: false, error: code }, 400);
  }
});

/**
 * GET /:id/children
 * 列出某父项的所有子项。guest 可读。不存在 → 200 + 空数组。
 */
feedbackRoute.get('/:id/children', (c) => {
  const items = feedbackStore.findChildren(c.req.param('id')).map(toPublicItem);
  return c.json({ ok: true, items });
});

/**
 * GET /:id/merge-candidates
 * 同主题 + 同情绪的顶层反馈候选（最多 50）。guest 可读。
 */
feedbackRoute.get('/:id/merge-candidates', (c) => {
  const items = feedbackStore.findMergeCandidates(c.req.param('id')).map(toPublicItem);
  return c.json({ ok: true, items });
});

function readBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) return null;
  const token = match[1]?.trim();
  return token ? token : null;
}

function getAuthorizedToken(headerValue: string | undefined): string | null {
  const token = readBearerToken(headerValue);
  return token && isValidToken(token) ? token : null;
}

function toPublicItem(item: FeedbackItem): FeedbackPublicItem {
  const { ip_hash: _ipHash, ...rest } = item;
  return rest;
}

export { feedbackRoute };
