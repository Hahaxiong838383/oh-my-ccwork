/**
 * experience-store 计数 / guard / 轻提示 / 弹窗状态机单测
 * 运行：npm run test:experience（tsx，node 环境无 localStorage → store 自动降级内存）
 */
import {
  useExperienceStore,
  MAX_SCENE_CLICKS,
  MAX_VOICE_ROUNDS,
} from '../src/kidshub/store/experience-store';

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}

const s = () => useExperienceStore.getState();

// 1. 初始态：两项都可用，无弹窗无轻提示
s().reset();
assert(s().canScene() && s().canVoice(), '初始：canScene && canVoice');
assert(!s().shouldShowHint(), '初始：无轻提示');
assert(!s().modalOpen, '初始：弹窗关闭');

// 2. 场景卡计数到上限
s().reset();
for (let i = 0; i < MAX_SCENE_CLICKS; i++) s().recordSceneClick();
assert(s().sceneClicks === MAX_SCENE_CLICKS, `场景卡计数到 ${MAX_SCENE_CLICKS}`);
assert(!s().canScene(), '场景卡到上限 → canScene false');
assert(s().canVoice(), '场景卡到上限不影响语音 → canVoice true（kind 隔离）');

// 3. 语音计数到上限
s().reset();
for (let i = 0; i < MAX_VOICE_ROUNDS; i++) s().recordVoiceRound();
assert(s().voiceRounds === MAX_VOICE_ROUNDS, `语音计数到 ${MAX_VOICE_ROUNDS}`);
assert(!s().canVoice(), '语音到上限 → canVoice false');
assert(s().canScene(), '语音到上限不影响场景卡 → canScene true（kind 隔离）');

// 4. 峰值轻提示：第 3 次场景卡触发，超限后消失
s().reset();
s().recordSceneClick();
s().recordSceneClick();
assert(!s().shouldShowHint(), '第 2 次场景卡：还没到轻提示点');
s().recordSceneClick();
assert(s().shouldShowHint(), '第 3 次场景卡：轻提示出现');
s().dismissHint();
assert(!s().shouldShowHint(), '关掉轻提示后不再显示');

// 5. 轻提示：第 2 次语音触发
s().reset();
s().recordVoiceRound();
assert(!s().shouldShowHint(), '第 1 次语音：还没到轻提示点');
s().recordVoiceRound();
assert(s().shouldShowHint(), '第 2 次语音：轻提示出现');

// 6. 超限后轻提示让位给弹窗（不再显示轻提示）
s().reset();
for (let i = 0; i < MAX_SCENE_CLICKS; i++) s().recordSceneClick();
assert(!s().shouldShowHint(), '场景卡超限后：轻提示消失（让位弹窗）');

// 7. 弹窗：可反复 open（超限后每次交互都弹，不静默放行）
s().reset();
s().openModal();
assert(s().modalOpen, 'openModal：modalOpen 置位');
s().closeModal();
assert(!s().modalOpen, 'closeModal：关闭弹窗');
s().openModal();
assert(s().modalOpen, '关闭后可再次 openModal（堵住关弹窗后无限白嫖）');

// 8. reset 清空一切
s().reset();
assert(
  s().sceneClicks === 0 && s().voiceRounds === 0 && !s().modalOpen && !s().hintDismissed,
  'reset 清空全部计数与状态',
);

console.log(`\n=== 结果汇总：PASS=${pass} FAIL=${fail} ===`);
if (fail > 0) {
  console.error('有用例失败');
  process.exit(1);
}
console.log('ALL GREEN');
