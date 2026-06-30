# -*- coding: utf-8 -*-
"""KidsHub Web 后台原型 6 张：按 kidshub-prototype.html 源码 1:1 重绘（brand-admin 青蓝专业风 + BrowserFrame）"""
import subprocess
src = open('/tmp/gen_proto_svg.py', encoding='utf-8').read().split('if __name__')[0]
exec(src)

# admin design tokens（源码 .brand-admin）
PRIMARY = "#3B7A99"; SECONDARY = "#5B8C7B"; ACCENT = "#E0913A"
BG = "#F6F8FA"; INK = "#1F2933"; SOFT = "#6B7785"; BORDER = "#E4E9EF"
ST = {  # 状态四态（全正面）
    "received":  ("已收到", "#F6A724", "#FEF3DC"),
    "reviewing": ("评估中", "#4A9DF0", "#E3F0FD"),
    "adopted":   ("已采纳", "#3DBE78", "#DEF5E9"),
    "vault":     ("金点子库", "#9B7BF0", "#EEE8FD"),
}
NAVS = ["Issue 看板", "贡献账本", "金点子库", "版本决策", "复访触发", "流失拦截", "度量看板", "回告路由"]

def chip(x, y, status, size=13):
    label, c, bg = ST[status]
    w = len(label) * size + 34
    s = rect(x, y, w, size + 12, bg, rx=999)
    s += f'<circle cx="{x + 13}" cy="{y + (size + 12) / 2}" r="{size * 0.25}" fill="{c}"/>'
    s += text(x + 22, y + (size + 12) / 2 + size * 0.36, label, size, c, weight="700")
    return s, w

def kh_shell(content, active, W=1280, H=840, url="hub.p003.cn/admin"):
    """BrowserFrame + admin 左导航"""
    s = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
    s += rect(0, 0, W, H, "#ECEFF3")
    fx, fy, fw, fh = 50, 36, W - 100, H - 72
    s += f'<rect x="{fx}" y="{fy}" width="{fw}" height="{fh}" rx="14" fill="#ffffff" stroke="#d7dde5" filter="drop-shadow(0 18px 40px rgba(20,28,40,0.28))"/>'
    # 浏览器栏
    s += rect(fx, fy, fw, 42, "#eef1f5", rx=14)
    s += rect(fx, fy + 28, fw, 14, "#eef1f5")
    for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        s += f'<circle cx="{fx + 24 + i * 20}" cy="{fy + 21}" r="6" fill="{c}"/>'
    s += rect(fx + 92, fy + 9, fw - 120, 25, "#ffffff", rx=7, stroke="#e1e6ec")
    s += text(fx + 106, fy + 26, url, 12, "#67727f")
    # 内容底
    cy0 = fy + 42
    ch = fh - 42
    s += rect(fx, cy0, fw, ch, BG)
    # 左导航 168
    s += rect(fx, cy0, 168, ch, "#ffffff")
    s += f'<line x1="{fx + 168}" y1="{cy0}" x2="{fx + 168}" y2="{cy0 + ch}" stroke="{BORDER}"/>'
    s += text(fx + 16, cy0 + 34, "KidsHub 后台", 14, PRIMARY, weight="800")
    ny = cy0 + 64
    for n in NAVS:
        if n == active:
            s += rect(fx + 10, ny - 18, 148, 34, "#E3F0FD", rx=8)
            s += text(fx + 22, ny + 4, n, 13, PRIMARY, weight="700")
        else:
            s += text(fx + 22, ny + 4, n, 13, SOFT, weight="600")
        ny += 42
    # 数据看板入口（同一后台互切）
    s += f'<line x1="{fx + 12}" y1="{cy0 + ch - 64}" x2="{fx + 156}" y2="{cy0 + ch - 64}" stroke="{BORDER}"/>'
    s += rect(fx + 10, cy0 + ch - 52, 148, 36, BG, rx=8, stroke=BORDER)
    s += text(fx + 22, cy0 + ch - 29, "⇠ 数据看板", 13, PRIMARY, weight="700")
    s += content(fx + 168, cy0, fw - 168, ch)
    s += "</svg>"
    return s

