#!/usr/bin/env python3
"""K12-KGraph 价值离线验证: 裸 gemini vs gemini+KG子图注入, 在 Prereq/Neighbor 上 exact-match 对比.

回答 docs/19 的核心问题: 给小可接 KG 到底有没有真增益?
- 用 K12-Bench 自带 multi-select 标准答案算 exact-match (客观,不写护栏 scorer).
- 只打最吃 KG 的 Prereq(先修依赖) + Neighbor(图邻域) 两类任务.
- arm1 裸模型 vs arm2 KG子图注入, 同 prompt 模板, 只差 KG 上下文.
数据: /tmp/k12-verify/data (nodes/edges + prereq/neighbor jsonl)
跑法: set -a; source <P003>/apps/server/.env.local; set +a; python3 run_verify.py --limit 40
"""
import os, json, re, argparse, random
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from openai import OpenAI

DATA = "/tmp/k12-verify/data"
SUBJECTS = ["biology", "physics", "chemistry", "math"]


def load_kg():
    nodes = {n["id"]: n for n in json.load(open(f"{DATA}/nodes.json"))}
    out_e, in_e = defaultdict(list), defaultdict(list)
    for e in json.load(open(f"{DATA}/edges.json")):
        out_e[e["source"]].append((e["type"], e["target"]))
        in_e[e["target"]].append((e["type"], e["source"]))
    return nodes, out_e, in_e


def nm(nodes, nid):
    return nodes.get(nid, {}).get("name", nid)


def concept_from_id(qid):
    return qid.split("::")[-1]  # prereq::subtask1::biology_7a_rjb_cpt13 -> biology_7a_rjb_cpt13


def subject_of(qid):
    cid = concept_from_id(qid)
    return next((s for s in SUBJECTS if cid.startswith(s)), "other")


def build_kg_context(nodes, out_e, in_e, cid):
    """目标概念 1-hop 子图文本化 (先修/上下位/关联)."""
    if cid not in nodes:
        return None
    lines = [f"【目标概念】{nm(nodes, cid)}"]
    prereqs = [nm(nodes, s) for (t, s) in in_e.get(cid, []) if t == "prerequisites_for"]
    if prereqs:
        lines.append(f"前置概念(学它之前要先掌握): {', '.join(dict.fromkeys(prereqs))}")
    leads = [nm(nodes, tg) for (t, tg) in out_e.get(cid, []) if t == "prerequisites_for"]
    if leads:
        lines.append(f"后继概念(掌握它之后才能学): {', '.join(dict.fromkeys(leads))}")
    up = [nm(nodes, tg) for (t, tg) in out_e.get(cid, []) if t == "is_a"]
    if up:
        lines.append(f"上位类(它属于): {', '.join(dict.fromkeys(up))}")
    down = [nm(nodes, s) for (t, s) in in_e.get(cid, []) if t == "is_a"]
    if down:
        lines.append(f"下位类(它包含): {', '.join(list(dict.fromkeys(down))[:8])}")
    rel = [nm(nodes, tg) for (t, tg) in out_e.get(cid, []) if t in ("relates_to", "leads_to")]
    rel += [nm(nodes, s) for (t, s) in in_e.get(cid, []) if t == "relates_to"]
    if rel:
        lines.append(f"相关概念: {', '.join(list(dict.fromkeys(rel))[:10])}")
    return "\n".join(lines)


def make_prompt(q, kg=None):
    opts = "\n".join(f"{k}. {v}" for k, v in q["options"].items())
    p = f"这是一道K12课程知识多选题(可能1个或多个正确答案)。\n\n问题: {q['question']}\n\n选项:\n{opts}\n"
    if kg:
        p += f"\n以下是来自人教版课程知识图谱的结构化参考(权威, 用于判断先修/关联关系):\n{kg}\n"
    p += "\n只输出正确选项的字母, 多个用逗号分隔(例: A 或 A,C), 不要解释。"
    return p


ANS_RE = re.compile(r"[A-D]")


def parse_ans(text):
    lines = [l for l in text.strip().splitlines() if l.strip()]
    cand = lines[-1] if lines else text
    letters = set(ANS_RE.findall(cand.upper())) or set(ANS_RE.findall(text.upper()))
    return letters


