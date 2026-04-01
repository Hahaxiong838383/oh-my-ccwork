"""Chinese comprehension benchmark: reading, idioms, sarcasm, needle-in-haystack."""
import re
import random
from utils import load_config, get_client, chat, print_header

READING_PASSAGES = [
    {
        "title": "人工智能的发展",
        "text": """人工智能（AI）的发展可以追溯到1956年达特茅斯会议，这被视为AI的诞生。早期的AI研究主要集中在符号推理和专家系统上。20世纪80年代，由于计算能力的限制和理论的不足，AI进入了所谓的寒冬期。直到2006年，深度学习的突破重新点燃了人们对AI的热情。2012年，AlexNet在ImageNet竞赛中的胜利标志着深度学习时代的到来。此后，AI技术在计算机视觉、自然语言处理、语音识别等领域取得了巨大进步。2016年，AlphaGo击败世界围棋冠军李世石，引起了全球关注。2022年底，ChatGPT的发布更是将大语言模型推向了公众视野。目前，AI已经广泛应用于医疗诊断、自动驾驶、金融分析等各个领域，但同时也带来了隐私、就业和伦理等方面的挑战。""",
        "questions": [
            {"q": "AI的诞生标志性事件发生在哪一年？\nA. 1950 B. 1956 C. 1980 D. 2006", "a": "B"},
            {"q": "AI寒冬的主要原因是什么？\nA. 资金不足 B. 兴趣减退 C. 计算能力限制和理论不足 D. 政府禁令", "a": "C"},
            {"q": "AlexNet的胜利发生在哪一年？\nA. 2006 B. 2010 C. 2012 D. 2016", "a": "C"},
            {"q": "AlphaGo击败的围棋冠军是谁？\nA. 柯洁 B. 李世石 C. 聂卫平 D. 古力", "a": "B"},
            {"q": "文中提到AI面临的挑战不包括？\nA. 隐私 B. 就业 C. 伦理 D. 能源消耗", "a": "D"},
        ],
    },
    {
        "title": "中国茶文化",
        "text": """中国是茶的故乡，茶文化有着数千年的历史。相传神农氏发现了茶叶的功效。唐代陆羽撰写了世界上第一部茶学专著《茶经》，被尊为茶圣。宋代时期，点茶法盛行，斗茶成为一种社会风尚。明代朱元璋下令废团改散，使散茶冲泡成为主流饮茶方式，一直延续至今。中国茶叶主要分为绿茶、红茶、乌龙茶、白茶、黄茶和黑茶六大类。其中，绿茶产量最大，西湖龙井、碧螺春等都是著名的绿茶品种。普洱茶属于黑茶类，以云南大叶种为原料，经过后发酵工艺制成。茶文化不仅是中国的，也是世界的。17世纪茶叶传入欧洲后，英国人发展出了下午茶文化，日本则形成了独特的茶道。""",
        "questions": [
            {"q": "《茶经》的作者是谁？\nA. 神农氏 B. 陆羽 C. 朱元璋 D. 苏轼", "a": "B"},
            {"q": "宋代流行的饮茶方式是？\nA. 煮茶 B. 点茶 C. 泡茶 D. 煎茶", "a": "B"},
            {"q": "散茶冲泡从哪个朝代开始成为主流？\nA. 唐 B. 宋 C. 明 D. 清", "a": "C"},
            {"q": "普洱茶属于哪一类茶？\nA. 绿茶 B. 红茶 C. 乌龙茶 D. 黑茶", "a": "D"},
            {"q": "茶叶传入欧洲是在哪个世纪？\nA. 15世纪 B. 16世纪 C. 17世纪 D. 18世纪", "a": "C"},
        ],
    },
    {
        "title": "量子计算原理",
        "text": """量子计算是一种基于量子力学原理的新型计算模式。传统计算机使用比特（bit）作为信息基本单位，每个比特只能处于0或1两种状态之一。而量子计算机使用量子比特（qubit），它可以同时处于0和1的叠加态，这就是量子叠加原理。当多个量子比特之间产生量子纠缠时，它们可以形成一个相互关联的整体，对其中一个量子比特的测量会立即影响其他纠缠的量子比特。这使得量子计算机在处理某些特定问题时，能够实现指数级的加速。目前，量子计算主要面临退相干问题——量子态非常脆弱，容易受到环境噪声的干扰而崩溃。IBM、Google、中国的九章等团队都在推进量子计算的实用化。2019年，Google宣布实现了量子霸权，其量子处理器仅用200秒完成了传统超级计算机需要1万年才能完成的计算。""",
        "questions": [
            {"q": "量子比特与经典比特的核心区别是？\nA. 速度更快 B. 可以处于叠加态 C. 体积更小 D. 更稳定", "a": "B"},
            {"q": "量子纠缠的特点是？\nA. 传输速度快 B. 对一个量子比特的测量影响其他纠缠的量子比特 C. 永远不会消失 D. 只在低温下产生", "a": "B"},
            {"q": "量子计算的主要挑战是？\nA. 成本太高 B. 退相干问题 C. 没有应用场景 D. 编程语言不成熟", "a": "B"},
            {"q": "Google宣布量子霸权是在哪一年？\nA. 2017 B. 2018 C. 2019 D. 2020", "a": "C"},
            {"q": "文中提到的中国量子计算团队名称是？\nA. 墨子 B. 九章 C. 祖冲之 D. 悟空", "a": "B"},
        ],
    },
]

