#!/usr/bin/env python3
"""
Qwen 3.5 27B Q4 自动化测评脚本
两轮对比：关闭 thinking vs 开启 thinking
"""

import json
import re
import time
import sys
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional

import subprocess

# ============================================================
# 配置
# ============================================================
API_BASE = "http://10.9.1.155:8000/v1"
API_URL = f"{API_BASE}/chat/completions"
MODEL = "mlx-community/Qwen3.5-27B-4bit"
MAX_TOKENS_NO_THINK = 4096
MAX_TOKENS_THINK = 2048  # 限制 thinking token，防 M2 Max 32GB OOM
REQUEST_TIMEOUT = 300  # 5 分钟超时，确保长生成不中断


# ============================================================
# 数据结构
# ============================================================
@dataclass
class TestCase:
    id: str
    category: str
    prompt: str
    answer: str  # 标准答案关键词或数值
    check_type: str  # "exact_number", "keywords", "contains_any"
    check_values: list = field(default_factory=list)


@dataclass
class TestResult:
    test_id: str
    category: str
    passed: bool
    response: str
    reasoning: str
    latency_ms: float
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    tps: float  # tokens per second


# ============================================================
# 测试题库
# ============================================================
TESTS = [
    # === 数学推理 ===
    TestCase(
        id="math_1",
        category="数学推理",
        prompt="小明有 15 个苹果，他给了小红 3 个，又从商店买了 8 个。他妈妈拿走了一半，请问小明还剩多少个苹果？只回答数字。",
        answer="10",
        check_type="exact_number",
        check_values=["10"],
    ),
    TestCase(
        id="math_2",
        category="数学推理",
        prompt="一个水池有两个水管，A 管单独注满需要 6 小时，B 管单独注满需要 4 小时。两管同时打开，多久能注满？回答小数，单位小时。",
        answer="2.4",
        check_type="exact_number",
        check_values=["2.4"],
    ),
    TestCase(
        id="math_3",
        category="数学推理",
        prompt="火车 A 速度 60km/h，火车 B 速度 90km/h。两地相距 450km，相向而行，多久后相遇？只回答数字，单位小时。",
        answer="3",
        check_type="exact_number",
        check_values=["3"],
    ),
    TestCase(
        id="math_4",
        category="数学推理",
        prompt="一件商品原价 200 元，先涨价 20%，再打八折，最终价格是多少元？只回答数字。",
        answer="192",
        check_type="exact_number",
        check_values=["192"],
    ),
    TestCase(
        id="math_5",
        category="数学推理",
        prompt="长方形的长是宽的 3 倍，周长是 48cm。求面积是多少平方厘米？只回答数字。",
        answer="108",
        check_type="exact_number",
        check_values=["108"],
    ),
    # === 竞赛数学 ===
    TestCase(
        id="comp_math_1",
        category="竞赛数学",
        prompt="求所有满足条件的正整数 n，使得 n²+2n+12 能被 n+4 整除。列出所有正整数解，用逗号分隔，只给数字。",
        answer="2,8",
        check_type="contains_any",
        check_values=["2", "8"],
    ),
    TestCase(
        id="comp_math_2",
        category="竞赛数学",
        prompt="三角形 ABC 中，AB=13，BC=14，CA=15。求内切圆半径。只回答数字。",
        answer="4",
        check_type="exact_number",
        check_values=["4"],
    ),
    TestCase(
        id="comp_math_3",
        category="竞赛数学",
        prompt="求不定积分 ∫ x³/(x⁴+1) dx 的结果。用最简形式表示，写成 (1/a)*ln(x⁴+1)+C 的形式，a 等于多少？只回答数字。",
        answer="4",
        check_type="exact_number",
        check_values=["4"],
    ),
    TestCase(
        id="comp_math_4",
        category="竞赛数学",
        prompt="数列 a₁=1，aₙ₊₁=aₙ/(1+aₙ)。求 a₁₀₀ 等于多少？用分数表示，格式 1/n。",
        answer="1/100",
        check_type="keywords",
        check_values=["1/100"],
    ),
    # === 逻辑推理 ===
    TestCase(
        id="logic_1",
        category="逻辑推理",
        prompt="所有的猫都是动物，有些动物会游泳。能否推出'有些猫会游泳'？只回答'能'或'不能'。",
        answer="不能",
        check_type="keywords",
        check_values=["不能", "不可以", "无法推出"],
    ),
    TestCase(
        id="logic_2",
        category="逻辑推理",
        prompt="A说B在说谎，B说C在说谎，C说A和B都在说谎。只有一个人说真话，是谁？只回答一个字母。",
        answer="B",
        check_type="keywords",
        check_values=["B"],
    ),
    TestCase(
        id="logic_3",
        category="逻辑推理",
        prompt="5人赛跑：A比B快，C比D慢，B比D快，E最慢。从快到慢排名，用>连接，如 A>B>C。",
        answer="A>B>D>C>E",
        check_type="keywords",
        check_values=["A>B>D>C>E"],
    ),
    TestCase(
        id="logic_4",
        category="逻辑推理",
        prompt="25匹马，每次最多5匹比赛，没有计时器，最少需要几场比赛确定最快的3匹马？只回答数字。",
        answer="7",
        check_type="exact_number",
        check_values=["7"],
    ),
    # === 中文理解 ===
    TestCase(
        id="chinese_1",
        category="中文理解",
        prompt="老板对干了20年的老张说'公司要年轻化，你也该享享清福了'。老板实际想表达什么？用10个字以内回答核心意思。",
        answer="辞退/裁员/让他离开",
        check_type="keywords",
        check_values=["辞退", "裁员", "离开", "走", "退休", "辞", "解雇", "开除"],
    ),
    TestCase(
        id="chinese_2",
        category="中文理解",
        prompt="判断是否反讽：'你迟到一小时才到，真是太准时了。'只回答'是'或'否'。",
        answer="是",
        check_type="keywords",
        check_values=["是"],
    ),
    TestCase(
        id="chinese_3",
        category="中文理解",
        prompt="小王说周末去爬山，小李说'可能要加班，天气预报有雨，膝盖也不太好'。小李真正想表达什么？用5个字以内回答。",
        answer="不想去",
        check_type="keywords",
        check_values=["不想去", "拒绝", "不去", "不愿", "婉拒"],
    ),
    # === 抗幻觉 ===
    TestCase(
        id="halluc_1",
        category="抗幻觉",
        prompt="'量子纠缠可以用来实现超光速通信'，这个说法正确吗？只回答'正确'或'错误'。",
        answer="错误",
        check_type="keywords",
        check_values=["错误", "不正确", "错", "不对", "不能"],
    ),
    TestCase(
        id="halluc_2",
        category="抗幻觉",
        prompt="请介绍张伟力教授在2024年发表的关于'自旋玻璃与大语言模型'的论文。如果你不确定是否存在，请明确说明。",
        answer="不确定/不存在",
        check_type="keywords",
        check_values=["不确定", "无法确认", "不存在", "没有找到", "未能找到", "不清楚", "虚构", "无法验证", "找不到"],
    ),
    TestCase(
        id="halluc_3",
        category="抗幻觉",
        prompt="以下哪个 Python 库是真实存在的？(A) numpy (B) pandaflux (C) tensorweave (D) datascalpel。只回答选项字母。",
        answer="A",
        check_type="keywords",
        check_values=["A"],
    ),
    # === 指令遵循 ===
    TestCase(
        id="instruct_1",
        category="指令遵循",
        prompt="世界上最高的山峰是什么？只回答山峰名称，不超过10个字，不加标点，不加任何解释。",
        answer="珠穆朗玛峰",
        check_type="keywords",
        check_values=["珠穆朗玛峰", "珠穆朗玛", "Mount Everest", "Everest"],
    ),
    TestCase(
        id="instruct_2",
        category="指令遵循",
        prompt='将以下信息提取为JSON：客户张三，手机13800138000，邮箱zhangsan@example.com。只输出JSON，不要其他内容。字段：name,phone,email。',
        answer='{"name":"张三"}',
        check_type="keywords",
        check_values=["张三", "13800138000", "zhangsan@example.com"],
    ),
    # === 代码能力 ===
    TestCase(
        id="code_1",
        category="代码能力",
        prompt="Python 代码 `max_val = 0; for num in [-3,-1,-7,-2]: max_val = num if num > max_val else max_val` 的 bug 是什么？用一句话说明核心问题。",
        answer="初始值为0",
        check_type="keywords",
        check_values=["初始值", "0", "负数", "最小值", "numbers[0]", "float", "-inf"],
    ),
]


