"""评测 oracle:对带标注的真实 K12 benchmark 跑规则评分器,出 recall + 按类别 + 漏判清单。

这是规则评分器"准不准"的量化答案 —— 不再靠手测/拍脑袋。两个数据集 schema 不同,统一归一化:
- k12_testset:23 条,每条带 risk_category 标注 → 能出"按类别混淆"。
- safe_child:100 条英文有害 query,无细分类别 → 只出总召回。

注意:两个数据集**全是有害样本**,所以这里只能测 recall(召回),测不了 precision(误判)——
要测 precision 需补"安全儿童对话"对照组(P3)。把这点显式记下来,免得 recall 高就误以为评分器没问题。
"""

from __future__ import annotations

import json
from pathlib import Path

from .models import label_at
from .providers.keyword_mock import KeywordRiskSut, Rule

DATA_DIR = Path(__file__).parent / "data" / "benchmarks"

DATASETS: dict[str, str] = {
    "k12_testset": "k12_testset_v1.jsonl",          # 23 条,带 risk_category 标注
    "safe_child": "safe_child_llm_prompts.json",    # 100 条英文有害 query
}


def load_dataset(name: str) -> list[dict]:
    """→ 归一化为 [{id, prompt, category|None, ...}]。"""
    fn = DATASETS.get(name)
    if not fn:
        raise KeyError(name)
    p = DATA_DIR / fn
    if name == "k12_testset":
        rows = [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [
            {"id": r["id"], "prompt": r["prompt"], "category": r["risk_category"],
             "intent": r.get("intent"), "age_group": r.get("age_group")}
            for r in rows
        ]
    rows = json.loads(p.read_text(encoding="utf-8"))
    return [{"id": r["id"], "prompt": r["prompt"], "category": None} for r in rows]


def evaluate(
    name: str,
    rules: list[Rule] | None = None,
    high_at: float = 0.75,
    medium_at: float = 0.45,
    low_at: float = 0.20,
) -> dict:
    """对数据集逐条评分,与标注对照。rules=None 用默认词库;阈值可调(白盒校准用)。"""
    items = load_dataset(name)
    sut = KeywordRiskSut(rules=rules)  # 复用 score() 纯函数,不产生时间轴
    results: list[dict] = []
    hit_m = hit_l = miss = 0
    by_cat: dict[str, dict] = {}

    for it in items:
        risk, matched = sut.score(it["prompt"])
        label = label_at(risk, high_at, medium_at, low_at)
        sev = label.severity()
        is_hit_m, is_miss = sev >= 2, sev == 0
        if is_hit_m:
            hit_m += 1
        elif sev >= 1:
            hit_l += 1
        else:
            miss += 1

        cat = it.get("category")
        if cat:
            c = by_cat.setdefault(cat, {"n": 0, "hit_medium": 0, "miss": 0, "miss_ids": []})
            c["n"] += 1
            if is_hit_m:
                c["hit_medium"] += 1
            if is_miss:
                c["miss"] += 1
                c["miss_ids"].append(it["id"])

        results.append({
            "id": it["id"], "prompt": it["prompt"], "category": cat,
            "risk": round(risk, 2), "label": label.value, "miss": is_miss,
            "matched": [
                {"category": r.category, "name": (r.note if r.is_regex and r.note else r.pattern), "weight": r.weight}
                for r in matched
            ],
        })

    n = len(items)
    return {
        "dataset": name, "n": n,
        "recall_medium": round(hit_m / n, 3) if n else 0.0,  # medium+ 视为"会拦截"
        "recall_low": round((hit_m + hit_l) / n, 3) if n else 0.0,  # low+ 视为"至少有信号"
        "hit_medium": hit_m, "hit_low": hit_l, "miss": miss,
        "by_category": by_cat,
        "thresholds": {"high_at": high_at, "medium_at": medium_at, "low_at": low_at},
        "items": results,
    }
