# -*- coding: utf-8 -*-
"""CD83 小程序交互逻辑画板节点生成器
画板: EqXlwLTZNhVowPbQCvqc3R7WnRe (CD83 文档内 block)
8 分区,每区一批节点(connector 只能 attach 同批节点)
"""
import json

TOKENS = {
    'home-v2': 'Q8xpb10lyotxLkxiDWkcscIGn7e',
    'weekly-report': 'Wp3fbxZIyoi70CxWrpqc5VpAnAe',
    'reward-v3': 'HXabbWRAQopBFSxWMFnchYw1nfg',
    'kidshub-parent': 'MIdtbG3evoh7vNxtstTcBQHYn9g',
    'cur-mine': 'XufQbpkNbo6JPWxT5cmcs6Unnph',
    'cur-home-unconnected': 'IY8lb9KB8oe5ZPxAZ0gcDsKeneg',
    'message-center': 'SNAEbX3NmolmoMxCcsgcOM9TnLb',
    'report-history': 'GaYVbDdgdo5QrTxkOHicZaTXnyh',
    'parent-task': 'SEXib9cFHoOtECxdolJcpfSpndc',
    'create-pact': 'HBCVb7EdvodvFUxzhLMctIIZnxd',
    'cur-profile': 'GmSob1jLSoV6YsxgQDPcTDNNntg',
    'cur-eyereport': 'UbPdbBFRKo26iCxvJ4ycRX4Fnd8',
    'retain-modal': 'VhyNbavTsoWASNxtDi2cBSswndO',
    'cur-net-add': 'IStGb11m7o4YdnxDckccfUiSnmf',
    'cur-net-search': 'G0qDbX0HyoQVYSxtcE5cJ1Qbnff',
    'cur-net-wifi': 'AShcbpdR0ooHbPxMDyrcPHZ3nWg',
    'cur-net-success': 'PWHTbwqv4ojexFxNR6XcrV84nbW',
}
SIZES = {
    'home-v2': (390, 844), 'weekly-report': (390, 844), 'reward-v3': (390, 844),
    'kidshub-parent': (390, 844), 'cur-mine': (750, 1624), 'cur-home-unconnected': (750, 1624),
    'message-center': (390, 844), 'report-history': (390, 844), 'parent-task': (390, 844),
    'create-pact': (390, 844), 'cur-profile': (750, 1624), 'cur-eyereport': (786, 1704),
    'retain-modal': (390, 844), 'cur-net-add': (750, 1624), 'cur-net-search': (750, 1624),
    'cur-net-wifi': (750, 1624), 'cur-net-success': (750, 1624),
}
IMG_W = 300

# 素材 token 与 image 节点一对一绑定(实测复用必 2890002)——s1-s5 用独立上传的第二批
import os
if os.path.exists('/tmp/board_tokens2.json'):
    TOKENS.update(json.load(open('/tmp/board_tokens2.json')))

KIND = {
    'action':  {'fill_color': '#FFF3EC', 'border_color': '#FF7A45'},
    'system':  {'fill_color': '#E8F4FF', 'border_color': '#3B7A99'},
    'success': {'fill_color': '#F6FFED', 'border_color': '#52C41A'},
    'redline': {'fill_color': '#FFF1F0', 'border_color': '#FF4D4F'},
    'state':   {'fill_color': '#FFFFFF', 'border_color': '#8C94A3'},
    'plain':   {'fill_color': '#F7F8FA', 'border_color': '#C2C9D1'},
}


