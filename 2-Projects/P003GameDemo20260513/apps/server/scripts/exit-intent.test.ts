/**
 * 退出意图纯函数回归测试 · 跑法：npm run test:exit（tsx 直跑，无测试框架依赖）
 *
 * 覆盖：
 *  - detectExitIntent：命中告别词白名单 / 排除裸否定（不要 X 不误判）/ 带宾语否定放行 / 长句偶含告别词不误触发
 *  - createExitMarkerStripper：开头 [EXIT] 剥离（一次性 + 切碎流）/ 非标记直通 / 标记后文本放行
 *  - stripExitMarkerOnce：整段剥离
 */
import {
  detectExitIntent,
  normalizeForExit,
  createExitMarkerStripper,
  stripExitMarkerOnce,
} from '../src/exit-intent.js';

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

// ---------- detectExitIntent：命中告别词 ----------
eq('exit-1 拜拜', detectExitIntent('拜拜'), true);
eq('exit-2 再见', detectExitIntent('再见'), true);
eq('exit-3 不聊了', detectExitIntent('不聊了'), true);
eq('exit-4 不想聊了', detectExitIntent('不想聊了'), true);
eq('exit-5 别说了', detectExitIntent('别说了'), true);
eq('exit-6 你别说了', detectExitIntent('你别说了'), true);
eq('exit-7 我走了', detectExitIntent('我走了'), true);
eq('exit-8 我要走啦', detectExitIntent('我要走啦'), true);
eq('exit-9 我去玩了', detectExitIntent('我去玩了'), true);
eq('exit-10 我去睡觉了', detectExitIntent('我去睡觉了'), true);
eq('exit-11 先这样', detectExitIntent('先这样'), true);
eq('exit-12 不玩了', detectExitIntent('不玩了'), true);
eq('exit-13 不想跟你说了', detectExitIntent('不想跟你说了'), true);

// 带标点 / 语气词（归一化后命中）
eq('exit-14 拜拜带标点', detectExitIntent('拜拜~'), true);
eq('exit-15 拜拜小可！', detectExitIntent('拜拜小可！'), true);
eq('exit-16 嗯拜拜啦（短句含）', detectExitIntent('嗯拜拜啦'), true);
eq('exit-17 那再见咯（短句含）', detectExitIntent('那再见咯'), true);
eq('exit-18 我去睡觉了。', detectExitIntent('我去睡觉了。'), true);

// ---------- detectExitIntent：严格排除裸否定（核心防误判）----------
eq('neg-1 不要', detectExitIntent('不要'), false);
eq('neg-2 不', detectExitIntent('不'), false);
eq('neg-3 我不', detectExitIntent('我不'), false);
eq('neg-4 我不要', detectExitIntent('我不要'), false);
eq('neg-5 不行', detectExitIntent('不行'), false);
eq('neg-6 不知道', detectExitIntent('不知道'), false);
eq('neg-7 我不想', detectExitIntent('我不想'), false);

// ---------- detectExitIntent：带宾语的否定句放行（不退出）----------
eq('obj-1 我不要吃青菜', detectExitIntent('我不要吃青菜'), false);
eq('obj-2 我不想写作业', detectExitIntent('我不想写作业'), false);
eq('obj-3 我不喜欢这个', detectExitIntent('我不喜欢这个'), false);
eq('obj-4 这个不好玩', detectExitIntent('这个不好玩'), false);
eq('obj-5 不要走（含走但非告别短语）', detectExitIntent('不要走'), false);

// ---------- detectExitIntent：长句里偶含告别词不误触发 ----------
eq('long-1 含再见的长句', detectExitIntent('我跟你说再见面的时候要打招呼'), false);
eq('long-2 含拜拜的叙述长句', detectExitIntent('今天同学跟我说拜拜的时候我很开心'), false);
eq('long-3 普通问句', detectExitIntent('小可你知道恐龙为什么灭绝吗'), false);
eq('long-4 空串', detectExitIntent(''), false);
eq('long-5 纯标点', detectExitIntent('。。。'), false);

// ---------- normalizeForExit ----------
eq('norm-1', normalizeForExit('拜拜~小可！'), '拜拜小可');
eq('norm-2', normalizeForExit('我..要走啦。'), '我要走啦');
eq('norm-3', normalizeForExit('  不聊 了  '), '不聊了');

// ---------- createExitMarkerStripper：完整开头标记一次到达 ----------
let s = createExitMarkerStripper();
eq('mk-1a 整块', s.feed('[EXIT]小可先去休息啦'), { text: '小可先去休息啦', exit: true });
eq('mk-1b 后续直通', s.feed('～'), { text: '～', exit: false });
eq('mk-1c hasExit', s.hasExit(), true);

// 全角方括号 + 大小写 + 前导空白容错
s = createExitMarkerStripper();
eq('mk-2 全角大小写', s.feed('  【exit】 再见啦'), { text: '再见啦', exit: true });
s = createExitMarkerStripper();
eq('mk-3 小写', s.feed('[exit]拜拜'), { text: '拜拜', exit: true });

// ---------- createExitMarkerStripper：标记被切碎在多个 delta ----------
s = createExitMarkerStripper();
eq('mk-4a 碎片1', s.feed('[E'), { text: '', exit: false });
eq('mk-4b 碎片2', s.feed('XI'), { text: '', exit: false });
eq('mk-4c 碎片3闭合', s.feed('T]好的'), { text: '好的', exit: true });
eq('mk-4d hasExit', s.hasExit(), true);

// ---------- createExitMarkerStripper：开头非标记 → 直通不吞 ----------
s = createExitMarkerStripper();
eq('mk-5 普通开头', s.feed('哇，指挥官！'), { text: '哇，指挥官！', exit: false });
eq('mk-5b hasExit false', s.hasExit(), false);

// 开头是 [ 但不是 EXIT（如 LLM 偶发 [笑]）→ 放行
s = createExitMarkerStripper();
eq('mk-6 方括号非exit', s.feed('[笑]你好呀'), { text: '[笑]你好呀', exit: false });

// 表情标记开头（【表情：xxx】）不应被 EXIT 剥离器吞（留给表情过滤器）
s = createExitMarkerStripper();
eq('mk-7 表情标记直通', s.feed('【表情：开心】你好'), { text: '【表情：开心】你好', exit: false });

// flush：只发了半截疑似前缀 → 当普通文本放行不吞
s = createExitMarkerStripper();
eq('mk-8a 半截前缀扣留', s.feed('[EX'), { text: '', exit: false });
eq('mk-8b flush 放行', s.flush(), { text: '[EX', exit: false });

// flush：空流
s = createExitMarkerStripper();
eq('mk-9 flush 空', s.flush(), { text: '', exit: false });

// ---------- stripExitMarkerOnce ----------
eq('once-1', stripExitMarkerOnce('[EXIT]小可先去休息啦～'), '小可先去休息啦～');
eq('once-2 全角', stripExitMarkerOnce('【EXIT】再见'), '再见');
eq('once-3 无标记', stripExitMarkerOnce('普通回复'), '普通回复');
eq('once-4 标记仅开头剥一次', stripExitMarkerOnce('[EXIT]中间也有[EXIT]字样'), '中间也有[EXIT]字样');

console.log(`\nexit-intent.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
