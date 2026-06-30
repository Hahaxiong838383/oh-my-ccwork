# -*- coding: utf-8 -*-
"""新设计 6 张：复访触发台/流失拦截台/度量看板/回告路由台(kh风格) + SN管理/客服工单池(数据看板风格)
   设计依据 = 《P003 Web 后台产品定义》V2 第 7.8/7.9/7.10/八/9.1/9.2 章的字段、规则与参数"""
import subprocess
src = open('/tmp/gen_kh_svg.py', encoding='utf-8').read().split('\nif __name__ ==')[0]
exec(src)  # 含 gen_proto_svg 组件 + shell/OPS_MENUS + kh_shell/chip/ST 等

# ---------- 1. 复访触发台（7.8 四级降级 L1-L4） ----------

def gen_revisit():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "复访触发台（孩子端 · 四级降级）", 18, INK, weight="700")
        s += text(cx + 20, cy + 56, "不走推送 · 不走家长 App · 只在设备端主线场景由小可开口", 12, SOFT)
        rules = [("L1", "入口冷启动", "1 周触发 0 进入", "完成专注后弹引导 + 每周主动唤起一次", "开启", "#4A9DF0"),
                 ("L2", "提交后不回看", "提交后 24h 未查看状态", "小可下一次主线场景开口「你提的那条有结果啦」", "开启", "#3DBE78"),
                 ("L3", "久未提交", "14 日无新提交", "出航 / 破冰里软触发「最近有想吐槽的吗」", "开启", "#F6A724"),
                 ("L4", "等级停滞", "长期初级且无提交", "进入用户访谈名单（人工跟进）", "人工", "#9B7BF0")]
        tx, ty, tw = cx + 20, cy + 76, cw - 40
        s += rect(tx, ty, tw, 44 + len(rules) * 52, "#ffffff", rx=12, stroke=BORDER)
        cols = [("级别", 0.0), ("规则", 0.08), ("触发条件", 0.26), ("动作（设备端主线场景）", 0.50), ("状态", 0.90)]
        for label, fx in cols:
            s += text(tx + 18 + tw * fx, ty + 28, label, 12, SOFT, weight="700")
        s += f'<line x1="{tx}" y1="{ty + 44}" x2="{tx + tw}" y2="{ty + 44}" stroke="{BORDER}"/>'
        yy = ty + 44
        for lv, name, cond, act, st, c in rules:
            s += rect(tx + 14, yy + 13, 36, 24, c, rx=6, opacity=0.16)
            s += text(tx + 32, yy + 30, lv, 13, c, weight="800", anchor="middle")
            s += text(tx + 18 + tw * 0.08, yy + 31, name, 13, INK, weight="600")
            s += text(tx + 18 + tw * 0.26, yy + 31, cond, 12.5, INK)
            s += text(tx + 18 + tw * 0.50, yy + 31, act, 12.5, SOFT)
            s += rect(tx + 14 + tw * 0.90, yy + 15, 52, 22, "#DEF5E9" if st == "开启" else "#EEE8FD", rx=999)
            s += text(tx + 40 + tw * 0.90, yy + 30, st, 11.5, "#3DBE78" if st == "开启" else "#9B7BF0", weight="700", anchor="middle")
            yy += 52
            s += f'<line x1="{tx}" y1="{yy}" x2="{tx + tw}" y2="{yy}" stroke="{BORDER}"/>'
        # 触发记录
        s += text(tx, yy + 38, "触发记录（近 7 天）", 14, INK, weight="700")
        recs = [("06-10 08:12", "小宇", "L2", "破冰场景", "已开口 · 孩子查看了状态"),
                ("06-09 16:40", "果果", "L3", "出航场景", "已开口 · 孩子提交新建议 +1"),
                ("06-08 19:05", "豆豆", "L1", "专注完成", "弹引导 · 进入 KidsHub"),
                ("06-07 10:30", "安安", "L4", "—", "已加入访谈名单")]
        ry = yy + 54
        s += rect(tx, ry, tw, 40 + len(recs) * 40, "#ffffff", rx=12, stroke=BORDER)
        rcols = [("时间", 0.0), ("孩子", 0.16), ("级别", 0.28), ("触达场景", 0.38), ("结果", 0.56)]
        for label, fx in rcols:
            s += text(tx + 18 + tw * fx, ry + 26, label, 12, SOFT, weight="700")
        s += f'<line x1="{tx}" y1="{ry + 40}" x2="{tx + tw}" y2="{ry + 40}" stroke="{BORDER}"/>'
        zy = ry + 40
        for t, kid, lv, scene, result in recs:
            s += text(tx + 18, zy + 26, t, 12, SOFT)
            s += text(tx + 18 + tw * 0.16, zy + 26, kid, 13, INK, weight="600")
            s += text(tx + 18 + tw * 0.28, zy + 26, lv, 12.5, PRIMARY, weight="700")
            s += text(tx + 18 + tw * 0.38, zy + 26, scene, 12.5, INK)
            s += text(tx + 18 + tw * 0.56, zy + 26, result, 12.5, SOFT)
            zy += 40
        return s
    return kh_shell(content, "复访触发")

