#!/usr/bin/env python3
"""
GitHub AI 风向标 - 每日23:30执行
关注: AI Agent、多智能体编排、记忆系统、Skills 热点开源项目
输出: 飞书通知（卡片分区版）
"""
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BJ_TZ = timezone(timedelta(hours=8))
SEND_JS = "/Users/rayman.chen/mycc/.claude/skills/tell-me/send.js"

# 搜索分类：[标签, GitHub 搜索 query]
CATEGORIES = [
    ("🤖 AI Agent", "ai-agent llm agent stars:>200"),
    ("🔗 多智能体编排", "multi-agent orchestration stars:>100"),
    ("🧠 记忆系统", "memory agent llm stars:>80"),
    ("⚡ Skills/工具框架", "agent framework skills tools stars:>150"),
]


def search_github(query: str, days: int = 7, per_page: int = 3) -> list:
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    full_query = f"{query} pushed:>{since}"
    url = (
        "https://api.github.com/search/repositories"
        f"?q={urllib.parse.quote(full_query)}"
        f"&sort=stars&order=desc&per_page={per_page}"
    )
    req = urllib.request.Request(url, headers={
        "User-Agent": "cc-github-radar/1.0",
        "Accept": "application/vnd.github.v3+json",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        return data.get("items", [])
    except Exception as e:
        print(f"[WARN] search failed ({query[:30]}): {e}", file=sys.stderr)
        return []


def fmt_stars(n: int) -> str:
    return f"{n/1000:.1f}k" if n >= 1000 else str(n)


def build_report() -> tuple[str, str]:
    now = datetime.now(BJ_TZ)
    date_str = now.strftime("%m-%d")

    sections = []
    total = 0

    for label, query in CATEGORIES:
        items = search_github(query)
        time.sleep(1)  # 避免触发 GitHub rate limit
        if not items:
            continue
        lines = [label]
        for repo in items:
            stars = fmt_stars(repo["stargazers_count"])
            name = repo["full_name"]
            desc = (repo.get("description") or "").strip()
            if len(desc) > 45:
                desc = desc[:45] + "…"
            lines.append(f"  ★{stars}  {name}")
            if desc:
                lines.append(f"        {desc}")
        sections.append("\n".join(lines))
        total += len(items)

    title = f"GitHub AI 风向标 {date_str}"
    body = (
        "━━━━━━━━━━━━━━━━\n"
        + "\n\n".join(sections)
        + f"\n\n━━━━━━━━━━━━━━━━\n共 {total} 个活跃项目 | 近7天更新"
    )
    return title, body


def send_feishu(title: str, body: str):
    result = subprocess.run(
        ["node", SEND_JS, title, body, "blue"],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print("✅ 发送成功")
    else:
        print(f"❌ 发送失败: {result.stderr}", file=sys.stderr)
        sys.exit(1)


def main():
    title, body = build_report()
    send_feishu(title, body)


if __name__ == "__main__":
    main()
