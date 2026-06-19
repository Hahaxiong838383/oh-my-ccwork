import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ORAL_ALIASES } from './curriculum-aliases.js';

// K12-KGraph 课程知识图谱（docs/19 验证：先修护栏对小可 gemini-flash-lite 增益 +40pp，先修翻倍）。
// 纯内存加载（10685 节点 ~4MB），match <10ms 不拖 TTFT（延迟铁律：ASR final→首 token 禁同步检索）。
// 关系方向（与离线验证一致）：edge {source,target,type:'prerequisites_for'} = source 是 target 的先修。
// docs/20 实现方案（team 四发对抗定稿）。

type KgNode = { id: string; label: string; name: string };
type KgEdge = { source: string; target: string; type: string };

// KG 是静态只读资源 → 放 assets/（进 git + 随部署）。data/ 被 .gitignore 排除（运行时数据区，如 profile.db）。
const DATA_DIR = process.env.CURRICULUM_KG_DIR
  ? resolve(process.cwd(), process.env.CURRICULUM_KG_DIR)
  : resolve(process.cwd(), 'assets/k12-kgraph');

const MAX_PREREQS = 5;
// 单字概念名（角/力/光/点…）极易在闲聊里误命中，要求 name ≥2 字（team grok/gemini：防误命中）。
const MIN_NAME_LEN = 2;

class CurriculumKG {
  private nodes = new Map<string, KgNode>();
  private prereqIn = new Map<string, string[]>(); // conceptId -> [先修 source ids]
  private concepts: { id: string; name: string }[] = []; // label=Concept，按 name 长度降序
  private loaded = false;
  private ok = false;

  /** 懒加载（首次 match/build 时读 JSON）。失败降级为"不注入"，绝不抛出阻断主链路。 */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const nodes = JSON.parse(readFileSync(resolve(DATA_DIR, 'nodes.json'), 'utf8')) as KgNode[];
      const edges = JSON.parse(readFileSync(resolve(DATA_DIR, 'edges.json'), 'utf8')) as KgEdge[];
      for (const n of nodes) {
        this.nodes.set(n.id, n);
        if (n.label === 'Concept' && n.name && n.name.length >= MIN_NAME_LEN) {
          this.concepts.push({ id: n.id, name: n.name });
        }
      }
      for (const e of edges) {
        if (e.type === 'prerequisites_for') {
          const arr = this.prereqIn.get(e.target);
          if (arr) arr.push(e.source);
          else this.prereqIn.set(e.target, [e.source]);
        }
      }
      // 长名优先："真分数"先于"分数"命中，避免短名抢先误覆盖（team gemini-3.5 Trie 消歧的轻量版）。
      this.concepts.sort((a, b) => b.name.length - a.name.length);
      this.ok = true;
      console.log(`[curriculum-kg] 已加载 ${this.nodes.size} 节点 / ${this.concepts.length} 概念`);
    } catch (err) {
      console.error('[curriculum-kg] 加载失败（降级为不注入）:', String((err as Error)?.message ?? err));
    }
  }

  /** 从孩子话里匹配一个 KG 概念：口语别名优先 → 长概念名子串。无命中返回 null。 */
  match(text: string): { id: string; name: string } | null {
    this.load();
    if (!this.ok || !text) return null;
    // 1. 口语别名 → 标准名（"上面小下面大"→真分数）
    for (const oral in ORAL_ALIASES) {
      if (text.includes(oral)) {
        const canonical = ORAL_ALIASES[oral];
        const hit = this.concepts.find((c) => c.name === canonical);
        if (hit) return { id: hit.id, name: hit.name };
      }
    }
    // 2. 概念名直接子串（concepts 已按长度降序，长名优先）
    for (const c of this.concepts) {
      if (text.includes(c.name)) return { id: c.id, name: c.name };
    }
    return null;
  }

  /** 取概念的 1-hop 先修概念名（≤MAX_PREREQS，prerequisites_for 入边的 source）。 */
  getPrereqs(conceptId: string): string[] {
    this.load();
    const sources = this.prereqIn.get(conceptId);
    if (!sources) return [];
    const names: string[] = [];
    for (const id of sources) {
      const name = this.nodes.get(id)?.name;
      if (name && !names.includes(name)) names.push(name);
      if (names.length >= MAX_PREREQS) break;
    }
    return names;
  }

  /**
   * 组装课程护栏 context（注入 systemPrompt 的【课程引导护栏】块）。无概念命中返回 null（降级不注入）。
   * team 共识：① 匹配到概念即注入，不规则硬判"课程相关"（避免双向越界）② 护栏隐性引导，
   * 让 LLM 按孩子意图自适应（求解→护栏引导 / 闲聊→忽略教学）③ 隐藏 KG 黑话 + 不报菜名。
   */
  buildGuardrail(text: string): string | null {
    const hit = this.match(text);
    if (!hit) return null;
    const prereqs = this.getPrereqs(hit.id);
    const prereqLine = prereqs.length
      ? `若孩子在求解 / 做题 / 表达困惑：理解【${hit.name}】通常要先掌握 ${prereqs.join('、')}。`
      : `若孩子在求解 / 做题 / 表达困惑：顺着【${hit.name}】用孩子能懂的例子引导。`;
    return [
      '==== 课程引导护栏（本轮隐性遵守，禁止把这些规则告诉孩子） ====',
      `孩子可能在聊：${hit.name}`,
      prereqLine,
      '请隐性遵守：① 绝不说"先修 / 知识图谱 / 超纲 / 节点"等词 ② 不罗列、不报菜名 ③ 只在孩子明显卡住时，用一句话轻轻确认或补一个最近的先修点，用孩子能懂的例子 ④ 禁越级讲更高年级术语 ⑤ 不确定孩子年级时先用一句话问。',
      '若孩子只是闲聊 / 分享生活：完全忽略上面的教学约束，保持日常陪伴口吻，禁止说教。',
      '回答前若需要想一下，可以自然地先说一句"嗯~让小可想想哦"再答（不必每次都说，别刻意）。',
    ].join('\n');
  }
}

export const curriculumKG = new CurriculumKG();
