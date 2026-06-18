// P0.2 画像注入 E2E：发 session.meta(nickname/age/gender) 后，抓 debug.prompt_assembled，
// 验证后端 Orchestrator 把「关于这个孩子」块注入了最终 systemPrompt。
// 跑法：E2E_WS_URL=ws://127.0.0.1:3001/ws/voice node scripts/p0-profile-e2e.mjs
import WebSocket from 'ws';

const URL = process.env.E2E_WS_URL || 'ws://127.0.0.1:3001/ws/voice';
const ws = new WebSocket(URL);
const timer = setTimeout(() => { console.error('❌ timeout 30s'); process.exit(2); }, 30000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'session.config', systemPrompt: '你是儿童陪伴机器人小可，回复简短。' }));
  // session.meta 字段平铺顶层（线上协议，parseSessionMeta 读 rec.sessionId，非嵌套 meta:{}）
  ws.send(JSON.stringify({
    type: 'session.meta',
    sessionId: 'e2e-profile', sceneId: null, nickname: '小明', gender: '男孩', age: '7岁', captureMode: 'off', source: 'card',
  }));
  ws.send(JSON.stringify({ type: 'chat.trigger', text: '你好' }));
});

ws.on('message', (d) => {
  let m;
  try { m = JSON.parse(d.toString()); } catch { return; }
  if (m.type === 'error') console.error('[e2e] server error:', m.code, m.message);
  if (m.type === 'debug.prompt_assembled') {
    clearTimeout(timer);
    const sp = m.systemPrompt || '';
    const ok = sp.includes('关于这个孩子') && sp.includes('小明') && sp.includes('7岁');
    console.log('[e2e] systemPrompt 尾部 160 字:\n' + sp.slice(-160));
    console.log(ok
      ? '\n✅ 画像注入 PASS：systemPrompt 含「关于这个孩子」+ 小明 + 7岁'
      : '\n❌ 画像未注入');
    ws.close();
    process.exit(ok ? 0 : 1);
  }
});

ws.on('error', (e) => { console.error('[e2e] ws error', e.message); process.exit(3); });