ISSUES = {
    "received": [("KH-241", "专注按钮太小，孩子够不着", "孩子", "吐槽", "专注·交互", 5),
                 ("KH-240", "周报里护眼数据看不太懂", "家长", "困惑", "周报·可读性", 2)],
    "reviewing": [("KH-235", "夜航故事太短，想听更长", "孩子", "期待", "夜航·内容", 12)],
    "adopted":  [("KH-198", "开机问候叫孩子名字", "孩子", "建议", "破冰·个性化", 8)],
    "vault":    [("KH-176", "想要会发光的恐龙皮肤", "孩子", "愿望", "皮肤·养成", 1),
                 ("KH-152", "能不能和同学比贡献值", "孩子", "愿望", "社交·PK", 1)],
}
THEMES = [("夜航·内容", 12, "期待"), ("专注·交互", 9, "吐槽"), ("皮肤·养成", 7, "愿望"), ("周报·可读性", 4, "困惑")]

def issue_card(x, y, w, iid, txt, src, mood, theme, contrib):
    h = 108
    s = rect(x, y, w, h, "#ffffff", rx=8, stroke=BORDER)
    s += text(x + 12, y + 22, iid, 11, SOFT)
    sc = ACCENT if src == "孩子" else SECONDARY
    sw = len(src) * 11 + 18
    s += rect(x + w - sw - 12, y + 10, sw, 18, sc, rx=999, opacity=0.9)
    s += text(x + w - sw / 2 - 12, y + 23, src, 11, "#ffffff", weight="700", anchor="middle")
    s += text(x + 12, y + 48, txt[:14], 13, INK, weight="600")
    if len(txt) > 14:
        s += text(x + 12, y + 66, txt[14:], 13, INK, weight="600")
    ty = y + h - 24
    s += rect(x + 12, ty - 12, len(mood) * 11 + 30, 18, BG, rx=6)
    s += text(x + 18, ty + 1, f"😶 {mood}", 11, SOFT)
    tw = len(theme) * 11 + 22
    s += rect(x + 12 + len(mood) * 11 + 38, ty - 12, tw, 18, BG, rx=6)
    s += text(x + 18 + len(mood) * 11 + 38, ty + 1, f"#{theme}", 11, SOFT)
    s += text(x + w - 16, ty + 1, f"+{contrib}", 12, PRIMARY, weight="700", anchor="end")
    return s, h

def theme_pool_panel(x, y, w):
    s = text(x + 16, y + 28, "主题池", 14, INK, weight="700")
    s += text(x + 16, y + 48, "情绪极性 + 主题 双标签聚合", 11, SOFT)
    s += text(x + 16, y + 64, "攒够阈值进版本决策", 11, SOFT)
    yy = y + 80
    for name, n, mood in THEMES:
        s += rect(x + 14, yy, w - 28, 54, BG, rx=8)
        s += text(x + 26, yy + 23, name, 13, INK, weight="700")
        s += text(x + 26, yy + 41, f"情绪：{mood}", 11, SOFT)
        s += text(x + w - 28, yy + 34, str(n), 18, PRIMARY if n >= 10 else SOFT, weight="800", anchor="end")
        yy += 62
    s += rect(x + 14, yy + 4, w - 28, 64, "#E3F0FD", rx=8)
    s += text(x + 26, yy + 28, "“夜航·内容” 已达 12 条 ≥ 阈值，", 12, "#4A9DF0", weight="600")
    s += text(x + 26, yy + 48, "建议进入版本决策。", 12, "#4A9DF0", weight="600")
    return s

# ---------- 1. Issue 看板（含主题池侧栏） ----------

def gen_board():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "KidsHub 后台 · Issue 看板", 18, INK, weight="700")
        s += text(cx + 20, cy + 56, "拖动卡片推进状态 · 全正面态 · 终态变更需二次确认", 12, SOFT)
        s += rect(cx + cw - 360, cy + 18, 92, 28, "#ffffff", rx=8, stroke=BORDER)
        s += text(cx + cw - 314, cy + 37, "来源：全部", 12, SOFT, anchor="middle")
        s += rect(cx + cw - 258, cy + 18, 92, 28, "#ffffff", rx=8, stroke=BORDER)
        s += text(cx + cw - 212, cy + 37, "情绪：全部", 12, SOFT, anchor="middle")
        s += rect(cx + cw - 152, cy + 18, 110, 28, PRIMARY, rx=8)
        s += text(cx + cw - 97, cy + 37, "+ 版本决策", 12, "#fff", weight="700", anchor="middle")
        s += f'<line x1="{cx}" y1="{cy + 72}" x2="{cx + cw}" y2="{cy + 72}" stroke="{BORDER}"/>'
        pool_w = 240
        main_w = cw - pool_w
        col_w = (main_w - 5 * 14) / 4
        for ci, key in enumerate(["received", "reviewing", "adopted", "vault"]):
            colx = cx + 14 + ci * (col_w + 14)
            cs, cw2 = chip(colx, cy + 88, key, 12)
            s += cs
            s += text(colx + col_w - 6, cy + 105, str(len(ISSUES[key])), 12, SOFT, weight="700", anchor="end")
            yy = cy + 124
            for it in ISSUES[key]:
                ic, ih = issue_card(colx, yy, col_w, *it)
                s += ic
                yy += ih + 10
        px = cx + main_w
        s += rect(px, cy + 72, pool_w, ch - 72, "#ffffff")
        s += f'<line x1="{px}" y1="{cy + 72}" x2="{px}" y2="{cy + ch}" stroke="{BORDER}"/>'
        s += theme_pool_panel(px, cy + 72, pool_w)
        return s
    return kh_shell(content, "Issue 看板")

