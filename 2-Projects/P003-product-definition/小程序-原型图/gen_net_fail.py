# -*- coding: utf-8 -*-
"""net-fail-options: 配网连续 2 次失败 — 双选项兜底页（热点主推 + 客服次选）"""
import subprocess

F = 'PingFang SC, sans-serif'
def t(x, y, s, size=14, fill="#1F2933", w="normal", anchor="start"):
    return f'<text x="{x}" y="{y}" font-family="{F}" font-size="{size}" fill="{fill}" font-weight="{w}" text-anchor="{anchor}">{s}</text>'
def r(x, y, w_, h, fill="#fff", rx=16, stroke="none", sw=1, op=1):
    return f'<rect x="{x}" y="{y}" width="{w_}" height="{h}" fill="{fill}" rx="{rx}" stroke="{stroke}" stroke-width="{sw}" opacity="{op}"/>'

s = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">'
s += r(0, 0, 390, 844, "#F7F8FA", rx=0)
s += t(24, 34, "9:41", 15, "#1F2933", "600")
for i in range(3):
    s += r(312 + i * 20, 22, 15, 10, "#1F2933", rx=2)
s += t(24, 76, "←", 20, "#1F2933", "600")
s += t(195, 76, "连接网络", 17, "#1F2933", "600", "middle")
# 失败图标
s += f'<circle cx="195" cy="200" r="34" fill="#FFF1F0"/>'
s += f'<circle cx="195" cy="200" r="24" fill="#FF7875"/>'
s += f'<path d="M 186 191 l 18 18 M 204 191 l -18 18" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round"/>'
s += t(195, 274, "还是没连上", 19, "#1F2933", "700", "middle")
s += t(195, 302, "WiFi 密码可能不对，或路由器有特殊设置", 13, "#8C94A3", anchor="middle")
s += t(195, 324, "已尝试 2 次 · 错误码 E-1003", 11, "#C2C9D1", anchor="middle")
# 建议卡
s += r(28, 356, 334, 96, "#FFFFFF", rx=14)
s += t(44, 384, "💡 试试这些办法", 13, "#5B6470", "600")
s += t(44, 408, "· 确认 WiFi 密码大小写；· 路由器若开了 5G 双频", 12, "#8C94A3")
s += t(44, 428, "  合一，建议临时分开 2.4G 再试", 12, "#8C94A3")
# 主按钮：自建热点
s += r(28, 496, 334, 50, "#FF7A45", rx=25)
s += t(195, 527, "用手机热点配网", 15, "#FFFFFF", "700", "middle")
s += t(195, 568, "开手机热点让设备连，绕开家里路由器问题", 11, "#C2C9D1", anchor="middle")
# 次按钮：联系客服
s += r(28, 596, 334, 50, "#FFFFFF", rx=25, stroke="#FF7A45", sw=2)
s += t(195, 627, "联系客服", 15, "#FF7A45", "600", "middle")
s += t(195, 668, "自动带上设备信息和错误记录，不用截图描述", 11, "#C2C9D1", anchor="middle")
# 文字链：再试一次
s += t(195, 718, "再试一次", 14, "#8C94A3", anchor="middle")
s += f'<line x1="167" y1="724" x2="223" y2="724" stroke="#C2C9D1"/>'
s += '</svg>'

p = '/tmp/mini_protos/net-fail-options.svg'
open(p, 'w', encoding='utf-8').write(s)
subprocess.run(["rsvg-convert", "-w", "390", "-o", "/tmp/mini_protos/net-fail-options.png", p], check=True)
print("net-fail-options OK")
