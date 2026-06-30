# -*- coding: utf-8 -*-
"""家长任务 2 张原型图:reward-v3(兑换Tab终版) + parent-task(新建任务页)"""
import subprocess

F = 'PingFang SC, sans-serif'
def t(x, y, s, size=14, fill="#1F2933", w="normal", anchor="start"):
    return f'<text x="{x}" y="{y}" font-family="{F}" font-size="{size}" fill="{fill}" font-weight="{w}" text-anchor="{anchor}">{s}</text>'
def r(x, y, w_, h, fill="#fff", rx=16, stroke="none", sw=1, op=1):
    return f'<rect x="{x}" y="{y}" width="{w_}" height="{h}" fill="{fill}" rx="{rx}" stroke="{stroke}" stroke-width="{sw}" opacity="{op}"/>'

def shell(content, title, active_tab, tabbar=True, back=False):
    s = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">'
    s += r(0, 0, 390, 844, "#F7F8FA", rx=0)
    s += t(24, 30, "9:41", 15, "#1F2933", "600")
    for i in range(3):
        s += r(330 + i * 18, 18, 13, 9, "#1F2933", rx=2)
    if back:
        s += t(24, 72, "←", 20, "#1F2933", "600")
    s += t(195, 72, title, 17, "#1F2933", "600", "middle")
    s += content
    if tabbar:
        s += r(0, 761, 390, 83, "#fff", rx=0)
        s += f'<line x1="0" y1="761" x2="390" y2="761" stroke="#EEEEEE"/>'
        tabs = ["首页", "周报", "兑换", "KidsHub", "我的"]
        for i, name in enumerate(tabs):
            cx = 39 + i * 78
            c = "#FF7A45" if name == active_tab else "#8C94A3"
            s += r(cx - 10, 775, 20, 20, c, rx=6)
            s += t(cx, 818, name, 11, c, "600", "middle")
    s += '</svg>'
    return s

# ── 1. reward-v3 兑换 Tab 终版 ──
c = ''
# 余额卡
c += r(16, 96, 358, 92, "#FF7A45")
c += r(16, 96, 358, 46, "#FFA940", rx=16); c += r(16, 120, 358, 30, "#FF7A45", rx=0)
c += t(32, 124, "当前家族币", 12, "#FFF3EC")
c += t(32, 160, "1250", 30, "#FFFFFF", "700")
c += t(120, 160, "来自夜航 · 任务", 11, "#FFE2D2")
c += t(358, 124, "记录 >", 12, "#FFF3EC", anchor="end")
# 待兑现置顶
c += r(16, 200, 358, 74, "#FFF3EC")
c += r(16, 200, 5, 74, "#FF7A45", rx=2)
c += t(34, 226, "⏰ 待兑现 · 小明已确认", 13, "#1F2933", "600")
c += t(34, 250, "踢足球 50 分钟（-100）", 12, "#8C94A3")
c += r(272, 218, 88, 32, "#52C41A", rx=16)
c += t(316, 239, "标记已兑现", 12, "#fff", "600", "middle")
# 家长任务区
c += t(24, 304, "家长任务", 15, "#1F2933", "700")
c += f'<circle cx="96" cy="299" r="4" fill="#FF4D4F"/>'
c += t(358, 304, "+ 新任务", 13, "#FF7A45", "600", "end")
c += r(16, 318, 358, 60, "#fff")
c += t(32, 342, "整理书包", 14, "#1F2933", "600")
c += t(32, 362, "每日任务 · +20 币", 11, "#8C94A3")
c += r(268, 330, 92, 30, "#FFF3EC", rx=15)
c += t(314, 350, "待确认 · 1", 12, "#FF7A45", "700", "middle")
c += r(16, 386, 358, 60, "#fff")
c += t(32, 410, "阅读打卡", 14, "#1F2933", "600")
c += t(32, 430, "每日任务 · +30 币", 11, "#8C94A3")
c += t(344, 414, "进行中", 12, "#8C94A3", anchor="end")
# 亲子约定区
c += t(24, 480, "亲子约定", 15, "#1F2933", "700")
c += t(358, 480, "+ 新建约定", 13, "#FF7A45", "600", "end")
for i, (name, cur, total, pct) in enumerate([("看电影一次", 800, 1000, 0.8), ("去游乐园", 350, 1000, 0.35)]):
    y = 494 + i * 72
    c += r(16, y, 358, 62, "#fff")
    c += t(32, y + 25, name, 14, "#1F2933", "600")
    c += t(358, y + 25, f"{cur}/{total}", 12, "#8C94A3", anchor="end")
    c += r(32, y + 38, 326, 8, "#F0F2F5", rx=4)
    c += r(32, y + 38, int(326 * pct), 8, "#FF7A45", rx=4)
