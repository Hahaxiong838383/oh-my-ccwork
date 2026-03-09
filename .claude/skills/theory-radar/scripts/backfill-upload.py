#!/usr/bin/env python3
"""
理论雷达 - 历史补录上传脚本
读取 backfill JSON，分类、生成元数据，批量写入飞书 bitable。
"""
import json
import sys
import time
import urllib.request

# ===== 配置 =====
BACKFILL_FILE = "/tmp/theory-radar-backfill.json"
TOKEN_FILE = "/Users/rayman.chen/.feishu-mcp/tokens.json"
APP_TOKEN = "CzwzbwKuBadUa3s7BPHcdTDYnGg"
TABLE_ID = "tblb4S7JAqz9lVDm"
BATCH_SIZE = 100  # 飞书 batch_create 单次上限 500

# 分类目录映射
CATEGORY_MAP = {
    "🧠 神经科学×语言模型": {"领域": ["神经科学", "认知科学"], "wiki_parent": "Rnk4woVFEiJOJykuOwJclSgxnDc"},
    "🔬 认知科学×AI理论": {"领域": ["认知科学", "AI安全"], "wiki_parent": "Rnk4woVFEiJOJykuOwJclSgxnDc"},
    "💡 语言与认知计算": {"领域": ["LLM机制", "推理机制"], "wiki_parent": "NwOSwann4iddE3ksdMFcSaFLnQb"},
    "⚡ 神经网络×认知机制": {"领域": ["神经科学", "训练优化"], "wiki_parent": "GDizwEBDrivE3IkXaS8cHlONndd"},
    "🔢 前沿算法×AI理论": {"领域": ["训练优化"], "wiki_parent": "GDizwEBDrivE3IkXaS8cHlONndd"},
    "📐 算法理论×机器学习": {"领域": ["训练优化"], "wiki_parent": "GDizwEBDrivE3IkXaS8cHlONndd"},
    "🤖 Agent能力评测": {"领域": ["AI评测", "多模态"], "wiki_parent": "Tyx4w0QkxitQD4k23rAciubInwc"},
}

# 关键词 → 额外领域标签
KEYWORD_TAGS = {
    "memory": "记忆系统",
    "reasoning": "推理机制",
    "attention": "LLM机制",
    "agent": "AI评测",
    "benchmark": "AI评测",
    "safety": "AI安全",
    "alignment": "AI安全",
    "multimodal": "多模态",
}


def get_access_token():
    with open(TOKEN_FILE) as f:
        data = json.load(f)
    return data["cli_a9f1cd1366751bc7"]["accessToken"]


def classify_paper(paper):
    """根据 section 和关键词分类论文"""
    section = paper.get("section", "")
    cat_info = CATEGORY_MAP.get(section, {"领域": ["LLM机制"], "wiki_parent": "NwOSwann4iddE3ksdMFcSaFLnQb"})

    tags = set(cat_info["领域"])

    # 额外关键词标签
    combined = (paper.get("title", "") + " " + paper.get("abstract", "")).lower()
    for kw, tag in KEYWORD_TAGS.items():
        if kw in combined:
            tags.add(tag)

    return list(tags)[:3], cat_info["wiki_parent"]


def generate_highlight(paper):
    """从 abstract 提取一句话亮点"""
    abstract = paper.get("abstract", "")
    # 取第一句话（. 分割），截断到 80 字
    first_sentence = abstract.split(". ")[0] if ". " in abstract else abstract[:100]
    if len(first_sentence) > 80:
        first_sentence = first_sentence[:77] + "..."
    return first_sentence


def short_title(paper):
    """生成精简标题（保留英文，控制长度）"""
    title = paper.get("title", "Unknown")
    if len(title) > 40:
        # 取前 37 字符 + ...
        return title[:37] + "..."
    return title


def published_to_timestamp(published_str):
    """将 YYYY-MM-DD 转为 Unix 毫秒时间戳"""
    from datetime import datetime, timezone
    try:
        dt = datetime.strptime(published_str[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)


def batch_create_records(token, records):
    """批量创建 bitable 记录"""
    url = f"https://open.feishu.cn/open-apis/bitable/v1/apps/{APP_TOKEN}/tables/{TABLE_ID}/records/batch_create"

    data = json.dumps({"records": records}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if result.get("code") == 0:
                created = len(result.get("data", {}).get("records", []))
                return created, None
            else:
                return 0, f"code={result.get('code')}, msg={result.get('msg')}"
    except Exception as e:
        return 0, str(e)


def main():
    # 加载数据
    with open(BACKFILL_FILE) as f:
        data = json.load(f)

    token = get_access_token()
    all_papers = []

    for month_key, papers in data["months"].items():
        for p in papers:
            p["_month"] = month_key
        all_papers.extend(papers)

    print(f"[INFO] 总计 {len(all_papers)} 篇论文待处理", file=sys.stderr)

    # 构建 bitable 记录
    records = []
    for paper in all_papers:
        tags, wiki_parent = classify_paper(paper)
        highlight = generate_highlight(paper)
        title = short_title(paper)

        record = {
            "fields": {
                "论文名称": f"[{paper['arxiv_id']}] {title}",
                "日期": published_to_timestamp(paper.get("published", "")),
                "领域": tags,
                "文档链接": {
                    "link": paper["url"],
                    "text": f"arXiv · {paper['arxiv_id']}",
                },
                "亮点": highlight,
            }
        }
        records.append(record)

    print(f"[INFO] 准备写入 {len(records)} 条记录", file=sys.stderr)

    # 分批上传
    total_created = 0
    batch_num = 0
    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i:i + BATCH_SIZE]
        batch_num += 1
        print(f"[INFO] 批次 {batch_num}: 上传 {len(batch)} 条...", file=sys.stderr)

        created, error = batch_create_records(token, batch)
        if error:
            print(f"  [ERROR] {error}", file=sys.stderr)
        else:
            total_created += created
            print(f"  [OK] 成功 {created} 条", file=sys.stderr)

        time.sleep(1)  # 避免限速

    print(f"\n[DONE] 总计写入 {total_created}/{len(records)} 条记录", file=sys.stderr)

    # 输出 wiki 待创建的 top 论文清单（按月 top 10）
    top_papers = []
    for month_key in sorted(data["months"].keys()):
        papers = data["months"][month_key]
        # 按 section 多样性排序，每个 section 取前 2 篇
        section_counts = {}
        month_top = []
        for p in papers:
            sec = p.get("section", "other")
            section_counts[sec] = section_counts.get(sec, 0) + 1
            if section_counts[sec] <= 2 and len(month_top) < 10:
                month_top.append(p)
        top_papers.extend(month_top)

    # 输出 top 论文列表
    top_output = {
        "total": len(top_papers),
        "papers": top_papers,
    }
    with open("/tmp/theory-radar-top-papers.json", "w") as f:
        json.dump(top_output, f, ensure_ascii=False, indent=2)

    print(f"[INFO] Top 论文清单已保存: {len(top_papers)} 篇 → /tmp/theory-radar-top-papers.json", file=sys.stderr)


if __name__ == "__main__":
    main()
