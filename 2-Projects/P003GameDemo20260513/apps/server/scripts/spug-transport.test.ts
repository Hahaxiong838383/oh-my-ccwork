import assert from 'node:assert/strict';
process.env.SPUG_SMS_TEMPLATE_CODE = 'ISOLATED_TEMPLATE';
process.env.SPUG_DEV_TOKEN = 'ISOLATED_ACCOUNT_TOKEN';
const { sendSpugSmsCode, querySpugStatus } = await import('../src/spug-sms.js');
const originalFetch = globalThis.fetch;
let count = 0;
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://push.spug.cc/sms/ISOLATED_TEMPLATE');
    assert.deepEqual(JSON.parse(String(init?.body)), { to: '13800009201', code: '457891', number: '5' });
    assert.ok(init?.signal, 'paid request must have bounded timeout');
    return Response.json({ code: 200, msg: '请求成功', request_id: 'receipt-1' });
  };
  assert.deepEqual(await sendSpugSmsCode('13800009201', '457891'), { ok: true, requestId: 'receipt-1' }); count++;
  for (const response of [new Response('unavailable', { status: 503 }), new Response('<html>broken</html>'), Response.json({ code: 200 }), Response.json(null)]) {
    globalThis.fetch = async () => response;
    await assert.rejects(() => sendSpugSmsCode('13800009201', '457891')); count++;
  }
  globalThis.fetch = async () => Response.json({ code: 403, msg: 'unsafe provider echo' });
  assert.deepEqual(await sendSpugSmsCode('13800009201', '457891'), { ok: false, code: 403, msg: 'spug_rejected' }); count++;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    assert.ok(init?.signal);
    init.signal.addEventListener('abort', () => reject(new Error('controlled timeout')), { once: true });
  });
  const start = Date.now();
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(() => sendSpugSmsCode('13800009201', '457891')); }
  finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - start >= 9000 && Date.now() - start < 15000, 'transport deadline is 10 seconds'); count++;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://push.spug.cc/request/query');
    assert.deepEqual(JSON.parse(String(init?.body)), { token: 'ISOLATED_ACCOUNT_TOKEN', request_id: 'receipt-1' });
    return Response.json({ code: 200, data: [{ target: '138****9201', status: '2', reason: '' }] });
  };
  assert.equal((await querySpugStatus('receipt-1')).data?.[0]?.status, '2'); count++;
  console.log('spug-transport: PASS ' + count + ' cases; no real external requests');
} finally { globalThis.fetch = originalFetch; }