# ---------- 2. 流失拦截台（7.9 家长端） ----------

def gen_intercept():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "流失拦截台（家长端）", 18, INK, weight="700")
        s += text(cx + 20, cy + 56, "活跃度命中流失规则 + 30 天频控 → 小程序软化单选题 → 按答案即时分流挽回", 12, SOFT)
        # 规则配置卡
        gw = (cw - 60) / 2
        s += rect(cx + 20, cy + 76, gw, 150, "#ffffff", rx=12, stroke=BORDER)
        s += text(cx + 40, cy + 104, "触发规则", 14, INK, weight="700")
        for i, line in enumerate(["流失风险命中：30-60 天未使用（用户状态=流失风险）",
                                  "频控：同一家长 30 天内最多触发 1 次",
                                  "必含选项：「只是暂时没空」 · 未作答只记标记不追问"]):
            s += text(cx + 40, cy + 132 + i * 26, "· " + line, 12.5, SOFT)
        s += rect(cx + 40 + gw, cy + 76, gw, 150, "#ffffff", rx=12, stroke=BORDER)
        s += text(cx + 60 + gw, cy + 104, "挽回分流规则（答案 → 动作）", 14, INK, weight="700")
        flows = [("觉得没用", "→ 推送价值解读（孩子数据亮点）"), ("觉得太贵", "→ 发放搬家券等挽留权益"),
                 ("不会用", "→ 推送教程"), ("暂时没空", "→ 记录，不再打扰")]
        for i, (a, b) in enumerate(flows):
            col, row = i % 2, i // 2
            fx2 = cx + 60 + gw + col * gw / 2
            s += text(fx2, cy + 134 + row * 30, a, 12.5, INK, weight="600")
            s += text(fx2, cy + 152 + row * 30, b, 11.5, SOFT)
        # 答卷记录
        tx, tw = cx + 20, cw - 40
        ry = cy + 250
        s += text(tx, ry, "答卷记录", 14, INK, weight="700")
        recs = [("06-10", "138****2046", "觉得太贵", "已发搬家券", ("tag", "挽回中", "orange")),
                ("06-09", "159****8812", "只是暂时没空", "记录 · 不再打扰", ("tag", "已关闭", "gray")),
                ("06-08", "186****0937", "不会用", "已推教程", ("tag", "已回访", "green")),
                ("06-06", "—（未作答）", "—", "仅记未作答标记", ("tag", "不纠缠", "gray"))]
        ry += 16
        s += rect(tx, ry, tw, 40 + len(recs) * 42, "#ffffff", rx=12, stroke=BORDER)
        rcols = [("日期", 0.0), ("家长", 0.12), ("答案", 0.32), ("挽回动作", 0.54), ("状态", 0.84)]
        for label, fx in rcols:
            s += text(tx + 18 + tw * fx, ry + 26, label, 12, SOFT, weight="700")
        s += f'<line x1="{tx}" y1="{ry + 40}" x2="{tx + tw}" y2="{ry + 40}" stroke="{BORDER}"/>'
        zy = ry + 40
        for d, p, a, act, st in recs:
            s += text(tx + 18, zy + 27, d, 12, SOFT)
            s += text(tx + 18 + tw * 0.12, zy + 27, p, 12.5, INK)
            s += text(tx + 18 + tw * 0.32, zy + 27, a, 12.5, INK, weight="600")
            s += text(tx + 18 + tw * 0.54, zy + 27, act, 12.5, SOFT)
            tcell, _ = tag(tx + 14 + tw * 0.84, zy + 10, st[1], st[2])
            s += tcell
            zy += 42
        s += text(tx, zy + 28, "与复访触发台分开：孩子复访走设备端小可、家长拦截走小程序推送——通道 / 对象 / 话术不同，频控互不污染。", 11.5, SOFT)
        return s
    return kh_shell(content, "流失拦截")

