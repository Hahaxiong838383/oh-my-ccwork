"""Practical ability benchmark: JSON extraction, translation, code, instruction following."""
import json as jsonlib
import re
from utils import load_config, get_client, chat, print_header

JSON_EXTRACTION = [
    {"input": "张三，男，35岁，北京人，电话13800138000，邮箱zhangsan@example.com", "fields": ["name", "gender", "age", "city", "phone", "email"]},
    {"input": "订单号：ORD-2024-001，商品：iPhone 15 Pro，数量：2，单价：7999元，总价：15998元", "fields": ["order_id", "product", "quantity", "unit_price", "total"]},
    {"input": "航班CA1234，2024年3月15日，北京首都T3到上海浦东T1，起飞08:30，到达10:45", "fields": ["flight", "date", "departure", "arrival", "depart_time", "arrive_time"]},
    {"input": "患者李四，女，28岁，主诉头痛三天，体温37.8度，血压120/80mmHg", "fields": ["name", "gender", "age", "symptom", "temperature", "blood_pressure"]},
    {"input": "比赛：2024 NBA总决赛G7，凯尔特人 106:98 独行侠，MVP：塔图姆", "fields": ["event", "team1", "score1", "team2", "score2", "mvp"]},
    {"input": "餐厅名：老北京涮羊肉，地址：朝阳区三里屯路8号，评分：4.5分，人均：128元", "fields": ["name", "address", "rating", "price_per_person"]},
    {"input": "简历：王五，1990年出生，清华大学计算机系本科，腾讯高级工程师，工作8年", "fields": ["name", "birth_year", "education", "company", "title", "experience"]},
    {"input": "天气预报：北京，2024-03-15，晴转多云，最高温18度，最低温5度，东北风3级", "fields": ["city", "date", "weather", "high_temp", "low_temp", "wind"]},
    {"input": "电影：流浪地球2，导演：郭帆，主演：吴京、刘德华，票房：40.29亿，评分8.3", "fields": ["title", "director", "actors", "box_office", "rating"]},
    {"input": "快递单号SF1234567890，寄件人张三（北京），收件人李四（上海），重量2.5kg，运费23元", "fields": ["tracking", "sender", "sender_city", "receiver", "receiver_city", "weight", "shipping_fee"]},
]

TRANSLATIONS = [
    {"zh": "今天天气真好，我们去公园散步吧。", "direction": "zh2en", "key_words": ["weather", "park", "walk"]},
    {"zh": "人工智能正在改变我们的生活方式。", "direction": "zh2en", "key_words": ["artificial intelligence", "changing", "life"]},
    {"en": "The quick brown fox jumps over the lazy dog.", "direction": "en2zh", "key_words": ["狐狸", "跳", "狗"]},
    {"en": "Practice makes perfect.", "direction": "en2zh", "key_words": ["熟能生巧"]},
    {"zh": "失败是成功之母。", "direction": "zh2en", "key_words": ["failure", "success", "mother"]},
    {"en": "Actions speak louder than words.", "direction": "en2zh", "key_words": ["行动", "言语"]},
    {"zh": "这个项目的截止日期是下周五。", "direction": "zh2en", "key_words": ["deadline", "Friday"]},
    {"en": "I have a dream that one day this nation will rise up.", "direction": "en2zh", "key_words": ["梦想", "国家"]},
    {"zh": "请问洗手间在哪里？", "direction": "zh2en", "key_words": ["restroom", "where", "bathroom"]},
    {"en": "To be or not to be, that is the question.", "direction": "en2zh", "key_words": ["生存", "毁灭", "问题"]},
]

CODE_QUESTIONS = [
    {"code": "def f(n): return 1 if n <= 1 else f(n-1) + f(n-2)", "q": "这个函数计算的是什么？f(10)的结果是多少？", "keywords": ["斐波那契", "fibonacci", "55"]},
    {"code": "def f(lst): return [x for x in lst if x % 2 == 0]", "q": "这个函数的功能是什么？f([1,2,3,4,5,6])的结果是？", "keywords": ["偶数", "even", "[2, 4, 6]"]},
    {"code": "def f(s): return s == s[::-1]", "q": "这个函数判断的是什么？f('racecar')返回什么？", "keywords": ["回文", "palindrome", "True"]},
    {"code": "def f(d): return {v: k for k, v in d.items()}", "q": "这个函数做了什么操作？", "keywords": ["键值", "交换", "反转", "swap", "invert"]},
    {"code": "def f(n): return all(n % i != 0 for i in range(2, int(n**0.5)+1)) and n > 1", "q": "这个函数判断的是什么？f(17)返回什么？", "keywords": ["素数", "质数", "prime", "True"]},
]