# ---------- 2. 工单详情抽屉（状态机操作） ----------

def gen_drawer():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "KidsHub 后台 · Issue 看板", 18, INK, weight="700")
        col_w = (cw - 240 - 5 * 14) / 4
        for ci, key in enumerate(["received", "reviewing", "adopted", "vault"]):
            colx = cx + 14 + ci * (col_w + 14)
            cs, _ = chip(colx, cy + 70, key, 12)
            s += cs
            yy = cy + 106
            for it in ISSUES[key][:1]:
                ic, ih = issue_card(colx, yy, col_w, *it)
                s += ic
        # 遮罩 + 抽屉
        s += rect(cx, cy, cw, ch, "#141C28", opacity=0.28)
        dw = 380
        dx = cx + cw - dw
        s += rect(dx, cy, dw, ch, "#ffffff")
        s += f'<rect x="{dx}" y="{cy}" width="{dw}" height="{ch}" fill="none" stroke="#00000022"/>'
        s += text(dx + 20, cy + 30, "KH-235", 12, SOFT)
        s += text(dx + dw - 24, cy + 32, "×", 20, SOFT, anchor="end")
        s += text(dx + 20, cy + 62, "夜航故事太短，想听更长", 16, INK, weight="700")
        for i, t in enumerate(["来源：孩子", "情绪：期待", "#夜航·内容"]):
            tx = dx + 20 + i * 92
            s += rect(tx, cy + 78, len(t) * 11 + 18, 22, BG, rx=8)
            s += text(tx + 9, cy + 93, t, 11, SOFT)
        s += text(dx + 20, cy + 132, "状态推进（全正面 · 终态需二次确认）", 13, SOFT, weight="800")
        opts = [("received", False), ("reviewing", True), ("adopted", False)]
        yy = cy + 148
        for key, cur in opts:
            stroke = PRIMARY if cur else BORDER
            s += rect(dx + 20, yy, dw - 40, 44, BG if cur else "#ffffff", rx=10, stroke=stroke, sw=2 if cur else 1)
            cs, _ = chip(dx + 32, yy + 9, key, 12)
            s += cs
            if cur:
                s += text(dx + dw - 34, yy + 27, "当前", 12, PRIMARY, weight="700", anchor="end")
            yy += 54
        s += f'<rect x="{dx + 20}" y="{yy}" width="{dw - 40}" height="44" rx="10" fill="none" stroke="{BORDER}" stroke-dasharray="5,4"/>'
        cs, cwv = chip(dx + 32, yy + 9, "vault", 12)
        s += cs
        s += text(dx + 44 + cwv, yy + 27, "暂不采纳 → 珍藏", 12, SOFT)
        yy += 70
        s += text(dx + 20, yy, "回告路由", 13, SOFT, weight="800")
        s += text(dx + 20, yy + 24, "采纳后 → 孩子端 KidsHub 署名致谢", 13, SOFT)
        s += text(dx + 20, yy + 44, "+ 家长端消息中心定向回告。", 13, SOFT)
        return s
    return kh_shell(content, "Issue 看板")

# ---------- 3. 主题池放大 ----------