# ---------- 3. KidsHub 度量看板（7.10） ----------

def gen_metrics():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "KidsHub 度量看板", 18, INK, weight="700")
        s += text(cx + 20, cy + 56, "两道验收闸门的判定依据 · 分层自然观察（本版不做 A/B）", 12, SOFT)
        # 孩子侧漏斗
        tx, tw = cx + 20, cw - 40
        s += rect(tx, cy + 72, tw * 0.58, 300, "#ffffff", rx=12, stroke=BORDER)
        s += text(tx + 18, cy + 98, "孩子侧漏斗（本月）", 14, INK, weight="700")
        funnel = [("曝光", 100, 2104), ("进入", 64, 1347), ("开口", 41, 863), ("提交", 33, 694),
                  ("回应送达", 32, 673), ("查看状态", 24, 505), ("再次提交", 15, 316), ("升级", 9, 189)]
        fy = cy + 116
        fw_max = tw * 0.58 - 160
        for name, pct, n in funnel:
            bw = fw_max * pct / 100
            s += text(tx + 18, fy + 14, name, 11.5, SOFT)
            s += rect(tx + 88, fy + 2, bw, 16, PRIMARY, rx=3, opacity=0.25 + pct / 160)
            s += text(tx + 96 + bw, fy + 15, f"{n} · {pct}%", 11, SOFT)
            fy += 22
        # 家长侧 3 卡
        px = tx + tw * 0.58 + 20
        pw = tw - tw * 0.58 - 20
        cards = [("小程序 PV", "3,420"), ("KidsHub 主页 UV", "1,186"), ("家长访问后孩子 7 日提交率", "38%")]
        for i, (lbl, val) in enumerate(cards):
            s += rect(px, cy + 72 + i * 72, pw, 62, "#ffffff", rx=10, stroke=BORDER)
            s += text(px + 16, cy + 96 + i * 72, lbl, 12, SOFT)
            s += text(px + 16, cy + 122 + i * 72, val, 20, SECONDARY, weight="700")
        s += rect(px, cy + 72 + 216, pw, 66, "#EEE8FD", rx=10)
        s += text(px + 16, cy + 96 + 216, "金点子库 vs 已采纳比", 12, "#9B7BF0")
        s += text(px + 16, cy + 124 + 216, "4.2 : 1（防婉拒垃圾桶）", 16, "#9B7BF0", weight="700")
        # 分层留存曲线
        gy = cy + 392
        s += rect(tx, gy, tw, 240, "#ffffff", rx=12, stroke=BORDER)
        s += text(tx + 18, gy + 28, "分层留存曲线（高/中/低/零贡献 · 30/60/90 日）", 14, INK, weight="700")
        series = [("高贡献", "#3DBE78", [82, 74, 69]), ("中贡献", "#4A9DF0", [66, 55, 48]),
                  ("低贡献", "#F6A724", [52, 40, 33]), ("零贡献", "#9aa4ae", [41, 28, 21])]
        gx0, gy0, gw0, gh0 = tx + 60, gy + 50, tw - 320, 160
        for gridv in range(4):
            yy = gy0 + gridv * gh0 / 3
            s += f'<line x1="{gx0}" y1="{yy:.0f}" x2="{gx0 + gw0}" y2="{yy:.0f}" stroke="#f0f2f5"/>'
        for i, d in enumerate(["30日", "60日", "90日"]):
            s += text(gx0 + i * gw0 / 2, gy0 + gh0 + 22, d, 11.5, SOFT, anchor="middle")
        for name, color, vals in series:
            pts = " ".join(f"{gx0 + i * gw0 / 2:.0f},{gy0 + gh0 - v / 100 * gh0:.0f}" for i, v in enumerate(vals))
            s += f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2.5"/>'
            for i, v in enumerate(vals):
                s += f'<circle cx="{gx0 + i * gw0 / 2:.0f}" cy="{gy0 + gh0 - v / 100 * gh0:.0f}" r="3.5" fill="#fff" stroke="{color}" stroke-width="2"/>'
        ly = gy0 + 8
        for name, color, vals in series:
            s += rect(gx0 + gw0 + 40, ly - 8, 12, 12, color, rx=2)
            s += text(gx0 + gw0 + 60, ly + 3, f"{name}（90日 {vals[2]}%）", 12, "#606266")
            ly += 26
        s += text(gx0 + gw0 + 40, ly + 8, "闸门②：高贡献显著高于", 11.5, SOFT)
        s += text(gx0 + gw0 + 40, ly + 26, "零贡献 + 切片较基线 ≥5pp", 11.5, SOFT)
        return s
    return kh_shell(content, "度量看板", H=900)

