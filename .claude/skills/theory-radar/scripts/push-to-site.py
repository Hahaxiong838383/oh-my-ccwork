#!/usr/bin/env python3
"""theory-radar → 个人站(my.chenchuan.cc)「前沿资讯雷达」深度拆解 webhook 推送。
独立于 multica 飞书流：读 /tmp/theory-radar-data.json → 选 8 篇 → gemini 做中文 5 段式
→ 组装 TheoryReport JSON → POST 到站点 /api/radar-webhook。
只依据真实摘要分析，不编造；论文 url/published 从抓取数据回填（权威源）。
secret 从环境变量来（见 ~/.theory-radar-push.env），不硬编码。"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

WEBHOOK_URL = os.environ.get("RADAR_WEBHOOK_URL", "https://my.chenchuan.cc/api/radar-webhook")
TOKEN = os.environ.get("RADAR_WEBHOOK_TOKEN", "")
GEMINI_URL = os.environ.get("GEMINI_PROXY_URL", "http://23.226.135.149:4000/v1/chat/completions")
GEMINI_KEY = os.environ.get("GEMINI_PROXY_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
DATA = os.environ.get("THEORY_RADAR_DATA", "/tmp/theory-radar-data.json")
BJ = timezone(timedelta(hours=8))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
# 绕 env 代理的 opener：webhook(国内站)直连，不走 xray 境外出口（否则 nginx/CF 视为可疑→403）
NOPROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 选篇优先级关键词（脑科学×LLM / 认知 / 机制 / Agent 治理）
PRI = [
    "cognit", "neuro", "brain", "memory", "attention", "reason", "mechanism",
    "interpret", "introspect", "chain-of-thought", "chain of thought", "world model",
    "agent", "benchmark", "evaluation", "alignment", "safety", "representation",
    "emergent", "reinforcement", "consciousness", "language model",
]


def log(m):
    print(f"[push-to-site] {m}", file=sys.stderr)


def load_papers():
    d = json.load(open(DATA))
    seen, out = set(), []
    for s in d.get("sections", []):
        for p in s.get("papers", []):
            aid = p.get("arxiv_id", "").split("v")[0]
            if not aid or aid in seen:
                continue
            seen.add(aid)
            out.append(p)
    return out


def score(p):
    t = (p.get("title", "") + " " + p.get("abstract", "")).lower()
    return sum(1 for k in PRI if k in t)


def call_gemini(sel):
    blocks = []
    for i, p in enumerate(sel):
        aid = p["arxiv_id"].split("v")[0]
        cats = ",".join(p.get("categories", [])[:2])
        blocks.append(
            f"[{i+1}] arxivId={aid} | {cats}\n标题: {p['title']}\n摘要: {p['abstract'][:500]}"
        )
    papers_block = "\n\n".join(blocks)
    prompt = (
        "你是「AI 前沿资讯雷达」的理论分析师。下面是今天 arXiv 抓到的 "
        f"{len(sel)} 篇论文（脑科学×LLM / 认知科学×AI / LLM 机制 / Agent 治理 方向）。\n"
        "对每篇做中文「5 段式」深度拆解，**只依据给定摘要，严禁编造数据或结论**。\n"
        "严格只输出 JSON（不要任何额外文字，不要 markdown 围栏）：\n"
        '{"summary":"一句话今日趋势综述(中文,≤80字)","papers":[{"arxivId":"原样回填",'
        '"titleCn":"中文精简标题≤22字","score":80到95的整数,"finding":"核心发现2-3句",'
        '"llmLink":"与LLM机制/AI设计的连接1-2句","insight":"研究启示1-2句"}]}\n'
        f"papers 必须恰好 {len(sel)} 条，arxivId 严格原样回填。\n\n论文：\n" + papers_block
    )
    body = json.dumps(
        {
            "model": GEMINI_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 65535,
            "reasoning_effort": "high",
        }
    ).encode()
    req = urllib.request.Request(
        GEMINI_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {GEMINI_KEY}",
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=200) as r:
        resp = json.load(r)
    return resp["choices"][0]["message"]["content"]


def parse_json(content):
    s = content.strip()
    s = re.sub(r"^```(json)?", "", s).strip()
    s = re.sub(r"```$", "", s).strip()
    a, b = s.find("{"), s.rfind("}")
    if a >= 0 and b > a:
        s = s[a : b + 1]
    return json.loads(s)


def main():
    if not TOKEN:
        log("缺 RADAR_WEBHOOK_TOKEN"); sys.exit(1)
    if not GEMINI_KEY:
        log("缺 GEMINI_PROXY_KEY"); sys.exit(1)

    papers = load_papers()
    log(f"加载 {len(papers)} 篇去重论文")
    sel = sorted(papers, key=score, reverse=True)[:8]
    if len(sel) < 4:
        log(f"可选论文过少({len(sel)})，放弃"); sys.exit(1)
    log(f"选出 {len(sel)} 篇")
    meta = {p["arxiv_id"].split("v")[0]: p for p in sel}

    content = call_gemini(sel)
    data = parse_json(content)
    analyses = data.get("papers", [])

    out = []
    for i, a in enumerate(analyses):
        aid = str(a.get("arxivId", "")).split("v")[0]
        m = meta.get(aid) or (sel[i] if i < len(sel) else None)
        if not m:
            continue
        aid = m["arxiv_id"].split("v")[0]
        out.append(
            {
                "index": i + 1,
                "title": a.get("titleCn") or m.get("title", ""),
                "arxivId": aid,
                "url": f"https://arxiv.org/abs/{aid}",
                "published": m.get("published"),
                "category": (m.get("categories") or [None])[0],
                "score": a.get("score"),
                "finding": a.get("finding"),
                "llmLink": a.get("llmLink"),
                "insight": a.get("insight"),
            }
        )
    if len(out) < 4:
        log(f"有效分析过少({len(out)})，放弃推送"); sys.exit(1)

    now = datetime.now(BJ)
    report = {
        "date": now.strftime("%Y-%m-%d"),
        "summary": data.get("summary", ""),
        "papers": out,
        "generatedAt": now.isoformat(),
    }
    body = json.dumps(report, ensure_ascii=False).encode()
    req = urllib.request.Request(
        WEBHOOK_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
        method="POST",
    )
    # 直连（绕 xray），国内站走国内出口，避免被上游当可疑请求 403
    with NOPROXY_OPENER.open(req, timeout=60) as r:
        log("webhook 响应: " + r.read().decode())
    log(f"推送成功 {len(out)} 篇，date={report['date']}")


if __name__ == "__main__":
    main()
