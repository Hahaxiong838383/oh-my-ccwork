# -*- coding: utf-8 -*-
"""net-profile-sheet: 配网连接中页 + 异步建档底部浮层（CD83 4.3 改造增量）"""
import subprocess

F = 'PingFang SC, sans-serif'
def t(x, y, s, size=14, fill="#1F2933", w="normal", anchor="start"):
    return f'<text x="{x}" y="{y}" font-family="{F}" font-size="{size}" fill="{fill}" font-weight="{w}" text-anchor="{anchor}">{s}</text>'
def r(x, y, w_, h, fill="#fff", rx=16, stroke="none", sw=1, op=1):
    return f'<rect x="{x}" y="{y}" width="{w_}" height="{h}" fill="{fill}" rx="{rx}" stroke="{stroke}" stroke-width="{sw}" opacity="{op}"/>'

s = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">'
# ── 背景页：连接中 ──
s += r(0, 0, 390, 844, "#F7F8FA", rx=0)
s += t(24, 34, "9:41", 15, "#1F2933", "600")
for i in range(3):
    s += r(312 + i * 20, 22, 15, 10, "#1F2933", rx=2)
s += t(24, 76, "←", 20, "#1F2933", "600")
s += t(195, 76, "连接网络", 17, "#1F2933", "600", "middle")
# 设备示意 + 转圈
s += r(135, 150, 120, 84, "#FFFFFF", rx=12, stroke="#D8E0E8", sw=2)
s += r(150, 164, 90, 44, "#EAF2F8", rx=6)
s += r(175, 240, 40, 8, "#D8E0E8", rx=4)
s += f'<circle cx="195" cy="320" r="26" fill="none" stroke="#E8EDF2" stroke-width="5"/>'
s += f'<path d="M 195 294 a 26 26 0 0 1 22.5 13" fill="none" stroke="#FF7A45" stroke-width="5" stroke-linecap="round"/>'
s += t(195, 382, "正在连接网络…", 17, "#1F2933", "600", "middle")
s += t(195, 408, "预计需要 10-30 秒", 13, "#8C94A3", anchor="middle")
# ── 遮罩 ──
s += r(0, 0, 390, 844, "#000000", rx=0, op=0.42)
# ── 底部浮层 ──
s += f'<path d="M 0 462 q 0 -24 24 -24 h 342 q 24 0 24 24 v 382 h -390 z" fill="#FFFFFF"/>'
s += r(171, 450, 48, 5, "#E0E3E8", rx=2.5)
s += t(28, 496, "等待时填一下", 19, "#1F2933", "700")
s += t(28, 522, "让小可第一次见面，就能叫出 TA 的名字", 13, "#8C94A3")
# 字段1 孩子昵称
s += t(28, 566, "孩子昵称", 13, "#5B6470", "600")
s += r(28, 580, 334, 48, "#F5F6F8", rx=12)
s += t(44, 610, "例如：小明", 14, "#B8BFC9")
# 字段2 出生年月
s += t(28, 662, "出生年月", 13, "#5B6470", "600")
s += r(28, 676, 334, 48, "#F5F6F8", rx=12)
s += t(44, 706, "请选择", 14, "#B8BFC9")
s += t(346, 706, "›", 16, "#C2C9D1", anchor="middle")
# 保存按钮 + 跳过
s += r(28, 744, 334, 48, "#FF7A45", rx=24)
s += t(195, 774, "保 存", 16, "#FFFFFF", "700", "middle")
s += t(195, 818, "跳过", 14, "#8C94A3", anchor="middle")
# 底部小字
s += t(195, 838, "配网正在后台继续，填写或跳过都不影响连接", 10, "#C2C9D1", anchor="middle")
s += '</svg>'

p = '/tmp/mini_protos/net-profile-sheet.svg'
open(p, 'w', encoding='utf-8').write(s)
subprocess.run(["rsvg-convert", "-w", "390", "-o", "/tmp/mini_protos/net-profile-sheet.png", p], check=True)
print("net-profile-sheet OK")
