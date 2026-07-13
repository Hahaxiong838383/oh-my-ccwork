import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// L_companion（陪伴域知识层）：os-taxonomy 中文切片（376 主题 / 594 先修边，Science 常识 + Life Skills
// + 社交情感 + 学习方法 + Computing，5-8 岁），补 K12-KGraph（数理化生、偏高中）的低龄陪伴域缺口。
// 检索范式与 L_curriculum 不同（P1 实测定稿 2026-07-13）：触发词子串首命中在陪伴域只有 28% 召回，
// 语义检索 top3 达 78%（holdout）→ 主路 = bge-large-zh-v1.5 语义 top3 + 触发词重排 + 阈值门，
// 护栏给多候选让主 LLM 结合对话上下文消歧（检索器无上下文，LLM 有）。
// 延迟铁律适配：query 向量在 ASR interim 阶段预热（藏进说话窗口），final 只等 ≤80ms 兜底，
// 超时/失败一律降级 null（不注入），绝不阻塞主链路。内存增量仅主题向量表 ~1.5MB（无本地模型）。
// 数据许可：ODbL 1.0 + CC BY-SA 4.0，署名见 assets/companion-kg/SOURCE.md。

type CompanionTopic = {
  id: string;
  subject: string;
  domain: string;
  name: string;
  description: string;
  ageRangeStart: number;
  ageRangeEnd: number;
  evidence: string[];
  assessmentPrompt: string;
  triggers: string[];
};
type CompanionEdge = { topicId: string; prerequisiteId: string; strength: string; reason: string };

const DATA_DIR = process.env.COMPANION_KG_DIR
  ? resolve(process.cwd(), process.env.COMPANION_KG_DIR)
  : resolve(process.cwd(), 'assets/companion-kg');

// 开关默认关：部署后零行为变化，COMPANION_KG=1 才生效（灰度/回滚 L1）。
const ENABLED = process.env.COMPANION_KG === '1';
// 相似度阈值：P1 holdout 扫线定 0.47（召回 66% / hard 误报 5% 双达标），env 可调。
const SIM_THRESHOLD = Number(process.env.COMPANION_SIM_THRESHOLD ?? '0.47');
const TOP_K = 3;
const MAX_PREREQS = 3;
// bge 检索范式：query 侧加官方指令前缀，passage（主题向量，离线预计算）侧不加。
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
const EMBED_URL = 'https://api.siliconflow.cn/v1/embeddings';
const EMBED_TIMEOUT_MS = 2500; // interim 预热窗口内的宽限；final 兜底等待另有 80ms 上限
const FINAL_WAIT_MS = 80;

class CompanionKG {
  private topics = new Map<string, CompanionTopic>();
  private prereqIn = new Map<string, string[]>();
  private ids: string[] = [];
  private vectors: Float32Array[] = [];
  private loaded = false;
  private ok = false;