class Sec:
    def __init__(self, prefix, ox, oy):
        self.p, self.ox, self.oy = prefix, ox, oy
        self.nodes, self.k = [], 0

    def _id(self):
        self.k += 1
        return f"{self.p}_{self.k}"

    def section(self, title, w, h):
        self.nodes.append({'id': self._id(), 'type': 'section',
                           'x': self.ox, 'y': self.oy, 'width': w, 'height': h,
                           'section': {'title': title}})

    def img(self, key, x, y, w=IMG_W):
        iw, ih = SIZES[key]
        h = round(w * ih / iw)
        nid = self._id()
        tok = TOKENS.get(f'{self.p}:{key}', TOKENS[key])
        self.nodes.append({'id': nid, 'type': 'image', 'x': self.ox + x, 'y': self.oy + y,
                           'width': w, 'height': h, 'image': {'token': tok}, 'z_index': 1})
        return nid

    def card(self, x, y, w, h, text, kind='system', fs=14, bold=False, align='left'):
        nid = self._id()
        self.nodes.append({'id': nid, 'type': 'composite_shape', 'x': self.ox + x, 'y': self.oy + y,
                           'width': w, 'height': h,
                           'composite_shape': {'type': 'round_rect'},
                           'text': {'text': text, 'font_size': fs,
                                    'font_weight': 'bold' if bold else 'regular',
                                    'horizontal_align': align},
                           'style': dict(KIND[kind]), 'z_index': 2})
        return nid

    def label(self, x, y, text, fs=18, w=420, h=36, align='left'):
        nid = self._id()
        self.nodes.append({'id': nid, 'type': 'text_shape', 'x': self.ox + x, 'y': self.oy + y,
                           'width': w, 'height': h,
                           'text': {'text': text, 'font_size': fs, 'font_weight': 'bold',
                                    'horizontal_align': align}, 'z_index': 2})
        return nid

    def arrow(self, frm, to, cap=None, fp=(1, 0.5), tp=(0, 0.5), shape='right_angled_polyline'):
        nid = self._id()
        conn = {
            'start': {'attached_object': {'id': frm, 'position': {'x': fp[0], 'y': fp[1]}}},
            'end': {'attached_object': {'id': to, 'position': {'x': tp[0], 'y': tp[1]}},
                    'arrow_style': 'triangle_arrow'},
            'shape': shape,
        }
        if cap:
            conn['captions'] = {'data': [{'text': cap, 'font_size': 12}]}
        self.nodes.append({'id': nid, 'type': 'connector', 'connector': conn, 'z_index': 3})
        return nid


def img_h(key, w=IMG_W):
    iw, ih = SIZES[key]
    return round(w * ih / iw)


# ════════ S0 全局导航与启动判定 ════════
def s0():
    s = Sec('s0', 0, 0)
    s.section('S0 · 全局导航与启动三态判定（对应 二、信息架构 + 3.1 进入逻辑）', 2120, 1420)

    boot = s.card(70, 200, 150, 70, '小程序\n启动', 'action', 15, True, 'center')
    r1 = s.card(420, 70, 320, 64, '统一登录页', 'system', 14, False, 'center')
    r2 = s.card(420, 154, 320, 64, '「添加读写台」配网引导态', 'action', 14, False, 'center')
    r3 = s.card(420, 238, 320, 64, '完整首页 + 顶部「补全孩子信息」提示条', 'system', 13, False, 'center')
    r4 = s.card(420, 322, 320, 64, '完整首页（正常态）', 'success', 14, False, 'center')
    s.arrow(boot, r1, '未登录', (1, 0.2))
    s.arrow(boot, r2, '已登录·未绑设备', (1, 0.4))
    s.arrow(boot, r3, '已绑·未建档', (1, 0.6))
    s.arrow(boot, r4, '正常', (1, 0.8))
    s.card(820, 154, 340, 148, '判定按顺序执行，命中即落地。\n「未建档」不阻断使用：提示条可关闭，随时在 我的-孩子管理 补全。', 'plain', 13)

    tabs = [('① 首页（启动默认落地）', 'home-v2'), ('② 周报', 'weekly-report'),
            ('③ 兑换', 'reward-v3'), ('④ KidsHub', 'kidshub-parent'), ('⑤ 我的', 'cur-mine')]
    for i, (name, key) in enumerate(tabs):
        x = 70 + i * 380
        s.label(x, 480, name, 16, 300, 32)
        s.img(key, x, 524)
    s.card(70, 1230, 1820, 64, '底部 TabBar 五 Tab 常驻、平级切换；跨 Tab 跳转关系见下方各分区流程', 'plain', 14, False, 'center')
    return s.nodes