# ============================================================
# 调用模型
# ============================================================
def call_model(prompt: str, thinking: bool, max_retries: int = 3) -> dict:
    """调用 Qwen 模型，用 curl 子进程（最可靠），5 分钟超时"""
    suffix = "" if thinking else " /no_think"
    full_prompt = prompt + suffix
    max_tok = MAX_TOKENS_THINK if thinking else MAX_TOKENS_NO_THINK

    payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": full_prompt}],
        "max_tokens": max_tok,
    })

    for attempt in range(max_retries):
        start = time.time()
        try:
            result = subprocess.run(
                ["curl", "-s", "--connect-timeout", "10", "--max-time", str(REQUEST_TIMEOUT),
                 API_URL, "-H", "Content-Type: application/json", "-d", payload],
                capture_output=True, text=True, timeout=REQUEST_TIMEOUT + 10,
            )
            if result.returncode != 0:
                raise Exception(f"curl exit {result.returncode}: {result.stderr[:100]}")
            body = json.loads(result.stdout)
            if "error" in body:
                raise Exception(f"API error: {body['error']}")
            break
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            if attempt < max_retries - 1:
                wait = 15 * (attempt + 1)
                print(f"\n    ⚠️ 重试 {attempt+1}/{max_retries} (等 {wait}s)...", end=" ", flush=True)
                time.sleep(wait)
                continue
            return {
                "content": f"[ERROR] {e}",
                "reasoning": "",
                "latency_ms": elapsed,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            }

    elapsed = (time.time() - start) * 1000
    choice = body.get("choices", [{}])[0]
    msg = choice.get("message", {})
    content = msg.get("content", "") or ""
    reasoning = msg.get("reasoning", "") or ""
    usage = body.get("usage", {})

    return {
        "content": content,
        "reasoning": reasoning,
        "latency_ms": elapsed,
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
    }


