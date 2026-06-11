// scripts/typewriter-test.ts
// npx tsx 直跑单测：验证 TTS 字幕打字机引擎契约
// 覆盖：切句、打字推进、句间停顿、advance 行为、进行中句、finish/reset 语义、finalize 覆盖、stale 防护

import {
  createSubtitleTypewriter,
  getSharedTypewriter,
  __resetSharedTypewriterForTesting,
  type TypewriterCallbacks,
} from '../src/kidshub/subtitle/typewriter';

type TestResult = { name: string; pass: boolean; detail?: string };

const results: TestResult[] = [];
let totalPass = 0;
let totalFail = 0;

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  if (pass) totalPass++; else totalFail++;
  const mark = pass ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ' :: ' + detail : ''}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('=== typewriter 单测开始 (charMs=5, clearDelayMs=30) ===\n');

  // ===== Case 1: 三句文本流入 + 三次 advanceSentence → 按句推进 + 每句完整显示过 =====
  {
    const onTextCalls: string[] = [];
    const onClearCalls: number[] = [];
    const cb: TypewriterCallbacks = {
      onText: (t) => onTextCalls.push(t),
      onClear: () => onClearCalls.push(1),
    };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30 });

    tw.feedText('你好。');
    tw.feedText('世界！');
    tw.feedText('再见。');

    tw.advanceSentence(); // 句0
    await sleep(25); // 足够打完 "你好。" (3字)
    tw.advanceSentence(); // 句1
    await sleep(25);
    tw.advanceSentence(); // 句2
    await sleep(25);

    const hasFull0 = onTextCalls.includes('你好。');
    const hasFull1 = onTextCalls.includes('世界！');
    const hasFull2 = onTextCalls.includes('再见。');
    const last = onTextCalls[onTextCalls.length - 1];
    const ok =
      hasFull0 &&
      hasFull1 &&
      hasFull2 &&
      last === '再见。' &&
      onClearCalls.length === 0; // 未 finish
    record(
      '三句流入+三次advance',
      ok,
      `calls=${onTextCalls.length} last=${last} fulls=${hasFull0 && hasFull1 && hasFull2}`,
    );
  }

  // ===== Case 2: 进行中句：delta分多次喂，打字追尾暂停、追加后继续 =====
  {
    const onTextCalls: string[] = [];
    const cb: TypewriterCallbacks = {
      onText: (t) => onTextCalls.push(t),
      onClear: () => {},
    };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30 });

    tw.advanceSentence();
    tw.feedText('你好');
    await sleep(15); // 打到尾 "你好" (2字)
    const atEnd = onTextCalls[onTextCalls.length - 1] === '你好';

    tw.feedText('，世界。'); // 追加使闭合
    await sleep(25); // 继续打 "，世界。"

    const hasFull = onTextCalls.includes('你好，世界。');
    const ok = atEnd && hasFull;
    record('进行中句delta多次+追尾续打', ok, `atEnd=${atEnd} hasFull=${hasFull} last=${onTextCalls[onTextCalls.length - 1]}`);
  }

  // ===== Case 3: advance时上句未打完 → 立即收到上句完整，再开始下句 =====
  {
    const onTextCalls: string[] = [];
    const cb: TypewriterCallbacks = {
      onText: (t) => onTextCalls.push(t),
      onClear: () => {},
    };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30 });

    tw.feedText('第一句。第二句。');
    tw.advanceSentence();
    await sleep(6); // 只打了一两个字 "第" or "第一"
    const beforeAdvanceLen = onTextCalls.length;
    const beforeLast = onTextCalls[beforeAdvanceLen - 1];

    tw.advanceSentence(); // 应 sync 补完 "第一句。"
    await sleep(1); // 让 sync 进入数组
    const afterSyncLen = onTextCalls.length;
    const sawFullPrev = onTextCalls.includes('第一句。');

    // 下一句开始打字（第一 tick 后出现前缀）
    await sleep(12);
    const sawNextStart = onTextCalls.some((s) => s.startsWith('第') && s.includes('二') || s === '第二句。' || onTextCalls.includes('第二句。'));

    const ok = sawFullPrev && afterSyncLen > beforeAdvanceLen && (sawNextStart || onTextCalls.includes('第二句。'));
    record(
      'advance未完补全上句再切下句',
      ok,
      `beforeLast=${beforeLast} sawFullPrev=${sawFullPrev} nextAppeared=${onTextCalls.some((x) => x.includes('二'))}`,
    );
  }

  // ===== Case 4: finishPlayback 补完当前句 + clearDelay 后 onClear 恰好一次 =====
  {
    const onTextCalls: string[] = [];
    let clearCount = 0;
    const cb: TypewriterCallbacks = {
      onText: (t) => onTextCalls.push(t),
      onClear: () => {
        clearCount++;
      },
    };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30 });

    tw.feedText('只此一句。');
    tw.advanceSentence();
    await sleep(20); // 打完大部
    tw.finishPlayback();
    // 立即应补完
    const sawFull = onTextCalls.includes('只此一句。');
    await sleep(50); // 超过 clearDelay=30
    const ok = sawFull && clearCount === 1;
    record('finish补完+clear恰好一次', ok, `sawFull=${sawFull} clearCount=${clearCount}`);
  }

  // ===== Case 5: reset 后 finishPlayback no-op（onText/onClear 都不再发生） =====
  {
    const onTextCalls: string[] = [];
    let clearCount = 0;
    const cb: TypewriterCallbacks = {
      onText: (t) => onTextCalls.push(t),
      onClear: () => {
        clearCount++;
      },
    };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30 });

    tw.feedText('旧内容。');
    tw.advanceSentence();
    await sleep(10);
    tw.reset(); // 清状态 + timers
    const lenAfterReset = onTextCalls.length;

    tw.finishPlayback(); // 必须 no-op
    await sleep(50);
    const noNewText = onTextCalls.length === lenAfterReset;
    const noClear = clearCount === 0;
    const ok = noNewText && noClear;
    record('reset后finishPlayback_no-op', ok, `noNewText=${noNewText} noClear=${noClear}`);
  }

  // ===== Case 6: reset 取消 pending clear（reset 前刚 finishPlayback） =====
  {
    const onTextCalls: string[] = [];
    let clearCount = 0;
    const cb: TypewriterCallbacks = {
      onText: (t) => onTextCalls.push(t),
      onClear: () => {
        clearCount++;
      },
    };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30 });

    tw.feedText('会清的句。');
    tw.advanceSentence();
    await sleep(15);
    tw.finishPlayback(); // 安排 clearTimer
    tw.reset(); // 必须取消 pending clear
    await sleep(60); // 超过 delay
    const ok = clearCount === 0;
    record('reset取消pending_clear', ok, `clearCount=${clearCount}`);
  }

  // ===== Case 7: finalizeText 全文覆盖后继续正确推进 =====
  {
    const onTextCalls: string[] = [];
    const cb: TypewriterCallbacks = {
      onText: (t) => onTextCalls.push(t),
      onClear: () => {},
    };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30 });

    tw.feedText('你好'); // 进行中
    tw.advanceSentence();
    await sleep(8);
    tw.feedText('，世'); // 追加
    await sleep(8);
    // 权威全文（可能修正或补全）
    tw.finalizeText('你好，世界！再见。');
    // 继续推进
    tw.advanceSentence(); // 完成当前（可能瞬间），切到下一
    await sleep(25);
    tw.advanceSentence();
    await sleep(25);

    const hasFull1 = onTextCalls.includes('你好，世界！');
    const hasFull2 = onTextCalls.includes('再见。');
    const ok = hasFull1 && hasFull2;
    record('finalize全文覆盖后推进', ok, `has1=${hasFull1} has2=${hasFull2} totalCalls=${onTextCalls.length}`);
  }

  // ===== Case 8: 空状态 finish 无副作用 + 基本 reset 防护（多轮） =====
  {
    const onTextCalls: string[] = [];
    let clearCount = 0;
    const cb: TypewriterCallbacks = {
      onText: (t) => onTextCalls.push(t),
      onClear: () => {
        clearCount++;
      },
    };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30 });

    tw.reset();
    tw.finishPlayback();
    tw.finishPlayback();
    await sleep(20);
    const before = onTextCalls.length + clearCount;

    tw.feedText('新的一句。');
    tw.advanceSentence();
    await sleep(15);
    tw.finishPlayback();
    await sleep(50);

    const after = onTextCalls.length + clearCount;
    const ok = before === 0 && clearCount === 1 && onTextCalls.includes('新的一句。');
    record('空reset+多finish无副作用', ok, `clear=${clearCount} hasFull=${onTextCalls.includes('新的一句。')}`);
  }

  // ===== Case 9: getSharedTypewriter 首次cb生效 + 后续忽略（简单验证） =====
  {
    __resetSharedTypewriterForTesting();
    const callsA: string[] = [];
    const callsB: string[] = [];
    const cbA: TypewriterCallbacks = { onText: (t) => callsA.push(t), onClear: () => {} };
    const cbB: TypewriterCallbacks = { onText: (t) => callsB.push(t), onClear: () => {} };

    const tw1 = getSharedTypewriter(cbA, { charMs: 5, clearDelayMs: 30 });
    const tw2 = getSharedTypewriter(cbB, { charMs: 999, clearDelayMs: 999 }); // 应忽略

    tw1.feedText('共享测试。');
    tw1.advanceSentence();
    await sleep(40); // 给 5 字 + 边距足够时间

    const usedA = callsA.length > 0;
    const usedB = callsB.length > 0;
    record('getShared首次cb生效', usedA && !usedB, `usedA=${usedA} usedB=${usedB} lenA=${callsA.length}`);

    // 清理
    tw1.reset();
    __resetSharedTypewriterForTesting();
  }

  // ===== Case 10: 连续标点归同一句 + 尾部无标点为partial =====
  {
    const onTextCalls: string[] = [];
    const cb: TypewriterCallbacks = { onText: (t) => onTextCalls.push(t), onClear: () => {} };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30 });
    tw.feedText('测试！？继续。');
    tw.advanceSentence();
    await sleep(30); // 4字 + 边距
    const sawCombined = onTextCalls.includes('测试！？');
    tw.advanceSentence();
    await sleep(20);
    const sawNext = onTextCalls.includes('继续。');
    record('连续标点同一句+切句正确', sawCombined && sawNext, `sawCombined=${sawCombined} sawNext=${sawNext} last=${onTextCalls[onTextCalls.length-1]}`);
  }

  // ===== Case 11: 自动跨句兜底——外部 advance 缺失（TTS 并段）时 autoAdvanceMs 后自己推进 =====
  {
    const onTextCalls: string[] = [];
    const cb: TypewriterCallbacks = { onText: (t) => onTextCalls.push(t), onClear: () => {} };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30, autoAdvanceMs: 40 });
    tw.feedText('短句！第二句来了。');
    tw.advanceSentence(); // 仅一次外部信号（实战卡 3：「朵朵！」后 TTS 没再发句边界）
    // autoAdvanceMs 有 Math.max(200,...) 生产下限（防配置过小抖动），传 40 实际生效 200
    await sleep(290); // 第一句打完(3字×5ms) + 兜底 200ms + 第二句打完(6字×5ms) + 边距
    const sawSecond = onTextCalls.includes('第二句来了。');
    record('自动跨句兜底(外部信号缺失不卡死)', sawSecond, `last=${onTextCalls[onTextCalls.length - 1]}`);
    tw.reset();
  }

  // ===== Case 12: 外部信号比文本句数多 → 末句原地不动不越界 =====
  {
    const onTextCalls: string[] = [];
    const cb: TypewriterCallbacks = { onText: (t) => onTextCalls.push(t), onClear: () => {} };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 30, autoAdvanceMs: 5000 });
    tw.feedText('只有一句。');
    tw.advanceSentence();
    await sleep(40);
    tw.advanceSentence(); // 多余信号（TTS 按逗号拆段时会发生）
    tw.advanceSentence();
    await sleep(20);
    tw.feedText('后来的句子。'); // idx 未越界 → 新句来了 reconcile 仍能工作
    tw.advanceSentence();
    await sleep(50);
    const ok = onTextCalls.includes('只有一句。') && onTextCalls.includes('后来的句子。');
    record('多余 advance 不越界且后续句可恢复', ok, `last=${onTextCalls[onTextCalls.length - 1]}`);
    tw.reset();
  }

  // ===== Case 13: finishPlayback 快进到最后一句（中途卡住也停在最后说的话上） =====
  {
    const onTextCalls: string[] = [];
    let clears = 0;
    const cb: TypewriterCallbacks = { onText: (t) => onTextCalls.push(t), onClear: () => { clears++; } };
    const tw = createSubtitleTypewriter(cb, { charMs: 5, clearDelayMs: 20, autoAdvanceMs: 5000 });
    tw.feedText('第一句。中间句。最后一句。');
    tw.advanceSentence(); // 只推进到第一句
    await sleep(30);
    tw.finishPlayback(); // 播完：应直接显示最后一句而不是停在第一句
    const lastShown = onTextCalls[onTextCalls.length - 1];
    await sleep(40);
    record('finishPlayback 快进末句+清空', lastShown === '最后一句。' && clears === 1, `last=${lastShown} clears=${clears}`);
  }

  console.log(`\n=== 结果汇总：PASS=${totalPass} FAIL=${totalFail} ===`);
  if (totalFail === 0) {
    console.log('ALL GREEN');
    process.exit(0);
  } else {
    console.log('有失败用例');
    results.filter((r) => !r.pass).forEach((r) => console.error('FAIL:', r.name, r.detail));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
