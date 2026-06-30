# -*- coding: utf-8 -*-
"""剩余 6 张：单用户查询/详情、全部用户列表、统计、日期查询、全国地图+省份下钻"""
import subprocess
src = open('/tmp/gen_proto_svg.py', encoding='utf-8').read().split('if __name__')[0]
exec(src)

# ---------- 3. 单用户查询（搜索列表态） ----------

def gen_user_query():
    W, H = 1440, 760
    X, w_main = 248, W - 248 - 28
    c = card(X, 80, w_main, 76)
    c += input_box(X + 20, 100, 420, 38, "DEV", filled=True)
    c += button(X + 452, 100, 92, 38, "搜索")
    c += text(X + 560, 124, "支持按用户昵称或设备ID搜索", 12, "#909399")
    rows = [
        ["小宇", "2026-03-12", "2026-06-09", "131h", ("tag", "ULTRA", "red"), "6/7", ("tag", "活跃", "green"), ("link", "查看详情")],
        ["朵朵", "2026-02-25", "2026-06-08", "96h", ("tag", "MAX", "orange"), "5/7", ("tag", "活跃", "green"), ("link", "查看详情")],
        ["乐乐", "2026-04-02", "2026-05-30", "58h", ("tag", "PRO", "gray"), "3/7", ("tag", "沉默", "orange"), ("link", "查看详情")],
        ["糖糖", "2026-01-18", "2026-06-10", "152h", ("tag", "ULTRA", "red"), "7/7", ("tag", "活跃", "green"), ("link", "查看详情")],
        ["俊俊", "2026-03-28", "2026-04-26", "33h", ("tag", "MAX", "orange"), "0/7", ("tag", "流失风险", "red"), ("link", "查看详情")],
        ["妞妞", "2026-02-09", "2026-06-07", "88h", ("tag", "PRO", "gray"), "4/7", ("tag", "活跃", "green"), ("link", "查看详情")],
    ]
    headers = ["用户昵称", "绑定日期", "最近活跃日期", "累计使用时长", "设备型号", "7日活跃天数", "当前状态", "操作"]
    widths = [120, 152, 168, 158, 140, 152, 150, 124]
    c2 = card(X, 176, w_main, 56 + 44 + 6 * 40 + 18)
    c2 += text(X + 20, 210, "查询结果（6 条）", 14, "#303133", weight="600")
    t, th = table(X + 20, 226, w_main - 40, headers, widths, rows)
    c2 += t
    return shell(c + c2, "单用户查询", "单用户查询", W, H), H

# ---------- 4. 单用户详情 ----------