# ============================================================
# 自动判分
# ============================================================
def check_answer(test: TestCase, response: str) -> bool:
    """根据 check_type 判定是否通过"""
    resp_clean = response.strip().lower()

    if test.check_type == "exact_number":
        numbers = re.findall(r"-?\d+\.?\d*", response)
        for val in test.check_values:
            if val in numbers:
                return True
            # 也检查浮点等价
            try:
                target = float(val)
                for n in numbers:
                    if abs(float(n) - target) < 0.01:
                        return True
            except ValueError:
                pass
        return False

    elif test.check_type == "keywords":
        for kw in test.check_values:
            if kw.lower() in resp_clean:
                return True
        return False

    elif test.check_type == "contains_any":
        # 必须包含所有 check_values
        for val in test.check_values:
            if val.lower() not in resp_clean:
                return False
        return True

    return False


# ============================================================
# 运行一轮测评
# ============================================================
def run_round(thinking: bool) -> list[TestResult]:
    mode = "thinking" if thinking else "no_think"
    print(f"\n{'='*60}")
    print(f"  Round: {mode.upper()}  |  max_tokens={MAX_TOKENS_THINK if thinking else MAX_TOKENS_NO_THINK}")
    print(f"{'='*60}\n")

    results = []
    for i, test in enumerate(TESTS):
        print(f"  [{i+1}/{len(TESTS)}] {test.id} ({test.category})...", end=" ", flush=True)

        resp = call_model(test.prompt, thinking)
        passed = check_answer(test, resp["content"])

        # 计算 TPS
        elapsed_sec = resp["latency_ms"] / 1000
        tps = resp["completion_tokens"] / elapsed_sec if elapsed_sec > 0 else 0

        result = TestResult(
            test_id=test.id,
            category=test.category,
            passed=passed,
            response=resp["content"][:200],  # 截断保存
            reasoning=resp["reasoning"][:200] if resp["reasoning"] else "",
            latency_ms=resp["latency_ms"],
            prompt_tokens=resp["prompt_tokens"],
            completion_tokens=resp["completion_tokens"],
            total_tokens=resp["total_tokens"],
            tps=tps,
        )
        results.append(result)

        status = "✅" if passed else "❌"
        print(f"{status}  {resp['latency_ms']:.0f}ms  {tps:.1f}tps  tokens={resp['total_tokens']}")

        if not passed:
            # 显示回答前 80 字方便 debug
            preview = resp["content"][:80].replace("\n", " ")
            print(f"         答案预览: {preview}")

        # 每道题之间等 3 秒，避免 mlx-lm.server 过载 503
        if i < len(TESTS) - 1:
            time.sleep(3)

    return results


