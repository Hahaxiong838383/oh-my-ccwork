/**
 * B 套 memory-items.md item 解析。
 * rebuild-index 与 memory-db 必须共用这里，保证向量索引 id 与 SQLite items id 逐字节一致。
 */

export interface ParsedMemoryItemLine {
  id: string;
  category: string;
  text: string;
  content: string;
  stars: number;
  scope: string;
  write_date: string | null;
  event_date: string | null;
  chain_type: string | null;
  chain_ref: string | null;
}

/** 简单字符串哈希（djb2），B 套 id = simpleHash(category:text)。 */
export function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

/** 提取用于 embedding 与 id 的纯文本；改这里会同时影响 rebuild-index 和 memory-db。 */
export function normalizeMemoryItemText(line: string): string {
  return line
    .replace(/^-\s*/, "")
    .replace(/★+\s*/g, "")
    .replace(/\[\d{4}-\d{2}-\d{2}\]/g, "")
    .replace(/\[event:\d{4}-\d{2}-\d{2}\]/g, "")
    .replace(/→(Δ|updates|supersedes|extends):[^\s]*/g, "")
    .replace(/#\w+/g, "")
    .replace(/#base/g, "")
    .replace(/\[已废弃\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 从 memory-items.md 的单行解析 B 套完整元数据。 */
export function parseMemoryItemLine(line: string, category: string): ParsedMemoryItemLine | null {
  const text = normalizeMemoryItemText(line);
  if (text.length < 5) return null;

  const starCount = (line.match(/★/g) || []).length;
  const writeDateMatch = line.match(/(?<!\bevent:)\[(\d{4}-\d{2}-\d{2})\]/);
  const eventDateMatch = line.match(/\[event:(\d{4}-\d{2}-\d{2})\]/);

  let chainType: string | null = null;
  let chainRef: string | null = null;
  if (line.includes("#base")) {
    chainType = "base";
  } else if (line.includes("→Δ:")) {
    chainType = "delta";
    const match = line.match(/→Δ:(.+?)(?:\s*\[|\s*#|\s*$)/);
    chainRef = match ? match[1].trim() : null;
  } else if (line.includes("→supersedes:")) {
    chainType = "supersedes";
    const match = line.match(/→supersedes:(.+?)(?:\s*\[|\s*#|\s*$)/);
    chainRef = match ? match[1].trim() : null;
  } else if (line.includes("→updates:")) {
    chainType = "supersedes";
    const match = line.match(/→updates:(.+?)(?:\s*\[|\s*#|\s*$)/);
    chainRef = match ? match[1].trim() : null;
  } else if (line.includes("→extends:")) {
    chainType = "extends";
    const match = line.match(/→extends:(.+?)(?:\s*\[|\s*#|\s*$)/);
    chainRef = match ? match[1].trim() : null;
  }

  return {
    id: simpleHash(`${category}:${text}`),
    category,
    text,
    content: line.replace(/^-\s*/, "").trim(),
    stars: starCount,
    scope: category.split("/")[0] || "project",
    write_date: writeDateMatch ? writeDateMatch[1] : null,
    event_date: eventDateMatch ? eventDateMatch[1] : null,
    chain_type: chainType,
    chain_ref: chainRef,
  };
}