def gen_themepool():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "主题池 · 聚合视图", 18, INK, weight="700")
        s += text(cx + 20, cy + 56, "情绪极性 + 主题双标签聚合，同类合并看量级；达到阈值自动标「待决策」", 12, SOFT)
        gw = (cw - 60) / 2
        yy = cy + 80
        for i, (name, n, mood) in enumerate(THEMES):
            gx = cx + 20 + (i % 2) * (gw + 20)
            gy = yy + (i // 2) * 120
            hot = n >= 10
            s += rect(gx, gy, gw, 104, "#ffffff", rx=12, stroke=PRIMARY if hot else BORDER, sw=2 if hot else 1)
            s += text(gx + 20, gy + 32, name, 16, INK, weight="700")
            s += text(gx + 20, gy + 56, f"情绪极性：{mood} · 双标签聚合", 12, SOFT)
            if hot:
                s += rect(gx + 20, gy + 70, 150, 22, "#E3F0FD", rx=6)
                s += text(gx + 28, gy + 86, "≥ 阈值 · 待决策", 12, "#4A9DF0", weight="700")
            else:
                s += text(gx + 20, gy + 86, f"距阈值还差 {10 - n} 条", 12, SOFT)
            s += text(gx + gw - 24, gy + 50, str(n), 34, PRIMARY if hot else SOFT, weight="800", anchor="end")
            s += text(gx + gw - 24, gy + 72, "条反馈", 11, SOFT, anchor="end")
        by = yy + 260
        s += rect(cx + 20, by, cw - 40, 64, "#E3F0FD", rx=10)
        s += text(cx + 40, by + 27, "⚡ “夜航·内容” 已达 12 条 ≥ 阈值，建议进入版本决策。", 14, "#4A9DF0", weight="700")
        s += rect(cx + cw - 170, by + 16, 130, 32, PRIMARY, rx=8)
        s += text(cx + cw - 105, by + 37, "进入版本决策", 13, "#fff", weight="700", anchor="middle")
        s += text(cx + 20, by + 100, "AI 标签仅为建议，运营确认/修正后生效；AI 聚类未上线时人工打标为 P0 合格降级。", 12, SOFT)
        return s
    return kh_shell(content, "Issue 看板")

# ---------- 4. 贡献账本 ----------

def gen_ledger():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "贡献账本", 18, INK, weight="700")
        s += text(cx + 20, cy + 56, "贡献值 / 等级由「被采纳的质量」驱动，非提交数量（防灌水刷分）", 12, SOFT)
        rows = [("乐乐", 5, "金牌共建", 240, 4, "4.9", "#F6A724"),
                ("果果", 4, "点子能手", 175, 2, "4.4", "#4A9DF0"),
                ("朵朵", 3, "小小设计师", 128, 1, "4.6", "#3DBE78"),
                ("豆豆", 2, "新晋玩家", 56, 0, "3.8", "#9B7BF0")]
        tx, ty, tw = cx + 20, cy + 76, cw - 40
        s += rect(tx, ty, tw, 46 + len(rows) * 56, "#ffffff", rx=12, stroke=BORDER)
        cols = [("孩子", 0.0), ("等级", 0.30), ("贡献值", 0.55), ("已采纳", 0.72), ("质量分", 0.87)]
        for label, fx in cols:
            s += text(tx + 20 + tw * fx, ty + 30, label, 12, SOFT, weight="700")
        s += f'<line x1="{tx}" y1="{ty + 46}" x2="{tx + tw}" y2="{ty + 46}" stroke="{BORDER}"/>'
        yy = ty + 46
        for name, lv, title, contrib, adopted, q, ac in rows:
            s += f'<circle cx="{tx + 38}" cy="{yy + 28}" r="16" fill="{ac}" opacity="0.85"/>'
            s += text(tx + 38, yy + 33, name[0], 13, "#fff", weight="700", anchor="middle")
            s += text(tx + 64, yy + 33, name, 14, INK, weight="600")
            s += text(tx + 20 + tw * 0.30, yy + 33, f"Lv.{lv} {title}", 13, INK)
            s += text(tx + 20 + tw * 0.55, yy + 33, str(contrib), 15, PRIMARY, weight="700")
            s += text(tx + 20 + tw * 0.72, yy + 33, str(adopted), 14, INK)
            s += text(tx + 20 + tw * 0.87, yy + 33, q, 15, "#3DBE78", weight="700")
            yy += 56
            s += f'<line x1="{tx}" y1="{yy}" x2="{tx + tw}" y2="{yy}" stroke="{BORDER}"/>'
        s += text(tx, yy + 36, "每笔贡献可溯源到来源工单；等级档位与命名后台可配置。", 12, SOFT)
        return s
    return kh_shell(content, "贡献账本")

# ---------- 5. 金点子库 ----------