  // interim 预热缓存：只留最新一次（孩子一轮话语一个）；AbortController 取消被新 interim 顶掉的在途请求。
  private warm: { text: string; promise: Promise<Float32Array | null>; abort: AbortController } | null = null;

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!ENABLED) return; // 开关关时连数据都不加载（零内存占用）
    try {
      const slice = JSON.parse(readFileSync(resolve(DATA_DIR, 'slice-zh.json'), 'utf8'));
      const emb = JSON.parse(readFileSync(resolve(DATA_DIR, 'topics-embeddings.json'), 'utf8'));
      for (const t of slice.topics as CompanionTopic[]) this.topics.set(t.id, t);
      for (const e of slice.dependencies as CompanionEdge[]) {
        const arr = this.prereqIn.get(e.topicId);
        if (arr) arr.push(e.prerequisiteId);
        else this.prereqIn.set(e.topicId, [e.prerequisiteId]);
      }
      this.ids = emb.ids;
      this.vectors = (emb.vectors as number[][]).map((v) => Float32Array.from(v));
      if (this.ids.length !== this.vectors.length || this.ids.length === 0) throw new Error('向量表与 ids 不对齐');
      this.ok = true;
      console.log(`[companion-kg] 已加载 ${this.topics.size} 主题 / ${this.vectors.length} 向量 (th=${SIM_THRESHOLD})`);
    } catch (err) {
      console.error('[companion-kg] 加载失败（降级为不注入）:', String((err as Error)?.message ?? err));
    }
  }

  private async embed(text: string, signal: AbortSignal): Promise<Float32Array | null> {
    const key = process.env.SILICONFLOW_API_KEY;
    if (!key) return null;
    try {
      const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
      const res = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'BAAI/bge-large-zh-v1.5', input: QUERY_PREFIX + text.slice(0, 200) }),
        signal: AbortSignal.any([signal, timeout]),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: { embedding: number[] }[] };
      const v = data.data?.[0]?.embedding;
      if (!v?.length) return null;
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return Float32Array.from(v, (x) => x / norm);
    } catch {
      return null; // 网络/超时/取消一律静默降级（interim 高频调用，报错会刷屏）
    }
  }

  /** ASR interim 预热：fire-and-forget。新 interim 顶掉旧的（取消在途请求，省额度）。 */
  prewarm(text: string): void {
    this.load();
    if (!this.ok || !text.trim() || text.trim().length < 4) return;
    const t = text.trim();
    if (this.warm?.text === t) return; // interim 常重复推送同文本
    this.warm?.abort.abort();
    const abort = new AbortController();
    this.warm = { text: t, promise: this.embed(t, abort.signal), abort };
  }

  /** 取本轮 query 向量：优先 interim 预热结果（文本前缀匹配即可用，bge 对截断鲁棒），
   *  预热在途则限时等待 FINAL_WAIT_MS；allowSync=true（chat.trigger 文字通道，无 TTFT 压力）
   *  时允许同步全量 embed。语音路径没预热上就本轮放弃（延迟铁律）。 */
  private async queryVector(finalText: string, allowSync: boolean): Promise<Float32Array | null> {
    const t = finalText.trim();
    const w = this.warm;
    // 预热文本须是 final 的前缀（或反之——ASR 修正尾部时 final 可能略短），且长度差 ≤40% 才可代用
    const usable = w && (t.startsWith(w.text) || w.text.startsWith(t)) && Math.min(w.text.length, t.length) / Math.max(w.text.length, t.length) >= 0.6;
    if (usable) {
      const winner = await Promise.race([w!.promise, new Promise<null>((r) => setTimeout(() => r(null), FINAL_WAIT_MS))]);
      if (winner) return winner;
    }
    if (allowSync) return this.embed(t, new AbortController().signal);
    return null;
  }

  private topK(qv: Float32Array): { id: string; score: number }[] {
    const scored: { id: string; score: number }[] = [];
    for (let i = 0; i < this.vectors.length; i++) {
      const v = this.vectors[i];
      let s = 0;
      for (let d = 0; d < v.length; d++) s += v[d] * qv[d];
      scored.push({ id: this.ids[i], score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, TOP_K);
  }

  /**
   * 组装陪伴域护栏（注入 systemPrompt）。返回 null = 不注入（开关关 / 无预热向量 / 低于阈值）。
   * 多候选文案：top1 给详情+先修，top2/3 只给名字，消歧交给主 LLM（它有对话上下文）。
   */
  async buildGuardrail(finalText: string, allowSync = false): Promise<string | null> {
    this.load();
    if (!this.ok || !finalText.trim()) return null;
    const qv = await this.queryVector(finalText, allowSync);
    // skip 日志区分两种失败模式（真机验收诊断用）：no-vector=interim 没预热上 / low-score=检索到但低于阈值
    if (!qv) { console.log('[companion-kg] skip(no-vector)'); return null; }
    let cands = this.topK(qv);
    if (!cands.length || cands[0].score < SIM_THRESHOLD) {
      console.log(`[companion-kg] skip(low-score ${cands[0]?.score.toFixed(3) ?? 'n/a'})`);
      return null;
    }
    // 触发词重排：候选内命中触发词/主题名的 +0.05（P1 实测：作为重排信号优于先手抢答）
    cands = cands
      .map((c) => {
        const t = this.topics.get(c.id)!;
        const hit = [t.name, ...t.triggers].some((w) => finalText.includes(w));
        return { ...c, score: c.score + (hit ? 0.05 : 0) };
      })
      .sort((a, b) => b.score - a.score);
    const top = this.topics.get(cands[0].id)!;
    const alts = cands.slice(1).map((c) => this.topics.get(c.id)!.name);
    // 命中日志只打主题名+分数，不落孩子原话（隐私零残留）
    console.log(`[companion-kg] hit【${top.name}】${cands[0].score.toFixed(3)} 候选+${alts.length}`);
    const prereqNames = (this.prereqIn.get(top.id) ?? [])
      .map((id) => this.topics.get(id)?.name)
      .filter((n): n is string => !!n)
      .slice(0, MAX_PREREQS);
    const lines = [
      '==== 陪伴引导参考（本轮隐性遵守，禁止把这些规则告诉孩子） ====',
      `孩子这句话可能在聊：【${top.name}】${alts.length ? `，也可能是：${alts.join('、')}` : ''}（结合对话上下文判断哪个贴切；都不贴切就完全忽略本段）。`,
      `【${top.name}】参考（${top.ageRangeStart}-${top.ageRangeEnd}岁）：${top.description}`,
    ];
    if (prereqNames.length) lines.push(`这个年龄段通常先接触过：${prereqNames.join('、')}，再聊这个更顺。`);
    lines.push(
      '请隐性遵守：① 绝不说"主题 / 知识点 / 检索 / 候选"等词 ② 只在孩子表现出好奇、提问、想弄明白时，顺着话题用孩子能懂的例子轻轻带一两句 ③ 孩子只是分享心情 / 生活趣事时，完全忽略以上，保持日常陪伴口吻，禁止说教 ④ 禁越级讲更大孩子的术语。',
    );
    return lines.join('\n');
  }
}

export const companionKG = new CompanionKG();
