import assert from 'node:assert';
import { ThinkStripper, stripThink } from '../src/providers/minimax-llm.js';

// 模拟流式喂入，收集剥离后往下游（TTS）发的正文。
function collect(chunks: string[]): string {
  const s = new ThinkStripper();
  let out = '';
  for (const c of chunks) s.feed(c, (x) => (out += x));
  return out;
}

// 1) 有 think：剥离，只留 </think> 之后的正文
assert.equal(collect(['<think>\n想一想\n</think>\n\n你好！']), '你好！');
// 2) 无 think：全部直发
assert.equal(collect(['你好呀，指挥官！']), '你好呀，指挥官！');
// 3) <think> / </think> 标签被切在多个 chunk
assert.equal(collect(['<th', 'ink>思考中', '</th', 'ink>\n\n正文来了']), '正文来了');
// 4) think 后正文分多个 chunk
assert.equal(collect(['<think>x</think>你', '好', '世界']), '你好世界');
// 5) 真实 MiniMax 分块形态（第一个 chunk 就是 <think>）
assert.equal(
  collect(['<think>\n用户说', '你好\n</think>\n\n你好！愿你今天开心！😊']),
  '你好！愿你今天开心！😊',
);
// 6) stripThink 非流式（extractor 用）
assert.equal(stripThink('<think>abc</think>\n\n{"nickname":"天天"}'), '{"nickname":"天天"}');
assert.equal(stripThink('没有 think 直接正文'), '没有 think 直接正文');

console.log('✅ ThinkStripper / stripThink 全部通过（6 组含跨 chunk 边界）');
