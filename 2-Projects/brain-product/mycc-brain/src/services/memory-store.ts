import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export interface MemoryFact {
  namespace: string;
  content: string;
  keywords: string[];
  dimension: string;
  tags?: string[];
  star?: number;
}

interface ParsedCategory {
  header: string;       // e.g. "[project/技术-飞书]"
  items: string[];      // 每行原始文本
}

/** 解析 memory-items.md 为按命名空间分组的结构 */
export function parseMemoryItems(dataDir: string): ParsedCategory[] {
  const filePath = join(dataDir, "memory-items.md");
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const categories: ParsedCategory[] = [];
  let current: ParsedCategory | null = null;

  for (const line of content.split("\n")) {
    const catMatch = line.match(/^###?\s*\[(.+?)\]/);
    if (catMatch) {
      current = { header: line, items: [] };
      categories.push(current);
    } else if (current && line.startsWith("- ")) {
      current.items.push(line);
    }
  }

  return categories;
}

/** 检查同命名空间内是否有潜在矛盾 */
function checkConflict(existing: string[], newFact: MemoryFact): boolean {
  if (!newFact.tags?.length) return false;

  for (const item of existing) {
    // 提取已有 item 的 #tag
    const existingTags = item.match(/#(\S+)/g)?.map(t => t.slice(1)) ?? [];
    if (existingTags.length === 0) continue;

    const newTags = newFact.tags ?? [];
    const intersection = newTags.filter(t => existingTags.includes(t));
    const union = [...new Set([...newTags, ...existingTags])];

    // 关键词交集 >= 50% 判定为潜在矛盾
    if (union.length > 0 && intersection.length / union.length >= 0.5) {
      // 进一步检查：同 tag 下内容是否有数值/路径/版本差异
      const hasNumericDiff = /\d/.test(item) && /\d/.test(newFact.content);
      if (hasNumericDiff) return true;
    }
  }
  return false;
}

/** 将提取的事实追加到 memory-items.md */
export function appendFacts(dataDir: string, facts: MemoryFact[]): { written: number; conflicts: number } {
  if (facts.length === 0) return { written: 0, conflicts: 0 };

  const filePath = join(dataDir, "memory-items.md");
  const today = new Date().toISOString().slice(0, 10);

  // 读取或创建文件
  let content = "";
  if (existsSync(filePath)) {
    content = readFileSync(filePath, "utf-8");
  }

  const categories = parseMemoryItems(dataDir);
  let conflicts = 0;
  const appendLines: Map<string, string[]> = new Map();

  for (const fact of facts) {
    const ns = `[${fact.namespace}]`;
    const star = "★".repeat(fact.star ?? 2);
    const tagStr = fact.tags?.map(t => `#${t}`).join(" ") ?? "";

    // 查找已有类别
    const existing = categories.find(c => c.header.includes(ns));
    const existingItems = existing?.items ?? [];

    // 矛盾检测
    const isConflict = checkConflict(existingItems, fact);
    const conflictMark = isConflict ? " [?conflict]" : "";
    if (isConflict) conflicts++;

    const line = `- ${star} ${fact.content} [${today}]${tagStr ? " " + tagStr : ""}${conflictMark}`;

    if (!appendLines.has(ns)) appendLines.set(ns, []);
    appendLines.get(ns)!.push(line);
  }

  // 追加到文件
  let newContent = content;
  for (const [ns, lines] of appendLines) {
    const nsHeader = `### ${ns}`;
    if (newContent.includes(ns)) {
      // 在已有类别末尾追加
      const nsIdx = newContent.indexOf(ns);
      // 找到该类别的下一个类别或文件末尾
      const afterNs = newContent.indexOf("\n###", nsIdx + ns.length);
      const insertPos = afterNs === -1 ? newContent.length : afterNs;
      const insertStr = "\n" + lines.join("\n");
      newContent = newContent.slice(0, insertPos) + insertStr + newContent.slice(insertPos);
    } else {
      // 新建类别
      newContent += `\n\n${nsHeader}\n${lines.join("\n")}`;
    }
  }

  writeFileSync(filePath, newContent, "utf-8");
  return { written: facts.length, conflicts };
}

/** 验证 fact 的格式合规性 */
export function validateFact(fact: MemoryFact): string | null {
  if (!fact.namespace || !fact.namespace.includes("/")) {
    return `invalid namespace: ${fact.namespace}`;
  }
  if (!fact.content || fact.content.length < 4) {
    return `content too short: ${fact.content}`;
  }
  if (!fact.keywords || fact.keywords.length === 0) {
    return `no keywords`;
  }
  const validDimensions = ["个人信息", "偏好变更", "事件事实", "时间数据", "更新/修正", "助手信息"];
  if (!validDimensions.includes(fact.dimension)) {
    return `invalid dimension: ${fact.dimension}`;
  }
  return null;
}