# ════════ S1 首页（y=1540）════════
def s1():
    s = Sec('s1', 0, 1540)
    s.section('S1 · 首页交互（对应 3.1 交互逻辑）', 2120, 1020)
    home = s.img('home-v2', 70, 110)
    cards = [
        ('system', '数据刷新：进入拉取一次 + 下拉刷新；设备状态靠 1 分钟心跳，显示「x 分钟前更新」，超 10 分钟未上报显示「离线」'),
        ('action', '夜航收益卡：仅昨晚有收益时显示；点「去兑换」→ 兑换 Tab；当日领取后收起为一行摘要'),
        ('action', '生态缸快照：点击仅展开说明浮层——小程序不控设备'),
        ('action', '消息铃铛：未读 >0 显示红点；点击 → 消息中心（我的 Tab 内页，路由直达）'),
        ('system', '异常态：设备离线 → 状态卡灰化 +「查看网络帮助」；加载失败 → 复用已开发超时态'),
    ]
    card_ids = []
    for i, (kind, txt) in enumerate(cards):
        card_ids.append(s.card(450, 110 + i * 112, 400, 98, txt, kind, 13))
    s.label(920, 70, '消息中心', 15, 300, 30)
    mc = s.img('message-center', 920, 110)
    s.label(1300, 70, '未绑定引导态（已开发）', 15, 320, 30)
    s.img('cur-home-unconnected', 1300, 110)
    s.arrow(card_ids[3], mc, '点击', (1, 0.5), (0, 0.5))
    s.arrow(home, card_ids[3], '铃铛', (1, 0.07), (0, 0.3))
    s.card(70, 820, 1530, 60, '进入三态判定见 S0；夜航收益卡跳转见 S3 兑换；未绑态复用已开发配网入口（S7）', 'plain', 13, False, 'center')
    return s.nodes


# ════════ S2 周报（y=2680）════════
def s2():
    s = Sec('s2', 0, 2680)
    s.section('S2 · 周报交互（对应 3.2 交互逻辑）', 2120, 1100)
    wk = s.img('weekly-report', 70, 110)
    cards = [
        ('system', '生成与推送：每周日 20:00 云端生成 → 模板消息（每周 1 条）；点推送或周报 Tab 进入'),
        ('system', '渲染顺序：高光卡（1-2 条）→ 护眼硬数字 → 一个问题+解法（按钮直达对应设置页）→ 亲子小目标'),
        ('action', '「转为约定」→ 兑换 Tab 新建约定页并预填'),
        ('system', '弱召回：设备断档 ≥7 天 → 末尾追加生态缸召回卡（点击 → 首页）；不满足不渲染'),
        ('action', '就地反馈：每期尾部 1 道单选；提交后「收到，下期改进」→ 写云端主题池（parent_report）'),
        ('redline', '⛔ 降频纪律：连续 4 周未读 → 停推模板消息，仅 Tab 红点（云端开关，前端按配置执行）'),
    ]
    for i, (kind, txt) in enumerate(cards):
        s.card(450, 110 + i * 112, 400, 98, txt, kind, 13)
    s.label(920, 70, '历史报告（周/月切换）', 15, 320, 30)
    hist = s.img('report-history', 920, 110)
    s.label(1300, 70, '新建约定（预填）', 15, 320, 30)
    pact = s.img('create-pact', 1300, 110)
    s.arrow(wk, hist, '顶部「历史 >」', (0.5, 0), (0.5, 0))
    s.arrow(wk, pact, '小目标「转为约定」', (0.5, 1), (0.5, 1))
    s.card(70, 900, 1530, 60, '分享卡：默认隐藏孩子姓名头像（可开关）→ 保存相册 / 微信好友', 'plain', 13, False, 'center')
    return s.nodes


