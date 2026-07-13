#!/usr/bin/env node
// e2e-ws.mjs <ws-url> — chat.trigger 三场景 E2E：收 debug.prompt_assembled 验护栏注入
import WebSocket from 'ws';

const URL = process.argv[2] || 'ws://127.0.0.1:3001/ws/voice';
const CASES = [
  { tag: '陪伴域-间接', text: '小可 我的小鸭子放在水里怎么不会沉下去呀' },
  { tag: 'K12-学科(应curriculum优先)', text: '什么是光合作用呀 老师说叶子会自己做饭' },
  { tag: '负样本-闲聊(应零注入)', text: '今天晚饭吃饺子 我最爱韭菜馅的' },
];

const results = [];
for (const c of CASES) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`${c.tag}: 8s 超时未收到 prompt_assembled`)); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'chat.trigger', text: c.text })));
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.type === 'debug.prompt_assembled') {
          const sp = msg.systemPrompt || '';
          results.push({
            tag: c.tag, text: c.text,
            companion: sp.includes('陪伴引导参考'),
            curriculum: sp.includes('课程引导护栏'),
            anchor: sp.includes('【牢记】'),
            companionExcerpt: sp.includes('陪伴引导参考') ? sp.slice(sp.indexOf('陪伴引导参考') - 5, sp.indexOf('陪伴引导参考') + 260) : null,
          });
          clearTimeout(timer); ws.close(); resolve();
        }
      } catch {}
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  }).catch((e) => results.push({ tag: c.tag, error: e.message }));
}
console.log(JSON.stringify(results, null, 2));