def gen_user_detail():
    W, H = 1440, 1300
    X, w_main = 248, W - 248 - 28
    c = text(X, 96, "← 返回搜索结果", 13, "#409eff")
    c += text(X + 150, 96, "用户详情：小宇（DEV-1006）", 16, "#303133", weight="600")
    # 6 指标卡
    cards = [("日均使用时长", "1.8h", "↑ 高于均值", "#409eff"),
             ("7日活跃天数", "6/7", "周一至周日", "#67c23a"),
             ("专注模式偏好", "出航 62%", "陪伴 38%", "#409eff"),
             ("流失风险", "低", "连续未活跃 0 天", "#67c23a"),
             ("宝箱开启率", "84%", "已开 21 / 应开 25", "#e6a23c"),
             ("藏品收集完成度", "57%", "已收集 17 / 30", "#e6a23c")]
    cw = (w_main - 5 * 16) / 6
    for i, (lbl, val, sub, color) in enumerate(cards):
        x = X + i * (cw + 16)
        c += card(x, 116, cw, 108)
        c += text(x + 14, 144, lbl, 12, "#909399")
        c += text(x + 14, 178, val, 22, color, weight="700")
        c += text(x + 14, 204, sub, 11, "#909399")
        if lbl == "7日活跃天数":
            for d in range(7):
                fill = "#67c23a" if d != 3 else "#ebeef5"
                c += rect(x + 14 + d * 22, 188, 16, 10, fill, rx=2)
        if "率" in lbl or "完成度" in lbl:
            pct = 0.84 if "宝箱" in lbl else 0.57
            c += rect(x + 14, 190, cw - 28, 8, "#ebeef5", rx=4)
            c += rect(x + 14, 190, (cw - 28) * pct, 8, color, rx=4)
    # 模块分区（展示 4 组 + 折叠提示）
    modules = [
        ("📋 基本信息（来源：3.1 用户基础信息）",
         [("用户昵称", "小宇"), ("设备ID", "DEV-1006"), ("设备型号", "ULTRA"),
          ("固件版本", "v2.3.1"), ("绑定日期", "2026-03-12"), ("所属B端客户", "直营")]),
        ("🔓 使用行为（来源：3.2 开盖/关盖行为）",
         [("日均开盖次数", "4.2"), ("日均使用次数", "3.1"), ("平均单次使用时长", "26min"),
          ("开盖间隔分布", "早晚双峰"), ("累计使用时长", "131h"), ("", "")]),
        ("🎯 专注模式（来源：3.3 专注模式行为）",
         [("出航模式次数", "86"), ("陪伴模式次数", "53"), ("暂离次数", "41"),
          ("暂离总时长", "3.2h"), ("平均专注时长", "22min"), ("", "")]),
        ("🌙 夜航报告（来源：3.4 夜航报告）",
         [("夜航次数", "73"), ("夜航总时长", "512h"), ("离线收益领取次数", "69"), ("", ""), ("", ""), ("", "")]),
    ]
    yy = 248
    for title, fields in modules:
        c += card(X, yy, w_main, 132)
        c += text(X + 20, yy + 30, title, 14, "#303133", weight="600")
        for i, (k, v) in enumerate(fields):
            if not k:
                continue
            col, row = i % 3, i // 3
            fx = X + 20 + col * (w_main - 40) / 3
            fy = yy + 62 + row * 34
            c += text(fx, fy, k, 12, "#909399")
            c += text(fx + 130, fy, v, 13, "#303133", weight="600")
        yy += 148
    c += card(X, yy, w_main, 150)
    c += text(X + 20, yy + 30, "🤝 KidsHub 状态区（整合新增）", 14, "#303133", weight="600")
    kh = [("当前等级", "Lv.3 见习舰长"), ("总贡献值", "12"), ("已采纳条数", "2"),
          ("建议清单", "「按钮再大一点」已采纳 · 「想要会发光的鱼」评估中 · 「宝箱声音太响」已进金点子库")]
    for i, (k, v) in enumerate(kh[:3]):
        fx = X + 20 + i * (w_main - 40) / 3
        c += text(fx, yy + 62, k, 12, "#909399")
        c += text(fx + 90, yy + 62, v, 13, "#303133", weight="600")
    c += text(X + 20, yy + 96, kh[3][0], 12, "#909399")
    c += text(X + 20, yy + 122, kh[3][1], 13, "#606266")
    yy += 166
    c += text(X + 8, yy + 24, "▾ 宝箱行为 / 生态缸 / 换装 / 藏品收集 / 设置调整（3.5-3.9，布局同上，略）", 13, "#909399")
    c += text(X + w_main - 280, 96, "时间范围筛选：近30天 ▾", 13, "#606266")
    return shell(c, "单用户查询", "单用户查询", W, H), H

# ---------- 5. 全部用户列表 ----------

def gen_user_list():
    W, H = 1440, 860
    X, w_main = 248, W - 248 - 28
    c = card(X, 80, w_main, 76)
    c += text(X + 20, 124, "省份：", 13, "#606266")
    c += input_box(X + 64, 100, 150, 36, "全国 ▾", filled=True)
    c += text(X + 236, 124, "用户状态：", 13, "#606266")
    c += input_box(X + 304, 100, 150, 36, "全部 ▾", filled=True)
    c += text(X + 476, 124, "设备型号：", 13, "#606266")
    c += input_box(X + 544, 100, 150, 36, "全部 ▾", filled=True)
    c += button(X + 716, 100, 84, 36, "筛选")
    c += button(X + 812, 100, 84, 36, "重置", primary=False)
    rows = [
        ["糖糖", "2026-01-18", "2026-06-10", "152h", ("tag", "ULTRA", "red"), "7/7", ("tag", "活跃", "green"), ("link", "查看详情")],
        ["小宇", "2026-03-12", "2026-06-09", "131h", ("tag", "ULTRA", "red"), "6/7", ("tag", "活跃", "green"), ("link", "查看详情")],
        ["朵朵", "2026-02-25", "2026-06-08", "96h", ("tag", "MAX", "orange"), "5/7", ("tag", "活跃", "green"), ("link", "查看详情")],
        ["妞妞", "2026-02-09", "2026-06-07", "88h", ("tag", "PRO", "gray"), "4/7", ("tag", "活跃", "green"), ("link", "查看详情")],
        ["乐乐", "2026-04-02", "2026-05-30", "58h", ("tag", "PRO", "gray"), "3/7", ("tag", "沉默", "orange"), ("link", "查看详情")],
        ["晨晨", "2026-03-05", "2026-05-12", "47h", ("tag", "MAX", "orange"), "1/7", ("tag", "沉默", "orange"), ("link", "查看详情")],
        ["俊俊", "2026-03-28", "2026-04-26", "33h", ("tag", "MAX", "orange"), "0/7", ("tag", "流失风险", "red"), ("link", "查看详情")],
        ["安安", "2026-01-30", "2026-03-02", "21h", ("tag", "PRO", "gray"), "0/7", ("tag", "已流失", "gray"), ("link", "查看详情")],
    ]
    headers = ["用户昵称", "绑定日期 ↕", "最近活跃日期 ↕", "累计使用时长 ↕", "设备型号", "7日活跃天数 ↕", "当前状态", "操作"]
    widths = [120, 152, 168, 158, 140, 152, 150, 124]
    c += card(X, 176, w_main, 44 + 8 * 40 + 70)
    t, th = table(X + 20, 192, w_main - 40, headers, widths, rows)
    c += t
    py = 192 + 44 + 8 * 40 + 26
    c += text(X + 20, py, "共 86 条", 13, "#606266")
    for i, p in enumerate(["‹", "1", "2", "3", "4", "5", "›"]):
        bx = X + w_main - 320 + i * 38
        on = p == "1"
        c += rect(bx, py - 18, 30, 28, "#409eff" if on else "#fff", rx=4, stroke="#dcdfe6" if not on else "#409eff")
        c += text(bx + 15, py + 1, p, 13, "#fff" if on else "#606266", anchor="middle")
    c += text(X + w_main - 46, py, "20条/页", 12, "#909399", anchor="end")
    return shell(c, "全部用户列表", "全部用户列表", W, H), H

