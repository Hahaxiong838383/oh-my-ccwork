#!/usr/bin/env python3
"""hotindex-derive.py 重排逻辑测试（构造小热索引；不碰真实文件）。
用法：python3 hotindex-derive.test.py [被测脚本路径]   ——负向验证时传一份故意改坏的副本，必须变红。"""
import os, sys, importlib.util, collections

SCRIPT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hotindex-derive.py')
os.environ.setdefault('HX_HOT_K', '2'); os.environ.setdefault('HX_GUARD_CAP', '30')
spec = importlib.util.spec_from_file_location('hx', SCRIPT); hx = importlib.util.module_from_spec(spec); spec.loader.exec_module(hx)

SRC = """# Memory Index
> 头部规则一行。

## ★ 项目
- [proj_a](project_a.md) ★ — 项目甲状态
- [user_hw](user_hardware.md) — 真值锚

## ★ 参考
- [ref_a](reference_a.md) — 参考甲

## ★ 教训（只留那类）
- [criteria](feedback_criteria_must_match_object_variant.md) — 判据要对准对象形态，这一行很长很长很长很长很长很长很长很长
- [truncated](feedback_truncated_output_negative_conclusion.md) — 截断后别下不存在结论，这一行也很长很长很长很长很长很长很长
- [hollow](feedback_hollow_200_needs_payload_check.md) — 空壳 200 要看载荷
- 三兄弟 [truncated](feedback_truncated_output_negative_conclusion.md)／[census](feedback_signal_census_on_target_subset.md) — 多链接行
- [quiet](feedback_quiet_lesson.md) — 近期没复发的教训

## 🗂 场景簇
- **簇甲**(~3)：a/b/c → `rg 'a|b|c'`
"""
DST_OLD = SRC + """
## 🏠 开发机本地
- [local_one](project_local_one.md) — 本机一行

## 🔥 近 28 天复发且尚无守门/提醒（上一轮派生物，不该被当本地区块带过去）
- [hollow](feedback_hollow_200_needs_payload_check.md) — 旧的 🔥 行 ×9
"""
hot = collections.Counter({'feedback_criteria_must_match_object_variant.md': 3, 'feedback_hollow_200_needs_payload_check.md': 2,
                           'feedback_truncated_output_negative_conclusion.md': 5, 'feedback_signal_census_on_target_subset.md': 1})
cover = lambda f: 'C' if f == 'feedback_truncated_output_negative_conclusion.md' else None

PASS = FAIL = 0
def chk(name, cond):
    global PASS, FAIL
    if cond: PASS += 1; print('  ✅', name)
    else: FAIL += 1; print('  ❌', name)

lb = hx.local_block_of(DST_OLD)
chk('本地区块只取到 🔥 节之前（不把上一轮派生物带过去）', 'local_one' in lb and '🔥' not in lb and '旧的 🔥 行' not in lb)
new = hx.derive(SRC, lb, 0, None, hot, cover)
les = new.split('## ★ 教训')[1].split('\n## ')[0]
hot_sec = new.split('\n## 🔥')[1] if '\n## 🔥' in new else ''
chk('🔥 节在文件最末', new.rstrip().endswith(hot_sec.rstrip()) and bool(hot_sec))
chk('🔥 取未覆盖且复发最多的前 HOT_K=2：criteria ×3、hollow ×2', '[criteria]' in hot_sec and '×3' in hot_sec and '[hollow]' in hot_sec and '×2' in hot_sec)
chk('已覆盖的 truncated（×5 但有守门）不进 🔥', '- [truncated](feedback_truncated_output_negative_conclusion.md)' not in hot_sec)
chk('🔥 行从教训区移走（不复制）', '[criteria]' not in les and '[hollow]' not in les)
g_lines = [l for l in les.split('\n') if l.endswith(' 🛡')]
chk('已覆盖行截短 + 🛡 + 排到教训区末尾', len(g_lines) == 1 and '[truncated]' in g_lines[0] and len(g_lines[0]) < 120
    and les.rstrip().endswith(g_lines[0]))
chk('多链接行（含未覆盖链接）不算已覆盖，留在原区；census ×1 未进前 2', '三兄弟' in les and '三兄弟' not in hot_sec)
chk('没复发的行留在原区', '[quiet]' in les)
chk('本地区块原样保留', lb.strip() in new)
probs = hx.verify(SRC, new, lb)
chk('验证器全绿（字符/链接/行数/本地区块）', not probs)
# 幂等：拿派生结果当「现有开发机文件」再派生一次，🔥 节不翻倍、行数不变
lb2 = hx.local_block_of(new); new2 = hx.derive(SRC, lb2, 0, None, hot, cover)
chk('再派生一次幂等（🔥 不累积）', new2.count('## 🔥') == 1 and new2.count('- [criteria]') == 1 and lb2.strip() == lb.strip())
# 负向：复制一行 → 验证器必须红
dup = new.replace('- [quiet]', '- [quiet]\n- [quiet]', 1)
chk('负向：复制一行时验证器报「行数变了」', any('行数' in p for p in hx.verify(SRC, dup, lb)))
# 评估器不可用 → 不重排，仍是合法派生
plain = hx.derive(SRC, lb, 0, None, None, None)
chk('无评估器数据时不重排、无 🔥 节、验证仍过', '## 🔥' not in plain and not hx.verify(SRC, plain, lb))

print(f'\n═══ 结果：{PASS} 通过 / {FAIL} 失败 ═══')
sys.exit(1 if FAIL else 0)
