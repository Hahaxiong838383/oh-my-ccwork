#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞书画板 DSL/Mermaid 机械校验器（lark-whiteboard-lite 配套）。

用法:  python3 validate.py <文件.json 或 文件.mmd>
输出:  逐条 [FAIL]/[WARN]（自带修法），最后一行 RESULT: PASS 或 RESULT: FAIL
退出码: PASS=0, FAIL=1
规则依据: 飞书 whiteboard-cli DSL schema v2。仅用 Python 标准库。
"""
import json
import re
import sys

FAILS = []
WARNS = []


def fail(code, where, msg, fix):
    FAILS.append("[FAIL] %s (%s): %s → 修法: %s" % (code, where, msg, fix))


def warn(code, where, msg, fix):
    WARNS.append("[WARN] %s (%s): %s → 建议: %s" % (code, where, msg, fix))


# ---------- DSL 字段白名单 ----------
COMMON = {"type", "id", "x", "y", "width", "height"}
TEXTA = {"text", "fontSize", "textColor", "textAlign", "verticalAlign"}
STYLE = {"fillColor", "borderColor", "borderWidth", "borderDash", "borderRadius",
         "opacity", "vFlip", "hFlip"}
ALLOWED = {
    "frame": COMMON | STYLE | {"layout", "gap", "padding", "justifyContent",
                               "alignItems", "children", "title"},
    "rect": COMMON | STYLE | TEXTA,
    "ellipse": COMMON | STYLE | TEXTA,
    "diamond": COMMON | STYLE | TEXTA,
    "cylinder": COMMON | STYLE | TEXTA,
    "triangle": COMMON | STYLE | TEXTA | {"topWidth"},
    "trapezoid": COMMON | STYLE | TEXTA | {"topWidth"},
    "text": COMMON | TEXTA,
    "stickyNote": COMMON | {"fillColor"} | TEXTA,
    "svg": COMMON | {"svg", "opacity"},
    "connector": {"type", "id", "connector"},
}
CONNECTOR_KEYS = {"from", "to", "fromAnchor", "toAnchor", "lineShape", "lineColor",
                  "lineWidth", "lineStyle", "startArrow", "endArrow", "label",
                  "labelPosition", "waypoints"}
ENUMS = {
    "layout": {"horizontal", "vertical", "none"},
    "textAlign": {"left", "center", "right"},
    "verticalAlign": {"top", "middle", "bottom"},
    "borderDash": {"solid", "dashed", "dotted"},
}
CONN_ENUMS = {
    "lineShape": {"straight", "polyline", "curve", "rightAngle"},
    "lineStyle": {"solid", "dashed", "dotted"},
    "startArrow": {"none", "arrow", "triangle", "circle", "diamond"},
    "endArrow": {"none", "arrow", "triangle", "circle", "diamond"},
    "fromAnchor": {"top", "right", "bottom", "left"},
    "toAnchor": {"top", "right", "bottom", "left"},
}
# 推荐色板（SKILL.md 附录 B）+ 线框灰阶。不在表内仅 WARN（用户显式指定色时允许）。
PALETTE = {"#F0F4FC", "#5178C6", "#EAE2FE", "#8569CB", "#DFF5E5", "#509863",
           "#FEF1CE", "#D4B45B", "#FEE3E2", "#D25D5A", "#FFFFFF", "#1F2329",
           "#646A73", "#BBBFC4", "#E8EAED", "#F1F3F5", "#DEE0E3", "#F5D1A7",
           "#CDF7CC", "#C9E8EF", "#D6DCF3", "#D3CCEE", "#F1C5E7", "#F6C8C8"}
STICKY_COLORS = {"#FEF1CE", "#F5D1A7", "#DFF5E5", "#CDF7CC", "#C9E8EF",
                 "#D6DCF3", "#D3CCEE", "#F1C5E7", "#F6C8C8"}
SHAPES_WITH_TEXT = {"rect", "ellipse", "diamond", "cylinder", "triangle",
                    "trapezoid", "text", "stickyNote"}


def node_name(node, idx_path):
    nid = node.get("id")
    return "id=%s" % nid if nid else "位置 nodes%s" % idx_path


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def axis_resolved(size, parent_resolved):
    """该轴尺寸是否可解析出确定值（用于 fill-container 死锁检测）。"""
    if is_num(size):
        return True
    if isinstance(size, str) and size.startswith("fill-container"):
        return parent_resolved
    return False  # fit-content / 缺失


def check_colors(node, where):
    for key in ("fillColor", "borderColor", "textColor"):
        v = node.get(key)
        if isinstance(v, str) and v.upper() not in {c.upper() for c in PALETTE}:
            if v.lower() not in ("transparent",):
                warn("W01", where, "%s=%s 不在推荐色板" % (key, v),
                     "除非用户明确指定了此颜色，否则改用 SKILL.md 附录 B 的色板色")


def walk(node, idx_path, ids, conn_refs, in_flex, parent_rw, parent_rh, depth):
    where = node_name(node, idx_path)
    if not isinstance(node, dict):
        fail("E03", "nodes%s" % idx_path, "节点不是 JSON 对象", "每个节点必须是 {...} 对象")
        return
    ntype = node.get("type")
    if ntype not in ALLOWED:
        fail("E03", where, "未知节点 type=%r" % ntype,
             "只能用: %s" % ", ".join(sorted(ALLOWED)))
        return

    # E04 未知字段
    unknown = set(node.keys()) - ALLOWED[ntype]
    for k in sorted(unknown):
        hint = ""
        low = {f.lower(): f for f in ALLOWED[ntype]}
        if k.lower() in low:
            hint = "（应为 %s，注意大小写）" % low[k.lower()]
        fail("E04", where, "type=%s 不支持字段 %r%s" % (ntype, k, hint),
             "删掉该字段或改为白名单字段（见 SKILL.md 附录 A）")

    # id 收集与查重
    nid = node.get("id")
    if nid is not None:
        if nid in ids:
            fail("E09", where, "id 重复: %r" % nid,
                 "复制节点后必须改 id，保证全文件唯一")
        ids[nid] = node

    # 枚举值
    for k, allowed_vals in ENUMS.items():
        v = node.get(k)
        if v is not None and v not in allowed_vals:
            fail("E04", where, "%s=%r 不是合法值" % (k, v),
                 "只能取: %s" % "/".join(sorted(allowed_vals)))

    if ntype == "connector":
        conn = node.get("connector")
        if not isinstance(conn, dict):
            fail("E16", where, "connector 节点缺少 connector 子对象",
                 '写成 {"type":"connector","connector":{"from":"idA","to":"idB",...}}')
        else:
            for k in sorted(set(conn.keys()) - CONNECTOR_KEYS):
                fail("E17", where, "connector 子对象不支持字段 %r" % k,
                     "只能用: %s" % ", ".join(sorted(CONNECTOR_KEYS)))
            for k, allowed_vals in CONN_ENUMS.items():
                v = conn.get(k)
                if v is not None and v not in allowed_vals:
                    fail("E17", where, "%s=%r 不是合法值" % (k, v),
                         "只能取: %s" % "/".join(sorted(allowed_vals)))
            for end in ("from", "to"):
                v = conn.get(end)
                if v is None:
                    fail("E16", where, "connector 缺 %r" % end, "填目标节点的 id 字符串")
                elif isinstance(v, str):
                    conn_refs.append((v, where))
            lc = conn.get("lineColor")
            if isinstance(lc, str) and lc.upper() != "#BBBFC4":
                warn("W01", where, "连线颜色 %s 非标准灰" % lc,
                     "连线统一用 #BBBFC4，不与节点抢注意力")
        if in_flex or depth > 0:
            fail("E05", where, "connector 出现在 frame 的 children 里",
                 "把整个 connector 对象移到顶层 nodes 数组末尾")
        return

    # 尺寸
    w, h = node.get("width"), node.get("height")
    if w is None or h is None:
        fail("E08", where, "缺 width 或 height", "所有节点必须显式声明 width 和 height")
    if in_flex and (("x" in node) or ("y" in node)):
        fail("E07", where, "flex 容器内的子节点写了 x/y（会被引擎忽略）",
             "删掉 x/y；需要自由定位的内容不属于本包支持范围")

    # E13 死锁
    my_rw = axis_resolved(w, parent_rw)
    my_rh = axis_resolved(h, parent_rh)
    if isinstance(w, str) and w.startswith("fill-container") and not parent_rw:
        fail("E13", where, 'width:"fill-container" 但祖先没有固定数字宽度（尺寸会塌陷为 0）',
             "给最近的祖先 frame 设固定数字 width（如 1200），或本节点改固定数字")
    if isinstance(h, str) and h.startswith("fill-container") and not parent_rh:
        fail("E13", where, 'height:"fill-container" 但祖先没有固定数字高度',
             "给祖先设固定数字 height，或本节点改 fit-content")

    # E06 含文字节点高度
    txt = node.get("text")
    has_text = (isinstance(txt, str) and txt.strip()) or (isinstance(txt, list) and txt)
    if ntype in SHAPES_WITH_TEXT and has_text:
        if not (isinstance(h, str) and h.startswith("fit-content")):
            fail("E06", where, "含文字节点的 height=%r 不是 fit-content（文字会被截断）" % h,
                 '把 height 改为 "fit-content"')

    # 字号
    fs = node.get("fontSize")
    if is_num(fs) and fs < 13:
        warn("W02", where, "fontSize=%s 过小" % fs, "正文≥14，辅助说明≥13")

    # cylinder 宽度
    if ntype == "cylinder":
        if not (is_num(w) and 120 <= w <= 200):
            fail("E12", where, "cylinder 的 width=%r 不合规" % w,
                 "必须是 120~200 的固定数字（弧度固定 16px，不能 fill-container）")

    # stickyNote 颜色
    if ntype == "stickyNote":
        fc = node.get("fillColor")
        if isinstance(fc, str) and fc.upper() not in {c.upper() for c in STICKY_COLORS}:
            fail("E14", where, "便签色 %s 不在 9 个合法便签色内" % fc,
                 "只能用: %s" % " ".join(sorted(STICKY_COLORS)))

    check_colors(node, where)

    # frame 专项
    if ntype == "frame":
        layout = node.get("layout")
        if layout is None:
            fail("E08", where, "frame 缺 layout 字段（默认变绝对定位，子节点堆左上角）",
                 '加 "layout": "vertical" 或 "horizontal"')
        elif layout == "none":
            fail("E15", where, 'layout:"none" 是手算坐标路线，本包禁用',
                 "改用 horizontal/vertical，或整图改走 Mermaid 模板")
        if node.get("gap") is None:
            fail("E08", where, "frame 缺 gap（子节点会粘连）", '加 "gap": 12 或更大')
        if node.get("padding") is None:
            fail("E08", where, "frame 缺 padding（内容会贴边）", '加 "padding": 16 或 0')
        if node.get("title"):
            warn("W03", where, "frame 的 title 会渲染成不可读的小字",
                 "删掉 title，用独立 text 节点做标签")
        visible = any(node.get(k) is not None
                      for k in ("fillColor", "borderColor", "borderWidth", "title"))
        if not visible:
            warn("W04", where, "纯布局 frame 无任何可见属性，编译时会被跳过、子节点提升到父级（布局可能乱）",
                 '加 "borderWidth": 0 阻止被优化')
        children = node.get("children")
        if children is not None:
            if not isinstance(children, list):
                fail("E03", where, "children 不是数组", "children 必须是 [ ... ]")
            else:
                child_flex = layout in ("horizontal", "vertical")
                for i, ch in enumerate(children):
                    walk(ch, "%s.children[%d]" % (idx_path, i), ids, conn_refs,
                         child_flex, my_rw, my_rh, depth + 1)


def validate_dsl(path):
    try:
        raw = open(path, "r", encoding="utf-8").read()
    except OSError as e:
        fail("E01", path, "文件读不到: %s" % e, "检查路径")
        return
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as e:
        fail("E01", path, "JSON 解析失败: 第 %d 行 %s" % (e.lineno, e.msg),
             "多逗号/少括号/引号未转义。跑 python3 -m json.tool %s 定位" % path)
        return
    if not isinstance(doc, dict) or doc.get("version") != 2 \
            or not isinstance(doc.get("nodes"), list):
        fail("E02", path, '顶层必须是 {"version": 2, "nodes": [...]}',
             "补上 version（数字 2）和 nodes 数组")
        return
    ids, conn_refs = {}, []
    for i, node in enumerate(doc["nodes"]):
        walk(node, "[%d]" % i, ids, conn_refs, in_flex=False,
             parent_rw=False, parent_rh=False, depth=0)
    # connector 引用检查
    for ref, where in conn_refs:
        if ref not in ids:
            fail("E10", where, "connector 引用的 id=%r 不存在" % ref,
                 "改成一个真实存在的节点 id（区分大小写）")
        else:
            target = ids[ref]
            if target.get("type") == "frame":
                visible = any(target.get(k) is not None
                              for k in ("fillColor", "borderColor", "borderWidth", "title"))
                if not visible:
                    fail("E11", where,
                         "connector 指向的 frame id=%r 是纯布局容器，编译时会消失导致连线失效" % ref,
                         '给该 frame 加 "borderWidth": 0（或连到它内部的可见节点）')


MMD_TYPES = ("flowchart", "graph", "mindmap", "sequenceDiagram", "classDiagram",
             "stateDiagram-v2", "stateDiagram", "pie", "gantt", "erDiagram", "gitGraph")


def validate_mmd(path):
    try:
        lines = open(path, "r", encoding="utf-8").read().splitlines()
    except OSError as e:
        fail("E01", path, "文件读不到: %s" % e, "检查路径")
        return
    body = [l for l in lines if l.strip() and not l.strip().startswith("%%")]
    if not body:
        fail("M01", path, "文件为空（只有注释）", "补充图表内容")
        return
    first = body[0].strip().split()[0]
    if not any(first.startswith(t) for t in MMD_TYPES):
        fail("M02", "第 1 行", "首行 %r 不是已知图表类型" % first,
             "首个非注释行必须以这些开头之一: %s" % ", ".join(MMD_TYPES))
    if first.startswith(("flowchart", "graph")):
        labels = re.findall(r"[\[\{\(]+\"?([^\]\}\)\"|]+)\"?[\]\}\)]+", "\n".join(body))
        for lb in labels:
            if len(lb.strip()) > 14:
                warn("M03", "节点 %r" % lb.strip()[:14], "节点文字超 14 字，图会拥挤",
                     "缩写到 12 字以内")
        arrow_lines = [l for l in body if "-->" in l or "==>" in l or "-.->" in l]
        if len(arrow_lines) > 24:
            warn("M04", path, "连线超过 24 条，图可能过于复杂", "合并步骤或拆成两张图")


def main():
    if len(sys.argv) != 2:
        print("用法: python3 validate.py <文件.json 或 文件.mmd>")
        sys.exit(2)
    path = sys.argv[1]
    if path.endswith(".json"):
        validate_dsl(path)
    elif path.endswith(".mmd"):
        validate_mmd(path)
    else:
        print("[FAIL] 不认识的扩展名（只支持 .json / .mmd）")
        sys.exit(2)
    for line in FAILS + WARNS:
        print(line)
    if FAILS:
        print("RESULT: FAIL (%d 处必须修复, %d 条建议)" % (len(FAILS), len(WARNS)))
        sys.exit(1)
    print("RESULT: PASS (%d 条建议)" % len(WARNS))
    sys.exit(0)


if __name__ == "__main__":
    main()