# ---------- 4. 回告路由台（第八章） ----------

def gen_notify():
    def content(cx, cy, cw, ch):
        s = text(cx + 20, cy + 34, "回告路由台（仅家长端定向 + 全体公开预告）", 18, INK, weight="700")
        s += text(cx + 20, cy + 56, "孩子端回告归 KidsHub（功能 15），不在本台 · 推送只是提醒，内容必落消息中心可重看", 12, SOFT)
        tx, tw = cx + 20, cw - 40
        # 路由队列
        s += text(tx, cy + 88, "路由队列", 14, INK, weight="700")
        rows = [("KH-198", "小改 · 已上线", "定向 → 来源家长（138****2046）", "48h 内", ("tag", "已送达·已打开", "green")),
                ("KH-235", "大功能 · 开发中", "公开预告 → 全体（周报首页+开机预告位）", "并入下周报", ("tag", "排期中", "blue")),
                ("KH-176", "小改 · 已上线", "定向 → 来源家长（159****8812）", "48h 内", ("tag", "7天未打开→兜底", "red")),
                ("KH-152", "大功能 · 规划中", "公开预告 → 全体（话术「在做」）", "并入下周报", ("tag", "草稿", "gray"))]
        ry = cy + 102
        s += rect(tx, ry, tw, 40 + len(rows) * 42, "#ffffff", rx=12, stroke=BORDER)
        rcols = [("工单", 0.0), ("级别 · 阶段", 0.10), ("路由目标", 0.30), ("时效", 0.66), ("送达状态", 0.80)]
        for label, fx in rcols:
            s += text(tx + 18 + tw * fx, ry + 26, label, 12, SOFT, weight="700")
        s += f'<line x1="{tx}" y1="{ry + 40}" x2="{tx + tw}" y2="{ry + 40}" stroke="{BORDER}"/>'
        zy = ry + 40
        for iid, lvl, target, sla, st in rows:
            s += text(tx + 18, zy + 27, iid, 12, SOFT)
            s += text(tx + 18 + tw * 0.10, zy + 27, lvl, 12.5, INK, weight="600")
            s += text(tx + 18 + tw * 0.30, zy + 27, target, 12.5, INK)
            s += text(tx + 18 + tw * 0.66, zy + 27, sla, 12.5, SOFT)
            tcell, _ = tag(tx + 14 + tw * 0.80, zy + 10, st[1], st[2])
            s += tcell
            zy += 42
        # 送达监控 + 兜底
        gw = (tw - 20) / 2
        my = zy + 30
        s += rect(tx, my, gw, 130, "#ffffff", rx=12, stroke=BORDER)
        s += text(tx + 18, my + 28, "送达监控", 14, INK, weight="700")
        mets = [("定向回告送达率", "98%"), ("打开率", "62%"), ("7天未打开（已走兜底）", "3 条")]
        for i, (k, v) in enumerate(mets):
            s += text(tx + 18, my + 58 + i * 24, k, 12, SOFT)
            s += text(tx + gw - 24, my + 58 + i * 24, v, 13, PRIMARY, weight="700", anchor="end")
        s += rect(tx + gw + 20, my, gw, 130, "#ffffff", rx=12, stroke=BORDER)
        s += text(tx + gw + 38, my + 28, "措辞模板（共创化）", 14, INK, weight="700")
        s += rect(tx + gw + 38, my + 44, gw - 40, 64, BG, rx=8)
        s += text(tx + gw + 52, my + 70, "「因为你的建议，小可又进化了」", 13, INK, weight="600")
        s += text(tx + gw + 52, my + 92, "+ 改后对比图（眼见为实）", 12, SOFT)
        s += text(tx, my + 158, "兜底链：推送 7 天未打开 → 周报二次提醒 + 消息中心常驻红点；亲子纽带联动仅触发条件，孩子端展示归功能 15。", 11.5, SOFT)
        return s
    return kh_shell(content, "回告路由")