# 道具区
c += t(24, 668, "道具", 15, "#1F2933", "700")
c += t(358, 668, "P1 上线", 11, "#C2C9D1", anchor="end")
c += r(16, 680, 358, 56, "#fff")
c += r(30, 692, 32, 32, "#9B7BF0", rx=8)
c += t(76, 706, "补勤卡 × 2", 13, "#1F2933", "600")
c += t(76, 724, "孩子在设备端使用 · 一卡补一天", 11, "#8C94A3")
svg1 = shell(c, "家族币 · 任务与约定", "兑换")

# ── 2. parent-task 新建任务页 ──
c = ''
c += t(24, 116, "选个任务模板", 15, "#1F2933", "700")
tpls = [("阅读打卡", True), ("帮做家务", False), ("整理书包", False), ("练字一页", False), ("户外运动", False), ("自定义", False)]
for i, (name, sel) in enumerate(tpls):
    col, row = i % 3, i // 3
    x, y = 16 + col * 122, 130 + row * 66
    c += r(x, y, 112, 56, "#FFF3EC" if sel else "#fff", rx=12, stroke="#FF7A45" if sel else "none", sw=2)
    c += r(x + 12, y + 12, 14, 14, "#FF7A45" if sel else "#FFA940", rx=4)
    c += t(x + 56, y + 44, name, 12, "#1F2933" if sel else "#5B6470", "600", "middle")
# 表单
fy = 286
c += r(16, fy, 358, 196, "#fff")
rows = [("任务名称", "阅读打卡", False), ("币奖励", "30（建议 10-50）", True), ("频次", "每日可重复 >", False), ("同步给小可", "开（设备端会告诉孩子）", False)]
for i, (k, v, pm) in enumerate(rows):
    y = fy + 32 + i * 46
    c += t(32, y, k, 13, "#8C94A3")
    if pm:
        c += r(252, y - 18, 24, 24, "#F0F2F5", rx=6); c += t(264, y - 1, "−", 14, "#5B6470", anchor="middle")
        c += t(300, y, "30", 14, "#1F2933", "600", "middle")
        c += r(326, y - 18, 24, 24, "#FFF3EC", rx=6); c += t(338, y - 1, "+", 14, "#FF7A45", anchor="middle")
    else:
        c += t(358, y, v, 13, "#1F2933", anchor="end")
    if i < 3:
        c += f'<line x1="32" y1="{y + 14}" x2="358" y2="{y + 14}" stroke="#F0F2F5"/>'
c += t(24, 514, "完成由你确认后到账；系统不会按使用时长自动发币。", 11, "#8C94A3")
c += t(24, 532, "孩子说「我完成了」时，你会在消息中心收到待确认提醒。", 11, "#8C94A3")
c += r(16, 700, 358, 50, "#FF7A45", rx=25)
c += t(195, 732, "发布任务", 16, "#fff", "700", "middle")
svg2 = shell(c, "新建家长任务", "兑换", tabbar=False, back=True)

for name, svg in [("reward-v3", svg1), ("parent-task", svg2)]:
    p = f'/tmp/mini_protos/{name}.svg'
    open(p, 'w', encoding='utf-8').write(svg)
    subprocess.run(["rsvg-convert", "-w", "390", "-o", f"/tmp/mini_protos/{name}.png", p], check=True)
    print(name, "OK")