IDIOM_QUESTIONS = [
    {"q": "以下哪个成语形容做事不彻底？\nA. 半途而废 B. 一鸣惊人 C. 画龙点睛 D. 锦上添花", "a": "A"},
    {"q": "杯弓蛇影的意思是？\nA. 酒杯里有蛇 B. 疑神疑鬼 C. 弓箭和蛇 D. 杯子的影子", "a": "B"},
    {"q": "亡羊补牢强调的是？\nA. 为时已晚 B. 出了问题及时补救 C. 放羊要小心 D. 修补栅栏", "a": "B"},
    {"q": "对牛弹琴比喻？\nA. 音乐很美 B. 对不理解的人讲道理 C. 牛很聪明 D. 弹琴给动物听", "a": "B"},
    {"q": "破釜沉舟出自哪个历史人物的故事？\nA. 刘邦 B. 项羽 C. 诸葛亮 D. 曹操", "a": "B"},
    {"q": "画蛇添足的寓意是？\nA. 蛇需要脚 B. 多此一举 C. 画画技术好 D. 创新精神", "a": "B"},
    {"q": "守株待兔批评的是？\nA. 耐心等待 B. 不劳而获的侥幸心理 C. 种树的人 D. 打猎技巧差", "a": "B"},
    {"q": "塞翁失马的完整后半句是？\nA. 一去不返 B. 焉知非福 C. 必有后患 D. 覆水难收", "a": "B"},
    {"q": "望梅止渴涉及的三国人物是？\nA. 刘备 B. 曹操 C. 孙权 D. 诸葛亮", "a": "B"},
    {"q": "刻舟求剑批评的思维方式是？\nA. 过于谨慎 B. 固执不变通 C. 做事仔细 D. 多此一举", "a": "B"},
]

SARCASM_QUESTIONS = [
    {"q": "同事迟到一小时后到达，你说'你来得可真早啊'。这句话的真实含义是？\nA. 称赞他来得早 B. 讽刺他来得晚 C. 描述事实 D. 开心他来了", "a": "B"},
    {"q": "看到一篇错误百出的文章，评论'这文章写得真好，一个字都不用改'。真实含义？\nA. 真的很好 B. 文章完美 C. 讽刺文章很差 D. 鼓励作者", "a": "C"},
    {"q": "考试得了30分，朋友说'你可真是个学霸'。这是？\nA. 真心夸奖 B. 反讽 C. 误解 D. 陈述事实", "a": "B"},
    {"q": "'这道菜的味道真独特'在餐桌上通常暗示？\nA. 味道很好 B. 味道很差 C. 从未尝过 D. 无法判断（需看语境）", "a": "D"},
    {"q": "老板对经常请假的员工说'你对公司的贡献有目共睹'。这是？\nA. 表扬 B. 肯定 C. 讽刺 D. 中性评价", "a": "C"},
]

NEEDLE_TEMPLATE = """以下是一篇关于{topic}的文章：

{padding_before}

{needle}

{padding_after}

请仔细阅读上面的文章，然后回答：{question}
请直接给出答案，不要引用原文。"""

PADDING_UNIT = "人工智能技术正在快速发展，从自然语言处理到计算机视觉，各个领域都取得了显著突破。机器学习算法不断优化，深度神经网络的架构日新月异。研究人员在大规模数据集上训练模型，以提升模型的泛化能力和准确率。同时，边缘计算和云计算的结合使得AI应用场景更加丰富。"

SYSTEM = "你是一个阅读理解测试助手。请选择正确答案，只输出字母选项（如 A、B、C 或 D），不要解释。"


