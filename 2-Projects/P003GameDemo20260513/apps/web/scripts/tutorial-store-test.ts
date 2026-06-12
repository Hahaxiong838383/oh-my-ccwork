/**
 * tutorial-store 多 unit 状态机单测（node/tsx 直跑，无 DOM）
 * 跑法：apps/web 下 `npm run test:tutorial` 或 `tsx scripts/tutorial-store-test.ts`
 */
import { useTutorialStore, currentStep } from '../src/kidshub/tutorial/tutorial-store';
import { getUnit } from '../src/kidshub/tutorial/tutorial-units';
import { matchHints } from '../src/kidshub/tutorial/tutorial-types';
import { BOARDING_HINTS } from '../src/kidshub/tutorial/tutorial-boarding';
import { READY_HINTS } from '../src/kidshub/tutorial/tutorial-settings';

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

// ── 关键词匹配 ──
expect('登舰命中', matchHints('我要登舰！', BOARDING_HINTS));
expect('同音误字命中', matchHints('登见', BOARDING_HINTS));
expect('准备好了命中', matchHints('小可我准备好了', READY_HINTS));
expect('无关话不命中', !matchHints('今天天气真好', BOARDING_HINTS));

console.log(`\n=== 结果汇总：PASS=${pass} FAIL=${fail} ===`);
if (fail === 0) console.log('ALL GREEN');
else process.exit(1);
