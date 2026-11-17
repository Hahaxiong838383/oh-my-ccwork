import assert from 'node:assert/strict';
import { WechatPhoneClient, WechatPhoneError } from '../src/wechat-phone.js';

process.env.WECHAT_APP_ID = 'wx1111111111111111';
process.env.WECHAT_APP_SECRET = 'fixture-wechat-secret-private';
let assertions = 0;
async function rejectResponse(body: unknown, expected: string) {
  const client = new WechatPhoneClient({ fetchImpl: async () => Response.json(body) });
  await assert.rejects(client.exchangeLoginCode('fixture-code'), (error: unknown) => {
    assert(error instanceof WechatPhoneError);
    assert.equal(error.code, expected);
    assert.equal(error.message, expected);
    assertions++;
    return true;
  });
}
// A malformed upstream error flag must never be accepted as a successful login.
await rejectResponse({ errcode: '40029', openid: 'fixture-user', session_key: 'private-session' }, 'wechat_exchange_failed');
await rejectResponse({ openid: 'fixture-user' }, 'wechat_exchange_failed');
await rejectResponse({ openid: 'invalid\nidentifier', session_key: 'private-session' }, 'wechat_exchange_failed');
await rejectResponse({ openid: 'fixture-user', session_key: 'private-session', unionid: 42 }, 'wechat_exchange_failed');
await rejectResponse({ openid: 'fixture-user', session_key: 'private-session', unionid: '' }, 'wechat_exchange_failed');
for (const errcode of [40029, 40163]) await rejectResponse({ errcode, errmsg: 'private upstream reason' }, 'wechat_login_code_invalid');
for (const errcode of [40013, 40125, 40164]) await rejectResponse({ errcode }, 'wechat_not_configured');
for (const errcode of [-1, 40226, 45011]) await rejectResponse({ errcode }, 'wechat_unavailable');
for (const response of [new Response('not JSON'), new Response('x'.repeat(65537)), new Response('{}', { status: 503 })]) {
  const client = new WechatPhoneClient({ fetchImpl: async () => response });
  await assert.rejects(client.exchangeLoginCode('fixture-code'), (error: unknown) => {
    assert(error instanceof WechatPhoneError);
    assert(['wechat_exchange_failed', 'wechat_unavailable'].includes(error.code));
    assertions++; return true;
  });
}
const timeout = new WechatPhoneClient({ timeoutMs: 5, fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
  init!.signal!.addEventListener('abort', () => reject(new Error('private-timeout-secret')), { once: true });
}) });
await assert.rejects(timeout.exchangeLoginCode('timeout-code'), (error: unknown) => {
  assert(error instanceof WechatPhoneError); assert.equal(error.message, 'wechat_exchange_failed'); assertions++; return true;
});
console.log(`wechat-client: PASS ${assertions} error/timeout cases; upstream HTTP simulated`);