def extract_choice(text):
    text = text.strip()
    m = re.search(r'\b([A-D])\b', text.upper())
    return m.group(1) if m else text[:1].upper()


def generate_needle_test(target_len):
    needle = "根据最新的科学研究报告，紫色水晶蝴蝶的翅膀在月光下能产生每秒42次的微弱荧光脉冲。"
    question = "紫色水晶蝴蝶的翅膀在月光下产生荧光脉冲的频率是多少？"
    expected = "42"

    chars_needed = target_len - len(needle) - 100
    repeats = max(chars_needed // len(PADDING_UNIT), 1)
    insert_pos = repeats // 2

    before = (PADDING_UNIT + "\n") * insert_pos
    after = (PADDING_UNIT + "\n") * (repeats - insert_pos)

    prompt = NEEDLE_TEMPLATE.format(
        topic="科技前沿",
        padding_before=before,
        needle=needle,
        padding_after=after,
        question=question,
    )
    return prompt, expected


def run(config=None):
    config = config or load_config()
    client = get_client(config)
    model = config["api"]["model"]

    print_header("Chinese Comprehension")
    results = {}

    # Reading comprehension
    rc_correct = 0
    rc_total = 0
    for passage in READING_PASSAGES:
        print(f"\n  --- {passage['title']} ---")
        for i, q in enumerate(passage["questions"]):
            prompt = f"请根据以下文章回答问题。\n\n文章：{passage['text']}\n\n问题：{q['q']}"
            resp = chat(client, model, [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": prompt},
            ], max_tokens=50, temperature=0.0)
            pred = extract_choice(resp)
            ok = pred == q["a"]
            if ok:
                rc_correct += 1
            rc_total += 1
            print(f"  [{'✓' if ok else '✗'}] Q{i+1}: expected={q['a']}, got={pred}")

    results["reading"] = {"correct": rc_correct, "total": rc_total, "accuracy": round(rc_correct / rc_total * 100, 1)}

    # Idioms
    id_correct = 0
    print(f"\n  --- 成语理解 ---")
    for i, q in enumerate(IDIOM_QUESTIONS):
        resp = chat(client, model, [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": q["q"]},
        ], max_tokens=50, temperature=0.0)
        pred = extract_choice(resp)
        ok = pred == q["a"]
        if ok:
            id_correct += 1
        print(f"  [{'✓' if ok else '✗'}] Idiom Q{i+1}: expected={q['a']}, got={pred}")

    results["idioms"] = {"correct": id_correct, "total": len(IDIOM_QUESTIONS), "accuracy": round(id_correct / len(IDIOM_QUESTIONS) * 100, 1)}

    # Sarcasm
    sc_correct = 0
    print(f"\n  --- 反讽/双关 ---")
    for i, q in enumerate(SARCASM_QUESTIONS):
        resp = chat(client, model, [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": q["q"]},
        ], max_tokens=50, temperature=0.0)
        pred = extract_choice(resp)
        ok = pred == q["a"]
        if ok:
            sc_correct += 1
        print(f"  [{'✓' if ok else '✗'}] Sarcasm Q{i+1}: expected={q['a']}, got={pred}")

    results["sarcasm"] = {"correct": sc_correct, "total": len(SARCASM_QUESTIONS), "accuracy": round(sc_correct / len(SARCASM_QUESTIONS) * 100, 1)}

    # Needle in haystack
    print(f"\n  --- 大海捞针 ---")
    needle_results = {}
    for length in config.get("chinese", {}).get("needle_lengths", [2000, 4000, 8000]):
        prompt, expected = generate_needle_test(length)
        resp = chat(client, model, [{"role": "user", "content": prompt}], max_tokens=100, temperature=0.0)
        found = expected in resp
        needle_results[f"{length//1000}K"] = found
        print(f"  [{length//1000}K chars] {'✓ Found' if found else '✗ Missing'}: '{resp[:80]}...'")

    results["needle"] = needle_results

    # Overall
    all_correct = rc_correct + id_correct + sc_correct
    all_total = rc_total + len(IDIOM_QUESTIONS) + len(SARCASM_QUESTIONS)
    results["overall_accuracy"] = round(all_correct / all_total * 100, 1)
    print(f"\n  Overall (excl. needle): {all_correct}/{all_total} = {results['overall_accuracy']}%")

    return results


if __name__ == "__main__":
    import json
    print(json.dumps(run(), indent=2, ensure_ascii=False))
