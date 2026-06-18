// P0.1 真实 WS E2E：起本地 server 后，连两轮对话验证「第二轮记得第一轮」= 会话 history 生效。
// 第一轮告诉小可名字/年龄，第二轮问它——若回复含「小明」「7」则证明 history 真进了 LLM。
// 跑法：先起 server(PORT=3019)，再 node scripts/p0-history-e2e.mjs
import WebSocket from 'ws';

const URL = process.env.E2E_WS_URL || 'ws://127.0.0.1:3019/ws/voice';
const ws = new WebSocket(URL);
const done = [];
const timer = setTimeout(() => { console.error('❌ timeout 40s'); process.exit(2); }, 40000);

ws.on('open', () => {
  console.log('[e2e] ws open →', URL);
  ws.send(JSON.stringify({ type: 'session.config', systemPrompt: '你是儿童陪伴机器人小可，回复简短(20字内)。' }));
  ws.send(JSON.stringify({ type: 'chat.trigger', text: '记住，我叫小明，今年7岁。简单跟我打个招呼。' }));
});

ws.on('message', (d) => {
  let m;
  try { m = JSON.parse(d.toString()); } catch { return; }
  if (m.type === 'error') console.error('[e2e] server error:', m.code, m.message);
  if (m.type === 'llm.done') {
    done.push(m.text);
    console.log(`[e2e] 轮${done.length} llm.done: ${m.text}`);
    if (done.length === 1) {
      ws.send(JSON.stringify({ type: 'chat.trigger', text: '我叫什么名字？今年几岁？' }));
    } else if (done.length >= 2) {
      clearTimeout(timer);
      const r = done[1];
      const ok = r.includes('小明') && (r.includes('7') || r.includes('七'));
      console.log(ok
        ? '\n✅ E2E PASS：第二轮记得第一轮（小明 / 7 岁）→ 多轮 history 真生效'
        : '\n❌ E2E FAIL：第二轮未记住 → ' + r);
      ws.close();
      process.exit(ok ? 0 : 1);
    }
  }
});

ws.on('error', (e) => { console.error('[e2e] ws error', e.message); process.exit(3); });