def call(client, model, prompt, reasoning=None):
    kw = {"model": model, "messages": [{"role": "user", "content": prompt}]}
    if reasoning:  # gpt-5.x 传 'low'; gemini 不支持 reasoning_effort, 留空
        kw["extra_body"] = {"reasoning_effort": reasoning}
    r = client.chat.completions.create(**kw)
    return r.choices[0].message.content or ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--model", default="gpt-5.5")
    ap.add_argument("--out", default="result.json")
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--reasoning", default=None, help="gpt-5.x 传 low; gemini 留空")
    args = ap.parse_args()

    client = OpenAI(base_url=os.environ["OPENAI_BASE_URL"], api_key=os.environ["OPENAI_API_KEY"])
    nodes, out_e, in_e = load_kg()

    files = {"prereq": ["prereq_subtask1.jsonl", "prereq_subtask2.jsonl"], "neighbor": ["neighbor.jsonl"]}
    random.seed(42)
    sampled = []
    for task, fs in files.items():
        rows = []
        for f in fs:
            rows += [(task, json.loads(l)) for l in open(f"{DATA}/{f}") if l.strip()]
        by_sub = defaultdict(list)
        for t, q in rows:
            if concept_from_id(q["id"]) in nodes:  # 只要能挂上 KG 的
                by_sub[subject_of(q["id"])].append((t, q))
        per_sub = max(1, (args.limit // 2) // len(SUBJECTS))
        for s in SUBJECTS:
            pool = by_sub.get(s, [])
            random.shuffle(pool)
            sampled += pool[:per_sub]
    print(f"抽样 {len(sampled)} 题 (model={args.model})")

    def run_one(item):
        task, q = item
        cid = concept_from_id(q["id"])
        gold = set(q["answer"])
        kg = build_kg_context(nodes, out_e, in_e, cid)
        try:
            a1 = parse_ans(call(client, args.model, make_prompt(q), args.reasoning))
            a2 = parse_ans(call(client, args.model, make_prompt(q, kg), args.reasoning))
        except Exception as ex:
            return {"id": q["id"], "task": task, "error": str(ex)}
        r = {"id": q["id"], "task": task, "subject": subject_of(q["id"]), "gold": sorted(gold),
             "arm1": sorted(a1), "arm2": sorted(a2), "arm1_ok": a1 == gold, "arm2_ok": a2 == gold, "has_kg": bool(kg)}
        if args.debug:
            print(f"[{q['id']}] gold={r['gold']} arm1={r['arm1']}({'✓' if r['arm1_ok'] else '✗'}) "
                  f"arm2={r['arm2']}({'✓' if r['arm2_ok'] else '✗'})\n  KG: {(kg or '<无>')[:160]}")
        return r

    results = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futs = [ex.submit(run_one, tq) for tq in sampled]
        for f in as_completed(futs):
            results.append(f.result())

    valid = [r for r in results if "error" not in r]
    errs = [r for r in results if "error" in r]

    def acc(rs, arm):
        return sum(1 for r in rs if r.get(f"{arm}_ok")) / len(rs) * 100 if rs else 0.0

    print(f"\n{'='*52}\n有效 {len(valid)} 题, 错误 {len(errs)}")
    print(f"总体 exact-match:  arm1 裸={acc(valid,'arm1'):.1f}%  arm2 +KG={acc(valid,'arm2'):.1f}%  "
          f"增益={acc(valid,'arm2')-acc(valid,'arm1'):+.1f}pp")
    for task in ["prereq", "neighbor"]:
        ts = [r for r in valid if r["task"] == task]
        if ts:
            print(f"  [{task:8}] n={len(ts):2}  arm1={acc(ts,'arm1'):.1f}%  arm2={acc(ts,'arm2'):.1f}%  "
                  f"增益={acc(ts,'arm2')-acc(ts,'arm1'):+.1f}pp")
    json.dump({"model": args.model, "n_valid": len(valid), "n_err": len(errs), "results": results},
              open(args.out, "w"), ensure_ascii=False, indent=1)
    print(f"明细 -> {args.out}")
    if errs:
        print(f"错误示例: {errs[0].get('error','')[:200]}")


if __name__ == "__main__":
    main()
