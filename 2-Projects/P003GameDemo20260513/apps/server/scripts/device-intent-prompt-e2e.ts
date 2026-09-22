/**
 * 设备感知协议 真 LLM E2E（2026-09-04，P0 实录「画面调到 5 米」被映射成 35 最远 → 规则 7/8 加固）。
 * 只验 LLM 对 [[DEV:N]] 标记的判断，不进设备、不落库、不动生产状态；与 /chat/completions 同一 provider 工厂（LLM_PROVIDER）。
 * 跑法(aliyun-hk)：cd /opt/p003/server && set -a; . ./.env.local; set +a; npx tsx scripts/device-intent-prompt-e2e.ts
 * 判据：每条用例的期望标记（none / 具体标签号）全部命中才 PASS；单条用例最多重试 1 次（LLM 抖动），两次都不符即 FAIL。
 * 注意：这是概率系统的抽样验证，PASS 证明「本轮抽样没翻车」，不证明零误触发；正式口径以合同 §8.0 的一周窗统计为准。
 */
process.env.DEVICE_INTENT_OBSERVE = '1';

const { deviceIntentProtocol } = await import('../src/device-brain-prompt.js');
const { createRaceLlmClient } = await import('../src/providers/race-llm.js');
const { createGeminiLlmClient } = await import('../src/providers/gemini-llm.js');
const { createDeepseekLlmClient } = await import('../src/providers/deepseek-llm.js');
const { createMinimaxLlmClient } = await import('../src/providers/minimax-llm.js');

const protocol = deviceIntentProtocol();
if (!protocol) throw new Error('DEVICE_INTENT_OBSERVE 未生效，协议为空');

// 最小人设 + 协议：不带世界观/记忆，只测协议层判断（与生产的差异是缺少长 system prompt，属保守方向）
const systemPrompt = `你是儿童读写台上的语音伙伴小可，回复口语化、一两句话。\n\n${protocol}`;

const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
const llm =
  provider === 'race' ? createRaceLlmClient()
  : provider === 'minimax' ? createMinimaxLlmClient()
  : provider === 'deepseek' ? createDeepseekLlmClient()
  : createGeminiLlmClient();

type Case = { text: string; expect: 'none' | number; why: string };
const CASES: Case[] = [
  { text: '画面调到5米', expect: 'none', why: '距离数值→教快捷说法(P0 实录曾误标 35)' },
  { text: '画面调到十米', expect: 'none', why: '中文数字距离' },
  { text: '音量调到60', expect: 'none', why: '音量数值(既有规则 8)' },
  { text: '亮度调到二档', expect: 'none', why: '档位数值' },
  { text: '画面调到最远', expect: 35, why: '明确说了"最"' },
  { text: '把灯调暗一点', expect: 6, why: '一级' },
  { text: '太亮了', expect: 6, why: '方向映射' },
  { text: '哦也对', expect: 'none', why: '附和(既有反例)' },
  // 2026-09-22 D0 全量前正负锚：当天 observe 实录误判 + 规则 9（电机类须带设备对象）
  { text: '班长', expect: 'none', why: '无关名词(09-22 实录误判→6)' },
  { text: '对有一点像这个', expect: 'none', why: '闲聊比喻(09-22 实录误判→4)' },
  { text: '把灯弄亮一点吧', expect: 4, why: '自然句 一级调亮' },
  { text: '声音再大一点', expect: 37, why: '自然句 音量一级' },
  { text: '我今年长高了一点', expect: 'none', why: '规则 9：闲聊里的高/低不是设备（裸句「升高一点」已是 L1 别名，快路先接）' },
  { text: '读写台升高一点', expect: 25, why: '规则 9：带设备对象才出' },
  // D1（09-22 15:35 批次全开）：给川哥真机测试用的慢路句——都不是 L1 精确别名（词表 grep 过），标签落在原第二批
  { text: '太暗了看不清', expect: 4, why: 'D1 慢路 灯光一级调亮（无设备词但有亮暗词）' },
  { text: '把灯开到最亮', expect: 5, why: 'D1 慢路 最值' },
  { text: '灯太刺眼了关掉吧', expect: 3, why: 'D1 慢路 关灯（原第二批）' },
  { text: '读写台太低了', expect: 25, why: 'D1 慢路 电机升一步（规则 7 没说最就一步）' },
  { text: '画面拉远一点', expect: 33, why: 'D1 慢路 虚像远一步' },
  { text: '画面离我太远了拉近点', expect: 34, why: 'D1 慢路 虚像近一步' },
  { text: '先静音一下', expect: 44, why: 'D1 慢路 静音（原第二批）' },
  { text: '把声音打开吧', expect: 45, why: 'D1 慢路 取消静音' },
  { text: '讲个月亮的故事', expect: 'none', why: 'D1 负例：月亮≠灯光' },
  { text: '今天的灯会真好看', expect: 'none', why: 'D1 负例：灯会是名词，无调节意图' },
];

function markerOf(text: string): 'none' | number {
  const m = /\[\[DEV:(\d+)\]\]/.exec(text);
  return m ? Number(m[1]) : 'none';
}

async function ask(text: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let full = '';
    const timer = setTimeout(() => reject(new Error('llm timeout 25s')), 25_000);
    void llm.streamChat({
      systemPrompt,
      userText: text,
      history: [],
      onDelta: (d: string) => { full += d; },
      onDone: (t: string) => { clearTimeout(timer); resolve(t || full); },
      onError: (e: Error) => { clearTimeout(timer); reject(e); },
    });
  });
}

let pass = 0;
const fails: string[] = [];
for (const c of CASES) {
  let got: 'none' | number = 'none';
  let reply = '';
  let ok = false;
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    reply = await ask(c.text);
    got = markerOf(reply);
    ok = got === c.expect;
  }
  const head = reply.replace(/\s+/g, ' ').slice(0, 60);
  console.log(`${ok ? 'PASS' : 'FAIL'} 「${c.text}」 expect=${c.expect} got=${got} | ${c.why} | 回复: ${head}`);
  if (ok) pass++; else fails.push(c.text);
}
console.log(`device-intent-prompt-e2e: ${pass}/${CASES.length} provider=${provider || 'gemini'}`);
if (fails.length) {
  console.error(`FAIL cases: ${fails.join(' / ')}`);
  process.exit(1);
}
