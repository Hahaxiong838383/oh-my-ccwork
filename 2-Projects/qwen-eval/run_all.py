"""Main evaluation runner: executes all benchmarks and generates report."""
import json
import sys
from datetime import datetime
from pathlib import Path

from utils import load_config, print_header

import bench_speed
import bench_math
import bench_logic
import bench_chinese
import bench_practical


def generate_report(results, config):
    now = datetime.now()
    model = config["api"]["model"]
    api_url = config["api"]["base_url"]

    lines = [
        f"# Qwen3.5-27B-4bit 本地模型测评报告",
        f"",
        f"> 生成时间: {now.strftime('%Y-%m-%d %H:%M')}",
        f"> 模型: `{model}`",
        f"> API: `{api_url}`",
        f"> 硬件: Mac Studio M2 Max 32GB (MLX)",
        f"",
        f"---",
        f"",
    ]

    # Speed
    speed = results.get("speed", {})
    lines += [
        "## 1. 速度测评",
        "",
        "| 档位 | TTFT (ms) | TPS (tok/s) | 端到端延迟 (ms) |",
        "|------|-----------|-------------|-----------------|",
    ]
    for label in ["short", "medium", "long"]:
        s = speed.get(label, {})
        lines.append(f"| {label} | {s.get('ttft_ms', '-')} | {s.get('tps', '-')} | {s.get('latency_ms', '-')} |")
    lines.append("")

    # Math
    math = results.get("math", {})
    lines += [
        "## 2. 数学推理 (GSM8K-style)",
        "",
        f"- 正确: {math.get('correct', '-')}/{math.get('total', '-')}",
        f"- **准确率: {math.get('accuracy', '-')}%**",
        "",
    ]

    # Logic
    logic = results.get("logic", {})
    lines += [
        "## 3. 逻辑推理",
        "",
        f"- 逻辑题: {logic.get('logic', {}).get('correct', '-')}/{logic.get('logic', {}).get('total', '-')} ({logic.get('logic', {}).get('accuracy', '-')}%)",
        f"- 常识题: {logic.get('common_sense', {}).get('correct', '-')}/{logic.get('common_sense', {}).get('total', '-')} ({logic.get('common_sense', {}).get('accuracy', '-')}%)",
        f"- **综合: {logic.get('overall_accuracy', '-')}%**",
        "",
    ]

    # Chinese
    chinese = results.get("chinese", {})
    lines += [
        "## 4. 中文理解",
        "",
        f"- 阅读理解: {chinese.get('reading', {}).get('correct', '-')}/{chinese.get('reading', {}).get('total', '-')} ({chinese.get('reading', {}).get('accuracy', '-')}%)",
        f"- 成语: {chinese.get('idioms', {}).get('correct', '-')}/{chinese.get('idioms', {}).get('total', '-')} ({chinese.get('idioms', {}).get('accuracy', '-')}%)",
        f"- 反讽/双关: {chinese.get('sarcasm', {}).get('correct', '-')}/{chinese.get('sarcasm', {}).get('total', '-')} ({chinese.get('sarcasm', {}).get('accuracy', '-')}%)",
        f"- 大海捞针: {json.dumps(chinese.get('needle', {}), ensure_ascii=False)}",
        f"- **综合: {chinese.get('overall_accuracy', '-')}%**",
        "",
    ]

    # Practical
    practical = results.get("practical", {})
    lines += [
        "## 5. 实用能力",
        "",
        f"- JSON提取: {practical.get('json_extraction', {}).get('correct', '-')}/{practical.get('json_extraction', {}).get('total', '-')} ({practical.get('json_extraction', {}).get('accuracy', '-')}%)",
        f"- 翻译: {practical.get('translation', {}).get('correct', '-')}/{practical.get('translation', {}).get('total', '-')} ({practical.get('translation', {}).get('accuracy', '-')}%)",
        f"- 代码理解: {practical.get('code', {}).get('correct', '-')}/{practical.get('code', {}).get('total', '-')} ({practical.get('code', {}).get('accuracy', '-')}%)",
        f"- 指令遵循: {practical.get('instruction', {}).get('correct', '-')}/{practical.get('instruction', {}).get('total', '-')} ({practical.get('instruction', {}).get('accuracy', '-')}%)",
        f"- **综合: {practical.get('overall_accuracy', '-')}%**",
        "",
    ]

    # Summary
    scores = {
        "数学推理": math.get("accuracy", 0),
        "逻辑推理": logic.get("overall_accuracy", 0),
        "中文理解": chinese.get("overall_accuracy", 0),
        "实用能力": practical.get("overall_accuracy", 0),
    }
    avg = sum(scores.values()) / len(scores) if scores else 0

    lines += [
        "## 总评",
        "",
        "| 维度 | 得分 |",
        "|------|------|",
    ]
    for dim, score in scores.items():
        bar = "█" * int(score / 5) + "░" * (20 - int(score / 5))
        lines.append(f"| {dim} | {score}% {bar} |")

    speed_note = ""
    med_speed = speed.get("medium", {})
    if med_speed:
        speed_note = f" | 推理速度 (medium) | TTFT={med_speed.get('ttft_ms','-')}ms, TPS={med_speed.get('tps','-')} tok/s |"

    lines += [
        f"| **平均** | **{avg:.1f}%** |",
        speed_note,
        "",
        "## 雷达图数据 (可用于可视化)",
        "",
        "```json",
        json.dumps(scores, indent=2, ensure_ascii=False),
        "```",
        "",
        "---",
        f"*测评完成: {now.strftime('%Y-%m-%d %H:%M:%S')}*",
    ]

    return "\n".join(lines)


def main():
    config = load_config()
    results = {}

    print_header("Qwen3.5-27B-4bit Full Evaluation")
    print(f"  Model: {config['api']['model']}")
    print(f"  API:   {config['api']['base_url']}")
    print()

    # Run each benchmark
    print("Running speed benchmark...")
    results["speed"] = bench_speed.run(config)

    print("\nRunning math benchmark...")
    results["math"] = bench_math.run(config)

    print("\nRunning logic benchmark...")
    results["logic"] = bench_logic.run(config)

    print("\nRunning Chinese benchmark...")
    results["chinese"] = bench_chinese.run(config)

    print("\nRunning practical benchmark...")
    results["practical"] = bench_practical.run(config)

    # Generate report
    report = generate_report(results, config)
    results_dir = Path(__file__).parent / config["results_dir"]
    results_dir.mkdir(exist_ok=True)

    report_file = results_dir / f"report_{datetime.now().strftime('%Y%m%d')}.md"
    report_file.write_text(report, encoding="utf-8")
    print(f"\n{'='*60}")
    print(f"  Report saved to: {report_file}")
    print(f"{'='*60}")

    # Also save raw JSON
    json_file = results_dir / f"raw_{datetime.now().strftime('%Y%m%d')}.json"
    json_file.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")

    return results


if __name__ == "__main__":
    main()