def gen_vault():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "金点子库", 18, INK, weight="700")
        s += text(cx + 20, cy + 56, "暂未进版本但被珍藏的点子 · 攒够热度可「翻牌」进版本决策", 12, SOFT)
        ideas = [("夜航能不能去太空", "豆豆", 15), ("想要会发光的恐龙皮肤", "朵朵", 12),
                 ("能不能和同学比贡献值", "乐乐", 8), ("生态缸加只小乌龟", "朵朵", 9),
                 ("小可能不能讲笑话", "果果", 6), ("专注音乐能换吗", "乐乐", 5)]
        gw = (cw - 40 - 2 * 16) / 3
        for i, (title, by, votes) in enumerate(ideas):
            gx = cx + 20 + (i % 3) * (gw + 16)
            gy = cy + 76 + (i // 3) * 150
            s += rect(gx, gy, gw, 136, "#ffffff", rx=10, stroke="#D9CEF7")
            s += text(gx + 16, gy + 28, "★", 14, "#9B7BF0")
            s += text(gx + 34, gy + 28, f"{votes} 热度", 12, "#9B7BF0", weight="800")
            s += text(gx + 16, gy + 60, title, 14, INK, weight="600")
            s += text(gx + 16, gy + 112, f"by {by}", 12, SOFT)
            s += rect(gx + gw - 84, gy + 96, 68, 26, "#EEE8FD", rx=8)
            s += text(gx + gw - 50, gy + 114, "翻牌 →", 12, "#9B7BF0", weight="700", anchor="middle")
        s += text(cx + 20, cy + 410, "不是回收站：主题征集 / 版本翻牌 / 月度回顾时从这里回捞；持续盯「金点子库 vs 已采纳比」。", 12, SOFT)
        return s
    return kh_shell(content, "金点子库")

# ---------- 6. 版本决策与致谢 ----------

def gen_version():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "版本决策与更新说明致谢", 18, INK, weight="700")
        s += text(cx + 20, cy + 56, "采纳的反馈 → 升版 → 更新说明署名致谢（= changelog contributors）", 12, SOFT)
        bx, by, bw = cx + 20, cy + 76, min(cw - 40, 700)
        s += rect(bx, by, bw, 330, "#ffffff", rx=12, stroke=BORDER)
        s += text(bx + 24, by + 38, "v1.4 更新说明（草稿）", 16, INK, weight="700")
        cs, _ = chip(bx + bw - 110, by + 22, "adopted", 12)
        s += cs
        s += text(bx + 24, by + 76, "这次因为小朋友们的建议，小可又进化了：", 14, INK, weight="700")
        adopted = [("开机问候叫孩子名字", "朵朵"), ("坐姿提醒改温和不锁屏", "乐乐"), ("周报数据加图标说明", "果果")]
        yy = by + 100
        for txt, by_ in adopted:
            s += text(bx + 24, yy + 20, f"· {txt}", 13, INK)
            s += text(bx + bw - 24, yy + 20, f"致谢 @{by_}", 13, "#3DBE78", weight="700", anchor="end")
            s += f'<line x1="{bx + 24}" y1="{yy + 34}" x2="{bx + bw - 24}" y2="{yy + 34}" stroke="{BORDER}" stroke-dasharray="4,4"/>'
            yy += 48
        s += rect(bx + 24, yy + 16, 140, 34, PRIMARY, rx=8)
        s += text(bx + 94, yy + 38, "发布 + 推送致谢", 13, "#fff", weight="700", anchor="middle")
        s += rect(bx + 178, yy + 16, 96, 34, "#ffffff", rx=8, stroke=BORDER)
        s += text(bx + 226, yy + 38, "编辑文案", 13, SOFT, anchor="middle")
        s += text(cx + 20, by + 360, "发布后：孩子端 KidsHub 署名致谢（归功能 15）+ 家长端定向回告（归功能 17 回告路由台）。", 12, SOFT)
        return s
    return kh_shell(content, "版本决策")

if __name__ == "__main__":
    jobs = {"kh-board": gen_board, "kh-drawer": gen_drawer, "kh-themepool": gen_themepool,
            "kh-ledger": gen_ledger, "kh-vault": gen_vault, "kh-version": gen_version}
    for name, fn in jobs.items():
        svg = fn()
        p = f"{OUT}/{name}.svg"
        open(p, "w", encoding="utf-8").write(svg)
        subprocess.run(["rsvg-convert", "-w", "1280", "-o", f"{OUT}/{name}.png", p], check=True)
        print(name, "OK")
