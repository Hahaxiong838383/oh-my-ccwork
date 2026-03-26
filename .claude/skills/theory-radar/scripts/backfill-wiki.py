#!/usr/bin/env python3
"""
理论雷达 - Wiki 页面批量创建
为 top 论文创建飞书 Wiki 页面（含结构化内容）。
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

TOKEN_FILE = "/Users/rayman.chen/.feishu-mcp/tokens.json"
TOP_FILE = "/tmp/theory-radar-top-papers.json"
SPACE_ID = "7589885788549024719"
PROGRESS_FILE = "/tmp/theory-radar-wiki-progress.json"

# bitable 配置
APP_TOKEN = os.environ.get("FEISHU_BITABLE_APP_TOKEN", "")
TABLE_ID = "tblb4S7JAqz9lVDm"

# 分类目录映射
CATEGORY_MAP = {
    "🧠 神经科学×语言模型": "Rnk4woVFEiJOJykuOwJclSgxnDc",
    "🔬 认知科学×AI理论": "Rnk4woVFEiJOJykuOwJclSgxnDc",
    "💡 语言与认知计算": "NwOSwann4iddE3ksdMFcSaFLnQb",
    "⚡ 神经网络×认知机制": "GDizwEBDrivE3IkXaS8cHlONndd",
    "🔢 前沿算法×AI理论": "GDizwEBDrivE3IkXaS8cHlONndd",
    "📐 算法理论×机器学习": "GDizwEBDrivE3IkXaS8cHlONndd",
    "🤖 Agent能力评测": "Tyx4w0QkxitQD4k23rAciubInwc",
}


def get_access_token():
    with open(TOKEN_FILE) as f:
        data = json.load(f)
    return data["${FEISHU_APP_ID}"]["accessToken"]


def feishu_api(method, path, body=None, token=None):
    """通用飞书 API 调用"""
    url = f"https://open.feishu.cn{path}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body else None
    req = urllib.request.Request(
        url, data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8") if e.fp else ""
        print(f"  [HTTP {e.code}] {body_text[:200]}", file=sys.stderr)
        return {"code": e.code, "msg": body_text}
    except Exception as e:
        return {"code": -1, "msg": str(e)}


def create_wiki_node(token, parent_token, title):
    """在知识库中创建页面节点"""
    result = feishu_api("POST", f"/open-apis/wiki/v2/spaces/{SPACE_ID}/nodes", {
        "obj_type": "docx",
        "node_type": "origin",
        "parent_node_token": parent_token,
        "title": title,
    }, token)

    if result.get("code") == 0:
        node = result["data"]["node"]
        return node.get("node_token"), node.get("obj_token")
    return None, None


def write_doc_content(token, doc_id, paper):
    """写入文档内容块"""
    abstract = paper.get("abstract", "N/A")
    arxiv_id = paper.get("arxiv_id", "")
    cats = ", ".join(paper.get("categories", []))
    url = paper.get("url", f"https://arxiv.org/abs/{arxiv_id}")

    blocks = [
        text_block(f"📍 arXiv:{arxiv_id} | 分类：{cats}"),
        text_block("📄 摘要（Abstract）", bold=True),
        text_block(abstract),
        text_block("👥 作者", bold=True),
        text_block(", ".join(paper.get("authors", ["Unknown"]))),
        text_block("📅 发布日期", bold=True),
        text_block(paper.get("published", "N/A")),
        link_block("🔗 原文链接", url),
    ]

    result = feishu_api("POST",
        f"/open-apis/docx/v1/documents/{doc_id}/blocks/{doc_id}/children",
        {"children": blocks}, token)

    return result.get("code") == 0


def text_block(content, bold=False):
    style = {"bold": True} if bold else {}
    return {
        "block_type": 2,
        "text": {
            "elements": [{"text_run": {"content": content, "text_element_style": style}}],
            "style": {},
        }
    }


def link_block(label, url):
    return {
        "block_type": 2,
        "text": {
            "elements": [
                {"text_run": {"content": f"{label}  ", "text_element_style": {"bold": True}}},
                {"text_run": {"content": url, "text_element_style": {"link": {"url": url}}}},
            ],
            "style": {},
        }
    }


def load_progress():
    try:
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    except Exception:
        return {"completed": [], "failed": []}


def save_progress(progress):
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


def main():
    with open(TOP_FILE) as f:
        data = json.load(f)

    token = get_access_token()
    papers = data["papers"]
    progress = load_progress()
    completed_ids = set(progress["completed"])

    # 过滤已完成的
    remaining = [p for p in papers if p["arxiv_id"] not in completed_ids]
    print(f"[INFO] 总计 {len(papers)} 篇，已完成 {len(completed_ids)}，剩余 {len(remaining)}", file=sys.stderr)

    created_count = 0
    failed_count = 0
    wiki_mappings = []  # arxiv_id → wiki_url

    for i, paper in enumerate(remaining):
        arxiv_id = paper["arxiv_id"]
        section = paper.get("section", "")
        parent = CATEGORY_MAP.get(section, "NwOSwann4iddE3ksdMFcSaFLnQb")

        # 短标题
        title = paper["title"]
        if len(title) > 30:
            title = title[:27] + "..."
        page_title = f"[{arxiv_id}] {title}"

        print(f"  [{i+1}/{len(remaining)}] 创建: {page_title[:50]}...", file=sys.stderr)

        # 1. 创建节点
        node_token, obj_token = create_wiki_node(token, parent, page_title)
        if not node_token:
            print(f"    [FAIL] 创建节点失败", file=sys.stderr)
            progress["failed"].append(arxiv_id)
            failed_count += 1
            save_progress(progress)
            time.sleep(1)
            continue

        # 2. 写入内容
        doc_id = obj_token or node_token
        ok = write_doc_content(token, doc_id, paper)

        if ok:
            created_count += 1
            progress["completed"].append(arxiv_id)
            wiki_url = f"https://b2kj9e7u26m.feishu.cn/wiki/{node_token}"
            wiki_mappings.append({"arxiv_id": arxiv_id, "node_token": node_token, "wiki_url": wiki_url})
            print(f"    [OK] {wiki_url}", file=sys.stderr)
        else:
            print(f"    [WARN] 内容写入失败，但节点已创建: {node_token}", file=sys.stderr)
            progress["completed"].append(arxiv_id)  # 节点已创建，标记完成
            created_count += 1

        save_progress(progress)
        time.sleep(0.5)  # 避免限速

    print(f"\n[DONE] 创建 {created_count} 页，失败 {failed_count} 页", file=sys.stderr)

    # 保存 wiki 映射表
    with open("/tmp/theory-radar-wiki-mappings.json", "w") as f:
        json.dump(wiki_mappings, f, ensure_ascii=False, indent=2)

    print(f"[INFO] Wiki 映射表已保存: {len(wiki_mappings)} 条", file=sys.stderr)


if __name__ == "__main__":
    main()
