import { Hono } from 'hono';
import { z } from 'zod';
import { profileStore } from '../profile-store.js';
import { memoryItemStore } from '../memory-item-store.js';
import { verifyAuthToken } from '../auth-jwt.js';

// 体验台记忆面板用户 API:读全量记忆 + 手动添加 / 删除 / 标记兑现 + 兴趣删除。
// 鉴权与 routes/profile.ts 同范式(邀请码登录 JWT),按 accountId 隔离;
// 删除 / 兑现均带归属校验(防越权红线:账号 B 动不了账号 A 的数据)。
const memoryRoute = new Hono<{ Variables: { accountId: string } }>();

// 鉴权中间件：Authorization: Bearer <JWT> → accountId；无/无效 → 401（家长账号专用，非 admin token）
memoryRoute.use('*', async (c, next) => {
  const header = c.req.header('authorization');
  const token = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const auth = await verifyAuthToken(token);
  if (!auth) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  c.set('accountId', auth.accountId);
  await next();
});

// 手动添加的 body 校验:content trim 后 1–60 字;subject / due_text ≤20 字。
const MemoryAddSchema = z.object({
  type: z.enum(['promise', 'event', 'emotion', 'relation', 'preference']),
  content: z.string().trim().min(1).max(60),
  subject: z.string().trim().max(20).optional(),
  due_text: z.string().trim().max(20).optional(),
});

// 读全量:profile 四字段 + 面板条目(滤掉 retracted;admin 端点保留全量不动) + 归档情绪计数 + 服务器时钟。
// 隐私红线:profile 只回 nickname/birthday/gender/interests,interests 元素只留 value,不泄漏内部字段。
// server_now 给前端算「最近注入」高亮,避免客户端时钟偏差。
memoryRoute.get('/', (c) => {
  const accountId = c.get('accountId');
  const member = profileStore.getProfile(accountId);
  const profile = member
    ? {
        nickname: member.nickname,
        birthday: member.birthday,
        gender: member.gender,
        interests: member.interests.map((i) => ({ value: i.value, state: i.state ?? 'unverified', evidence: i.evidence ?? '' })),
      }
    : null;
  const { items, archived_emotion_count } = memoryItemStore.listByAccount(accountId);
  return c.json({
    ok: true,
    profile,
    items: items.filter((it) => it.status !== 'retracted'),
    archived_emotion_count,
    server_now: Date.now(),
  });
});

// 手动添加(演示预埋):due 解析 / 去重 / 上限淘汰均由 store 内建,这里只做校验 + subject 按类型归一。
memoryRoute.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const parsed = MemoryAddSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const { type, content, due_text } = parsed.data;
  // subject 归一:promise 必须 'xiaoke'|'child'(默认 'xiaoke');relation 为人名(允许空);其余忽略传 ''
  let subject = '';
  if (type === 'promise') {
    const s = parsed.data.subject || 'xiaoke';
    if (s !== 'xiaoke' && s !== 'child') {
      return c.json({ ok: false, error: 'bad_request' }, 400);
    }
    subject = s;
  } else if (type === 'relation') {
    subject = parsed.data.subject ?? '';
  }
  const added = memoryItemStore.addItems(c.get('accountId'), [
    {
      type,
      content,
      subject,
      due_text,
      source: 'manual',
      confidence: 1,
      session_id: 'manual-panel',
      source_role: 'user',
      source_quote: '',
    },
  ]);
  return c.json({ ok: true, added });
});

// 兴趣删除:value 走 URL 编码(中文兴趣),removeInterest 内部按 accountId 找档案天然隔离。
// 注:放在 '/:id' 之前注册,静态段 'interest' 优先,避免路由歧义。
memoryRoute.delete('/interest/:value', (c) => {
  const raw = c.req.param('value');
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // 非法编码时用原值兜底,不抛 500
  }
  const removed = profileStore.deleteInterest(c.get('accountId'), value);
  return c.json({ ok: true, removed });
});

// R1 家长否决（2026-09-03）：软撤回 + 标记 parent，之后同名兴趣不再被语音抽取升格（区别于 DELETE 的物理删）。
memoryRoute.post('/interest/:value/veto', (c) => {
  const raw = c.req.param('value');
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // 非法编码时用原值兜底
  }
  const vetoed = profileStore.vetoInterest(c.get('accountId'), value);
  return c.json({ ok: true, vetoed });
});

// 面板用户删除:归属校验版物理删(儿童数据删除权)。越权(别人的 id)→ deleted=false,数据不动。
memoryRoute.delete('/:id', (c) => {
  const deleted = memoryItemStore.hardDeleteOwned(c.get('accountId'), c.req.param('id'));
  return c.json({ ok: true, deleted });
});

// 手动标记约定已兑现:resolvePromisesByIds 的 SQL 自带 account_id 归属条件(已读源码确认),越权 resolve 不生效。
memoryRoute.post('/:id/resolve', (c) => {
  const n = memoryItemStore.resolvePromisesByIds(c.get('accountId'), [c.req.param('id')], 'manual: 面板手动标记兑现');
  return c.json({ ok: true, resolved: n > 0 });
});

export { memoryRoute };