INSTRUCTION_FOLLOW = [
    {"instruction": "请用恰好20个字描述春天。不多不少，正好20个汉字。", "check": lambda r: 18 <= len(re.sub(r'[^\u4e00-\u9fff]', '', r)) <= 22, "desc": "字数控制(20字)"},
    {"instruction": "列出5种水果，用JSON数组格式输出，不要其他内容。", "check": lambda r: r.strip().startswith('[') and len(jsonlib.loads(r.strip())) == 5 if r.strip().startswith('[') else False, "desc": "JSON数组格式"},
    {"instruction": "写一首四行诗，每行恰好7个字，关于月亮。", "check": lambda r: len([l for l in r.strip().split('\n') if len(re.sub(r'[^\u4e00-\u9fff]', '', l)) >= 5]) >= 4, "desc": "四行七言诗"},
    {"instruction": "用英文回答：What is 2+2? Answer with only the number.", "check": lambda r: '4' in r and len(r.strip()) < 10, "desc": "英文回答+简洁"},
    {"instruction": "请用Markdown表格列出周一到周五的英文名称。表格有两列：中文和英文。", "check": lambda r: '|' in r and 'Monday' in r, "desc": "Markdown表格格式"},
]


def run(config=None):
    config = config or load_config()
    client = get_client(config)
    model = config["api"]["model"]

    print_header("Practical Ability")
    results = {}

    # JSON extraction
    print("  --- JSON 结构化提取 ---")
    json_ok = 0
    for i, item in enumerate(JSON_EXTRACTION):
        prompt = f"请将以下信息提取为JSON格式，字段包括{', '.join(item['fields'])}。只输出JSON，不要其他内容。\n\n{item['input']}"
        resp = chat(client, model, [{"role": "user", "content": prompt}], max_tokens=300, temperature=0.0)
        try:
            # try to parse JSON from response
            json_str = re.search(r'\{[^{}]+\}', resp, re.DOTALL)
            if json_str:
                parsed = jsonlib.loads(json_str.group())
                has_fields = sum(1 for f in item["fields"] if f in parsed) / len(item["fields"])
                ok = has_fields >= 0.7
            else:
                ok = False
        except Exception:
            ok = False
        if ok:
            json_ok += 1
        print(f"  [{'✓' if ok else '✗'}] JSON Q{i+1}")

    results["json_extraction"] = {"correct": json_ok, "total": len(JSON_EXTRACTION), "accuracy": round(json_ok / len(JSON_EXTRACTION) * 100, 1)}

    # Translation
    print("\n  --- 中英翻译 ---")
    trans_ok = 0
    for i, item in enumerate(TRANSLATIONS):
        if item["direction"] == "zh2en":
            prompt = f"请将以下中文翻译成英文：{item['zh']}"
        else:
            prompt = f"请将以下英文翻译成中文：{item['en']}"
        resp = chat(client, model, [{"role": "user", "content": prompt}], max_tokens=200, temperature=0.0)
        matched = sum(1 for kw in item["key_words"] if kw.lower() in resp.lower())
        ok = matched >= len(item["key_words"]) * 0.5
        if ok:
            trans_ok += 1
        print(f"  [{'✓' if ok else '✗'}] Trans Q{i+1} ({item['direction']}): matched {matched}/{len(item['key_words'])} keywords")

    results["translation"] = {"correct": trans_ok, "total": len(TRANSLATIONS), "accuracy": round(trans_ok / len(TRANSLATIONS) * 100, 1)}

    # Code understanding
    print("\n  --- 代码理解 ---")
    code_ok = 0
    for i, item in enumerate(CODE_QUESTIONS):
        prompt = f"请分析以下Python代码：\n```python\n{item['code']}\n```\n{item['q']}"
        resp = chat(client, model, [{"role": "user", "content": prompt}], max_tokens=300, temperature=0.0)
        matched = any(kw.lower() in resp.lower() for kw in item["keywords"])
        if matched:
            code_ok += 1
        print(f"  [{'✓' if matched else '✗'}] Code Q{i+1}")

    results["code"] = {"correct": code_ok, "total": len(CODE_QUESTIONS), "accuracy": round(code_ok / len(CODE_QUESTIONS) * 100, 1)}

    # Instruction following
    print("\n  --- 指令遵循 ---")
    inst_ok = 0
    for i, item in enumerate(INSTRUCTION_FOLLOW):
        resp = chat(client, model, [{"role": "user", "content": item["instruction"]}], max_tokens=300, temperature=0.0)
        try:
            ok = item["check"](resp)
        except Exception:
            ok = False
        if ok:
            inst_ok += 1
        print(f"  [{'✓' if ok else '✗'}] Inst Q{i+1}: {item['desc']}")

    results["instruction"] = {"correct": inst_ok, "total": len(INSTRUCTION_FOLLOW), "accuracy": round(inst_ok / len(INSTRUCTION_FOLLOW) * 100, 1)}

    all_correct = json_ok + trans_ok + code_ok + inst_ok
    all_total = len(JSON_EXTRACTION) + len(TRANSLATIONS) + len(CODE_QUESTIONS) + len(INSTRUCTION_FOLLOW)
    results["overall_accuracy"] = round(all_correct / all_total * 100, 1)
    print(f"\n  Overall: {all_correct}/{all_total} = {results['overall_accuracy']}%")

    return results


if __name__ == "__main__":
    print(jsonlib.dumps(run(), indent=2, ensure_ascii=False))
