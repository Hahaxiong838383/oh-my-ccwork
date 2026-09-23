#!/usr/bin/env python3
"""evaluate-memory-policy.py 的严口径测试（构造记忆目录，不碰真实记忆）。
用法：python3 evaluate-memory-policy.test.py [被测脚本路径]   ——负向验证时传一份故意改坏的副本，必须变红。"""
import os, sys, json, tempfile, datetime, importlib.util

SCRIPT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'evaluate-memory-policy.py')
T = tempfile.mkdtemp(prefix='evaltest-')
MEM = os.path.join(T, 'memory'); os.makedirs(MEM)
ts = lambda s: datetime.datetime.fromisoformat(s).timestamp()

def mem(name, body, born, mtime=None, osid=None, extra_meta=''):
    fm = f"---\nname: {name}\ndescription: x\nmetadata:\n  type: feedback\n{extra_meta}"
    if osid:
        fm += f"  originSessionId: {osid}\n"
    fm += "---\n\n"
    p = os.path.join(MEM, name + '.md')
    open(p, 'w').write(fm + body + '\n')
    t = ts(mtime or born)
    os.utime(p, (t, t))
    return name + '.md', ts(born)

births = {}
def add(*a, **k):
    f, b = mem(*a, **k); births[f] = b

open(os.path.join(MEM, 'MEMORY.md'), 'w').write("## ★ 教训\n- [alias-three](feedback_old3.md) — x\n")
add('feedback_old1', '旧坑一', '2026-08-01')
add('feedback_old2', '旧坑二\n同族 [[feedback_old3]]\n这次又踩了 [[feedback_old1]]', '2026-08-02', mtime='2026-09-06')   # 下面差异日志里 9-06 追加了后一行
add('feedback_old3', '旧坑三', '2026-08-03')
add('project_hub', '项目档案', '2026-08-03')
add('feedback_old_same', '同会话写的', '2026-08-30', osid='aaaaaaaa-1111')
add('feedback_n_strong', '这次又踩了 [[feedback_old1]] 的坑', '2026-09-01')
add('feedback_n_weak', '关联：[[feedback_old1]]（背景）', '2026-09-01')
add('feedback_n_reverse', '反向同族：[[feedback_old1]]（方向相反）', '2026-09-01')
add('feedback_n_decl', '另见 [[feedback_old1]]', '2026-09-01', extra_meta='  recurrence_of: [feedback_old2]\n')
add('feedback_n_decl_empty', '又踩了 [[feedback_old1]]', '2026-09-01', extra_meta='  recurrence_of: []\n')
add('feedback_n_block', '正文不提', '2026-09-01', extra_meta='  recurrence_of:\n    - feedback_old1.md\n')
add('feedback_n_alias', '变体 [[alias-three]]', '2026-09-01')
add('feedback_n_edited_old', '又踩了 [[feedback_old1]]', '2026-08-10', mtime='2026-09-01')   # 老文件被编辑：mtime 新、出生旧
add('feedback_n_same', '又踩了 [[feedback_old_same]]', '2026-09-01', osid='aaaaaaaa-1111')
add('feedback_n_badref', '正文', '2026-09-01', extra_meta='  recurrence_of: [no_such_lesson]\n')
json.dump(births, open(os.path.join(T, 'births.json'), 'w'))

# Air git 差异日志：一次自身追加、一次原样挪动的小节（不算）、一次往老文件追加的强链接、一次原样挪动的链接（不算）
open(os.path.join(T, 'diff.log'), 'w').write(f"""@@COMMIT {int(ts('2026-09-05T10:00'))}
diff --git a/m/feedback_old1.md b/m/feedback_old1.md
+## 2026-09-05 变体：又一种形态
+正文
@@COMMIT {int(ts('2026-09-05T11:00'))}
diff --git a/m/feedback_old2.md b/m/feedback_old2.md
+## 二犯：换了个场景（不带关键词，也算）
diff --git a/m/project_hub.md b/m/project_hub.md
+## 2026-09-05 变体：项目档案里的不算
+**2026-09-05 又一次**：加粗也不算
@@COMMIT {int(ts('2026-09-06T10:00'))}
diff --git a/m/feedback_old3.md b/m/feedback_old3.md
-## 2026-08-25 变体：挪位置
+## 2026-08-25 变体：挪位置
diff --git a/m/feedback_old2.md b/m/feedback_old2.md
+这次又踩了 [[feedback_old1]]
-同族 [[feedback_old3]]
+同族 [[feedback_old3]]
""")

os.environ.update(EVAL_MEM_DIR=MEM, EVAL_TRJ=os.path.join(T, 'none'), EVAL_TRJ_AIR=os.path.join(T, 'none'),
                  EVAL_BIRTHS=os.path.join(T, 'births.json'), EVAL_DIFFLOG=os.path.join(T, 'diff.log'))
spec = importlib.util.spec_from_file_location('ev', SCRIPT); ev = importlib.util.module_from_spec(spec); spec.loader.exec_module(ev)
r = ev.compute_full(); K = r['kinds']
pairs = {(p[0], p[1]): p for p in r['pairs']}
selfs = {(f, d) for f, d, _, _ in r['self_events']}

PASS = FAIL = 0
def chk(name, cond):
    global PASS, FAIL
    if cond: PASS += 1; print('  ✅', name)
    else: FAIL += 1; print('  ❌', name)

