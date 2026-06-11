/**
 * 表情标记流式过滤器回归测试 · 跑法：npm run test:expr（tsx 直跑，无测试框架依赖）
 *
 * 覆盖：多标记句级 / 流开头双格式容错 + 句中仅标准 / 任意切碎缓冲 / 裸【宝箱】不误剥 /
 * 超长/带冒号非表情保护 / flush 部分闭合丢标记名 / 零标记纯文本零扣留 / strip 多标记
 */
import { createExpressionFilter, stripExpressionTags } from '../src/expression-filter.js';

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
eq('1a 碎片缓冲', f.feed('【表'), { text: '', expressions: [] });
eq('1b 闭合解析', f.feed('情：比心】今天'), { text: '今天', expressions: ['比心'] });
eq('1c 后续透传', f.feed('真棒'), { text: '真棒', expressions: [] });

// 2. 无标记回复立即放行（零缓冲损耗）
f = createExpressionFilter();
eq('2a 非【开头直通', f.feed('哇，指挥官'), { text: '哇，指挥官', expressions: [] });

// 3. 半角冒号 + 空格容错
f = createExpressionFilter();
eq('3a 冒号容错', f.feed('【表情: 开心跳起】 哦耶'), { text: '哦耶', expressions: ['开心跳起'] });

// 4. 裸短标记容错（LLM 省"表情："前缀）
f = createExpressionFilter();
eq('4a 裸标记', f.feed('【打招呼大笑】朵朵！'), { text: '朵朵！', expressions: ['打招呼大笑'] });
f = createExpressionFilter();
eq('4b 裸标记菜单外名（前端忽略）', f.feed('【今日任务】出发'), { text: '出发', expressions: ['今日任务'] });
f = createExpressionFilter();
eq('4c 带冒号【】不剥', f.feed('【注意：安全】好'), { text: '【注意：安全】好', expressions: [] });
f = createExpressionFilter();
eq('4d 超10字【】不剥', f.feed('【这是一个很长很长的标题块】好'), { text: '【这是一个很长很长的标题块】好', expressions: [] });

// 5. 超长未闭合 → 放行防卡流
f = createExpressionFilter();
const long = `【${'表'.repeat(45)}`;
eq('5a 超长放行', f.feed(long), { text: long, expressions: [] });

// 6. 流截断 flush 兜底
f = createExpressionFilter();
eq('6a 纯标记回复', f.feed('【表情：睡觉】'), { text: '', expressions: ['睡觉'] });
f = createExpressionFilter();
eq('6b 截断缓冲', f.feed('【表情：睡'), { text: '', expressions: [] });
eq('6c flush 解析半截名', f.flush(), { text: '', expressions: ['睡'] });
f = createExpressionFilter();
eq('6d 截断无名', f.feed('【表情：'), { text: '', expressions: [] });
eq('6e flush 丢弃不念', f.flush(), { text: '', expressions: [] });

// 7. 开头空白再标记
f = createExpressionFilter();
eq('7a 空白前缀', f.feed('  \n【表情：遵命】收到'), { text: '收到', expressions: ['遵命'] });

// 8. 非流式整段剥离
eq('8a 标准', stripExpressionTags('【表情：比耶】我们赢啦'), { text: '我们赢啦', expressions: ['比耶'] });
eq('8b 无标记', stripExpressionTags('我们赢啦'), { text: '我们赢啦', expressions: [] });
eq('8c 裸标记', stripExpressionTags('【打招呼大笑】朵朵，欢迎来到方舟！'), {
  text: '朵朵，欢迎来到方舟！',
  expressions: ['打招呼大笑'],
});

// 9. 句中正文里的【】不受影响（resolved 概念已删，持续扫描但仅标准）
f = createExpressionFilter();
f.feed('【表情：微笑】好');
eq('9a 正文【】透传', f.feed('看【宝箱】哦'), { text: '看【宝箱】哦', expressions: [] });

// 10. flush 幂等
f = createExpressionFilter();
f.feed('【表情：晕');
f.flush();
eq('10a 二次 flush 空', f.flush(), { text: '', expressions: [] });

// 11. 裸标记切碎在多个 delta
f = createExpressionFilter();
eq('11a 裸碎片缓冲', f.feed('【开心'), { text: '', expressions: [] });
eq('11b 裸闭合解析', f.feed('跳起】耶！'), { text: '耶！', expressions: ['开心跳起'] });

// ===== 新增句级多标记用例（B 阶段） =====

// 12. 句级三标记完整流（一个 delta）
f = createExpressionFilter();
const three = '【表情：吃惊】哇，你猜怎么着！【表情：开心跳起】方舟带回了 30 颗星尘！【表情：微笑歪头】要不要去看看呀？';
eq('12a 三标记一句', f.feed(three), {
  text: '哇，你猜怎么着！方舟带回了 30 颗星尘！要不要去看看呀？',
  expressions: ['吃惊', '开心跳起', '微笑歪头'],
});

// 13. 句中标准标记切碎跨 3 delta
f = createExpressionFilter();
eq('13a 句中首标', f.feed('【表情：吃惊】哇，你猜怎么着！【表情：开'), { text: '哇，你猜怎么着！', expressions: ['吃惊'] });
eq('13b 句中续标', f.feed('心跳起】方舟'), { text: '方舟', expressions: ['开心跳起'] });
eq('13c 句中后续', f.feed('带回了！'), { text: '带回了！', expressions: [] });

// 14. 句中裸【宝箱】不剥
f = createExpressionFilter();
eq('14a 句中裸宝箱', f.feed('【表情：微笑】看【宝箱】哦'), { text: '看【宝箱】哦', expressions: ['微笑'] });

// 15. 开头裸标记 + 句中标准混合
f = createExpressionFilter();
eq('15a 裸+标准', f.feed('【打招呼】你好【表情：开心】今天'), { text: '你好今天', expressions: ['打招呼', '开心'] });

// 16. 句中【注意：安全】（非"表情"前缀）不剥
f = createExpressionFilter();
eq('16a 句中注意安全', f.feed('【表情：微笑】注意【注意：安全】好'), { text: '注意【注意：安全】好', expressions: ['微笑'] });

// 17. 【后超 40 字无】 → 整段放行（句中场景）
f = createExpressionFilter();
f.feed('hi');
const longMid = '【' + '表'.repeat(45);
eq('17a 句中超长放行', f.feed(longMid), { text: longMid, expressions: [] });

// 18. flush 句中未闭合【表情：晕 → 丢弃文本+返回名字
f = createExpressionFilter();
f.feed('【表情：微笑】hi');
eq('18a flush句中partial', f.feed('【表情：晕'), { text: '', expressions: [] });
eq('18b flush返回名', f.flush(), { text: '', expressions: ['晕'] });

// 19. flush 带前置正文 + 未闭合标准标记
f = createExpressionFilter();
eq('19a flush前文+partial', f.feed('前文【表情：哭'), { text: '前文', expressions: [] });
eq('19b flush仅名', f.flush(), { text: '', expressions: ['哭'] });

// 20. flush 未闭合非标记 → 原样放行
f = createExpressionFilter();
eq('20a flush非标放行', f.feed('hi【宝箱未闭'), { text: 'hi', expressions: [] });
eq('20b flush剩余文', f.flush(), { text: '【宝箱未闭', expressions: [] });

console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