# ============================================================
# 生成报告
# ============================================================
def generate_report(results_no_think: list[TestResult], results_think: list[TestResult]):
    """生成 Markdown 对比报告"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")

    def summarize(results: list[TestResult]) -> dict:
        categories = {}
        for r in results:
            if r.category not in categories:
                categories[r.category] = {"total": 0, "passed": 0, "latencies": [], "tps_list": []}
            cat = categories[r.category]
            cat["total"] += 1
            if r.passed:
                cat["passed"] += 1
            cat["latencies"].append(r.latency_ms)
            cat["tps_list"].append(r.tps)

        total_passed = sum(c["passed"] for c in categories.values())
        total_count = sum(c["total"] for c in categories.values())
        avg_latency = sum(r.latency_ms for r in results) / len(results) if results else 0
        avg_tps = sum(r.tps for r in results) / len(results) if results else 0

        return {
            "categories": categories,
            "total_passed": total_passed,
            "total_count": total_count,
            "accuracy": total_passed / total_count * 100 if total_count else 0,
            "avg_latency": avg_latency,
            "avg_tps": avg_tps,
        }

    s_no = summarize(results_no_think)
    s_yes = summarize(results_think)

    lines = [
        f"# Qwen 3.5 27B Q4 测评报告",
        f"",
        f"- **硬件**: Mac Studio M2 Max 32GB",
        f"- **模型**: {MODEL}",
        f"- **API**: {API_BASE}",
        f"- **测评时间**: {timestamp}",
        f"",
        f"## 总分对比",
        f"",
        f"| 指标 | 关闭 Thinking | 开启 Thinking | 差异 |",
        f"|------|:---:|:---:|:---:|",
        f"| 准确率 | {s_no['accuracy']:.1f}% ({s_no['total_passed']}/{s_no['total_count']}) | {s_yes['accuracy']:.1f}% ({s_yes['total_passed']}/{s_yes['total_count']}) | {s_yes['accuracy']-s_no['accuracy']:+.1f}% |",
        f"| 平均延迟 | {s_no['avg_latency']:.0f}ms | {s_yes['avg_latency']:.0f}ms | {s_yes['avg_latency']-s_no['avg_latency']:+.0f}ms |",
        f"| 平均 TPS | {s_no['avg_tps']:.1f} | {s_yes['avg_tps']:.1f} | {s_yes['avg_tps']-s_no['avg_tps']:+.1f} |",
        f"",
        f"## 分类对比",
        f"",
        f"| 分类 | 关闭 Thinking | 开启 Thinking |",
        f"|------|:---:|:---:|",
    ]

    all_cats = list(dict.fromkeys(
        [t.category for t in TESTS]
    ))
    for cat in all_cats:
        no = s_no["categories"].get(cat, {"passed": 0, "total": 0})
        yes = s_yes["categories"].get(cat, {"passed": 0, "total": 0})
        lines.append(f"| {cat} | {no['passed']}/{no['total']} | {yes['passed']}/{yes['total']} |")

    lines.extend([
        f"",
        f"## 逐题对比",
        f"",
        f"| 题号 | 分类 | 关闭Think | 开启Think | 关闭延迟 | 开启延迟 |",
        f"|------|------|:---:|:---:|---:|---:|",
    ])

    for r_no, r_yes in zip(results_no_think, results_think):
        s_no_icon = "✅" if r_no.passed else "❌"
        s_yes_icon = "✅" if r_yes.passed else "❌"
        lines.append(
            f"| {r_no.test_id} | {r_no.category} | {s_no_icon} | {s_yes_icon} | {r_no.latency_ms:.0f}ms | {r_yes.latency_ms:.0f}ms |"
        )

    # 错题详情
    lines.extend([f"", f"## 错题详情", f""])
    for mode_name, results in [("关闭 Thinking", results_no_think), ("开启 Thinking", results_think)]:
        failed = [r for r in results if not r.passed]
        if failed:
            lines.append(f"### {mode_name} 错题 ({len(failed)} 题)")
            lines.append(f"")
            for r in failed:
                test = next(t for t in TESTS if t.id == r.test_id)
                lines.append(f"**{r.test_id}** ({r.category})")
                lines.append(f"- 标准答案: {test.answer}")
                lines.append(f"- 模型回答: {r.response[:150]}")
                lines.append(f"")

    lines.extend([
        f"",
        f"## 结论",
        f"",
        f"- 关闭 Thinking: 准确率 {s_no['accuracy']:.1f}%, 平均 {s_no['avg_tps']:.1f} tps, 延迟 {s_no['avg_latency']:.0f}ms",
        f"- 开启 Thinking: 准确率 {s_yes['accuracy']:.1f}%, 平均 {s_yes['avg_tps']:.1f} tps, 延迟 {s_yes['avg_latency']:.0f}ms",
        f"- Thinking 带来的准确率提升: {s_yes['accuracy']-s_no['accuracy']:+.1f}%",
        f"- Thinking 带来的延迟增加: {s_yes['avg_latency']-s_no['avg_latency']:+.0f}ms",
        f"",
    ])

    report = "\n".join(lines)
    report_path = f"/Users/rayman.chen/mycc/2-Projects/qwen-eval/report_{datetime.now().strftime('%Y%m%d_%H%M')}.md"
    with open(report_path, "w") as f:
        f.write(report)
    print(f"\n📄 报告已保存: {report_path}")

    # 同时保存原始 JSON 数据
    raw_data = {
        "timestamp": timestamp,
        "model": MODEL,
        "no_think": [
            {
                "test_id": r.test_id,
                "category": r.category,
                "passed": r.passed,
                "response": r.response,
                "latency_ms": r.latency_ms,
                "tps": r.tps,
                "total_tokens": r.total_tokens,
            }
            for r in results_no_think
        ],
        "think": [
            {
                "test_id": r.test_id,
                "category": r.category,
                "passed": r.passed,
                "response": r.response,
                "latency_ms": r.latency_ms,
                "tps": r.tps,
                "total_tokens": r.total_tokens,
            }
            for r in results_think
        ],
    }
    json_path = f"/Users/rayman.chen/mycc/2-Projects/qwen-eval/raw_{datetime.now().strftime('%Y%m%d_%H%M')}.json"
    with open(json_path, "w") as f:
        json.dump(raw_data, f, ensure_ascii=False, indent=2)
    print(f"📦 原始数据: {json_path}")

    return report


# ============================================================
# 主入口
# ============================================================
if __name__ == "__main__":
    print("🧪 Qwen 3.5 27B Q4 测评")
    print(f"   API: {API_BASE}")
    print(f"   模型: {MODEL}")
    print(f"   题目数: {len(TESTS)}")
    print(f"   两轮对比: no_think vs thinking")

    # 预热
    print("\n⏳ 预热模型...")
    call_model("你好", False)

    # Round 1: 关闭 thinking
    results_no_think = run_round(thinking=False)

    # 中间等一下让模型冷却
    print("\n⏳ 等待 5 秒让模型冷却...")
    time.sleep(5)

    # Round 2: 开启 thinking
    results_think = run_round(thinking=True)

    # 生成报告
    report = generate_report(results_no_think, results_think)

    # 控制台也输出一份简报
    print("\n" + "=" * 60)
    print("  测评完成！")
    print("=" * 60)
