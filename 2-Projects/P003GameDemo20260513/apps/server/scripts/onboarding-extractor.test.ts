/**
 * onboarding 信息抽取纯函数回归测试 · 跑法：npm run test:onboarding（tsx 直跑，无测试框架依赖）
 *
 * 覆盖 parseOnboarding（解析 LLM 输出 JSON → 归一化 + 校验 + 去重）：
 *  - 昵称：正常抽取 / 注入符号拒 / 注入关键词拒 / 与 current 相同不重写
 *  - 性别：男/女模糊词归一到 男孩/女孩 / 与 current 相同不重写
 *  - 生日：YYYY-MM / 中文年月归一 / 只说年龄必拒（推不出年月）/ 年份越界拒 / 月份非法拒
 *  - 多字段 / 增量补字段 / 空 JSON / 非 JSON / JSON 前后带文字容错提取
 */
import { parseOnboarding } from '../src/onboarding-extractor.js';
import type { FamilyMember } from '../src/profile-store.js';

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

function mk(p: Partial<FamilyMember>): FamilyMember {
  return {
    id: 'x',
    account_id: 'acct-01',
    nickname: '',
    birthday: '',
    gender: '',
    interests: [],
    preferred_address: '',
    personality_notes: '',
    recent_emotion: '',
    game_progress: [],
    created_at: 0,
    updated_at: 0,
    ...p,
  };
}

// ---------- 昵称 ----------
eq('nick-1 正常', parseOnboarding('{"nickname":"天天"}', null), { nickname: '天天' });
eq('nick-2 注入符号拒', parseOnboarding('{"nickname":"叮@当"}', null), null);
eq('nick-3 注入关键词拒', parseOnboarding('{"nickname":"system"}', null), null);
eq('nick-4 与current相同不写', parseOnboarding('{"nickname":"天天"}', mk({ nickname: '天天' })), null);
eq('nick-5 剥前缀 我叫', parseOnboarding('{"nickname":"我叫天天"}', null), { nickname: '天天' });
eq('nick-6 剥前缀 叫我', parseOnboarding('{"nickname":"叫我朵朵"}', null), { nickname: '朵朵' });
eq('nick-7 剥前缀 我是', parseOnboarding('{"nickname":"我是小宇"}', null), { nickname: '小宇' });

// ---------- 性别归一 ----------
eq('gender-1 男→男孩', parseOnboarding('{"gender":"男"}', null), { gender: '男孩' });
eq('gender-2 女生→女孩', parseOnboarding('{"gender":"女生"}', null), { gender: '女孩' });
eq('gender-3 男孩直通', parseOnboarding('{"gender":"男孩"}', null), { gender: '男孩' });
eq('gender-4 与current相同不写', parseOnboarding('{"gender":"男"}', mk({ gender: '男孩' })), null);
eq('gender-5 双值/否定拒', parseOnboarding('{"gender":"不是男孩，是女孩"}', null), null);

// ---------- 生日归一 + 校验 ----------
eq('bday-1 标准', parseOnboarding('{"birthday":"2018-08"}', null), { birthday: '2018-08' });
eq('bday-2 中文年月归一', parseOnboarding('{"birthday":"2018年8月"}', null), { birthday: '2018-08' });
eq('bday-3 只说年龄必拒', parseOnboarding('{"birthday":"4岁"}', null), null);
eq('bday-4 年份越界拒', parseOnboarding('{"birthday":"3000-01"}', null), null);
eq('bday-5 月份非法拒', parseOnboarding('{"birthday":"2018-13"}', null), null);
eq('bday-6 与current相同不写', parseOnboarding('{"birthday":"2018-08"}', mk({ birthday: '2018-08' })), null);
eq('bday-7 中文数字归一', parseOnboarding('{"birthday":"二零一八年八月"}', null), { birthday: '2018-08' });
eq('bday-8 中文十二月', parseOnboarding('{"birthday":"二零二零年十二月"}', null), { birthday: '2020-12' });

// ---------- 多字段 / 增量 / 容错 ----------
eq('multi-1 三字段', parseOnboarding('{"nickname":"朵朵","gender":"女孩","birthday":"2019-03"}', null), {
  nickname: '朵朵',
  gender: '女孩',
  birthday: '2019-03',
});
eq('multi-2 已有昵称只补生日', parseOnboarding('{"birthday":"2018-08"}', mk({ nickname: '天天' })), {
  birthday: '2018-08',
});
eq('robust-1 JSON前后带文字', parseOnboarding('好的 {"nickname":"豆豆"} 已记录', null), { nickname: '豆豆' });
eq('robust-2 空JSON', parseOnboarding('{}', null), null);
eq('robust-3 非JSON', parseOnboarding('hello', null), null);

console.log(`\nonboarding-extractor.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
