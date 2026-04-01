"""Speed benchmark: TTFT, TPS, end-to-end latency."""
import statistics
from utils import load_config, get_client, chat_stream, print_header

PROMPTS = {
    "short": "用一句话解释什么是量子计算。",
    "medium": "详细介绍人工智能的发展历史，包括关键里程碑和代表性技术突破。",
    "long": "写一篇关于全球气候变化的综述文章，涵盖原因、影响、各国应对措施和未来展望。要求结构清晰、论据充分。",
}
OUTPUT_MAP = {"short": 50, "medium": 200, "long": 500}


def run(config=None):
    config = config or load_config()
    client = get_client(config)
    model = config["api"]["model"]
    rounds = config["speed"]["test_rounds"]
    warmup = config["speed"].get("warmup_rounds", 1)

    print_header("Speed Benchmark")
    results = {}

    for label, prompt in PROMPTS.items():
        max_tok = OUTPUT_MAP[label]
        msgs = [{"role": "user", "content": prompt}]
        ttfts, tpss, lats = [], [], []

        # warmup
        for _ in range(warmup):
            chat_stream(client, model, msgs, max_tokens=max_tok)

        for r in range(rounds):
            text, ttft, total, tokens = chat_stream(client, model, msgs, max_tokens=max_tok)
            tps = tokens / (total / 1000) if total > 0 else 0
            ttfts.append(ttft)
            tpss.append(tps)
            lats.append(total)
            print(f"  [{label}] round {r+1}: TTFT={ttft:.0f}ms  TPS={tps:.1f}  latency={total:.0f}ms  tokens={tokens}")

        med_ttft = statistics.median(ttfts)
        med_tps = statistics.median(tpss)
        med_lat = statistics.median(lats)
        results[label] = {
            "ttft_ms": round(med_ttft),
            "tps": round(med_tps, 1),
            "latency_ms": round(med_lat),
        }
        print(f"  [{label}] median: TTFT={med_ttft:.0f}ms  TPS={med_tps:.1f}  latency={med_lat:.0f}ms")

    return results


if __name__ == "__main__":
    import json
    r = run()
    print(json.dumps(r, indent=2, ensure_ascii=False))
