// 括号旁白剥离器单测:旁白剥离/数学放行/跨delta切碎/未闭合flush/混用括号/嵌套开括号/超限放行。
// 跑法:cd apps/server && ../../node_modules/.bin/tsx scripts/paren-filter.test.ts
import assert from 'node:assert';
import { createParenFilter, stripParenAsides } from '../src/paren-filter.js';

let pass = 0;
const eq = (actual: string, expect: string, name: string) => {
  assert.equal(actual, expect, name);
  pass += 1;
  console.log(`✅ ${name}`);
};

// 1. 基础旁白剥离(全角/半角/混用)
eq(stripParenAsides('好呀！（开心地拍手）我们开始吧'), '好呀！我们开始吧', '全角中文旁白剥离');
eq(stripParenAsides('好呀!(挠了挠头)我们开始吧'), '好呀!我们开始吧', '半角中文旁白剥离');
eq(stripParenAsides('嘿嘿(笑）继续'), '嘿嘿继续', '开闭括号混用也剥');
eq(stripParenAsides('（温柔地）你好呀（眨眨眼）'), '你好呀', '多段旁白全剥');

// 2. 非旁白放行
eq(stripParenAsides('算式是(3+2)×5哦'), '算式是(3+2)×5哦', '纯数字符号放行');
eq(stripParenAsides('英文缩写(ok)放行'), '英文缩写(ok)放行', '无中文放行');
const long = '这段括号里的内容特别长超过了四十个字的上限所以应当被当作正文内容原样放行不能被吞掉哦真的很长';
eq(stripParenAsides(`前文（${long}）后文`), `前文（${long}）后文`, '超40字中文段放行(当正文)');

// 3. 跨 delta 切碎(流式)
{
  const f = createParenFilter();
  let out = '';
  out += f.feed('今天天气真好（');
  out += f.feed('开心地');
  out += f.feed('转了个圈');
  out += f.feed('）我们去玩吧');
  out += f.flush();
  eq(out, '今天天气真好我们去玩吧', '旁白跨4个delta切碎仍剥净');
}

// 4. 未闭合 flush 放行(绝不吞正文)
{
  const f = createParenFilter();
  let out = '';
  out += f.feed('结尾话没说完（这段没有闭合');
  out += f.flush();
  eq(out, '结尾话没说完（这段没有闭合', '未闭合原样放行');
}

// 5. 括号里又开括号:前段放行,新段继续判
{
  const f = createParenFilter();
  let out = '';
  out += f.feed('前面（假开头(笑)后面');
  out += f.flush();
  eq(out, '前面（假开头后面', '嵌套开括号:旧段放行新段剥');
}

// 6. 超扣留上限(60字)未闭合 → 中途整段放行
{
  const f = createParenFilter();
  const longOpen = '（' + '很长'.repeat(35); // 71 字,超 60
  const out = f.feed(longOpen) + f.feed('）尾巴') + f.flush();
  assert.ok(out.includes('很长很长'), '超限段被放行');
  assert.ok(out.includes('尾巴'), '后续正文不丢');
  pass += 1;
  console.log('✅ 超60字扣留上限中途放行');
}

// 7. 纯文本零扣留直通
{
  const f = createParenFilter();
  eq(f.feed('没有括号的普通话语直接过'), '没有括号的普通话语直接过', '纯文本直通');
}

console.log(`🎉 paren-filter ${pass}/${pass} 全过`);