# ════════ S3 兑换·家族币·家长任务·亲子约定（y=3900）════════
def s3():
    s = Sec('s3', 0, 3900)
    s.section('S3 · 兑换：家族币 / 家长任务 / 亲子约定（对应 3.3 + 3.3A + 4.1 + 4.1A）', 2120, 1620)
    s.label(70, 70, '兑换 Tab 主页', 15, 300, 30)
    rw = s.img('reward-v3', 70, 110)
    s.label(450, 70, '新建家长任务', 15, 300, 30)
    pt = s.img('parent-task', 450, 110)
    s.label(830, 70, '新建亲子约定', 15, 300, 30)
    cp = s.img('create-pact', 830, 110)
    s.arrow(rw, pt, '+ 新任务', (1, 0.3), (0, 0.3))
    s.arrow(rw, cp, '+ 新建约定', (0.5, 1), (0.5, 1))
    cards = [
        ('system', '双产出线：被动 = 夜航收益（合盖自动）；主动 = 家长任务（现实行为赚币）→ 攒币 → 兑现亲子约定（花币）'),
        ('system', '任务确认双路径：① 孩子在设备端说「我完成了」→ 转待确认 → 家长收轻通知；② 家长直接点「完成」。确认 → 币到账 → 设备端小可庆祝'),
        ('action', '待兑现置顶：「标记已兑现」→ 二次确认 → 落打卡流 + 同步设备端告知孩子；超 24h 显示「孩子在等你哦」'),
        ('action', '约定删除：长按/右滑 → 编辑/删除（二次确认）；有进度的约定删除提示「进度保留为家族币余额」'),
        ('system', '补勤卡（道具区）：只读展示数量 + 使用流水；获取 = 宝箱掉落；使用 = 孩子在设备端一键补缺勤天；修复日单列不进主 KPI'),
        ('redline', '⛔ 防刷红线：家族币只由家长确认发放，系统绝不按使用时长自动发币；每日任务每天最多确认 1 次'),
    ]
    for i, (kind, txt) in enumerate(cards):
        s.card(1210, 110 + i * 122, 430, 108, txt, kind, 13)
    # 任务状态机
    s.label(70, 880, '家长任务状态机（无失败/拒绝负面态，过期任务静默归档）', 15, 700, 30)
    t1 = s.card(70, 920, 220, 64, '进行中', 'state', 14, True, 'center')
    t2 = s.card(370, 920, 220, 64, '待确认', 'action', 14, True, 'center')
    t3 = s.card(670, 920, 260, 64, '已完成（币到账）', 'success', 14, True, 'center')
    s.arrow(t1, t2, '孩子设备端报完成')
    s.arrow(t2, t3, '家长确认')
    # 约定状态机
    s.label(70, 1060, '亲子约定状态机（五态，对应 4.1）', 15, 700, 30)
    p1 = s.card(70, 1100, 200, 64, '进行中', 'state', 14, True, 'center')
    p2 = s.card(340, 1100, 230, 64, '已达成（云端触发）', 'state', 13, True, 'center')
    p3 = s.card(640, 1100, 280, 64, '设备端告知孩子 → 孩子确认', 'system', 13, False, 'center')
    p4 = s.card(990, 1100, 220, 64, '待家长兑现（置顶）', 'action', 13, True, 'center')
    p5 = s.card(1280, 1100, 200, 64, '已兑现', 'success', 14, True, 'center')
    p6 = s.card(1280, 1200, 360, 64, '24h 未接住 → 设备端安抚话术（云端负责）', 'plain', 12)
    s.arrow(p1, p2, '进度攒满')
    s.arrow(p2, p3)
    s.arrow(p3, p4)
    s.arrow(p4, p5, '标记已兑现')
    s.arrow(p4, p6, '超 24h', (0.5, 1), (0, 0.5))
    s.card(70, 1320, 1570, 64, '联动：新建约定成功 → 提示「再发个任务帮 TA 攒币」一键带入；任务到账且有进行中约定 → 提示「离『XX』还差 N 币」', 'success', 13, False, 'center')
    s.card(70, 1420, 1570, 60, '余额区点「记录 >」→ 收支流水页（历史积分迁移条目带标记）；升级首次进入显示一次性说明浮层「积分已升级为家族币」', 'plain', 13, False, 'center')
    return s.nodes


