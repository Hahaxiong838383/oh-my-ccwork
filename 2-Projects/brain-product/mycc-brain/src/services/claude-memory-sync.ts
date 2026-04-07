/**
 * claude-memory-sync.ts — Claude Code 记忆 → Brain memory-items 格式转换
 *
 * 扫描 claude-memory/ 目录的 .md 文件，解析 frontmatter，
 * 按段落拆分正文，转换为 brain 的 memory-items-claude.md 格式。
 * 幂等：基于所有源文件 mtime 最大值判断是否需要重新生成。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

// ─── Types ───

interface ClaudeMemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string; // user | project | feedback | reference
  body: string;
}

interface ConvertedItem {
  namespace: string;
  content: string;
  star: number;
  tags: string[];
}

export interface ClaudeSyncResult {
  converted: number;
  filesProcessed: number;
  skipped: boolean;
  outputPath: string;
}

// ─── Frontmatter 解析 ───

function parseFrontmatter(content: string): { name: string; description: string; type: string; body: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { name: "", description: "", type: "", body: content.trim() };
  }
  const fmBlock = fmMatch[1];
  const body = fmMatch[2].trim();
  const name = fmBlock.match(/name:\s*(.+)/)?.[1]?.trim() ?? "";
  const description = fmBlock.match(/description:\s*(.+)/)?.[1]?.trim() ?? "";
  const type = fmBlock.match(/type:\s*(.+)/)?.[1]?.trim() ?? "";
  return { name, description, type, body };
}

// ─── Type → Namespace 映射 ───

function typeToNamespace(type: string): string {
  switch (type) {
    case "user": return "user/claude-cc";
    case "project": return "project/claude-cc";
    case "feedback": return "user/claude-feedback";
    case "reference": return "project/claude-ref";
    default: return "project/claude-cc";
  }
}

function typeToStar(type: string): number {
  switch (type) {
    case "user":
    case "feedback":
      return 3;
    case "project":
      return 2;
    case "reference":
      return 1;
    default:
      return 2;
  }
}

// ─── 标签提取 ───

function extractTags(name: string): string[] {
  const tags: string[] = [];
  // 从 name 提取中文关键词（2-6字）
  const cjk = name.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,6}/g);
  if (cjk) tags.push(...cjk.slice(0, 3));
  // 从 name 提取英文关键词
  const words = name.match(/[a-zA-Z][\w-]{2,}/g);
  if (words) tags.push(...words.filter(w => w.length > 2).slice(0, 2));
  return tags;
}

// ─── 段落拆分 ───

function splitIntoParagraphs(body: string): string[] {
  // 先按 ## 标题拆分
  const sections = body.split(/\n(?=##\s)/);
  const paragraphs: string[] = [];

  for (const section of sections) {
    // 去掉标题行（如有），保留内容
    const lines = section.trim().split("\n");
    const titleMatch = lines[0]?.match(/^##\s+(.+)/);
    const prefix = titleMatch ? `[${titleMatch[1]}] ` : "";
    const content = titleMatch ? lines.slice(1).join("\n").trim() : section.trim();

    if (!content) continue;

    // 再按双换行拆段
    const subParagraphs = content.split(/\n{2,}/);
    for (const p of subParagraphs) {
      const trimmed = p.trim();
      if (!trimmed || trimmed.length < 8) continue;
      // 压缩为单行（去掉换行）
      const oneLine = trimmed.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      // 截断超长段落（保留前 200 字）
      const capped = oneLine.length > 200 ? oneLine.slice(0, 200) + "…" : oneLine;
      paragraphs.push(prefix + capped);
    }
  }

  return paragraphs;
}

// ─── 主转换逻辑 ───

function convertFile(file: ClaudeMemoryFile, today: string): ConvertedItem[] {
  // 跳过无 frontmatter 的文件（type 为空 = 没有有效的 YAML frontmatter）
  if (!file.type) return [];
  const namespace = typeToNamespace(file.type);
  const star = typeToStar(file.type);
  const tags = extractTags(file.name);
  const paragraphs = splitIntoParagraphs(file.body);

  return paragraphs.map(content => ({
    namespace,
    content,
    star,
    tags,
  }));
}

function buildOutputContent(itemsByNs: Map<string, ConvertedItem[]>, today: string): string {
  const lines: string[] = [
    "# Claude Code 记忆（自动转换，勿手动编辑）",
    `# 生成时间: ${today}`,
    "",
  ];

  for (const [ns, items] of itemsByNs) {
    lines.push(`### [${ns}]`);
    for (const item of items) {
      const starStr = "★".repeat(item.star);
      const tagStr = item.tags.length > 0 ? " " + item.tags.map(t => `#${t}`).join(" ") : "";
      lines.push(`- ${starStr} ${item.content} [${today}]${tagStr} [src:claude-sync]`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── 公开 API ───

export function syncClaudeMemory(dataDir: string): ClaudeSyncResult {
  const claudeMemDir = join(dataDir, "claude-memory");
  const outputPath = join(dataDir, "memory-items-claude.md");

  if (!existsSync(claudeMemDir)) {
    return { converted: 0, filesProcessed: 0, skipped: true, outputPath };
  }

  // 收集所有 .md 文件（跳过 MEMORY.md）
  const mdFiles = readdirSync(claudeMemDir).filter(
    f => f.endsWith(".md") && f !== "MEMORY.md"
  );

  if (mdFiles.length === 0) {
    return { converted: 0, filesProcessed: 0, skipped: true, outputPath };
  }

  // 幂等检查：所有源文件 mtime 最大值 vs 输出文件 mtime
  let maxMtime = 0;
  for (const f of mdFiles) {
    const st = statSync(join(claudeMemDir, f));
    if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
  }

  if (existsSync(outputPath)) {
    const outMtime = statSync(outputPath).mtimeMs;
    if (outMtime >= maxMtime) {
      return { converted: 0, filesProcessed: mdFiles.length, skipped: true, outputPath };
    }
  }

  // 解析并转换
  const today = new Date().toISOString().slice(0, 10);
  const itemsByNs = new Map<string, ConvertedItem[]>();
  let totalConverted = 0;

  for (const filename of mdFiles) {
    const content = readFileSync(join(claudeMemDir, filename), "utf-8");
    const { name, description, type, body } = parseFrontmatter(content);

    if (!body || body.length < 10) continue;

    const file: ClaudeMemoryFile = { filename, name: name || filename, description, type, body };
    const items = convertFile(file, today);

    for (const item of items) {
      const existing = itemsByNs.get(item.namespace) ?? [];
      existing.push(item);
      itemsByNs.set(item.namespace, existing);
    }
    totalConverted += items.length;
  }

  // 写入输出文件（全量重写）
  const output = buildOutputContent(itemsByNs, today);
  writeFileSync(outputPath, output, "utf-8");

  return { converted: totalConverted, filesProcessed: mdFiles.length, skipped: false, outputPath };
}
