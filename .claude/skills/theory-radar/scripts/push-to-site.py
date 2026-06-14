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
# codex API 网关（gpt-5.5）。必须 stream:true：网关在 CF 后源站 ~100s 超时回 524，流式持续吐字节绕过。
CODEX_BASE = os.environ.get("CODEX_API_GATEWAY_BASE_URL", "https://10521052.xyz/v1").rstrip("/")
CODEX_URL = CODEX_BASE + "/chat/completions"
CODEX_KEY = os.environ.get("CODEX_API_GATEWAY_KEY", "")
CODEX_MODEL = os.environ.get("CODEX_MODEL", "gpt-5.5")
# 降级模型：codex 失败时用 gemini 3.1 flash（走 proxy；实测 proxy 真实 model id = gemini-3.1-flash-lite-preview）
GEMINI_URL = os.environ.get("GEMINI_PROXY_URL", "http://23.226.135.149:4000/v1/chat/completions")
GEMINI_KEY = os.environ.get("GEMINI_PROXY_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite-preview")
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


def build_prompt(sel):
    blocks = []
    for i, p in enumerate(sel):
        aid = p["arxiv_id"].split("v")[0]
        cats = ",".join(p.get("categories", [])[:2])
        blocks.append(
            f"[{i+1}] arxivId={aid} | {cats}\n标题: {p['title']}\n摘要: {p['abstract'][:500]}"
        )
    papers_block = "\n\n".join(blocks)
    return (
        "你是「AI 前沿资讯雷达」的理论分析师。下面是今天 arXiv 抓到的 "
        f"{len(sel)} 篇论文（脑科学×LLM / 认知科学×AI / LLM 机制 / Agent 治理 方向）。\n"
        "对每篇做中文「5 段式」深度拆解，**只依据给定摘要，严禁编造数据或结论**。\n"
        "严格只输出 JSON（不要任何额外文字，不要 markdown 围栏）：\n"
        '{"summary":"一句话今日趋势综述(中文,≤80字)","papers":[{"arxivId":"原样回填",'
        '"titleCn":"中文精简标题≤22字","score":80到95的整数,"finding":"核心发现2-3句",'
        '"llmLink":"与LLM机制/AI设计的连接1-2句","insight":"研究启示1-2句"}]}\n'
        f"papers 必须恰好 {len(sel)} 条，arxivId 严格原样回填。\n\n论文：\n" + papers_block
    )


def call_codex(sel):
    prompt = build_prompt(sel)
    body = json.dumps(
        {
            "model": CODEX_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 20000,
            "reasoning_effort": "high",
            "stream": True,
        }
    ).encode()
    req = urllib.request.Request(
        CODEX_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {CODEX_KEY}",
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    # 直连绕 xray（网关在 CF 后，与 _codex_lane.sh 的 curl --noproxy 同款）
    content = ""
    with NOPROXY_OPENER.open(req, timeout=240) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
                delta = chunk["choices"][0].get("delta", {}).get("content", "")
                if delta:
                    content += delta
            except Exception:
                continue
    return content


def call_gemini(sel):
    """降级：codex 失败时用 gemini 3.1 flash（非流式，走 proxy/xray，与早期实现一致）。"""
    prompt = build_prompt(sel)
    body = json.dumps(
        {
            "model": GEMINI_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 16384,
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
    with urllib.request.urlopen(req, timeout=120) as r:
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


def get_analysis(sel):
    """主用 codex gpt-5.5；失败或结果不足 4 篇则降级 gemini 3.1 flash。返回 (data, engine)。"""
    try:
        data = parse_json(call_codex(sel))
        if len(data.get("papers", [])) >= 4:
            log(f"codex({CODEX_MODEL}) 分析成功")
            return data, f"codex/{CODEX_MODEL}"
        log(f"codex 结果不足 4 篇({len(data.get('papers', []))})，降级 gemini")
    except Exception as e:
        log(f"codex 失败({type(e).__name__}: {str(e)[:100]})，降级 gemini")
    if not GEMINI_KEY:
        raise RuntimeError("codex 失败且未配 GEMINI_PROXY_KEY，无降级路径")
    data = parse_json(call_gemini(sel))
    log(f"gemini({GEMINI_MODEL}) 降级分析成功")
    return data, f"gemini/{GEMINI_MODEL}"


def main():
    if not TOKEN:
        log("缺 RADAR_WEBHOOK_TOKEN"); sys.exit(1)
    if not CODEX_KEY:
        log("缺 CODEX_API_GATEWAY_KEY"); sys.exit(1)

    papers = load_papers()
    log(f"加载 {len(papers)} 篇去重论文")
    sel = sorted(papers, key=score, reverse=True)[:8]
    if len(sel) < 4:
        log(f"可选论文过少({len(sel)})，放弃"); sys.exit(1)
    log(f"选出 {len(sel)} 篇")
    meta = {p["arxiv_id"].split("v")[0]: p for p in sel}

    data, engine = get_analysis(sel)
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
    log(f"推送成功 {len(out)} 篇，date={report['date']}，engine={engine}")


if __name__ == "__main__":
    main()
