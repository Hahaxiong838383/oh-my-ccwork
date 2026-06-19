/**
 * L_curriculum KG 回归测试 · 跑法：npx tsx scripts/curriculum-kg.test.ts（tsx 直跑，无框架）
 * 覆盖：概念名匹配 / 防误命中（闲聊不触发）/ 先修子图方向 / 护栏组装（隐藏黑话+过渡语）/ 降级 null
 * 依赖真实 KG 数据 data/k12-kgraph/{nodes,edges}.json（docs/20）。
 */
import { curriculumKG } from '../src/curriculum-kg.js';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL ${name}`);
  }
}

// 1. 概念名命中（长名优先 + label=Concept）
ok('match 分数', curriculumKG.match('老师今天讲了分数我没听懂')?.name === '分数');
ok('match 光合作用', curriculumKG.match('光合作用是怎么回事呀')?.name === '光合作用');

// 2. 防误命中：闲聊 / 情绪 / 学习泛词都不该命中（team grok/gemini 双向越界防范）
ok('不误命中-情绪', curriculumKG.match('我不开心想哭') === null);
ok('不误命中-学习泛词', curriculumKG.match('妈妈说我要好好学习') === null);
ok('不误命中-纯闲聊', curriculumKG.match('今天天气真好想出去玩') === null);

// 3. 先修子图方向（prerequisites_for：source 是 target 先修，与离线验证一致）
const dx = curriculumKG.match('今天学了动作电位好难');
ok('match 动作电位', dx?.name === '动作电位');
ok('动作电位先修含静息电位', !!dx && curriculumKG.getPrereqs(dx.id).includes('静息电位'));
ok('未命中概念取先修为空', curriculumKG.getPrereqs('nonexistent_id_xxx').length === 0);

// 4. 护栏组装（隐藏 KG 黑话 + 过渡语自发 + 不报菜名指引）
const g = curriculumKG.buildGuardrail('老师讲了分数我没听懂');
ok('护栏含标题', !!g && g.includes('课程引导护栏'));
ok('护栏含命中概念', !!g && g.includes('分数'));
ok('护栏含过渡语指引', !!g && g.includes('让小可想想'));
ok('护栏含禁黑话约束', !!g && g.includes('绝不说'));
ok('护栏含闲聊忽略分支', !!g && g.includes('忽略'));

// 5. 降级 null（闲聊不注入，主链路正常陪伴）
ok('闲聊 buildGuardrail 降级 null', curriculumKG.buildGuardrail('我不开心想哭') === null);
ok('空文本降级 null', curriculumKG.buildGuardrail('') === null);

console.log(`\ncurriculum-kg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