# ════════ S4 KidsHub 家长主页（y=5640）════════
def s4():
    s = Sec('s4', 0, 5640)
    s.section('S4 · KidsHub 家长主页（对应 3.4 交互逻辑）', 2120, 1020)
    s.img('kidshub-parent', 70, 110)
    cards = [
        ('system', '数据源：全部来自云端 KidsHub 后台（与设备端孩子视角同一状态机），小程序只读——家长端没有修改建议状态的操作'),
        ('system', '时间线状态只有四个正面态：已收到（橙）/ 评估中（蓝）/ 已采纳（绿）/ 进了金点子库（紫）'),
        ('action', '点击条目 → 详情浮层（完整内容 + 状态变更时间线）'),
        ('action', '高光卡：建议被采纳上线 → 「因为 {昵称} 的建议，小可又进化了」（含改动说明）；可生成分享图（同周报隐私规则）'),
        ('system', '空态：「孩子可以对小可说出任何想法，被采纳会在这里出现」——不催促、不任务化'),
        ('redline', '⛔ 本页永不出现「拒绝 / 驳回 / 未通过」字样；不显示「提交数量排名」等比较性信息'),
    ]
    for i, (kind, txt) in enumerate(cards):
        s.card(450, 110 + i * 122, 460, 108, txt, kind, 13)
    s.card(950, 110, 400, 108, '等级区：等级 + 称号 + 贡献值 + 已采纳条数——数字与设备端孩子看到的完全一致（云端同源）', 'system', 13)
    return s.nodes


# ════════ S5 我的（y=6760）════════
def s5():
    s = Sec('s5', 0, 6760)
    s.section('S5 · 我的（对应 3.5 交互逻辑）', 2120, 1120)
    s.label(70, 70, '我的 Tab（现状骨架 + 新增消息中心行）', 15, 420, 30)
    mine = s.img('cur-mine', 70, 110)
    s.label(820, 70, '孩子管理 · 档案', 15, 300, 30)
    prof = s.img('cur-profile', 820, 110)
    s.label(1200, 70, '视光报告', 15, 300, 30)
    eye = s.img('cur-eyereport', 1200, 110)
    s.label(1580, 70, '消息中心（新增）', 15, 300, 30)
    mc = s.img('message-center', 1580, 110)
    s.arrow(mine, prof, '孩子管理', (0.3, 0), (0.5, 0))
    s.arrow(mine, eye, '视光报告', (0.5, 0), (0.5, 0))
    s.arrow(mine, mc, '消息中心', (0.7, 0), (0.5, 0))
    cards = [
        ('action', '昵称保存（≤10 字）→ 同步下发设备端 = 小可称呼源，弹提示「小可会用新昵称称呼孩子」'),
        ('action', '视光报告：新建 / 编辑 / 删除（二次确认）；保存成功提示「已纳入周报视力趋势」'),
        ('system', '坐姿提醒间隔（滚轮 20/30/45/60 分钟）：保存即云端下发、设备端确认后生效——参数预设下发，非实时遥控'),
        ('system', '移除设备：二次确认，保留使用数据；设备信息支持改名（≤10 字）'),
        ('system', '消息中心：全部通知倒序可重看；未读红点进入即消；点击各条 → 跳对应落点（兑换 Tab / 周报 Tab / 回告浮层）'),
    ]
    for i, (kind, txt) in enumerate(cards):
        s.card(70 + i * 400, 820, 380, 120, txt, kind, 13)
    return s.nodes


