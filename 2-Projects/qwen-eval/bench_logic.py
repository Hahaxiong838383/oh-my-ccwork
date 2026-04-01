"""Logic and common-sense reasoning benchmark."""
import re
from utils import load_config, get_client, chat, print_header

LOGIC_QUESTIONS = [
    {"q": "所有的猫都是动物，小花是一只猫。所以小花是什么？\nA. 植物 B. 动物 C. 矿物 D. 不确定", "a": "B"},
    {"q": "如果下雨，地面就会湿。地面是湿的。能得出什么结论？\nA. 一定下雨了 B. 可能下雨了 C. 没有下雨 D. 不能确定原因", "a": "D"},
    {"q": "小明比小红高，小红比小华高。谁最矮？\nA. 小明 B. 小红 C. 小华 D. 无法判断", "a": "C"},
    {"q": "所有医生都上过大学。张三没上过大学。能得出什么？\nA. 张三是医生 B. 张三不是医生 C. 张三可能是医生 D. 信息不足", "a": "B"},
    {"q": "5个人排成一排，有多少种不同的排列方式？\nA. 25 B. 60 C. 120 D. 720", "a": "C"},
    {"q": "一个袋子里有3红2蓝球，随机取1个，取到红球的概率是？\nA. 2/5 B. 3/5 C. 1/2 D. 2/3", "a": "B"},
    {"q": "甲说乙在说谎，乙说丙在说谎，丙说甲和乙都在说谎。谁说的是真话？\nA. 甲 B. 乙 C. 丙 D. 无法确定", "a": "B"},
    {"q": "如果A则B，如果B则C。A为真。C是？\nA. 真 B. 假 C. 不确定 D. 以上都不对", "a": "A"},
    {"q": "小李、小王、小张分别是教师、医生、工程师（不一定对应）。小李不是医生，小王不是教师，小张不是教师也不是医生。小王的职业是？\nA. 教师 B. 医生 C. 工程师 D. 无法确定", "a": "B"},
    {"q": "一个数列：2, 6, 12, 20, 30, ?  下一个数是？\nA. 36 B. 40 C. 42 D. 48", "a": "C"},
    {"q": "否命题和逆否命题的关系是？已知'如果p则q'为真。\nA. 逆否命题也为真 B. 否命题也为真 C. 逆命题也为真 D. 以上都对", "a": "A"},
    {"q": "有8支队伍进行淘汰赛，需要打几场比赛才能决出冠军？\nA. 7 B. 8 C. 15 D. 28", "a": "A"},
    {"q": "从5个人中选2个代表，有多少种选法？\nA. 10 B. 20 C. 25 D. 60", "a": "A"},
    {"q": "一根木头锯成5段需要8分钟。锯成10段需要几分钟？\nA. 16 B. 18 C. 20 D. 36", "a": "B"},
    {"q": "钟表3点整时，时针和分针的夹角是多少度？\nA. 60 B. 90 C. 120 D. 180", "a": "B"},
    {"q": "如果所有A是B，所有B是C，那么？\nA. 所有C是A B. 所有A是C C. 部分C是A D. B和C同时成立", "a": "B"},
    {"q": "小明说：'我说的这句话是假的。'这句话是？\nA. 真 B. 假 C. 悖论 D. 无意义", "a": "C"},
    {"q": "1000瓶药水中有1瓶有毒，用小白鼠试毒（毒性次日发作），最少需要几只小白鼠能在两天内找出毒药？\nA. 10 B. 100 C. 500 D. 999", "a": "A"},
    {"q": "三个人三天做三件事。九个人九天可以做几件事？\nA. 9 B. 27 C. 81 D. 3", "a": "B"},
    {"q": "A是B的父亲，B是C的父亲。A和C的关系是？\nA. 父子 B. 祖孙 C. 兄弟 D. 叔侄", "a": "B"},
]