# ---------- 5. SN 与订单管理（9.1 数据看板风格） ----------

def gen_ops_sn():
    W, H = 1440, 860
    X, w_main = 248, W - 248 - 28
    c = rect(X, 80, w_main, 56, "#E3F0FD", rx=8)
    c += text(X + 20, 114, "⚙ 口径 P0：退货 / 呆滞 SN 自动从激活率分母剔除（聚合层生效）——本页人工操作台为 P1 交付", 13, "#2E6480", weight="600")
    c += card(X, 152, w_main, 76)
    c += input_box(X + 20, 172, 320, 36, "SN / 订单号检索", filled=False)
    c += button(X + 352, 172, 84, 36, "检索")
    c += text(X + 460, 195, "状态：", 13, "#606266")
    c += input_box(X + 504, 172, 140, 36, "全部 ▾", filled=True)
    rows = [
        ["SN-2403-0117", "PO-88213", "2026-03-02", ("tag", "已激活", "green"), "—", ("link", "换绑 / 解绑")],
        ["SN-2403-0254", "PO-88419", "2026-03-15", ("tag", "未激活", "orange"), "—", ("link", "查看")],
        ["SN-2402-0083", "PO-87206", "2026-02-11", ("tag", "已退货", "red"), "已剔除分母", ("link", "打呆滞标记")],
        ["SN-2402-0095", "PO-87391", "2026-02-18", ("tag", "呆滞", "gray"), "已剔除分母", ("link", "重置（翻新再售）")],
        ["SN-2401-0312", "PO-86150", "2026-01-25", ("tag", "已激活", "green"), "—", ("link", "换绑 / 解绑")],
        ["SN-2401-0078", "PO-85894", "2026-01-12", ("tag", "重置待售", "blue"), "重置后不计已激活", ("link", "绑定新订单")],
    ]
    headers = ["设备 SN", "绑定订单", "出库日期", "激活状态", "分母处理", "操作"]
    widths = [200, 160, 160, 160, 220, 264]
    c += card(X, 248, w_main, 44 + len(rows) * 40 + 20)
    t, _ = table(X + 20, 264, w_main - 40, headers, widths, rows)
    c += t
    c += text(X, 248 + 44 + len(rows) * 40 + 50, "退货 SN 状态可重置（翻新二次售出不能直接算「已激活」）；P0 期间退货名单由订单系统导入兜底。", 12, "#909399")
    return shell(c, "SN 与订单管理（运营操作台）", "SN 与订单管理", W, H)

