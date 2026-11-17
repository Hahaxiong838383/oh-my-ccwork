/**
 * 短信验证码注册/登录 + 绑定即接入大脑 回归测试 · 跑法：npm run test:sms（tsx 直跑，无框架）
 *
 * 覆盖：
 *  - POP percentEncode 特殊字符（签名正确性的静态部分；动态部分由生产 E2E 兜）
 *  - /sms/send：手机号格式门 / 三窗限流（间隔+时窗）/ 阿里云受理→流水 / 阿里云拒绝→502 / 未配置→503
 *  - /sms/verify：PASS→建号+JWT / 幂等（同号二登同账号）/ 核验失败→401 单一口径
 *  - JWT 与 verifyAuthToken 闭环（role=parent，bind-sn 中间件直接放行）
 *  - bind-sn 自动开 brain：绑定→device 账号+关联+建档 / 已开通不重建（幂等）/ 防抢绑 409 仍在
 *  - upsertPhoneAccount 幂等 + phone 唯一索引兜底
 *
 * 阿里云调用全程 mock（setSmsTransportForTest），不实发短信。
 */

// ── env 必须先于被测模块 import（store 均为模块加载期单例）──
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'sms-auth-test-'));
process.env.ACCOUNTS_DB_PATH = join(tmp, 'accounts.db');
process.env.SMS_DB_PATH = join(tmp, 'sms.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.AUTH_JWT_SECRET = 'sms-regression-test-secret-at-least-32-bytes';
process.env.SMS_PROVIDER = 'aliyun'; // 存量段落按阿里云链路跑；文件末尾有 spug 专段（届时切换）
delete process.env.ALIYUN_SMS_ACCESS_KEY_ID;
delete process.env.ALIYUN_SMS_ACCESS_KEY_SECRET;
delete process.env.SPUG_SMS_TEMPLATE_CODE;

const { Hono } = await import('hono');
const { smsAuthRoute } = await import('../src/routes/sms-auth.js');
const { profileRoute } = await import('../src/routes/profile.js');
const { setSmsTransportForTest } = await import('../src/aliyun-sms.js');
const { accountStore } = await import('../src/account-store.js');
const { smsLimitStore } = await import('../src/sms-limit-store.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { profileStore } = await import('../src/profile-store.js');
const { verifyAuthToken } = await import('../src/auth-jwt.js');

let pass = 0;
let fail = 0;

function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL ${name} got=${g} want=${w}`);
  }
}

const app = new Hono();
app.route('/api/auth', smsAuthRoute);
app.route('/api/profile', profileRoute);

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// ── mock 传输层：默认全部成功 ──
type Call = { action: string; params: Record<string, string> };
const calls: Call[] = [];
let sendResponse: unknown = { Code: 'OK', Success: true, Model: { BizId: 'mock-biz-1' } };
let checkResponse: unknown = { Code: 'OK', Success: true, Model: { VerifyResult: 'PASS' } };
setSmsTransportForTest(async (action, params) => {
  calls.push({ action, params });
  return action === 'SendSmsVerifyCode' ? sendResponse : checkResponse;
});

const PHONE_A = '13800000001';
const PHONE_B = '13800000002';
const SN_1 = 'BJP00326060100000001';
const SN_2 = 'BJP00326060100000002';

// ---------- percentEncode（经 signedQuery 间接验，此处验导出行为足够的静态子集）----------
// pe 未导出——通过一次真实 transport 调用无从离线断言签名值（nonce/timestamp 动态），
// 生产 E2E 是签名正确性的 oracle；这里守住「特殊字符参数不会让请求组装抛错」。
{
  const r = await post('/api/auth/sms/send', { phone: PHONE_A });
  eq('send-1 mock 受理', { status: r.status, ok: r.json.ok }, { status: 200, ok: true });
  eq('send-2 调用了 SendSmsVerifyCode', calls[0]?.action, 'SendSmsVerifyCode');
  eq('send-3 模板参数为托管核验形态', calls[0]?.params.TemplateParam, '{"code":"##code##","min":"5"}');
  eq('send-4 绝不传 ReturnVerifyCode', 'ReturnVerifyCode' in (calls[0]?.params ?? {}), false);
  eq('send-5 六位码', calls[0]?.params.CodeLength, '6');
}

// ---------- send：手机号格式门 ----------
eq('send-fmt-1 空号', (await post('/api/auth/sms/send', { phone: '' })).status, 400);
eq('send-fmt-2 10 位', (await post('/api/auth/sms/send', { phone: '1380000000' })).status, 400);
eq('send-fmt-3 12 开头', (await post('/api/auth/sms/send', { phone: '12800000001' })).status, 400);
eq('send-fmt-4 带字母', (await post('/api/auth/sms/send', { phone: '1380000000a' })).status, 400);
eq('send-fmt-5 非 json body 不 500', (await app.request('/api/auth/sms/send', { method: 'POST', body: 'x' })).status, 400);

// ---------- send：限流三窗 ----------
{
  // 同号 60s 间隔：PHONE_A 刚发过 → 立即再发被拒
  const r = await post('/api/auth/sms/send', { phone: PHONE_A });
  eq('limit-1 间隔窗 429', { status: r.status, error: r.json.error }, { status: 429, error: 'rate_limited' });
  eq('limit-2 带 retry_after_s', typeof r.json.retry_after_s, 'number');
  // 不同号不受影响
  eq('limit-3 换号放行', (await post('/api/auth/sms/send', { phone: PHONE_B })).status, 200);
  // 小时窗：直接灌流水到阈值（默认 5/h），下次发送被拒
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) smsLimitStore.record('13800000003', '', `seed-${i}`, now - 120_000 - i * 1000);
  const r2 = await post('/api/auth/sms/send', { phone: '13800000003' });
  eq('limit-4 小时窗 429', { status: r2.status, reason: r2.json.error }, { status: 429, reason: 'rate_limited' });
  // IP 日窗：生产nginx覆盖的X-Real-IP计数，不能信任调用方追加的XFF首项
  for (let i = 0; i < 20; i += 1) smsLimitStore.record(`1390000${String(i).padStart(4, '0')}`, '9.9.9.9', `ip-${i}`, now - 3600_000);
  const res = await app.request('/api/auth/sms/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '9.9.9.9', 'x-forwarded-for': 'spoofed, 10.0.0.1' },
    body: JSON.stringify({ phone: '13800000004' }),
  });
  eq('limit-5 IP 日窗 429', res.status, 429);

  // retry_after_s 真实化：注入同一 now 做精确断言（seed 最老一条 now-124s，1h 窗 → 剩 3600-124=3476s）
  // seed 在上面灌了 5 条：now-120_000 - i*1000（i=0..4），最老 = now-124_000
  const v = smsLimitStore.check('13800000003', '', now);
  eq('limit-6 小时窗 retry 为真实剩余秒数', v, { ok: false, reason: 'phone_hour', retry_after_s: 3476 });

  // 测试号白名单：跳过额度窗、60s 间隔保留（对齐阿里云平台同号频控）；移除后额度窗恢复（负向锚，防白名单恒 true）
  smsLimitStore.record('13800000003', '', 'wl-interval-seed', now); // 该号现 6 条流水，额度窗（5/h）已超
  process.env.SMS_TEST_PHONE_ALLOWLIST = ' 13800000003 ,13800000099';
  eq(
    'limit-7a 白名单间隔窗仍拦',
    smsLimitStore.check('13800000003', '', now + 1000),
    { ok: false, reason: 'interval', retry_after_s: 59 },
  );
  eq('limit-7b 白名单跳过额度窗', smsLimitStore.check('13800000003', '', now + 61_000), { ok: true });
  delete process.env.SMS_TEST_PHONE_ALLOWLIST;
  eq(
    'limit-8 移除白名单额度窗恢复',
    (smsLimitStore.check('13800000003', '', now + 61_000) as { ok: boolean; reason?: string }).reason,
    'phone_hour',
  );
}

// ---------- send：阿里云拒绝/未配置 ----------
{
  sendResponse = { Code: 'isv.BUSINESS_LIMIT_CONTROL', Success: false };
  const r = await post('/api/auth/sms/send', { phone: '13800000005' });
  eq('send-rej-1 阿里云拒绝→502', { status: r.status, error: r.json.error }, { status: 502, error: 'send_failed' });
  sendResponse = { Code: 'OK', Success: true, Model: { BizId: 'mock-biz-2' } };
  // 拒绝的发送不占流水额度：同号立刻可再发（间隔窗只看已实发流水）
  const r2 = await post('/api/auth/sms/send', { phone: '13800000005' });
  eq('send-rej-2 被拒不记流水', r2.status, 200);
}

// ---------- verify：PASS → 建号 + JWT 闭环 ----------
let tokenA = '';
{
  const r = await post('/api/auth/sms/verify', { phone: PHONE_A, code: '123456' });
  eq('verify-1 PASS 登录', { status: r.status, ok: r.json.ok, is_new: r.json.is_new }, { status: 200, ok: true, is_new: true });
  eq('verify-2 返回 token', typeof r.json.token === 'string' && r.json.token.length > 20, true);
  eq('verify-3 昵称=家长+尾4', r.json.account.nickname, '家长0001');
  tokenA = r.json.token;
  const auth = await verifyAuthToken(tokenA);
  eq('verify-4 verifyAuthToken 闭环', { accountId: auth?.accountId, role: auth?.role }, { accountId: r.json.account.id, role: 'parent' });
  // 持久登录 TTL=30d（前端 localStorage 记住登录态，2026-08-23）：exp-iat 精确 30 天
  const payload = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64url').toString()) as { iat: number; exp: number };
  eq('verify-5 token TTL 30 天', payload.exp - payload.iat, 30 * 86400);
  // 幂等：同号再 verify → 同账号，is_new=false
  const r2 = await post('/api/auth/sms/verify', { phone: PHONE_A, code: '654321' });
  eq('verify-5 二登同账号', { id: r2.json.account.id, is_new: r2.json.is_new }, { id: r.json.account.id, is_new: false });
  // upsert 幂等直验
  const acc1 = accountStore.upsertPhoneAccount(PHONE_A);
  const acc2 = accountStore.upsertPhoneAccount(PHONE_A);
  eq('verify-6 upsert 幂等', acc1.id, acc2.id);
}

// ---------- verify：失败单一口径 ----------
{
  checkResponse = { Code: 'OK', Success: true, Model: { VerifyResult: 'UNKNOWN' } };
  const r = await post('/api/auth/sms/verify', { phone: PHONE_B, code: '000000' });
  eq('verify-fail-1 非 PASS→401', { status: r.status, error: r.json.error }, { status: 401, error: 'code_invalid' });
  eq('verify-fail-2 未建号', accountStore.findByPhone(PHONE_B), null);
  checkResponse = { Code: 'MOBILE_NUMBER_ILLEGAL', Success: false };
  eq('verify-fail-3 阿里云错误码→401', (await post('/api/auth/sms/verify', { phone: PHONE_B, code: '000000' })).status, 401);
  eq('verify-fail-4 格式门', (await post('/api/auth/sms/verify', { phone: PHONE_B, code: 'abcdef' })).status, 400);
  checkResponse = { Code: 'OK', Success: true, Model: { VerifyResult: 'PASS' } };
}

// ---------- bind-sn：绑定即接入大脑 ----------
{
  deviceRegistryStore.add(SN_1, '测试机一号');
  const r = await post('/api/profile/bind-sn', { sn: SN_1 }, tokenA);
  eq('bind-1 绑定成功+brain 开通', { status: r.status, ok: r.json.ok, brain: r.json.brain_opened }, { status: 200, ok: true, brain: true });
  const dev = deviceRegistryStore.get(SN_1);
  eq('bind-2 device 账号已建并关联', dev?.account_id, `device-${SN_1}`);
  eq('bind-3 parent 已关联', dev?.parent_account_id, (await verifyAuthToken(tokenA))?.accountId);
  eq('bind-4 设备档案已建', profileStore.getProfile(`device-${SN_1}`) !== null, true);
  // 幂等：同人重绑不报错、不重建
  const r2 = await post('/api/profile/bind-sn', { sn: SN_1 }, tokenA);
  eq('bind-5 重绑幂等', { status: r2.status, brain: r2.json.brain_opened }, { status: 200, brain: true });
  // 防抢绑：另一账号绑同 SN → 409
  const rB = await post('/api/auth/sms/verify', { phone: PHONE_B, code: '111111' });
  const rTaken = await post('/api/profile/bind-sn', { sn: SN_1 }, rB.json.token);
  eq('bind-6 防抢绑 409', { status: rTaken.status, error: rTaken.json.error }, { status: 409, error: 'sn_taken' });
  // 已手工开过 brain 的设备：绑定不重建账号（account_id 不变）
  deviceRegistryStore.add(SN_2, '测试机二号');
  deviceRegistryStore.setAccountId(SN_2, 'device-preopened');
  const r3 = await post('/api/profile/bind-sn', { sn: SN_2 }, rB.json.token);
  eq('bind-7 已开通不重建', { status: r3.status, acc: deviceRegistryStore.get(SN_2)?.account_id }, { status: 200, acc: 'device-preopened' });
  // 现役 SIMPLE_SN_BINDING 默认允许手机号用户创建新SN；关闭时保留旧台账门。
  // 原“始终404”断言在本次修改前的隔离基线已失败，不能为旧断言回退已上线行为。
  const simpleBefore = process.env.SIMPLE_SN_BINDING_ENABLED;
  process.env.SIMPLE_SN_BINDING_ENABLED = '1';
  const createdSn = 'BJP00326060100000009';
  const created = await post('/api/profile/bind-sn', { sn: createdSn }, tokenA);
  eq('bind-8 默认简化绑定创建新SN和Brain', { status: created.status, brain: created.json.brain_opened,
    account: deviceRegistryStore.get(createdSn)?.account_id, owner: deviceRegistryStore.get(createdSn)?.parent_account_id },
    { status: 200, brain: true, account: `device-${createdSn}`, owner: (await verifyAuthToken(tokenA))?.accountId });
  process.env.SIMPLE_SN_BINDING_ENABLED = '0';
  const deniedSn = 'BJP00326060100000010';
  const denied = await post('/api/profile/bind-sn', { sn: deniedSn }, tokenA);
  eq('bind-8b 关闭简化绑定仍拒台账外SN且不落库', { status: denied.status, error: denied.json.error, exists: !!deviceRegistryStore.get(deniedSn) },
    { status: 404, error: 'sn_not_available', exists: false });
  if (simpleBefore === undefined) delete process.env.SIMPLE_SN_BINDING_ENABLED;
  else process.env.SIMPLE_SN_BINDING_ENABLED = simpleBefore;
  // 无 token → 401
  eq('bind-9 未登录 401', (await post('/api/profile/bind-sn', { sn: SN_1 })).status, 401);
}

// ---------- Spug 主渠道（2026-08-23 自备码模式：server 生成/存储/校验，Spug 只发送）----------
{
  const { setSpugTransportForTest } = await import('../src/spug-sms.js');
  const { verifyCodeStore } = await import('../src/verify-code-store.js');
  process.env.SMS_PROVIDER = 'spug';

  // 未配模板码 → 503（default=spug 时凭证缺失要显式报错，不静默）
  eq('spug-0 未配置 503', (await post('/api/auth/sms/send', { phone: '13900010001' })).status, 503);

  process.env.SPUG_SMS_TEMPLATE_CODE = 'TPL_TEST';
  let spugCalls: Array<{ url: string; body: Record<string, string> }> = [];
  let spugResponse: unknown = { code: 200, msg: '请求成功', request_id: 'req-1' };
  setSpugTransportForTest(async (url, body) => {
    spugCalls.push({ url, body });
    return spugResponse;
  });

  // send 成功：URL 带模板码 + body 含 to/code(6位)/number=5 + 落码可 verify
  const r1 = await post('/api/auth/sms/send', { phone: '13900010001' });
  eq('spug-1 send 200', { status: r1.status, ok: r1.json.ok }, { status: 200, ok: true });
  eq('spug-2 URL 模板码', spugCalls[0]?.url.endsWith('/sms/TPL_TEST'), true);
  const sentCode = spugCalls[0]?.body.code ?? '';
  eq('spug-3 码 6 位数字+number=5', { c: /^\d{6}$/.test(sentCode), n: spugCalls[0]?.body.number }, { c: true, n: '5' });

  // verify 全链：错码 401 → 正码 200 拿 token → 重放 401（一次性）
  eq('spug-4 错码 401', (await post('/api/auth/sms/verify', { phone: '13900010001', code: '000000' })).status, 401);
  const r2 = await post('/api/auth/sms/verify', { phone: '13900010001', code: sentCode });
  eq('spug-5 正码登录', { status: r2.status, hasToken: typeof r2.json.token === 'string' }, { status: 200, hasToken: true });
  eq('spug-6 重放 401(一次性)', (await post('/api/auth/sms/verify', { phone: '13900010001', code: sentCode })).status, 401);

  // 过期：注入 now 越过 TTL（store 单元级）
  verifyCodeStore.issue('13900010002', '123456');
  eq('spug-7 过期 expired', verifyCodeStore.verify('13900010002', '123456', Date.now() + 5 * 60_000 + 1000), 'expired');

  // 尝试上限：5 次错后即使正码也拒（记录已删 → not_found）
  verifyCodeStore.issue('13900010003', '654321');
  for (let i = 0; i < 5; i += 1) verifyCodeStore.verify('13900010003', '999999');
  eq('spug-8 超限后正码也拒', verifyCodeStore.verify('13900010003', '654321'), 'too_many');
  eq('spug-9 超限记录已焚', verifyCodeStore.verify('13900010003', '654321'), 'not_found');

  // 发送失败 → 502 且不落码（失败不留可用码）
  spugResponse = { code: 403, msg: 'IP 不在白名单' };
  spugCalls = [];
  const r3 = await post('/api/auth/sms/send', { phone: '13900010004' });
  eq('spug-10 发送失败 502', { status: r3.status, error: r3.json.error }, { status: 502, error: 'send_failed' });
  eq('spug-11 失败不落码', verifyCodeStore.verify('13900010004', spugCalls[0]?.body.code ?? '000000'), 'not_found');

  process.env.SMS_PROVIDER = 'aliyun'; // 恢复，防污染后续段落
}

// ---------- 汇总 ----------
console.log(`\nsms-auth.test: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
