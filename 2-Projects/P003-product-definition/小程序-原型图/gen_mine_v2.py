# -*- coding: utf-8 -*-
"""mine-v2: 我的 Tab 改造版 = 现状骨架 + 新增「消息中心」行(未读红点) + 五 Tab"""
import subprocess

F = 'PingFang SC, sans-serif'
def t(x, y, s, size=14, fill="#1F2933", w="normal", anchor="start"):
    return f'<text x="{x}" y="{y}" font-family="{F}" font-size="{size}" fill="{fill}" font-weight="{w}" text-anchor="{anchor}">{s}</text>'
def r(x, y, w_, h, fill="#fff", rx=16, stroke="none", sw=1, op=1):
    return f'<rect x="{x}" y="{y}" width="{w_}" height="{h}" fill="{fill}" rx="{rx}" stroke="{stroke}" stroke-width="{sw}" opacity="{op}"/>'
def c(cx, cy, rr, fill):
    return f'<circle cx="{cx}" cy="{cy}" r="{rr}" fill="{fill}"/>'

s = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">'
s += r(0, 0, 390, 844, "#F7F8FA", rx=0)
# 状态栏
s += t(24, 34, "9:41", 15, "#1F2933", "600")
for i in range(3):
    s += r(312 + i * 20, 22, 15, 10, "#1F2933", rx=2)
# 小程序胶囊
s += r(296, 52, 78, 30, "#FFFFFF", rx=15, stroke="#E5E6EB")
s += c(316, 67, 2.2, "#1F2933"); s += c(324, 67, 2.2, "#1F2933"); s += c(332, 67, 2.2, "#1F2933")
s += f'<line x1="344" y1="58" x2="344" y2="76" stroke="#E5E6EB"/>'
s += c(358, 67, 7, "none").replace('fill="none"', 'fill="none" stroke="#1F2933" stroke-width="1.6"')
s += c(358, 67, 2.6, "#1F2933")
# 头像 + 用户名 + 个人中心
s += c(44, 132, 27, "#FF7A45")
s += f'<path d="M 44 124 a 8 8 0 1 1 0.01 0 M 30 148 a 14 9 0 0 1 28 0" fill="#FFD9C2"/>'
s += t(84, 140, "用户名称用户名…", 19, "#1F2933", "700")
s += r(296, 116, 78, 32, "#FFFFFF", rx=16, stroke="#C2C9D1")
s += t(335, 137, "个人中心", 13, "#5B6470", anchor="middle")

def row(y, icon_bg, label, badge=None, sub=None):
    out = r(16, y, 358, 64, "#FFFFFF", rx=14)
    out += r(30, y + 16, 32, 32, icon_bg, rx=9)
    out += t(76, y + 38, label, 15, "#1F2933", "600")
    if badge:
        out += c(76 + len(label) * 15 + 18, y + 24, 9, "#FF4D4F")
        out += t(76 + len(label) * 15 + 18, y + 29, badge, 11, "#FFFFFF", "700", "middle")
    out += t(352, y + 38, "›", 18, "#C2C9D1", anchor="middle")
    return out

# 孩子管理
s += t(24, 192, "孩子管理", 12, "#8C94A3")
s += r(16, 204, 358, 76, "#FFFFFF", rx=14)
s += c(48, 242, 22, "#E8D5C8")
s += t(84, 236, "大妮", 16, "#1F2933", "600")
s += t(84, 258, "女｜10岁｜左 200｜右 200", 12, "#8C94A3")
s += t(352, 246, "›", 18, "#C2C9D1", anchor="middle")
# 健康报告
s += t(24, 316, "健康报告", 12, "#8C94A3")
s += row(328, "#DCE6F0", "视光报告")
# 设备管理
s += t(24, 428, "设备管理", 12, "#8C94A3")
s += row(440, "#D8E4EE", "空间光学读写台")
# 消息(新增)
s += t(24, 540, "消息", 12, "#8C94A3")
s += r(16, 552, 358, 64, "#FFFFFF", rx=14)
s += r(30, 568, 32, 32, "#FFE7D6", rx=9)
s += f'<path d="M 46 576 a 7 7 0 0 1 7 7 v 5 h 2 v 3 h -18 v -3 h 2 v -5 a 7 7 0 0 1 7 -7 m -3 16 h 6 a 3 3 0 0 1 -6 0" fill="#FF7A45"/>'
s += t(76, 590, "消息中心", 15, "#1F2933", "600")
s += c(150, 576, 9, "#FF4D4F")
s += t(150, 581, "3", 11, "#FFFFFF", "700", "middle")
s += t(290, 590, "夜航助攻 · 回告", 11, "#C2C9D1", anchor="end")
s += t(352, 590, "›", 18, "#C2C9D1", anchor="middle")
# 设置
s += t(24, 652, "设置", 12, "#8C94A3")
s += row(664, "#D9DEE8", "使用帮助")

# 五 Tab
s += r(0, 761, 390, 83, "#fff", rx=0)
s += f'<line x1="0" y1="761" x2="390" y2="761" stroke="#EEEEEE"/>'
tabs = ["首页", "周报", "兑换", "KidsHub", "我的"]
for i, name in enumerate(tabs):
    cx = 39 + i * 78
    col = "#FF7A45" if name == "我的" else "#8C94A3"
    s += r(cx - 10, 775, 20, 20, col, rx=6)
    s += t(cx, 818, name, 11, col, "600", "middle")
s += r(115, 832, 160, 5, "#1F2933", rx=2.5)
s += '</svg>'

p = '/tmp/mini_protos/mine-v2.svg'
open(p, 'w', encoding='utf-8').write(s)
subprocess.run(["rsvg-convert", "-w", "390", "-o", "/tmp/mini_protos/mine-v2.png", p], check=True)
print("mine-v2 OK")
