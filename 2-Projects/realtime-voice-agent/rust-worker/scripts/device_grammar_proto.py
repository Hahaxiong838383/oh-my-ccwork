# -*- coding: utf-8 -*-
"""语法匹配原型 v2（离线验证用）：对象 + 动作/方向 + 程度 → 标签。只用于出证据，不上生产。"""
import re, sys
SP = sys.argv[1] if len(sys.argv) > 1 else '.'
import os
_TSV = f'{SP}/prod_aliases.tsv'
if not os.path.exists(_TSV):  # 默认用仓库里的词表（与生产 /root/rust-worker/device_aliases.tsv 同 md5 fc7b54d3…）
    _TSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'device_aliases.tsv')
rows = [l.rstrip('\n').split('\t') for l in open(_TSV, encoding='utf-8') if l.strip() and not l.startswith('#')]
ACTION = {}; ALIAS = {}
for r in rows:
    lab = int(r[0]); ACTION[lab] = r[1]
    for t in [r[2].strip()] + [a.strip() for a in r[3].split(',') if a.strip()]:
        ALIAS.setdefault(t, lab)
PRE = ["可以帮我", "麻烦", "帮我", "小可", "请", "把", "好", "那", "嗯", "哎", "哦", "啊", "呃", "就"]
SUF = ["可以吗", "好吗", "一下", "吧", "啊", "呀", "哈", "呢", "哦", "了"]
PUNCT = re.compile(r"[\s,.!?;:'\"()\[\]{}<>~`@#$%^&*+=|\\/，。！？；：、“”‘’（）【】《》…—·~]")
def normalize(t): return PUNCT.sub('', t or '').strip()
def peel(t):
    """与 Rust match_command 同构：每轮先查表再剥一层，最多 4 轮。返回 (查表命中, 剥完的串)"""
    s = normalize(t)
    if not s: return None, ''
    for _ in range(4):
        if s in ALIAS: return ALIAS[s], s
        peeled = False
        for p in PRE:
            if s.startswith(p) and len(s) > len(p): s = s[len(p):]; peeled = True; break
        for x in SUF:
            if s.endswith(x) and len(s) > len(x): s = s[:-len(x)]; peeled = True; break
        if not peeled: return None, s
    return ALIAS.get(s), s
def exact(text): return peel(text)[0]
def strip_polite(text): return peel(text)[1]

# ---------- 语法：先挡（宁漏勿误）----------
NEG = ["不要", "不用", "别", "不是", "没有", "没", "不能", "不会", "不想", "不许", "不准", "不可以", "不行", "不知道"]
NEG_ADJ = re.compile(r'不(高|亮|暗|大|小|远|近|暖|冷|开|关|响)')
NARR = ["刚才", "刚刚", "刚", "昨天", "已经", "之前", "以前", "然后", "后来", "一直", "总是", "忘了", "忘记", "曾经", "上次", "昨晚", "又", "着"]
DISCUSS = ["如果", "要是", "假如", "万一", "但是", "不过", "可是", "因为", "所以", "或者", "还是", "到底", "同时", "效果", "米数", "数值", "参数",
           "也", "用", "说", "你看", "看看", "挺", "比较", "怕", "它", "这样", "那样", "一种", "会", "应该", "可能", "好像", "感觉", "觉得", "其实", "反正", "而且"]
PERCEPT = ["听不到", "听不见", "听不清", "看不清", "看不见", "太吵", "好吵", "啰嗦", "安静"]
QWORDS = ["为什么", "为啥", "怎么", "什么", "哪", "几", "多少", "会不会", "是不是", "有没有", "吗", "呢"]
REQ = ["可以", "能不能", "能", "帮我", "请", "麻烦", "要", "想", "给我", "让", "需要", "希望", "来", "得"]
THIRD = ["他", "她", "妈妈", "爸爸", "老师", "同学", "别人", "大家", "小明", "朋友", "哥哥", "姐姐", "弟弟", "妹妹", "爷爷", "奶奶", "外公", "外婆", "叔叔", "阿姨", "他们", "她们", "你们", "咱们"]
CHAT_SENSE = ["空调", "灯会", "灯笼", "灯谜", "红绿灯", "路灯", "车灯", "闪光灯", "灯塔", "花灯", "神灯", "灯火", "灯泡", "灯节", "点灯", "灯下",
              "开心", "开始", "开学", "开门", "开车", "开会", "开玩笑", "离开", "开水", "开花", "关系", "关心", "关于", "关门", "关注", "关键", "海关", "机关",
              "好看", "好听", "漂亮", "真美", "好美", "真好", "喜欢", "讨厌", "害怕", "故事", "唱", "歌", "游戏", "电影", "视频", "动画", "比赛",
              "太阳", "月亮", "星星", "天气", "外面", "屋里", "房间", "教室", "学校", "画面感", "音量键", "声音像", "声音好", "声音真", "声音很"]
