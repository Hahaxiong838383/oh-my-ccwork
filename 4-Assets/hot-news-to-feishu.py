#!/usr/bin/env python3
"""
热点新闻抓取 → 飞书发送
数据源：百度实时热搜 + 今日头条热榜 + 抖音热搜
发送到：飞书（FEISHU1 通道的 receive user）

用法：
  python3 hot-news-to-feishu.py              # 抓取并发飞书
  python3 hot-news-to-feishu.py --preview    # 只打印，不发飞书
  python3 hot-news-to-feishu.py --top 20     # 每源取前 N 条（默认 15）
  python3 hot-news-to-feishu.py --text-only  # 发纯文本（不用卡片）
"""

import os
import sys
import json
import argparse
import requests
from datetime import datetime
from pathlib import Path
from bs4 import BeautifulSoup

# ─── 路径 & 配置 ─────────────────────────────────────────────
ENV_FILE = Path(__file__).resolve().parent.parent / ".claude/skills/mycc/scripts/.env"

def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    return env

ENV = load_env(ENV_FILE)

FEISHU_APP_ID     = ENV.get("FEISHU_APP_ID", "")
FEISHU_APP_SECRET = ENV.get("FEISHU_APP_SECRET", "")
RECEIVE_ID        = ENV.get("FEISHU_RECEIVE_USER_ID", "")
RECEIVE_ID_TYPE   = ENV.get("FEISHU_RECEIVE_ID_TYPE", "open_id")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


# ─── 数据抓取 ────────────────────────────────────────────────

def fetch_baidu_hot(top: int = 15) -> list[dict]:
    """百度实时热搜（HTML解析，需求稳定）"""
    url = "https://top.baidu.com/board?tab=realtime"
    items = []
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(resp.text, "html.parser")
        # class 名含随机 hash，用 class* 模糊匹配
        cards = soup.select("div[class*=category-wrap]")
        for i, card in enumerate(cards[:top], 1):
            title_el = card.select_one("div.c-single-text-ellipsis")
            hot_el   = card.select_one("div[class*=hot-index]")
            tag_el   = card.select_one("div[class*=hot-tag]")
            title = title_el.get_text(strip=True) if title_el else ""
            hot   = hot_el.get_text(strip=True) if hot_el else ""
            tag   = tag_el.get_text(strip=True) if tag_el else ""
            if title:
                items.append({"rank": i, "title": title, "hot": hot,
                               "tag": tag, "source": "百度热搜"})
    except Exception as e:
        print(f"[百度] 抓取失败: {e}", file=sys.stderr)
    return items


def fetch_toutiao_hot(top: int = 15) -> list[dict]:
    """今日头条热榜（JSON API）"""
    url = "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc"
    items = []
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        data = resp.json()
        for i, item in enumerate(data.get("data", [])[:top], 1):
            title = item.get("Title", item.get("title", ""))
            hot   = item.get("HotValue", item.get("hotValue", ""))
            tag   = item.get("LabelName", "")
            if title:
                items.append({"rank": i, "title": title,
                               "hot": f"{int(hot):,}" if str(hot).isdigit() else str(hot),
                               "tag": tag, "source": "今日头条"})
    except Exception as e:
        print(f"[头条] 抓取失败: {e}", file=sys.stderr)
    return items


def fetch_douyin_hot(top: int = 15) -> list[dict]:
    """抖音热搜（JSON API）"""
    url = "https://www.douyin.com/aweme/v1/web/hot/search/list/"
    items = []
    try:
        resp = requests.get(
            url,
            headers={**HEADERS, "Referer": "https://www.douyin.com/"},
            timeout=10
        )
        data = resp.json()
        word_list = data.get("data", {}).get("word_list", [])
        for i, item in enumerate(word_list[:top], 1):
            title = item.get("word", "")
            hot   = item.get("hot_value", "")
            tag   = {1: "热", 2: "新", 3: "爆", 4: "商业化"}.get(item.get("label", 0), "")
            if title:
                items.append({
                    "rank": i,
                    "title": title,
                    "hot": f"{int(hot):,}" if str(hot).isdigit() else str(hot),
                    "tag": tag,
                    "source": "抖音热搜",
                })
    except Exception as e:
        print(f"[抖音] 抓取失败: {e}", file=sys.stderr)
    return items


# ─── 格式化 ───────────────────────────────────────────────────

