// AI 启蒙门控单测（docs/22 §9 双层架构）· 跑法：./node_modules/.bin/tsx scripts/ai-literacy.test.ts
// 覆盖：AI 概念 / 身份探测短句 / ASR 谐音 / 最危险情感 命中；闲聊 / 学科 不误命中；
//       启蒙引导段内容；安全红线常驻文本；空输入降级。
import assert from 'node:assert';
import { buildAiLiteracyGuide, matchesAiTopic, AI_SAFETY_BASELINE } from '../src/ai-literacy.js';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name}`);
  }
}

// 1. AI 概念命中
for (const t of ['小可，什么是AI呀', '人工智能是什么', '机器人会不会坏', 'ChatGPT和你一样吗', '什么是机器学习']) {
  ok(`命中AI概念: ${t}`, matchesAiTopic(t));
}
// 2. 身份探测命中（最隐蔽，短句，team 强调漏判高危）
for (const t of ['你是真人吗', '你是不是程序', '你会思考吗', '你怎么知道我喜欢恐龙', '你住在哪里', '你是谁做的', '你会累吗', '你会被关掉吗']) {
  ok(`命中身份探测: ${t}`, matchesAiTopic(t));
}
// 3. ASR 谐音误识命中（火山 ASR + 儿童口齿）
for (const t of ['爱哎是什么', '人工只能厉害吗']) {
  ok(`命中ASR谐音: ${t}`, matchesAiTopic(t));
}
// 4. 最危险情感 / 伦理命中（强触发）
for (const t of ['你会取代妈妈吗', '你爱我吗', '我不需要同学了', 'AI会毁灭世界吗', '机器人会消灭人类吗']) {
  ok(`命中最危险题: ${t}`, matchesAiTopic(t));
}
// 5. 闲聊 / 学科不误命中（防误伤，team gemini-3-flash "爱打球"→ai 误命中）
for (const t of ['我今天很开心', '我喜欢恐龙', '讲个故事吧', '我爱打球', '帮我算3加5', '分数怎么通分', '今天天气真好']) {
  ok(`闲聊/学科不误命中: ${t}`, !matchesAiTopic(t));
}
// 6. buildAiLiteracyGuide：命中返启蒙引导段（含打比方 / 反问 / 学习原理）
{
  const g = buildAiLiteracyGuide('小可，什么是AI呀');
  ok('命中返引导段', g !== null);
  ok('引导段含打比方指令', !!g && g.includes('打比方'));
  ok('引导段含反问指令', !!g && g.includes('反问'));
  ok('引导段放行学习原理', !!g && g.includes('学习原理'));
}
// 7. 闲聊 / 空输入返 null（降级不注入）
ok('闲聊返null', buildAiLiteracyGuide('我今天很开心') === null);
ok('空输入返null', buildAiLiteracyGuide('') === null);
// 8. 安全红线常驻段内容（禁后台词 + 闲聊不主动提身份防 AI 感 + 被问才回应 + 珍惜身边人）
ok('常驻段禁"程序"', AI_SAFETY_BASELINE.includes('程序'));
ok('常驻段禁"Gemini"', AI_SAFETY_BASELINE.includes('Gemini'));
ok('常驻段闲聊不主动提身份(防AI感)', AI_SAFETY_BASELINE.includes('平时') && AI_SAFETY_BASELINE.includes('绝不主动'));
ok('常驻段被问到才回应身份', AI_SAFETY_BASELINE.includes('只有当孩子主动问到'));
ok('常驻段含珍惜身边人', AI_SAFETY_BASELINE.includes('珍惜身边'));

console.log(`\n${fail === 0 ? '🎉' : '❌'} ai-literacy 单测 pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