SELF_REQ = ["我要", "我想", "我得", "我需要", "我希望", "给我", "让我", "我来"]
MAX_LEN = 14
DIGIT = re.compile(r'[0-9０-９]|百分之(?!百)|[一二三四五六七八九十]+(米|厘米|分米|度|格)')
DONE = re.compile(r'(关|开|调)了(灯|光)')

LIGHT_OBJ = ["灯光", "台灯", "灯", "光线", "亮度"]
CT_OBJ = ["色温", "光谱", "暖光", "冷光", "中性光", "暖色", "冷色", "中性", "绘画模式", "夜读", "阅读模式", "常规", "普通模式", "画画"]
MOTOR_RW = ["读写台"]
MOTOR_OBJ = ["台子", "高度"]
DIST_OBJ = ["虚像", "画面", "显示", "距离", "趋向"]
VOL_OBJ = ["音量", "声音", "大声", "小声", "点声", "静音", "声"]
def has(t, ws): return next((w for w in ws if w in t), None)

def domains(t):
    d = {}
    if '静音' in t: return {'VOL': '静音'}
    if has(t, CT_OBJ): d['CT'] = has(t, CT_OBJ)
    if has(t, DIST_OBJ): d['DIST'] = has(t, DIST_OBJ)
    if has(t, VOL_OBJ): d['VOL'] = has(t, VOL_OBJ)
    if has(t, MOTOR_RW): d['RW'] = '读写台'
    elif has(t, MOTOR_OBJ): d['MOTOR'] = has(t, MOTOR_OBJ)
    t2 = t
    for w in CT_OBJ + VOL_OBJ: t2 = t2.replace(w, '')
    if has(t2, LIGHT_OBJ) or re.search(r'(?<![暖冷性])光(?![谱线])', t2): d['LIGHT'] = has(t2, LIGHT_OBJ) or '光'
    if not d and '设备' in t: d['MOTOR'] = '设备'
    if 'LIGHT' in d and 'CT' not in d and re.search(r'暖|冷', t): d['CT'] = 'via_light'; del d['LIGHT']
    return d

VERB_DOMAIN = [
    ('VOL', r'大声|小声|点声'),
    ('LIGHT', r'调亮|调暗|变亮|变暗|弄亮|弄暗|亮一点|暗一点|亮一些|暗一些|开灯|关灯|太亮|太暗|刺眼|晃眼|最亮|最暗|调到柔和|调到标准|调到明亮'),
    ('CT', r'调暖|调冷|暖一点|冷一点|暖一些|冷一些|暖一级|冷一级|最冷|最暖'),
    ('MOTOR', r'(升高|抬高|降低)(一点|一些|点)|往上一点|往下一点|高一点点|低一点点|升到最高|降到最低|升到顶|降到底'),
    ('DIST', r'拉远|拉近|调远|调近|调到最远|调到最近|再远一些|再近一些|拉到最远|拉到最近'),
]

def rule_light(t):
    if re.search(r'最亮|最高亮度|最大亮度|亮度最大|亮度调到最大|开到最大|调满|全亮', t): return 5
    if re.search(r'最暗|最低亮度|亮度最低|亮度最小|亮度调到最小|调到最低', t): return 7
    if re.search(r'一档|柔和', t): return 8
    if re.search(r'二档|标准', t): return 9
    if re.search(r'三档|明亮', t): return 10
    if re.search(r'关|熄|灭', t): return 3
    if re.search(r'打开|开启|开灯|灯开|开一下|开着|开光|光开|(?<!一)点亮|亮起来', t): return 2
    if re.search(r'太亮|刺眼|晃眼|好亮|亮死', t): return 6
    if re.search(r'太暗|好暗|暗死|太黑|好黑', t): return 4
    up = re.search(r'调亮|变亮|弄亮|亮一点|亮一些|(?<=[调再灯光])亮点|再亮|亮一亮|提高.{0,2}亮度|亮度.{0,2}(提高|调高|高|大|加|上|增)', t)
    dn = re.search(r'调暗|变暗|弄暗|暗一点|暗一些|(?<=[调再灯光])暗点|再暗|降低.{0,2}亮度|亮度.{0,2}(降低|调低|低|小|减|下)', t)
    if up and dn: return None
    if up: return 4
    if dn: return 6
    return None

