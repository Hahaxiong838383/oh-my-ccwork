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
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import * as path from "path";
import { embed, isOllamaReady, loadVectorIndex, saveVectorIndex, } from "../services/embedding.js";
import { parseMemoryItemLine } from "../services/memory-item-parser.js";
const MODEL = "qwen3-embedding:0.6b";
const DIMENSIONS = 512;
const A_MEMORY_DIR = path.join(process.env.HOME || "", ".claude/projects/-Users-rayman-chen-mycc/memory");
const A_MEMORY_EXCLUDED = new Set(["MEMORY.md", "INDEX-full.md"]);
/** 从 memory-items.md 解析 B 套 item */
function parseMemoryItems(filePath) {
    if (!existsSync(filePath)) {
        console.error(`文件不存在：${filePath}`);
        return [];
    }
    const content = readFileSync(filePath, "utf-8");
    const sections = content.split(/^## /m).filter(Boolean);
    const items = [];
    for (const section of sections) {
        const headerMatch = section.match(/^\[([^\]]+)\]/);
        if (!headerMatch)
            continue;
        const category = headerMatch[1];
        // 跳过注释块（以 > 开头的行）
        const lines = section.split("\n").filter((l) => l.startsWith("- "));
        for (const line of lines) {
            const parsed = parseMemoryItemLine(line, category);
            if (!parsed)
                continue;
            items.push({
                category: parsed.category,
                text: parsed.text,
                stars: parsed.stars,
                id: parsed.id,
                source: "B",
            });
        }
    }
    return items;
}
function cleanFrontmatterValue(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1).trim();
        }
    }
    return trimmed;
}
function parseAFrontmatter(content) {
    if (!content.startsWith("---"))
        return null;
    const end = content.indexOf("\n---", 3);
    if (end === -1)
        return null;
    let description = "";
    let type = "";
    let inMetadata = false;
    for (const rawLine of content.slice(3, end).split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (!line.trim() || line.trimStart().startsWith("#"))
            continue;
        const topMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (topMatch) {
            const key = topMatch[1];
            inMetadata = key === "metadata";
            if (key === "description") {
                description = cleanFrontmatterValue(topMatch[2]);
            }
            else if (key === "type") {
                type = cleanFrontmatterValue(topMatch[2]);
            }
            continue;
        }
        if (inMetadata) {
            const metaMatch = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
            if (metaMatch?.[1] === "type") {
                type = cleanFrontmatterValue(metaMatch[2]);
            }
        }
    }
    return { description, type };
}
/** 从 CC 原生 A 套 memory 卡读取 description，不读取/嵌入正文。 */
function parseClaudeMemoryCards(memoryDir = A_MEMORY_DIR) {
    if (!memoryDir || !existsSync(memoryDir))
        return [];
    const items = [];
    const fileNames = readdirSync(memoryDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !A_MEMORY_EXCLUDED.has(entry.name))
        .map((entry) => entry.name)
        .sort();
    for (const fileName of fileNames) {
        const cardPath = path.join(memoryDir, fileName);
        const frontmatter = parseAFrontmatter(readFileSync(cardPath, "utf-8"));
        if (!frontmatter)
            continue;
        const text = frontmatter.description.trim();
        const category = frontmatter.type.trim();
        if (text.length < 5 || !category)
            continue;
        // A 套 ID 必须使用文件名 stem；frontmatter name 已实测不可靠。
        const id = path.basename(fileName, ".md");
        items.push({ id, category, text, stars: 0, source: "A" });
    }
    return items;
}
// ============================================================
// 主流程
// ============================================================
function defaultCwd() {
    return path.resolve(import.meta.dirname || new URL(".", import.meta.url).pathname, "../../../../..");
}
function parseArgs(argv) {
    let cwd = defaultCwd();
    let force = false;
    let strict = false;
    let dryRunA = false;
    for (const arg of argv) {
        if (arg === "--force") {
            force = true;
        }
        else if (arg === "--strict") {
            strict = true;
        }
        else if (arg === "--dry-run-a") {
            dryRunA = true;
        }
        else {
            cwd = arg;
        }
    }
    return { cwd, force, strict, dryRunA };
}
function appendVectorAlert(cwd, reason, now) {
    const recentEventsPath = path.join(cwd, "0-System/RECENT_EVENTS.md");
    appendFileSync(recentEventsPath, `\n- ⚠️ [向量系统告警 ${now}] memory 向量重建:${reason},语义召回降级,请修复`, "utf-8");
}
function writeVectorHealth(cwd, now, stats, ollamaReady) {
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
    writeFileSync(path.join(cwd, "0-System/vector-health.json"), `${JSON.stringify(health, null, 2)}\n`, "utf-8");
}
async function main() {
    const options = parseArgs(process.argv.slice(2));
    const cwd = options.cwd;
    const memPath = path.join(cwd, "0-System/memory-items.md");
    if (options.dryRunA) {
        const aItems = parseClaudeMemoryCards();
        console.log(`A 套解析：${aItems.length} 张卡`);
        for (const item of aItems.slice(0, 3)) {
            console.log(`- id=${item.id} category=${item.category} description=${item.text}`);
        }
        return;
    }
    console.log("🔍 检查 Ollama 状态...");
    const ready = await isOllamaReady();
    if (!ready) {
        console.error("❌ Ollama 未就绪。请确保：");
        console.error("   1. ollama serve 已启动");
        console.error("   2. ollama pull qwen3-embedding:0.6b 已完成");
    }
    else {
        console.log("✅ Ollama 就绪");
    }
    console.log(`📖 解析 B 套 ${memPath}...`);
    const bItems = parseMemoryItems(memPath);
    console.log(`   B 套找到 ${bItems.length} 条 item`);
    console.log(`📖 解析 A 套 ${A_MEMORY_DIR}...`);
    const aItems = parseClaudeMemoryCards();
    console.log(`   A 套找到 ${aItems.length} 张卡`);
    const parsed = [...bItems, ...aItems];
    console.log(`   合并后 ${parsed.length} 条 item`);
    const oldIndex = loadVectorIndex(cwd);
    const oldItems = new Map(oldIndex.items.map((item) => [item.id, item]));
    const vectorItems = [];
    const stats = {
        total: parsed.length,
        reused: 0,
        embedded: 0,
        failedKept: 0,
        missing: 0,
    };
    if (parsed.length === 0) {
        console.log("⚠️ 无 item 可索引");
    }
    else {
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
                source: item.source,
                vector: oldItem.vector,
            });
            stats.reused++;
        }
        else {
            const vec = ready ? await embed(item.text) : null;
            if (vec) {
                vectorItems.push({
                    id: item.id,
                    category: item.category,
                    text: item.text,
                    stars: item.stars,
                    source: item.source,
                    vector: vec,
                });
                stats.embedded++;
            }
            else if (oldItem) {
                // 数据安全红线：当前条目 embed 失败时，绝不丢弃已有向量。
                vectorItems.push({
                    id: item.id,
                    category: item.category,
                    text: item.text,
                    stars: item.stars,
                    source: item.source,
                    vector: oldItem.vector,
                });
                stats.failedKept++;
            }
            else {
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
    const index = {
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
    }
    else if (stats.missing > 0) {
        appendVectorAlert(cwd, `${stats.missing}条新记忆embed失败`, now);
    }
    const indexPath = path.join(cwd, "0-System/memory-vectors.json");
    const statsFile = readFileSync(indexPath);
    const sizeKB = Math.round(statsFile.length / 1024);
    const coverage = stats.total === 0 ? 1 : vectorItems.length / stats.total;
    console.log(`✅ 完成！索引大小：${sizeKB} KB`);
    console.log(`   路径：${indexPath}`);
    console.log(`   total=${stats.total} reused=${stats.reused} embedded=${stats.embedded} failedKept=${stats.failedKept} missing=${stats.missing} coverage=${coverage.toFixed(4)}`);
    if (options.strict && (!ready || stats.missing > 0)) {
        process.exit(1);
    }
}
main().catch((err) => {
    console.error("❌ 执行失败：", err);
    process.exit(1);
});
//# sourceMappingURL=rebuild-index.js.map