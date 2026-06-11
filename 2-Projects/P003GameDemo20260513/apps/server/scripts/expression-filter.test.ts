/**
 * 表情标记流式过滤器回归测试 · 跑法：npm run test:expr（tsx 直跑，无测试框架依赖）
 *
 * 覆盖：标记切碎多 delta / 无标记零缓冲放行 / 全角冒号容错 / 裸短标记容错
 * （temperature 1.0 实测 LLM 会省"表情："前缀）/ 带冒号·超长【】保护 /
 * 超长未闭合防卡流 / 流截断 flush 兜底（不让 TTS 念"表情："）/ resolved 后正文【】不受影响。
 */
import { createExpressionFilter, stripExpressionTag } from '../src/expression-filter.js';

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

// 1. 标准标记被切碎在多个 delta
let f = createExpressionFilter();
eq('1a 碎片缓冲', f.feed('【表'), { text: '' });
eq('1b 闭合解析', f.feed('情：比心】今天'), { text: '今天', expression: '比心' });
eq('1c 后续透传', f.feed('真棒'), { text: '真棒' });

// 2. 无标记回复立即放行（零缓冲损耗）
f = createExpressionFilter();
eq('2a 非【开头直通', f.feed('哇，指挥官'), { text: '哇，指挥官' });

// 3. 半角冒号 + 空格容错
f = createExpressionFilter();
eq('3a 冒号容错', f.feed('【表情: 开心跳起】 哦耶'), { text: '哦耶', expression: '开心跳起' });

// 4. 裸短标记容错（LLM 省"表情："前缀）
f = createExpressionFilter();
eq('4a 裸标记', f.feed('【打招呼大笑】朵朵！'), { text: '朵朵！', expression: '打招呼大笑' });
f = createExpressionFilter();
eq('4b 裸标记菜单外名（前端忽略）', f.feed('【今日任务】出发'), { text: '出发', expression: '今日任务' });
f = createExpressionFilter();
eq('4c 带冒号【】不剥', f.feed('【注意：安全】好'), { text: '【注意：安全】好' });
f = createExpressionFilter();
eq('4d 超10字【】不剥', f.feed('【这是一个很长很长的标题块】好'), { text: '【这是一个很长很长的标题块】好' });

// 5. 超长未闭合 → 放行防卡流
f = createExpressionFilter();
const long = `【${'表'.repeat(45)}`;
eq('5a 超长放行', f.feed(long), { text: long });

// 6. 流截断 flush 兜底
f = createExpressionFilter();
eq('6a 纯标记回复', f.feed('【表情：睡觉】'), { text: '', expression: '睡觉' });
f = createExpressionFilter();
eq('6b 截断缓冲', f.feed('【表情：睡'), { text: '' });
eq('6c flush 解析半截名', f.flush(), { text: '', expression: '睡' });
f = createExpressionFilter();
eq('6d 截断无名', f.feed('【表情：'), { text: '' });
eq('6e flush 丢弃不念', f.flush(), { text: '' });

// 7. 开头空白再标记
f = createExpressionFilter();
eq('7a 空白前缀', f.feed('  \n【表情：遵命】收到'), { text: '收到', expression: '遵命' });

// 8. 非流式整段剥离
eq('8a 标准', stripExpressionTag('【表情：比耶】我们赢啦'), { text: '我们赢啦', expression: '比耶' });
eq('8b 无标记', stripExpressionTag('我们赢啦'), { text: '我们赢啦' });
eq('8c 裸标记', stripExpressionTag('【打招呼大笑】朵朵，欢迎来到方舟！'), {
  text: '朵朵，欢迎来到方舟！',
  expression: '打招呼大笑',
});

// 9. resolved 后正文里的【】不受影响
f = createExpressionFilter();
f.feed('【表情：微笑】好');
eq('9a 正文【】透传', f.feed('看【宝箱】哦'), { text: '看【宝箱】哦' });

// 10. flush 幂等
f = createExpressionFilter();
f.feed('【表情：晕');
f.flush();
eq('10a 二次 flush 空', f.flush(), { text: '' });

// 11. 裸标记切碎在多个 delta
f = createExpressionFilter();
eq('11a 裸碎片缓冲', f.feed('【开心'), { text: '' });
eq('11b 裸闭合解析', f.feed('跳起】耶！'), { text: '耶！', expression: '开心跳起' });

console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