def rule_ct(t):
    if '最暖' in t: return 17
    if '最冷' in t: return 16
    if re.search(r'正常|默认|恢复', t) and re.search(r'色温|光谱|光', t): return 18
    if re.search(r'绘画|画画', t): return 19
    if re.search(r'常规|普通', t): return 20 if re.search(r'调|换|切|开|到|成|用|要|来|给|恢复|模式', t) else None
    if re.search(r'夜读|阅读', t): return 21 if re.search(r'调|换|切|开|到|成|用|要|来|给|模式', t) else None
    if re.search(r'暖.{0,3}(一级|一档)', t): return 12
    if re.search(r'冷.{0,3}(一级|一档)', t): return 13
    verb = re.search(r'调|换|切|开|到|成|用|要|来|给', t)
    if re.search(r'暖光|暖色', t): return 22 if verb else None
    if re.search(r'冷光|冷色', t): return 23 if verb else None
    if '中性' in t: return 24 if verb else None
    if re.search(r'太暖|好暖', t): return 15
    if re.search(r'太冷|好冷', t): return 14
    if '暖' in t: return 14
    if '冷' in t: return 15
    if re.search(r'(换|切|跳|掉|调整|调).{0,2}(色温|光谱)|(色温|光谱).{0,2}(换|切|调)', t): return 11
    return None

def rule_motor(t, rw):
    up_max, dn_max, up, dn = (31, 32, 27, 28) if rw else (29, 30, 25, 26)
    if re.search(r'最高|到顶|升到顶', t): return up_max
    if re.search(r'最低|到底|降到底', t): return dn_max
    if '太高' in t: return dn
    if re.search(r'太低|太矮', t): return up
    if re.search(r'升|抬|高一点|高点|往上|上去|上来|高一些', t): return up
    if re.search(r'降|低一点|低点|往下|下来|下去|低一些', t): return dn
    return None

def rule_dist(t):
    if re.search(r'最远|最高', t): return 35
    if re.search(r'最近|最低', t): return 36
    if '太远' in t: return 34
    if '太近' in t: return 33
    if '远' in t: return 33
    if '近' in t: return 34
    return None

def rule_vol(t):
    if re.search(r'(取消|解除|关闭|关掉|不要)静音', t): return 45
    if '静音' in t: return 44
    if re.search(r'最大|百分之百|最高', t): return 42
    if re.search(r'最小|最低', t): return 43
    if re.search(r'(关掉|关了|关闭|不要|没有|去掉)(声音|音量)|(声音|音量)(关掉|关了|关闭|关|去掉)', t): return 44
    if re.search(r'(打开|恢复|开启)(声音|音量)|(声音|音量)(打开|开启|恢复)', t): return 45
    if re.search(r'(声音|音量|声).{0,3}(太|好|很|有点|有些)(大|响|吵)|太(大声|响)', t): return 38
    if re.search(r'(声音|音量|声).{0,3}(太|好|很|有点|有些)(小|轻|低)|太小声', t): return 37
    up = re.search(r'大|加|提高|调高|高|响|大声', t)
    dn = re.search(r'小|减|降低|调低|低|轻|小声', t)
    if up and dn: return None
    if up: return 37
    if dn: return 38
    return None

def grammar(text):
    t = strip_polite(text)
    if not t: return None, 'empty'
    if len(t) > MAX_LEN: return None, 'too_long'
    for name, ws in (('chat_sense', CHAT_SENSE), ('third_party', THIRD), ('narrative', NARR), ('discuss', DISCUSS), ('perception', PERCEPT), ('negation', NEG)):
        w = has(t, ws)
        if w and not (name == 'perception' and re.search(r'太暗|太亮|刺眼|晃眼|太黑', t)): return None, f'{name}:{w}'
    if NEG_ADJ.search(t): return None, 'negation_adj'
    if DIGIT.search(t): return None, 'number'
    if DONE.search(t): return None, 'done_action'
    if t.endswith('的'): return None, 'statement_de'
    req = has(t, REQ) is not None
    q = has(t, QWORDS)
    if q and not (q in ('吗', '呢') and req): return None, 'question:' + q
    if '是' in t and not req: return None, 'statement_shi'
    if re.search(r'有(?!点|些|一点|一些)', t): return None, 'statement_you'
    if t.startswith('我') and not has(t, SELF_REQ): return None, 'self_narrative'
    d = domains(t)
    if not d:
        for dom, pat in VERB_DOMAIN:
            if re.search(pat, t): d = {dom: 'verb'}; break
    if not d: return None, 'no_domain'
    doms = set(d)
    if 'CT' in doms and 'LIGHT' in doms: doms.discard('LIGHT')
    if len(doms) > 1: return None, 'ambiguous_domain:' + '+'.join(sorted(doms))
    dom = doms.pop()
    lab = {'LIGHT': rule_light, 'CT': rule_ct, 'DIST': rule_dist, 'VOL': rule_vol}.get(dom, lambda x: rule_motor(x, dom == 'RW'))(t)
    return (lab, dom) if lab else (None, 'no_direction:' + dom)

def combined(text):
    e = exact(text)
    if e: return e, 'exact'
    return grammar(text)
if __name__ == '__main__':
    for s in sys.argv[2:]: print(s, exact(s), grammar(s))
