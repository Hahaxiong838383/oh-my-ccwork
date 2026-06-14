/**
 * 向量索引全量重建脚本
 *
 * 解析 memory-items.md → 逐条 embed → 写入 memory-vectors.json
 *
 * 用法：
 *   npx tsx scripts/rebuild-index.ts [mycc根目录]
 *
 * 前置条件：
 *   1. Ollama 已启动：ollama serve
 *   2. 模型已拉取：ollama pull qwen3-embedding:0.6b
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import {
  embed,
  isOllamaReady,
  loadVectorIndex,
  saveVectorIndex,
  type VectorItem,
  type VectorIndex,
} from "../services/embedding.js";

// ============================================================
// memory-items.md 解析
// ============================================================

interface ParsedItem {
  category: string;
  text: string;
  stars: number;
  id: string;
}

interface CliOptions {
  cwd: string;
  force: boolean;
  strict: boolean;
}

interface RebuildStats {
  total: number;
  reused: number;
  embedded: number;
  failedKept: number;
  missing: number;
}

const MODEL = "qwen3-embedding:0.6b";
const DIMENSIONS = 512;

/** 从 memory-items.md 解析所有 item */
function parseMemoryItems(filePath: string): ParsedItem[] {
  if (!existsSync(filePath)) {
    console.error(`文件不存在：${filePath}`);
    return [];
  }

  const content = readFileSync(filePath, "utf-8");
  const sections = content.split(/^## /m).filter(Boolean);
  const items: ParsedItem[] = [];

  for (const section of sections) {
    const headerMatch = section.match(/^\[([^\]]+)\]/);
    if (!headerMatch) continue;
    const category = headerMatch[1];

    // 跳过注释块（以 > 开头的行）
    const lines = section.split("\n").filter((l) => l.startsWith("- "));

    for (const line of lines) {
      // 提取纯文本（去掉标记符号）
      const text = line
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

      if (text.length < 5) continue;

      const starCount = (line.match(/★/g) || []).length;

      // 用内容哈希作为 ID（简单稳定）
      const id = simpleHash(`${category}:${text}`);

      items.push({ category, text, stars: starCount, id });
    }
  }

  return items;
}

/** 简单字符串哈希（djb2） */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

// ============================================================
// 主流程
// ============================================================

function defaultCwd(): string {
  return path.resolve(import.meta.dirname || new URL(".", import.meta.url).pathname, "../../../../..");
}

function parseArgs(argv: string[]): CliOptions {
  let cwd = defaultCwd();
  let force = false;
  let strict = false;

  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
    } else if (arg === "--strict") {
      strict = true;
    } else {
      cwd = arg;
    }
  }

  return { cwd, force, strict };
}

function appendVectorAlert(cwd: string, reason: string, now: string): void {
  const recentEventsPath = path.join(cwd, "0-System/RECENT_EVENTS.md");
  appendFileSync(
    recentEventsPath,
    `\n- ⚠️ [向量系统告警 ${now}] memory 向量重建:${reason},语义召回降级,请修复`,
    "utf-8",
  );
}

function writeVectorHealth(
  cwd: string,
  now: string,
  stats: RebuildStats,
  ollamaReady: boolean,
): void {
  const vectored = stats.total - stats.missing;
  const coverage = stats.total === 0 ? 1 : vectored / stats.total;
  const health = {
    last_run: now,
    last_success: ollamaReady && stats.missing === 0,
    total: stats.total,
    vectored,
    coverage,
    missing: stats.missing,
    ollama_ready: ollamaReady,
    model: MODEL,
    dimensions: DIMENSIONS,
  };

  writeFileSync(
    path.join(cwd, "0-System/vector-health.json"),
    `${JSON.stringify(health, null, 2)}\n`,
    "utf-8",
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cwd = options.cwd;
  const memPath = path.join(cwd, "0-System/memory-items.md");

  console.log("🔍 检查 Ollama 状态...");
  const ready = await isOllamaReady();
  if (!ready) {
    console.error("❌ Ollama 未就绪。请确保：");
    console.error("   1. ollama serve 已启动");
    console.error("   2. ollama pull qwen3-embedding:0.6b 已完成");
  } else {
    console.log("✅ Ollama 就绪");
  }

  console.log(`📖 解析 ${memPath}...`);
  const parsed = parseMemoryItems(memPath);
  console.log(`   找到 ${parsed.length} 条 item`);

  const oldIndex = loadVectorIndex(cwd);
  const oldItems = new Map(oldIndex.items.map((item) => [item.id, item]));
  const vectorItems: VectorItem[] = [];
  const stats: RebuildStats = {
    total: parsed.length,
    reused: 0,
    embedded: 0,
    failedKept: 0,
    missing: 0,
  };

  if (parsed.length === 0) {
    console.log("⚠️ 无 item 可索引");
  } else {
    console.log(options.force ? "🧠 开始强制生成 embedding..." : "🧠 开始增量生成 embedding...");
  }

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    const oldItem = oldItems.get(item.id);

    if (!options.force && oldItem && oldItem.text === item.text) {
      vectorItems.push({
        id: item.id,
        category: item.category,
        text: item.text,
        stars: item.stars,
        vector: oldItem.vector,
      });
      stats.reused++;
    } else {
      const vec = ready ? await embed(item.text) : null;

      if (vec) {
        vectorItems.push({
          id: item.id,
          category: item.category,
          text: item.text,
          stars: item.stars,
          vector: vec,
        });
        stats.embedded++;
      } else if (oldItem) {
        // 数据安全红线：当前条目 embed 失败时，绝不丢弃已有向量。
        vectorItems.push({
          id: item.id,
          category: item.category,
          text: item.text,
          stars: item.stars,
          vector: oldItem.vector,
        });
        stats.failedKept++;
      } else {
        stats.missing++;
      }
    }

    // 进度显示（每 10 条或最后一条）
    if ((i + 1) % 10 === 0 || i === parsed.length - 1) {
      const pct = Math.round(((i + 1) / parsed.length) * 100);
      process.stdout.write(`\r   进度：${i + 1}/${parsed.length} (${pct}%)`);
    }
  }

  if (parsed.length > 0) {
    console.log(""); // 换行
  }

  const now = new Date().toISOString();
  const index: VectorIndex = {
    model: MODEL,
    dimensions: DIMENSIONS,
    updated_at: now,
    items: vectorItems,
  };

  console.log(`💾 写入索引（${vectorItems.length} 条）...`);
  saveVectorIndex(cwd, index);
  writeVectorHealth(cwd, now, stats, ready);

  if (!ready) {
    appendVectorAlert(cwd, "Ollama不可用", now);
  } else if (stats.missing > 0) {
    appendVectorAlert(cwd, `${stats.missing}条新记忆embed失败`, now);
  }

  const indexPath = path.join(cwd, "0-System/memory-vectors.json");
  const statsFile = readFileSync(indexPath);
  const sizeKB = Math.round(statsFile.length / 1024);
  const coverage = stats.total === 0 ? 1 : vectorItems.length / stats.total;
  console.log(`✅ 完成！索引大小：${sizeKB} KB`);
  console.log(`   路径：${indexPath}`);
  console.log(
    `   total=${stats.total} reused=${stats.reused} embedded=${stats.embedded} failedKept=${stats.failedKept} missing=${stats.missing} coverage=${coverage.toFixed(4)}`,
  );

  if (options.strict && (!ready || stats.missing > 0)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ 执行失败：", err);
  process.exit(1);
});