k = lambda o, n: K.get((o + '.md', n + '.md'))
print('═══ 语境判定（无字段）═══')
chk('「又踩了 [[x]]」→ strong', k('feedback_old1', 'feedback_n_strong') == 'strong')
chk('「关联：[[x]]」→ weak（宽口径计、严口径不计）', k('feedback_old1', 'feedback_n_weak') == 'weak')
chk('「反向同族 [[x]]」→ weak（明说不是同一个坑）', k('feedback_old1', 'feedback_n_reverse') == 'weak')
chk('热索引短别名 [[alias-three]] 能解析且判 strong', k('feedback_old3', 'feedback_n_alias') == 'strong')
chk('别名解析到常驻区 → resident=lesson', pairs.get(('feedback_old3.md', 'feedback_n_alias.md'), [None] * 4)[3] == 'lesson')
print('═══ recurrence_of 字段优先 ═══')
chk('字段声明的旧教训 → declared（正文没链接也算）', k('feedback_old2', 'feedback_n_decl') == 'declared')
chk('有字段时，未声明的链接 → declared_not', k('feedback_old1', 'feedback_n_decl') == 'declared_not')
chk('recurrence_of: [] 压过正文「又踩了」→ declared_not', k('feedback_old1', 'feedback_n_decl_empty') == 'declared_not')
chk('YAML 块列表 + .md 后缀 → declared', k('feedback_old1', 'feedback_n_block') == 'declared')
chk('字段里解析不到的名字进 decl_unresolved', r['decl_unresolved'].get('no_such_lesson') == 1)
print('═══ 时间用出生台账 ═══')
chk('出生在窗口前、被编辑过的老文件不算新复发', ('feedback_old1.md', 'feedback_n_edited_old.md') not in pairs)
print('═══ 同会话排除 ═══')
chk('同一会话写的两条互链不计', ('feedback_old_same.md', 'feedback_n_same.md') not in pairs and r['same_session'] == 1)
print('═══ Air git 差异 ═══')
chk('老教训自己文件里追加「日期+变体」小节 → 自身复发事件', ('feedback_old1.md', '2026-09-05') in selfs)
chk('同一提交里原样挪动的变体小节不算', not any(f == 'feedback_old3.md' for f, _ in selfs))
chk('老教训追加不带关键词的 ## 小节（「二犯：…」）也算', ('feedback_old2.md', '2026-09-05') in selfs)
chk('项目档案里追加的变体小节/加粗不算', not any(f == 'project_hub.md' for f, _ in selfs))
p = pairs.get(('feedback_old1.md', 'feedback_old2.md'))
chk('往出生在窗口前的老文件追加强链接 → 计入，按追加时刻、检索维 None',
    p is not None and k('feedback_old1', 'feedback_old2') == 'strong' and p[4] is None
    and datetime.date.fromtimestamp(r['dates'][('feedback_old1.md', 'feedback_old2.md')]).isoformat() == '2026-09-06')
chk('原样挪动的链接不算追加', ('feedback_old3.md', 'feedback_old2.md') not in pairs)
print('═══ 台账只增不改 ═══')
b2 = json.load(open(os.path.join(T, 'births.json')))
chk('没见过的文件入账、已有的不被 mtime 改写', 'MEMORY.md' not in b2 and b2['feedback_n_edited_old.md'] == births['feedback_n_edited_old.md'])

print('═══ 提醒覆盖归类 ═══')
chk('acceptance_numbers → A', ev.cover_group('feedback_acceptance_numbers_need_causal_link.md') == 'A')
chk('D 组已回滚：criteria_must_match_object_variant → 未覆盖', ev.cover_group('feedback_criteria_must_match_object_variant.md') is None)
chk('truncated_output → C', ev.cover_group('feedback_truncated_output_negative_conclusion.md') == 'C')
chk('未覆盖的教训 → None', ev.cover_group('feedback_old1.md') is None)

print('═══ 守门 G 组 / 近期计数 / CUPED+序贯 ═══')
chk('probe_parameters（8-01 起有窄守门）→ G', ev.cover_group('feedback_probe_parameters_are_facts_too.md') == 'G')
chk('truncated 同时在 C 组与守门 → 归 C（nudge 优先）', ev.cover_group('feedback_truncated_output_negative_conclusion.md') == 'C')
rc = ev.recent_counts(r, days=30, today=datetime.date(2026, 9, 10))
chk('recent_counts：old1 = 链接式 3（strong/declared/追加）+ 自身追加 1 = 4', rc.get('feedback_old1.md') == 4)
chk('recent_counts：窗口外不计（today 提前到 9-02 → old1 只剩 9-01 的 2 条）', ev.recent_counts(r, days=30, today=datetime.date(2026, 9, 2)).get('feedback_old1.md') == 2)
import random
rng = random.Random(7)
null = [('T' if i % 2 else 'C', rng.random(), rng.choice([0, 0, 0, 1, 1, 2])) for i in range(200)]
res0 = ev.cuped_avi(null)
chk('无效应时 always-valid p 不显著、区间含 0', res0 and res0['p'] > 0.05 and res0['ci'][0] <= 0 <= res0['ci'][1])
eff = [('T', 0.0, rng.choice([0, 0, 0, 0, 1])) for _ in range(300)] + [('C', 0.0, rng.choice([1, 2, 2, 3])) for _ in range(300)]
res1 = ev.cuped_avi(eff)
chk('强效应时 p<0.05、区间在 0 以下、Δ 为负', res1 and res1['p'] < 0.05 and res1['ci'][1] < 0 and res1['delta'] < 0)
corr = []
for i in range(300):
    x = rng.random() * 4; corr.append(('T' if i % 2 else 'C', x, x + rng.random() * 0.5))
res2 = ev.cuped_avi(corr)
chk('协变量与结果相关时 CUPED 方差缩减 > 50%', res2 and res2['var_reduction'] > 0.5)
chk('样本不足（每组 <2）返回 None', ev.cuped_avi([('T', 0, 1), ('C', 0, 1)]) is None)

print(f'\n═══ 结果：{PASS} 通过 / {FAIL} 失败 ═══')
sys.exit(1 if FAIL else 0)