# ════════ S6 推送与流失拦截（y=8000）════════
def s6():
    s = Sec('s6', 0, 8000)
    s.section('S6 · 推送与流失拦截（对应 3.6 + 4.2 推送纪律）', 2120, 1020)
    s.label(70, 70, '流失拦截弹窗', 15, 300, 30)
    rm = s.img('retain-modal', 70, 110)
    cond = s.card(450, 110, 400, 130, '拦截条件（打开小程序时判定）：用户状态 = 流失风险（30-60 天未用）且 距上次拦截 ≥30 天 → 半屏软弹窗；任意选择或关闭后 30 天内不再出现', 'system', 13)
    s.arrow(cond, rm, '命中 → 弹出', (0, 0.5), (1, 0.5))
    opts = [('没空', '「好的，等你们回来」即关', 'plain'),
            ('嫌烦', '跳 坐姿提醒间隔设置', 'action'),
            ('不值', '跳 周报（价值解读）', 'action'),
            ('其他', '可选文字框', 'plain')]
    for i, (opt, dest, kind) in enumerate(opts):
        o = s.card(450, 300 + i * 84, 150, 64, opt, 'state', 14, True, 'center')
        d = s.card(660, 300 + i * 84, 390, 64, dest, kind, 13, False, 'center')
        s.arrow(o, d)
    s.card(450, 650, 600, 56, '全部选择写入云端主题池（parent_intercept 标签）', 'system', 13, False, 'center')
    pushes = [
        ('system', '夜航助攻：每日 8:00 判定（昨晚有收益 + 今日未推过）→ 模板消息 → 点击落首页收益卡；当日设备已开盖领取则不再推'),
        ('system', '兑换确认提醒：孩子设备端确认 → 实时推 1 条 + 写消息中心 + 待兑现置顶；之后不再加推（24h 未处理只改状态文案）'),
        ('system', '未激活提醒：妥投 T+1 / T+3（扣周末）各推 1 条配网引导；T+5 仍未激活转人工客服（云端任务，小程序无界面）'),
        ('redline', '⛔ 频控总闸：所有推送过云端统一频控服务（4.2 纪律）；前端不自行发起任何推送'),
    ]
    for i, (kind, txt) in enumerate(pushes):
        s.card(1480, 110 + i * 144, 570, 130, txt, kind, 13)
    return s.nodes


# ════════ S7 配网与建档（y=9140）════════
def s7():
    s = Sec('s7', 0, 9140)
    s.section('S7 · 配网与建档流程（对应 4.3，全流程已开发，标注为改造增量）', 2120, 1300)
    steps = [('① 添加设备', 'cur-net-add'), ('② 蓝牙搜索', 'cur-net-search'),
             ('③ WiFi 配置 / 连接中', 'cur-net-wifi'), ('④ 连接成功', 'cur-net-success')]
    ids = []
    for i, (name, key) in enumerate(steps):
        x = 70 + i * 380
        s.label(x, 70, name, 15, 320, 30)
        ids.append(s.img(key, x, 110))
    s.arrow(ids[0], ids[1], '选择设备')
    s.arrow(ids[1], ids[2], '蓝牙连接成功')
    s.arrow(ids[2], ids[3], '配网完成')
    fl = s.card(830, 880, 420, 110, '改造增量 · 异步建档浮层：连接中等待期（10-30s）弹底部浮层「孩子昵称 + 出生年月」+「跳过」——填完 / 跳过都不打断配网主流程', 'action', 13)
    s.arrow(ids[2], fl, '等待期弹出', (0.5, 1), (0.5, 0))
    cards = [
        ('system', '跳过兜底：云端从预设词库生成随机昵称(如「小航海家」) → 首页保留「补全孩子信息」提示条'),
        ('system', '称呼下发：建档成功（含随机兜底）即下发设备端 = 小可 D0 登舰称呼来源——孩子第一次开盖小可就能叫出名字'),
        ('system', '埋点（新增）：五步漏斗（扫码→蓝牙→WiFi→心跳→建档）每步上报 + 失败错误码；闸门 1 / 闸门 2 按 PRD 0.1 口径'),
        ('system', '失败兜底（已开发保留）：各异常态沿用现有页面；连续 2 次失败后出现「联系客服」入口'),
    ]
    for i, (kind, txt) in enumerate(cards):
        s.card(1590, 110 + i * 134, 460, 120, txt, kind, 13)
    return s.nodes


SECTIONS = {'s0': s0, 's1': s1, 's2': s2, 's3': s3, 's4': s4, 's5': s5, 's6': s6, 's7': s7}

if __name__ == '__main__':
    import sys
    which = sys.argv[1] if len(sys.argv) > 1 else 's0'
    nodes = SECTIONS[which]()
    out = f'/tmp/board_{which}.json'
    json.dump({'nodes': nodes}, open(out, 'w'), ensure_ascii=False)
    print(out, len(nodes), 'nodes')