# ---------- 6. 客服挽回工单池（9.2 数据看板风格） ----------

def gen_ops_cs():
    W, H = 1440, 880
    X, w_main = 248, W - 248 - 28
    c = ""
    cards = [("今日新增工单（T+5）", "14", "#409eff"), ("待外呼", "9", "#e6a23c"), ("本周挽回成功率", "31%", "#67c23a")]
    cw = (w_main - 2 * 20) / 3
    for i, (lbl, val, color) in enumerate(cards):
        x = X + i * (cw + 20)
        c += card(x, 80, cw, 96)
        c += text(x + 20, 110, lbl, 13, "#909399")
        c += text(x + 20, 148, val, 26, color, weight="700")
    rows = [
        ["SN-2403-0254", "138****2046", "T+6", "蓝牙日志：WiFi 5G 不兼容 · 卡配网", ("tag", "待外呼", "orange"), ("link", "记录外呼")],
        ["SN-2403-0311", "159****8812", "T+5", "蓝牙日志：闸门1已过 · 孩子未真用", ("tag", "待外呼", "orange"), ("link", "记录外呼")],
        ["SN-2402-0188", "186****0937", "T+8", "蓝牙日志：路由器密码错误 3 次", ("tag", "已挽回", "green"), ("link", "查看")],
        ["SN-2402-0205", "135****5523", "T+9", "蓝牙日志：闸门2未过 · 开盖无交互", ("tag", "跟进中", "blue"), ("link", "记录外呼")],
        ["SN-2401-0420", "150****7741", "T+12", "未取得联系（2 次）", ("tag", "二次跟进", "red"), ("link", "记录外呼")],
    ]
    headers = ["设备 SN", "家长联系方式", "T+天数", "蓝牙错误日志摘要（外呼前必看）", "状态", "操作"]
    widths = [180, 170, 100, 380, 140, 194]
    c += card(X, 196, w_main, 44 + len(rows) * 40 + 20)
    t, _ = table(X + 20, 212, w_main - 40, headers, widths, rows)
    c += t
    y2 = 196 + 44 + len(rows) * 40 + 50
    c += text(X, y2, "触达分级：T+1 / T+3 自动提醒（扣除周末权重），T+5 转人工 · 日志区分「卡配网」vs「激活了没真用」，话术按卡点精准。", 12, "#909399")
    c += text(X, y2 + 22, "P0 过渡：未激活名单每日导出 excel（复用统计页导出），本工单池界面 P1 交付。", 12, "#909399")
    return shell(c, "客服挽回工单池（运营操作台）", "客服挽回工单池", W, H)

if __name__ == "__main__":
    jobs = {"kh-revisit": (gen_revisit, 1280), "kh-intercept": (gen_intercept, 1280),
            "kh-metrics": (gen_metrics, 1280), "kh-notify": (gen_notify, 1280),
            "ops-sn": (gen_ops_sn, 1440), "ops-cs": (gen_ops_cs, 1440)}
    for name, (fn, w) in jobs.items():
        svg = fn()
        p = f"{OUT}/{name}.svg"
        open(p, "w", encoding="utf-8").write(svg)
        subprocess.run(["rsvg-convert", "-w", str(w), "-o", f"{OUT}/{name}.png", p], check=True)
        print(name, "OK")
