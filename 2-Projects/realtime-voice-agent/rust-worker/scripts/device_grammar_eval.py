# -*- coding: utf-8 -*-
import sys, re, collections
sys.path.insert(0, sys.argv[1]); SP = sys.argv[1]
import device_grammar_proto as G

def act(l): return G.ACTION.get(l, '?')

# ---------- E1 词表一致性（关掉精确匹配，纯语法） ----------
ok_label = ok_action = miss = wrong = 0; miss_list = []; wrong_list = []
for text, lab in G.ALIAS.items():
    g, why = G.grammar(text)
    if g is None: miss += 1; miss_list.append((text, lab, why))
    elif g == lab: ok_label += 1
    elif act(g) == act(lab): ok_action += 1
    else: wrong += 1; wrong_list.append((text, lab, g, why))
print(f"E1 词表 389 条纯语法回放：标签全对 {ok_label}｜同动作不同标签 {ok_action}｜漏 {miss}｜错动作 {wrong}")
print("  错动作：", [(t, f"应{l}/{act(l)}", f"得{g}/{act(g)}", w) for t, l, g, w in wrong_list])
print("  漏：", [(t, l, w) for t, l, w in miss_list])

# ---------- E2 自然句正例 ----------
POS = [('把灯弄亮一点吧',4),('太暗了看不清',4),('把灯开到最亮',5),('把灯调暗一点',6),('太亮了',6),('灯太刺眼了关掉吧',3),
       ('画面调到最远',35),('画面拉远一点',33),('画面离我太远了拉近点',34),('读写台升高一点',27),('读写台太低了',27),('先静音一下',44),('把声音打开吧',45),
       ('声音再大一点',37),('色温调暖',14),('灯光调冷一级',13),('光调冷一点',15),('灯光关闭',3),('声音太大',38),('啊调暗一点',6),('空调暗一点',6),
       ('可以关灯吗',3),('你能把灯打开吗',2),('我想把灯调暗一点',6),('灯光弄暗一些',6),('声音调小一点点',38),('画面再往远一点',33),('读写台再高一点点',27),
       ('把光调暖一点',14),('灯太暗了',4),('灯光有点刺眼',6),('声音有点太大了',38),('音量再大一些',37),('把设备降低一些',26),('画面太近了',33)]
hit = 0; rows = []
for t, exp in POS:
    l, why = G.combined(t)
    status = '对' if l == exp else ('同动作' if l and act(l) == act(exp) else ('漏' if l is None else '错'))
    hit += status in ('对', '同动作'); rows.append(f"  {status} 「{t}」 期望 {exp}/{act(exp)} 得 {l}/{act(l) if l else '-'} ({why})")
print(f"E2 自然句正例 {len(POS)} 条：命中 {hit}（含同动作）")
print('\n'.join(rows))

# ---------- E3 全语料 ----------
finals = collections.Counter(); prop = {}
for ln in open(f'{SP}/corpus_raw.tsv', encoding='utf-8'):
    src, ts, payload = ln.rstrip('\n').split('\t', 2)
    if payload.startswith('stt final: '):
        finals[payload[len('stt final: '):].strip()] += 1
    elif payload.startswith('device command proposed:'):
        m = re.search(r"proposed: '([^']*)'.*?semantic_label=(\d+).*?lane=\"?(\w+)\"?", payload)
        if m: prop.setdefault(m.group(1), []).append((int(m.group(2)), m.group(3), ts[:16]))
total = sum(finals.values()); uniq = len(finals)
ex_hit = sum(c for t, c in finals.items() if G.exact(t))
g_only = {t: c for t, c in finals.items() if not G.exact(t) and G.grammar(t)[0]}
print(f"\nE3 全语料：{total} 句（去重 {uniq}）｜现词表精确命中 {ex_hit} 句｜语法额外命中 {sum(g_only.values())} 句（去重 {len(g_only)} 句）")
lanes = collections.Counter(l for v in prop.values() for _, l, _ in v)
print(f"  历史命令 {sum(lanes.values())} 条：{dict(lanes)}")
# 历史 L2 提案在语法下的结果
print("  历史 L2 提案：")
for t, v in prop.items():
    for lab, lane, ts in v:
        if lane == 'L2':
            l, why = G.combined(t); print(f"    「{t}」 历史→{lab} {ts} ｜ 语法→{l} ({why})")
print("\n  语法额外命中全表（按出现次数；需人工判：真意图=词表漏掉的收益，非意图=误开火）：")
for t, c in sorted(g_only.items(), key=lambda x: -x[1]):
    l, why = G.grammar(t); hist = prop.get(t)
    print(f"    {c:>3}× 「{t}」→{l}/{act(l)} [{why}]" + (f" 历史:{[(a,b) for a,b,_ in hist]}" if hist else ''))
# 语法为何拦住：统计长度分布
short = sum(c for t, c in finals.items() if len(G.strip_polite(G.normalize(t))) <= G.MAX_LEN)
print(f"\n  ≤{G.MAX_LEN} 字的句子 {short} 句（语法只看这些），其余 {total-short} 句直接不看")

# ---------- E4 负例 ----------
NEG = ['画面调到5米','画面调到十米','音量调到60','亮度调到二档','哦也对','班长','对有一点像这个','我今年长高了一点','讲个月亮的故事','今天的灯会真好看',
       '这个呢这本身没啥这个那我们这个产品是是别人代工的','比较低够劲','嗯','太吵了','听不清','看不清','安静点','别说了','闭嘴','太啰嗦',
       '我刚才把灯关了','灯为什么会亮','小明把灯关了','妈妈让我关灯','灯关了吗','声音好听','画面好漂亮','读写台是什么','音量键在哪','外面太亮了','太阳好亮',
       '我不要关灯','别开灯','不用调了','灯坏了','灯不亮了','你的声音真好听','把灯泡换了','红绿灯变绿了','我画画的时候灯很亮','今天天气太冷了','这个故事太长了','我长高了']
fp = []
for t in NEG:
    l, why = G.combined(t)
    if l: fp.append((t, l, why))
print(f"\nE4 负例 {len(NEG)} 条：误开火 {len(fp)} → {fp}")
