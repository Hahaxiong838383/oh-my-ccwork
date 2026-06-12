/**
 * tutorial-store 多 unit 状态机单测（node/tsx 直跑，无 DOM）
 * 跑法：apps/web 下 `npm run test:tutorial` 或 `tsx scripts/tutorial-store-test.ts`
 */
import { useTutorialStore, currentStep } from '../src/kidshub/tutorial/tutorial-store';
import { getUnit, TUTORIAL_UNITS } from '../src/kidshub/tutorial/tutorial-units';
import { matchHints } from '../src/kidshub/tutorial/tutorial-types';
import { BOARDING_HINTS } from '../src/kidshub/tutorial/tutorial-boarding';
import { READY_HINTS } from '../src/kidshub/tutorial/tutorial-settings';
import { WAKE_HINTS } from '../src/kidshub/tutorial/tutorial-night-report';
import { CLAIM_HINTS } from '../src/kidshub/tutorial/tutorial-focus';

let pass = 0;
let fail = 0;

function expect(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL: ${name}`);
  }
}

function s() {
  return useTutorialStore.getState();
}

// ── 注册表 ──
expect('注册表含 boarding+settings', !!getUnit('boarding') && !!getUnit('settings'));
expect('boarding 排在 settings 前（navOrder）', (getUnit('boarding')?.navOrder ?? 99) < (getUnit('settings')?.navOrder ?? 0));
expect('未知 unit 启动被拒', (s().start('nonexistent'), !s().isActive));

// ── boarding 全流程 ──
s().start('boarding');
expect('boarding 启动', s().isActive && s().unitId === 'boarding' && s().stepIndex === 0);
expect('step1 无语音有时长', currentStep(s())?.voiceCopy === null && (currentStep(s())?.durationMs ?? 0) === 5000);
expect('step1 scene=alert + alarm', currentStep(s())?.scene === 'alert' && currentStep(s())?.sound === 'alarm');

s().onSpeechEnd(); // 1→2（定时到等价）
s().onSpeechEnd(); // 2→3
s().onSpeechEnd(); // 3→4
expect('step4 带 nickname 占位', currentStep(s())?.voiceCopy?.includes('{child_nickname}') === true);
s().onSpeechEnd(); // 4→5
expect('step5 等待 boot-button', currentStep(s())?.waitFor === 'boot-button');
expect('step5 播完转 waiting', (s().onSpeechEnd(), s().phase === 'waiting'));

// 提醒计数 ×3
expect('提醒1 未超限', s().onRemindTick().exceeded === false);
expect('提醒2 未超限', s().onRemindTick().exceeded === false);
expect('提醒3 超限', s().onRemindTick().exceeded === true);

// 不匹配的操作不消费
expect('错误目标不推进', s().advanceOnAction('brightness') === false && currentStep(s())?.waitFor === 'boot-button');
// 正确操作推进到末步
expect('boot-button 推进', s().advanceOnAction('boot-button') === true);
expect('末步 celebrating', s().phase === 'celebrating' && currentStep(s())?.isUnitEnd === true);
s().onSpeechEnd(); // 庆祝播完 → complete
expect('boarding 完成退出', !s().isActive && s().completedUnits['boarding'] === true);
expect('settings 未被波及', s().completedUnits['settings'] !== true);

// ── 打断不标记完成 ──
s().resetForDebug();
expect('重置清空完成标记', s().completedUnits['boarding'] === false);
s().start('boarding');
s().onSpeechEnd();
s().interrupt();
expect('打断退出且不标记完成', !s().isActive && s().completedUnits['boarding'] === false);

// ── settings 回归（unit 切换不串台） ──
s().start('settings');
expect('settings 启动 step1', s().unitId === 'settings' && currentStep(s())?.id === '1');
s().onSpeechEnd(); // 1→2
expect('settings step2 等 open-panel', currentStep(s())?.waitFor === 'open-panel');
expect('boarding 的 boot-button 在 settings 不消费', s().advanceOnAction('boot-button') === false);
expect('open-panel 推进+面板打开', s().advanceOnAction('open-panel') === true && s().panelOpen === true);
s().interrupt();

// ── 夜航报告全流程 ──
s().start('night-report');
expect('夜航启动', s().isActive && s().unitId === 'night-report');
expect('链条顺序：登舰<设置<夜航', (() => {
  const order = TUTORIAL_UNITS.map((u) => u.id);
  return order.indexOf('boarding') < order.indexOf('settings') && order.indexOf('settings') < order.indexOf('night-report');
})());
expect('设置单元衔接指向专注', getUnit('settings')?.nextUnitId === 'focus' && !!getUnit('settings')?.outroCopy);
s().onSpeechEnd(); // 1→2
s().onSpeechEnd(); // 2→3
s().onSpeechEnd(); // 3→4
expect('step4 无语音纯特效', currentStep(s())?.voiceCopy === null && (currentStep(s())?.durationMs ?? 0) > 0);
s().onSpeechEnd(); // 4→5
expect('step5 庆祝文案', currentStep(s())?.expression === 'jump-joy');
s().onSpeechEnd(); // 5→6
expect('step6 吃惊彩蛋', currentStep(s())?.expression === 'surprised');
s().onSpeechEnd(); // 6→7
expect('step7 等唤醒词', currentStep(s())?.waitFor === 'wake-word');
s().onSpeechEnd();
expect('step7 转 waiting', s().phase === 'waiting');
expect('唤醒词推进到收尾', s().advanceOnAction('wake-word') === true && currentStep(s())?.id === '8');
expect('收尾步 celebrating', s().phase === 'celebrating' && currentStep(s())?.isUnitEnd === true);
s().onSpeechEnd();
expect('夜航完成落盘', !s().isActive && s().completedUnits['night-report'] === true);

// 超时跳步路径：3 次提醒后 forceNext 也应落到收尾步而非卡死
s().resetForDebug();
s().start('night-report');
for (let i = 0; i < 6; i++) s().onSpeechEnd(); // 1→7
s().onSpeechEnd(); // 7 waiting
s().onRemindTick(); s().onRemindTick();
expect('第3次提醒超限', s().onRemindTick().exceeded === true);
s().forceNext();
expect('超时跳步落到收尾步', currentStep(s())?.id === '8' && s().phase === 'celebrating');
s().interrupt();

// ── 专注模式全流程 ──
s().resetForDebug();
s().start('focus');
expect('专注启动', s().isActive && s().unitId === 'focus');
for (let i = 0; i < 4; i++) s().onSpeechEnd(); // 1→5
expect('step5 无语音计时幕', currentStep(s())?.voiceCopy === null && currentStep(s())?.scene === 'focus-counting');
s().onSpeechEnd(); // 5→6
expect('step6 宝箱出现吃惊', currentStep(s())?.expression === 'surprised' && currentStep(s())?.scene === 'chest-ready');
s().onSpeechEnd(); // 6→7
expect('step7 等获取奖励', currentStep(s())?.waitFor === 'claim-reward');
s().onSpeechEnd();
expect('step7 转 waiting', s().phase === 'waiting');
expect('点宝箱推进开箱', s().advanceOnAction('claim-reward') === true && currentStep(s())?.scene === 'chest-open');
s().onSpeechEnd(); // 8→9
expect('step9 总结收尾', currentStep(s())?.isUnitEnd === true && s().phase === 'celebrating');
s().onSpeechEnd();
expect('专注完成落盘', !s().isActive && s().completedUnits['focus'] === true);

// ── 生态缸全流程 ──
s().start('eco-pond');
expect('生态缸启动', s().unitId === 'eco-pond');
s().onSpeechEnd(); // 1→2
expect('step2 种子升起无语音', currentStep(s())?.voiceCopy === null && currentStep(s())?.scene === 'seed-rise');
s().onSpeechEnd(); // 2→3
s().onSpeechEnd(); // 3→4
expect('step4 收尾步', currentStep(s())?.isUnitEnd === true);
s().onSpeechEnd();
expect('生态缸完成（全部引导结束）', !s().isActive && s().completedUnits['eco-pond'] === true);

// ── 五单元链条 ──
expect('链条顺序 登舰→设置→专注→夜航→生态缸', (() => {
  const ids = TUTORIAL_UNITS.map((u) => u.id);
  return JSON.stringify(ids) === JSON.stringify(['boarding', 'settings', 'focus', 'night-report', 'eco-pond']);
})());
expect('outro 链 settings→focus→night→eco 闭合', (() => {
  return (
    getUnit('boarding')?.nextUnitId === 'settings' &&
    getUnit('settings')?.nextUnitId === 'focus' &&
    getUnit('focus')?.nextUnitId === 'night-report' &&
    getUnit('night-report')?.nextUnitId === 'eco-pond' &&
    getUnit('eco-pond')?.nextUnitId === undefined
  );
})());
s().resetForDebug();

// ── 关键词匹配 ──
expect('开箱口令命中', matchHints('打开宝箱！', CLAIM_HINTS));
expect('登舰命中', matchHints('我要登舰！', BOARDING_HINTS));
expect('同音误字命中', matchHints('登见', BOARDING_HINTS));
expect('准备好了命中', matchHints('小可我准备好了', READY_HINTS));
expect('唤醒词命中', matchHints('小可小可！', WAKE_HINTS));
expect('唤醒词同音命中', matchHints('小科小科', WAKE_HINTS));
expect('单叠"小可"不命中（防误触吞 LLM）', !matchHints('小可你好呀', WAKE_HINTS));
expect('无关话不命中', !matchHints('今天天气真好', BOARDING_HINTS));

console.log(`\n=== 结果汇总：PASS=${pass} FAIL=${fail} ===`);
if (fail === 0) console.log('ALL GREEN');
else process.exit(1);