COMMON_SENSE = [
    {"q": "太阳从哪个方向升起？\nA. 东 B. 西 C. 南 D. 北", "a": "A"},
    {"q": "水的沸点在标准大气压下是多少摄氏度？\nA. 50 B. 80 C. 100 D. 120", "a": "C"},
    {"q": "哪种动物是哺乳动物？\nA. 鳄鱼 B. 鲸鱼 C. 金鱼 D. 蜥蜴", "a": "B"},
    {"q": "地球绕太阳一圈大约是多久？\nA. 一天 B. 一个月 C. 一年 D. 一世纪", "a": "C"},
    {"q": "人体最大的器官是？\nA. 心脏 B. 肝脏 C. 皮肤 D. 大脑", "a": "C"},
    {"q": "中国最长的河流是？\nA. 黄河 B. 长江 C. 珠江 D. 黑龙江", "a": "B"},
    {"q": "钢铁是怎样炼成的？这本书的作者是？\nA. 托尔斯泰 B. 奥斯特洛夫斯基 C. 高尔基 D. 普希金", "a": "B"},
    {"q": "光年是什么的单位？\nA. 时间 B. 距离 C. 速度 D. 亮度", "a": "B"},
    {"q": "DNA的全称中文翻译是？\nA. 核糖核酸 B. 脱氧核糖核酸 C. 氨基酸 D. 蛋白质", "a": "B"},
    {"q": "以下哪位不是唐代诗人？\nA. 李白 B. 杜甫 C. 白居易 D. 苏轼", "a": "D"},
]

SYSTEM = "你是一个推理测试助手。请选择正确答案，只输出字母选项（如 A、B、C 或 D），不要解释。"


def extract_choice(text):
    text = text.strip()
    m = re.search(r'\b([A-D])\b', text.upper())
    return m.group(1) if m else text[:1].upper()


def run(config=None):
    config = config or load_config()
    client = get_client(config)
    model = config["api"]["model"]

    print_header("Logic & Common-Sense Reasoning")

    logic_correct = 0
    for i, q in enumerate(LOGIC_QUESTIONS):
        resp = chat(client, model, [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": q["q"]},
        ], max_tokens=50, temperature=0.0)
        pred = extract_choice(resp)
        ok = pred == q["a"]
        if ok:
            logic_correct += 1
        print(f"  [{'✓' if ok else '✗'}] Logic Q{i+1}: expected={q['a']}, got={pred}")

    cs_correct = 0
    for i, q in enumerate(COMMON_SENSE):
        resp = chat(client, model, [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": q["q"]},
        ], max_tokens=50, temperature=0.0)
        pred = extract_choice(resp)
        ok = pred == q["a"]
        if ok:
            cs_correct += 1
        print(f"  [{'✓' if ok else '✗'}] CS Q{i+1}: expected={q['a']}, got={pred}")

    logic_acc = logic_correct / len(LOGIC_QUESTIONS) * 100
    cs_acc = cs_correct / len(COMMON_SENSE) * 100
    total_acc = (logic_correct + cs_correct) / (len(LOGIC_QUESTIONS) + len(COMMON_SENSE)) * 100

    print(f"\n  Logic: {logic_correct}/{len(LOGIC_QUESTIONS)} = {logic_acc:.1f}%")
    print(f"  Common Sense: {cs_correct}/{len(COMMON_SENSE)} = {cs_acc:.1f}%")
    print(f"  Overall: {total_acc:.1f}%")

    return {
        "logic": {"correct": logic_correct, "total": len(LOGIC_QUESTIONS), "accuracy": round(logic_acc, 1)},
        "common_sense": {"correct": cs_correct, "total": len(COMMON_SENSE), "accuracy": round(cs_acc, 1)},
        "overall_accuracy": round(total_acc, 1),
    }


if __name__ == "__main__":
    import json
    print(json.dumps(run(), indent=2, ensure_ascii=False))
