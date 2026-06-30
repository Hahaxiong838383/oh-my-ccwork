# -*- coding: utf-8 -*-
"""按 WEB后台.html 源码 1:1 重绘高保真界面 SVG（Element Plus 风格）"""
import os

FONT = "PingFang SC, Hiragino Sans GB, STHeiti, sans-serif"
OUT = "/tmp/proto_shots"
os.makedirs(OUT, exist_ok=True)

# ---------- 基础组件 ----------

def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def text(x, y, s, size=14, fill="#303133", weight="normal", anchor="start"):
    return (f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" '
            f'fill="{fill}" font-weight="{weight}" text-anchor="{anchor}">{esc(s)}</text>')

def rect(x, y, w, h, fill="#fff", rx=0, stroke="none", sw=1, opacity=1):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" rx="{rx}" '
            f'stroke="{stroke}" stroke-width="{sw}" opacity="{opacity}"/>')

def card(x, y, w, h):
    return (rect(x, y, w, h, "#ffffff", rx=8, stroke="#ebeef5") +
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="none" stroke="#e4e7ed" stroke-width="1"/>')

def button(x, y, w, h, label, primary=True, size=13):
    bg = "#409eff" if primary else "#ffffff"
    fg = "#ffffff" if primary else "#606266"
    stroke = "#409eff" if primary else "#dcdfe6"
    return (rect(x, y, w, h, bg, rx=4, stroke=stroke) +
            text(x + w / 2, y + h / 2 + size * 0.36, label, size, fg, anchor="middle"))

def input_box(x, y, w, h, placeholder, filled=False, size=13):
    fg = "#303133" if filled else "#a8abb2"
    return (rect(x, y, w, h, "#ffffff", rx=4, stroke="#dcdfe6") +
            text(x + 12, y + h / 2 + size * 0.36, placeholder, size, fg))

def tag(x, y, label, color, size=12):
    colors = {"green": ("#f0f9eb", "#67c23a"), "orange": ("#fdf6ec", "#e6a23c"),
              "red": ("#fef0f0", "#f56c6c"), "gray": ("#f4f4f5", "#909399"),
              "blue": ("#ecf5ff", "#409eff")}
    bg, fg = colors[color]
    w = len(label) * size + 16
    return (rect(x, y, w, 22, bg, rx=4, stroke=fg, sw=0.5) +
            text(x + w / 2, y + 15.5, label, size, fg, anchor="middle")), w

def table(x, y, w, headers, widths, rows, row_h=40, header_h=44):
    s = rect(x, y, w, header_h, "#f5f7fa", rx=0)
    cx = x
    for hcell, cw in zip(headers, widths):
        s += text(cx + 12, y + header_h / 2 + 5, hcell, 13, "#909399", weight="600")
        cx += cw
    yy = y + header_h
    for r_i, row in enumerate(rows):
        s += rect(x, yy, w, row_h, "#ffffff" if r_i % 2 == 0 else "#fafafa")
        s += f'<line x1="{x}" y1="{yy}" x2="{x + w}" y2="{yy}" stroke="#ebeef5" stroke-width="1"/>'
        cx = x
        for cell, cw in zip(row, widths):
            if isinstance(cell, tuple):  # ("tag", label, color) or ("link", label)
                if cell[0] == "tag":
                    t, _ = tag(cx + 12, yy + 9, cell[1], cell[2])
                    s += t
                elif cell[0] == "link":
                    s += text(cx + 12, yy + row_h / 2 + 5, cell[1], 13, "#409eff")
            else:
                s += text(cx + 12, yy + row_h / 2 + 5, cell, 13, "#606266")
            cx += cw
        yy += row_h
    s += f'<line x1="{x}" y1="{yy}" x2="{x + w}" y2="{yy}" stroke="#ebeef5" stroke-width="1"/>'
    return s, yy - y

def pie(cx, cy, r, slices, legend_x=None, legend_y=None):
    """slices: [(label, pct, color)]"""
    import math
    s = ""
    a0 = -90
    for label, pct, color in slices:
        a1 = a0 + pct * 3.6
        x0 = cx + r * math.cos(math.radians(a0)); y0 = cy + r * math.sin(math.radians(a0))
        x1 = cx + r * math.cos(math.radians(a1)); y1 = cy + r * math.sin(math.radians(a1))
        large = 1 if pct > 50 else 0
        s += (f'<path d="M{cx},{cy} L{x0:.1f},{y0:.1f} A{r},{r} 0 {large} 1 {x1:.1f},{y1:.1f} Z" '
              f'fill="{color}" stroke="#fff" stroke-width="2"/>')
        a0 = a1
    if legend_x is not None:
        ly = legend_y
        for label, pct, color in slices:
            s += rect(legend_x, ly - 9, 12, 12, color, rx=2)
            s += text(legend_x + 20, ly + 2, f"{label}  {pct}%", 12, "#606266")
            ly += 24
    return s

def line_chart(x, y, w, h, points, color="#409eff", area=True):
    n = len(points)
    lo, hi = min(points), max(points)
    span = (hi - lo) or 1
    coords = [(x + i * w / (n - 1), y + h - (p - lo) / span * (h - 20) - 10) for i, p in enumerate(points)]
    s = ""
    for gy in range(5):
        yy = y + gy * h / 4
        s += f'<line x1="{x}" y1="{yy:.0f}" x2="{x + w}" y2="{yy:.0f}" stroke="#f0f2f5" stroke-width="1"/>'
    pts = " ".join(f"{a:.1f},{b:.1f}" for a, b in coords)
    if area:
        s += f'<polygon points="{x},{y + h} {pts} {x + w},{y + h}" fill="{color}" opacity="0.12"/>'
    s += f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2.5"/>'
    for a, b in coords[::max(1, n // 10)]:
        s += f'<circle cx="{a:.1f}" cy="{b:.1f}" r="3" fill="#fff" stroke="{color}" stroke-width="2"/>'
    return s

# ---------- 后台框架（侧栏 + 顶栏） ----------

MENUS = ["数据概览", "单用户查询", "全部用户列表", "统计页面", "日期范围查询"]
OPS_MENUS = ["SN 与订单管理", "客服挽回工单池"]

def shell(content, page_title, active, W=1440, H=900):
    s = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
    s += rect(0, 0, W, H, "#f0f2f5")
    # 侧栏
    s += rect(0, 0, 220, H, "#001529")
    s += text(110, 40, "P003读写台数据后台", 15, "#ffffff", weight="600", anchor="middle")
    my = 88
    for m in MENUS:
        if m == active:
            s += rect(0, my - 26, 220, 44, "#409eff")
            s += text(28, my, m, 14, "#ffffff")
        else:
            s += text(28, my, m, 14, "#a6adb4")
        my += 52
    # 运营操作台分组
    s += f'<line x1="16" y1="{my - 18}" x2="204" y2="{my - 18}" stroke="#1d2935" stroke-width="1"/>'
    s += text(28, my + 8, "运营操作台", 11, "#5c6b77")
    my += 40
    for m in OPS_MENUS:
        if m == active:
            s += rect(0, my - 24, 220, 40, "#409eff")
            s += text(28, my, m, 13.5, "#ffffff")
        else:
            s += text(28, my, m, 13.5, "#a6adb4")
        my += 46
    # KidsHub 运营台入口（同一后台互切）
    s += f'<line x1="16" y1="{my - 16}" x2="204" y2="{my - 16}" stroke="#1d2935" stroke-width="1"/>'
    s += rect(12, my - 4, 196, 42, "#3B7A99", rx=8)
    s += text(28, my + 22, "KidsHub 运营台 ↗", 13.5, "#ffffff", weight="700")
    # 顶栏
    s += rect(220, 0, W - 220, 56, "#ffffff", stroke="#ebeef5")
    s += text(248, 35, page_title, 16, "#303133", weight="600")
    s += f'<circle cx="{W - 92}" cy="28" r="14" fill="#409eff"/>'
    s += text(W - 92, 33, "A", 13, "#fff", anchor="middle")
    s += text(W - 70, 33, "admin ▾", 13, "#606266")
    s += content
    s += "</svg>"
    return s

# ---------- 1. 登录页 ----------

def gen_login():
    W, H = 1440, 900
    s = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
    s += ('<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
          '<stop offset="0" stop-color="#667eea"/><stop offset="1" stop-color="#764ba2"/></linearGradient></defs>')
    s += rect(0, 0, W, H, "url(#bg)")
    cx, cy, cw, ch = (W - 420) / 2, (H - 460) / 2, 420, 460
    s += f'<rect x="{cx}" y="{cy}" width="{cw}" height="{ch}" rx="14" fill="#ffffff" filter="drop-shadow(0 8px 24px rgba(0,0,0,0.25))"/>'
    s += text(cx + cw / 2, cy + 88, "P003读写台数据后台", 26, "#303133", weight="700", anchor="middle")
    s += input_box(cx + 50, cy + 140, cw - 100, 46, "请输入账号")
    s += input_box(cx + 50, cy + 206, cw - 100, 46, "请输入密码")
    s += button(cx + 50, cy + 280, cw - 100, 46, "登 录", size=15)
    s += text(cx + cw / 2, cy + 372, "演示账号：", 12, "#909399", anchor="middle")
    s += text(cx + cw / 2, cy + 394, "admin / admin（管理员）", 12, "#909399", anchor="middle")
    s += text(cx + cw / 2, cy + 414, "client / client（B端用户）", 12, "#909399", anchor="middle")
    s += "</svg>"
    return s, 900

# ---------- 2. 数据概览 ----------

def gen_dashboard():
    W, H = 1440, 1240
    c = ""
    X, w_main = 248, W - 248 - 28
    # 筛选条
    c += text(X, 96, "时间范围：", 14, "#606266")
    for i, (lbl, on) in enumerate([("近7天", False), ("近30天", True), ("近90天", False)]):
        bx = X + 80 + i * 84
        c += rect(bx, 78, 80, 30, "#409eff" if on else "#ffffff", rx=4, stroke="#dcdfe6" if not on else "#409eff")
        c += text(bx + 40, 98, lbl, 13, "#ffffff" if on else "#606266", anchor="middle")
    # 指标卡
    cards = [("累计注册用户", "2,847", "↑ 较上月 +128", "#409eff", "#67c23a"),
             ("本月活跃用户", "1,563", "↑ 活跃率 54.9%", "#67c23a", "#67c23a"),
             ("30日活跃率", "54.9%", "↓ 较上月 -2.3%", "#e6a23c", "#f56c6c"),
             ("流失风险用户", "312", "↑ 较上月 +23", "#f56c6c", "#f56c6c")]
    cw = (w_main - 3 * 20) / 4
    for i, (lbl, val, trend, color, tcolor) in enumerate(cards):
        x = X + i * (cw + 20)
        c += card(x, 126, cw, 110)
        c += f'<circle cx="{x + cw - 34}" cy="160" r="18" fill="{color}" opacity="0.9"/>'
        c += text(x + 20, 158, lbl, 13, "#909399")
        c += text(x + 20, 192, val, 28, "#303133", weight="700")
        c += text(x + 20, 218, trend, 12, tcolor)
    # 折线卡
    c += card(X, 258, w_main, 340)
    c += text(X + 20, 290, "每日新增用户趋势", 15, "#303133", weight="600")
    for i, (lbl, on) in enumerate([("7天", False), ("30天", True)]):
        bx = X + w_main - 140 + i * 62
        c += rect(bx, 272, 58, 26, "#409eff" if on else "#fff", rx=4, stroke="#dcdfe6" if not on else "#409eff")
        c += text(bx + 29, 289, lbl, 12, "#fff" if on else "#606266", anchor="middle")
    pts = [62, 75, 68, 88, 95, 81, 102, 96, 110, 89, 118, 104, 92, 121, 108, 96, 125, 112, 99, 116, 128, 107, 95, 119, 126, 111, 98, 122, 130, 117]
    c += line_chart(X + 30, 320, w_main - 60, 250, pts)
    # 两饼图
    half = (w_main - 20) / 2
    c += card(X, 618, half, 300)
    c += text(X + 20, 650, "设备型号分布", 15, "#303133", weight="600")
    c += pie(X + half / 2 - 60, 780, 92,
             [("ULTRA", 38, "#409eff"), ("MAX", 41, "#67c23a"), ("PRO", 21, "#e6a23c")],
             X + half - 150, 740)
    x2 = X + half + 20
    c += card(x2, 618, half, 300)
    c += text(x2 + 20, 650, "用户状态分布", 15, "#303133", weight="600")
    c += pie(x2 + half / 2 - 60, 780, 92,
             [("活跃", 45, "#67c23a"), ("沉默", 25, "#e6a23c"), ("流失风险", 18, "#f56c6c"), ("已流失", 12, "#909399")],
             x2 + half - 150, 726)
    # 地图卡（缩略示意）
    c += card(X, 938, w_main, 270)
    c += text(X + 20, 970, "全国用户分布", 15, "#303133", weight="600")
    c += china_map(X + 120, 950, 0.62)
    c += map_legend(X + w_main - 240, 1010)
    return shell(c, "数据概览", "数据概览", W, H), H

# ---------- 中国地图示意 ----------

def china_map(ox, oy, scale=1.0, highlight=None):
    """粗略中国轮廓 + 省份色块示意"""
    pts = [(280, 60), (380, 30), (470, 50), (520, 110), (500, 170), (530, 230), (490, 300),
           (430, 360), (350, 400), (300, 380), (250, 400), (200, 370), (150, 330),
           (100, 280), (60, 220), (90, 160), (160, 120), (220, 100), (280, 60)]
    path = "M" + " L".join(f"{ox + x * scale:.0f},{oy + y * scale:.0f}" for x, y in pts) + " Z"
    s = f'<path d="{path}" fill="#FDF1E7" stroke="#d0d0d0" stroke-width="1.5"/>'
    provs = [("广东", 430, 340, "#E63946"), ("江苏", 440, 200, "#E63946"), ("浙江", 460, 250, "#E63946"),
             ("北京", 380, 110, "#F4A261"), ("四川", 240, 260, "#F4A261"), ("山东", 410, 160, "#F4A261"),
             ("湖北", 350, 240, "#FAD4B0"), ("陕西", 290, 190, "#FAD4B0"), ("辽宁", 460, 90, "#FAD4B0"),
             ("新疆", 130, 160, "#FDF1E7"), ("云南", 230, 350, "#FAD4B0"), ("湖南", 350, 300, "#F4A261")]
    hl = highlight
    for name, x, y, color in provs:
        r = 26 if name == hl else 20
        stroke = '#c0392b" stroke-width="3' if name == hl else '#ffffff" stroke-width="1.5'
        s += f'<circle cx="{ox + x * scale:.0f}" cy="{oy + y * scale:.0f}" r="{r * scale:.0f}" fill="{color}" stroke="{stroke}" opacity="0.92"/>'
        s += text(ox + x * scale, oy + y * scale + 4, name, int(11 * scale + 2), "#303133", anchor="middle")
    return s

def map_legend(x, y):
    s = text(x, y - 12, "用户数量", 12, "#909399")
    for i, (lbl, color) in enumerate([("Top 1-3", "#E63946"), ("Top 4-10", "#F4A261"),
                                      ("Top 11-20", "#FAD4B0"), ("20名以后", "#FDF1E7")]):
        s += rect(x, y + i * 26, 14, 14, color, rx=2, stroke="#d0d0d0", sw=0.5)
        s += text(x + 22, y + i * 26 + 11, lbl, 12, "#606266")
    return s

if __name__ == "__main__":
    import subprocess
    jobs = {"login": gen_login, "dashboard": gen_dashboard}
    for name, fn in jobs.items():
        svg, h = fn()
        p = f"{OUT}/{name}.svg"
        open(p, "w", encoding="utf-8").write(svg)
        subprocess.run(["rsvg-convert", "-w", "1440", "-o", f"{OUT}/{name}.png", p], check=True)
        print(name, "OK")