def build_table_text(news_by_source: dict) -> str:
    """构建等宽表格文本（终端预览用）"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"📰 今日热点新闻汇总  {now}\n"]

    for source, items in news_by_source.items():
        if not items:
            continue
        lines.append(f"{'─'*50}")
        lines.append(f"  {source}")
        lines.append(f"{'─'*50}")
        lines.append(f"{'#':<3}  {'标题':<32}  {'热度':<12}  标签")
        lines.append(f"{'─'*3}  {'─'*32}  {'─'*12}  {'─'*6}")
        for item in items:
            rank  = str(item["rank"]).ljust(3)
            title = item["title"][:30]
            # 补全对齐（中文字符宽度 2，简单处理）
            padding = 30 - sum(2 if ord(c) > 127 else 1 for c in title)
            title_padded = title + " " * max(0, padding)
            hot   = str(item["hot"])[:12].ljust(12)
            tag   = item.get("tag", "")
            lines.append(f"{rank}  {title_padded}  {hot}  {tag}")

    total = sum(len(v) for v in news_by_source.values())
    lines.append(f"\n{'─'*50}")
    lines.append(f"共 {total} 条 | 来源：{'、'.join(k for k, v in news_by_source.items() if v)}")
    return "\n".join(lines)


def build_feishu_card(news_by_source: dict) -> dict:
    """构建飞书卡片消息"""
    now = datetime.now().strftime("%m-%d %H:%M")
    total = sum(len(v) for v in news_by_source.values())

    elements = []
    for source, items in news_by_source.items():
        if not items:
            continue
        # 来源分组标题
        elements.append({"tag": "markdown", "content": f"**{source}**"})

        # 构建 Markdown 表格内容
        rows = []
        for item in items:
            tag_str = f" `{item['tag']}`" if item.get("tag") else ""
            hot_str = f"*{item['hot']}*" if item.get("hot") else ""
            rows.append(f"**{item['rank']}.** {item['title']}{tag_str}　{hot_str}")

        elements.append({"tag": "markdown", "content": "\n".join(rows)})
        elements.append({"tag": "hr"})

    # 末尾统计
    sources_str = "、".join(k for k, v in news_by_source.items() if v)
    elements.append({
        "tag": "note",
        "elements": [{"tag": "plain_text", "content": f"共 {total} 条 | 来源：{sources_str}"}]
    })

    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": f"📰 今日热点  {now}"},
            "template": "blue"
        },
        "elements": elements
    }


# ─── 飞书 API ─────────────────────────────────────────────────

def get_feishu_token() -> str:
    resp = requests.post(
        "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
        json={"app_id": FEISHU_APP_ID, "app_secret": FEISHU_APP_SECRET},
        timeout=8
    )
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"飞书 token 获取失败: {data}")
    return data["app_access_token"]


def send_feishu_msg(msg_type: str, content: dict, token: str) -> bool:
    resp = requests.post(
        "https://open.feishu.cn/open-apis/im/v1/messages",
        params={"receive_id_type": RECEIVE_ID_TYPE},
        json={
            "receive_id": RECEIVE_ID,
            "msg_type": msg_type,
            "content": json.dumps(content),
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=10
    )
    data = resp.json()
    if data.get("code") != 0:
        print(f"[飞书] 发送失败: {data}", file=sys.stderr)
        return False
    return True


# ─── 主流程 ───────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="抓取热点新闻发飞书")
    parser.add_argument("--preview", action="store_true", help="只打印，不发飞书")
    parser.add_argument("--top", type=int, default=15, help="每源取前N条（默认15）")
    parser.add_argument("--text-only", action="store_true", help="发纯文本而非卡片")
    args = parser.parse_args()

    print("📡 正在抓取热点新闻...")

    # 并发抓取各平台
    import concurrent.futures
    sources = {
        "百度热搜": (fetch_baidu_hot, args.top),
        "今日头条": (fetch_toutiao_hot, args.top),
        "抖音热搜": (fetch_douyin_hot, args.top),
    }

    news_by_source = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(fn, n): name
            for name, (fn, n) in sources.items()
        }
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                result = future.result()
                news_by_source[name] = result
                print(f"  ✓ {name}: {len(result)} 条")
            except Exception as e:
                print(f"  ✗ {name}: {e}", file=sys.stderr)
                news_by_source[name] = []

    # 按来源顺序排列
    news_by_source = {k: news_by_source.get(k, []) for k in sources}

    print()
    print(build_table_text(news_by_source))

    if args.preview:
        print("\n[--preview 模式，跳过飞书发送]")
        return

    if not FEISHU_APP_ID or not RECEIVE_ID:
        print(f"\n⚠️  未找到飞书配置（ENV: {ENV_FILE}），跳过发送")
        return

    print("\n📨 正在发送飞书消息...")
    try:
        token = get_feishu_token()

        if args.text_only:
            ok = send_feishu_msg("text", {"text": build_table_text(news_by_source)}, token)
        else:
            card = build_feishu_card(news_by_source)
            ok = send_feishu_msg("interactive", card, token)
            if not ok:
                print("  卡片失败，降级纯文本...")
                ok = send_feishu_msg("text", {"text": build_table_text(news_by_source)}, token)

        print("✅ 发送成功！" if ok else "❌ 发送失败")

    except Exception as e:
        print(f"❌ 异常: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