# ---------- 6. 统计页面 ----------

def gen_user_stats():
    W, H = 1440, 1080
    X, w_main = 248, W - 248 - 28
    c = card(X, 80, w_main, 76)
    c += text(X + 20, 124, "当前统计范围用户总数：", 14, "#606266")
    c += text(X + 178, 126, "86", 20, "#409eff", weight="700")
    c += text(X + 240, 124, "省份筛选：", 13, "#606266")
    c += input_box(X + 308, 100, 160, 36, "全国 ▾", filled=True)
    c += button(X + w_main - 150, 100, 130, 36, "导出统计数据")
    groups = [
        ("使用行为", [("日均开盖次数", "4.2", "—"), ("日均使用次数", "3.1", "—"),
                   ("平均单次使用时长", "24min", "—"), ("累计使用时长", "76.3h", "6,562h")]),
        ("专注模式", [("出航模式次数", "58.2", "5,005"), ("陪伴模式次数", "41.6", "3,578"),
                   ("暂离次数", "33.4", "2,872"), ("平均专注时长", "21min", "—")]),
        ("夜航报告", [("夜航次数", "49.8", "4,283"), ("夜航总时长", "356h", "30,616h"),
                   ("离线收益领取次数", "45.1", "3,879"), ("", "", "")]),
        ("宝箱行为", [("宝箱出现次数", "38.7", "3,328"), ("宝箱开启次数", "29.4", "2,528"),
                   ("开启率", "76%", "仅均值"), ("", "", "")]),
        ("生态缸", [("互动次数", "52.3", "4,498"), ("换水次数", "12.1", "1,041"),
                  ("投喂次数", "47.6", "4,094"), ("", "", "")]),
        ("活跃度", [("7日活跃天数", "4.3", "仅均值"), ("日均使用时长", "1.2h", "仅均值"),
                  ("", "", ""), ("", "", "")]),
    ]
    yy = 176
    gh = 138
    for gi, (gname, items) in enumerate(groups):
        col = gi % 2
        gx = X + col * ((w_main - 20) / 2 + 20)
        gw = (w_main - 20) / 2
        gy = yy + (gi // 2) * (gh + 16)
        c += card(gx, gy, gw, gh)
        c += text(gx + 20, gy + 30, gname, 14, "#303133", weight="600")
        c += text(gx + gw - 130, gy + 30, "均值 / 总计", 12, "#909399")
        for i, (k, avg, total) in enumerate(items):
            if not k:
                continue
            icol, irow = i % 2, i // 2
            fx = gx + 20 + icol * gw / 2
            fy = gy + 62 + irow * 36
            c += text(fx, fy, k, 12, "#909399")
            c += text(fx, fy + 18, f"{avg}  /  {total}", 14, "#303133", weight="600")
    return shell(c, "统计页面", "统计页面", W, H), H

# ---------- 7. 日期范围查询 ----------

def gen_date_query():
    W, H = 1440, 700
    X, w_main = 248, W - 248 - 28
    c = card(X, 80, w_main, 76)
    c += text(X + 20, 124, "日期范围：", 13, "#606266")
    c += input_box(X + 88, 100, 180, 36, "2026-05-01", filled=True)
    c += text(X + 280, 124, "至", 13, "#606266")
    c += input_box(X + 304, 100, 180, 36, "2026-06-10", filled=True)
    c += button(X + 508, 100, 84, 36, "查询")
    c += button(X + 604, 100, 84, 36, "重置", primary=False)
    cards = [("期间注册用户数", "486", "#409eff"), ("期间活跃用户数", "312", "#67c23a"), ("期间激活设备总数", "268", "#e6a23c")]
    cw = (w_main - 2 * 20) / 3
    for i, (lbl, val, color) in enumerate(cards):
        x = X + i * (cw + 20)
        c += card(x, 176, cw, 110)
        c += text(x + 20, 208, lbl, 13, "#909399")
        c += text(x + 20, 248, val, 30, color, weight="700")
    c += card(X, 306, w_main, 330)
    c += text(X + 20, 338, "期间激活用户设备型号分布", 15, "#303133", weight="600")
    c += pie(X + w_main / 2 - 80, 490, 105,
             [("ULTRA", 40, "#409eff"), ("MAX", 39, "#67c23a"), ("PRO", 21, "#e6a23c")],
             X + w_main / 2 + 90, 450)
    return shell(c, "日期范围查询", "日期范围查询", W, H), H

# ---------- 8. 全国地图 + 省份下钻（两张） ----------

def gen_map_china():
    W, H = 1440, 820
    X, w_main = 248, W - 248 - 28
    c = card(X, 80, w_main, 700)
    c += text(X + 20, 116, "全国用户分布", 16, "#303133", weight="600")
    c += text(X + 20, 140, "支持鼠标拖拽、缩放（0.8x~5x），点击省份进入省份看板", 12, "#909399")
    c += china_map(X + 200, 130, 1.15)
    c += map_legend(X + w_main - 230, 200)
    return shell(c, "数据概览 · 全国地图看板", "数据概览", W, H), H

def gen_map_province():
    W, H = 1440, 820
    X, w_main = 248, W - 248 - 28
    half = (w_main - 20) * 0.56
    c = card(X, 80, half, 700)
    c += text(X + 20, 116, "全国用户分布", 16, "#303133", weight="600")
    c += china_map(X + 40, 150, 0.92, highlight="广东")
    # 省份看板
    px = X + half + 20
    pw = w_main - half - 20
    c += card(px, 80, pw, 700)
    c += rect(px, 80, pw, 56, "#409eff", rx=8)
    c += rect(px, 112, pw, 24, "#409eff")
    c += text(px + 20, 114, "广东省", 17, "#ffffff", weight="700")
    c += text(px + pw - 110, 114, "◀ 返回全国", 13, "#ffffff")
    stats = [("累计注册用户", "412", "#409eff"), ("活跃用户", "203", "#67c23a"), ("活跃率", "49.3%", "#e6a23c")]
    sw = (pw - 40 - 24) / 3
    for i, (lbl, val, color) in enumerate(stats):
        sx = px + 20 + i * (sw + 12)
        c += rect(sx, 156, sw, 86, "#f7f9fc", rx=8)
        c += text(sx + sw / 2, 186, lbl, 12, "#909399", anchor="middle")
        c += text(sx + sw / 2, 220, val, 24, color, weight="700", anchor="middle")
    c += text(px + 30, 286, "◀", 16, "#409eff")
    c += text(px + pw / 2, 286, "设备型号分布", 14, "#303133", weight="600", anchor="middle")
    c += text(px + pw - 40, 286, "▶", 16, "#409eff")
    c += pie(px + pw / 2 - 60, 470, 110,
             [("ULTRA", 42, "#409eff"), ("MAX", 37, "#67c23a"), ("PRO", 21, "#e6a23c")],
             px + pw - 170, 420)
    c += text(px + pw / 2, 720, "可切换：设备型号分布 / 用户状态分布 / 每日新增曲线", 12, "#909399", anchor="middle")
    return shell(c, "数据概览 · 省份看板（下钻）", "数据概览", W, H), H

if __name__ == "__main__":
    jobs = {"user-query": gen_user_query, "user-detail": gen_user_detail,
            "user-list": gen_user_list, "user-stats": gen_user_stats,
            "date-query": gen_date_query, "map-china": gen_map_china,
            "map-province": gen_map_province}
    for name, fn in jobs.items():
        svg, h = fn()
        p = f"{OUT}/{name}.svg"
        open(p, "w", encoding="utf-8").write(svg)
        subprocess.run(["rsvg-convert", "-w", "1440", "-o", f"{OUT}/{name}.png", p], check=True)
        print(name, "OK")
