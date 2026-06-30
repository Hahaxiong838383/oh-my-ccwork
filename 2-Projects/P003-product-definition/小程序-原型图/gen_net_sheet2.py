# -*- coding: utf-8 -*-
"""net-profile-sheet v2: 建档浮层(昵称+出生年月+性别) x 连接中/连接成功 两态"""
import subprocess

F = 'PingFang SC, sans-serif'
def t(x, y, s, size=14, fill="#1F2933", w="normal", anchor="start"):
    return f'<text x="{x}" y="{y}" font-family="{F}" font-size="{size}" fill="{fill}" font-weight="{w}" text-anchor="{anchor}">{s}</text>'
def r(x, y, w_, h, fill="#fff", rx=16, stroke="none", sw=1, op=1):
    return f'<rect x="{x}" y="{y}" width="{w_}" height="{h}" fill="{fill}" rx="{rx}" stroke="{stroke}" stroke-width="{sw}" opacity="{op}"/>'
def c(cx, cy, rr, fill):
    return f'<circle cx="{cx}" cy="{cy}" r="{rr}" fill="{fill}"/>'


def build(state):  # state: 'connecting' | 'success'
    s = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">'
    s += r(0, 0, 390, 844, "#F7F8FA", rx=0)
    s += t(24, 34, "9:41", 15, "#1F2933", "600")
    for i in range(3):
        s += r(312 + i * 20, 22, 15, 10, "#1F2933", rx=2)
    s += t(24, 76, "←", 20, "#1F2933", "600")
    s += t(195, 76, "连接网络", 17, "#1F2933", "600", "middle")
    # 设备示意
    s += r(135, 108, 120, 84, "#FFFFFF", rx=12, stroke="#D8E0E8", sw=2)
    s += r(150, 122, 90, 44, "#EAF2F8", rx=6)
    s += r(175, 198, 40, 8, "#D8E0E8", rx=4)
    if state == 'connecting':
        s += f'<circle cx="195" cy="252" r="22" fill="none" stroke="#E8EDF2" stroke-width="5"/>'
        s += f'<path d="M 195 230 a 22 22 0 0 1 19 11" fill="none" stroke="#FF7A45" stroke-width="5" stroke-linecap="round"/>'
        s += t(195, 304, "正在连接网络…", 16, "#1F2933", "600", "middle")
        s += t(195, 328, "预计需要 10-30 秒", 12, "#8C94A3", anchor="middle")
    else:
        s += c(195, 252, 22, "#52C41A")
        s += f'<path d="M 185 252 l 7 7 l 13 -14" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
        s += t(195, 304, "设备已连接", 16, "#1F2933", "600", "middle")
    # 遮罩
    s += r(0, 0, 390, 844, "#000000", rx=0, op=0.42)
    # 浮层
    s += f'<path d="M 0 374 q 0 -24 24 -24 h 342 q 24 0 24 24 v 470 h -390 z" fill="#FFFFFF"/>'
    s += r(171, 362, 48, 5, "#E0E3E8", rx=2.5)
    y0 = 0
    if state == 'success':
        # 成功反馈条（浮层内顶部）
        s += r(16, 384, 358, 38, "#F6FFED", rx=10)
        s += c(34, 403, 8, "#52C41A")
        s += f'<path d="M 30 403 l 3 3 l 5 -6" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        s += t(50, 408, "设备已连接！填完这一步就全部完成啦", 12, "#3E8E22", "600")
        y0 = 46
    s += t(28, 414 + y0, "等待时填一下", 19, "#1F2933", "700")
    s += t(28, 438 + y0, "让小可第一次见面，就能叫出 TA 的名字", 12, "#8C94A3")
    # 昵称
    s += t(28, 474 + y0, "孩子昵称", 13, "#5B6470", "600")
    s += r(28, 486 + y0, 334, 44, "#F5F6F8", rx=12)
    s += t(44, 514 + y0, "例如：小明", 14, "#B8BFC9")
    # 出生年月
    s += t(28, 562 + y0, "出生年月", 13, "#5B6470", "600")
    s += r(28, 574 + y0, 334, 44, "#F5F6F8", rx=12)
    s += t(44, 602 + y0, "请选择", 14, "#B8BFC9")
    s += t(346, 602 + y0, "›", 16, "#C2C9D1", anchor="middle")
    # 性别（分段选择）
    s += t(28, 650 + y0, "性别", 13, "#5B6470", "600")
    s += r(28, 662 + y0, 163, 44, "#FFF3EC", rx=12, stroke="#FF7A45", sw=2)
    s += t(109, 690 + y0, "男 孩", 14, "#FF7A45", "600", "middle")
    s += r(199, 662 + y0, 163, 44, "#F5F6F8", rx=12)
    s += t(280, 690 + y0, "女 孩", 14, "#5B6470", anchor="middle")
    # 按钮
    if state == 'success':
        s += r(28, 726 + y0, 334, 46, "#FF7A45", rx=23)
        s += t(195, 755 + y0, "保存并开始使用", 15, "#FFFFFF", "700", "middle")
    else:
        s += r(28, 726 + y0, 334, 46, "#FF7A45", rx=23)
        s += t(195, 755 + y0, "保 存", 15, "#FFFFFF", "700", "middle")
    s += t(195, 798 + y0, "跳过", 13, "#8C94A3", anchor="middle")
    if state == 'connecting':
        s += t(195, 824, "配网正在后台继续，填写或跳过都不影响连接", 10, "#C2C9D1", anchor="middle")
    s += '</svg>'
    return s


for name, st in [("net-profile-sheet-v2", "connecting"), ("net-profile-sheet-success", "success")]:
    p = f'/tmp/mini_protos/{name}.svg'
    open(p, 'w', encoding='utf-8').write(build(st))
    subprocess.run(["rsvg-convert", "-w", "390", "-o", f"/tmp/mini_protos/{name}.png", p], check=True)
    print(name, "OK")
