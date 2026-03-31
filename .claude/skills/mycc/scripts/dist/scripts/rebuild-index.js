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
import { readFileSync, existsSync } from "fs";
import * as path from "path";
import { embed, saveVectorIndex, isOllamaReady, } from "../services/embedding.js";
/** 从 memory-items.md 解析所有 item */
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
            if (text.length < 5)
                continue;
            const starCount = (line.match(/★/g) || []).length;
            // 用内容哈希作为 ID（简单稳定）
            const id = simpleHash(`${category}:${text}`);
            items.push({ category, text, stars: starCount, id });
        }
    }
    return items;
}
/** 简单字符串哈希（djb2） */
function simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
    }
    return hash.toString(36);
}
// ============================================================
// 主流程
// ============================================================
async function main() {
    const cwd = process.argv[2] || path.resolve(import.meta.dirname || new URL(".", import.meta.url).pathname, "../../../../..");
    const memPath = path.join(cwd, "0-System/memory-items.md");
    console.log("🔍 检查 Ollama 状态...");
    const ready = await isOllamaReady();
    if (!ready) {
        console.error("❌ Ollama 未就绪。请确保：");
        console.error("   1. ollama serve 已启动");
        console.error("   2. ollama pull qwen3-embedding:0.6b 已完成");
        process.exit(1);
    }
    console.log("✅ Ollama 就绪");
    console.log(`📖 解析 ${memPath}...`);
    const parsed = parseMemoryItems(memPath);
    console.log(`   找到 ${parsed.length} 条 item`);
    if (parsed.length === 0) {
        console.log("⚠️ 无 item 可索引，退出");
        return;
    }
    console.log("🧠 开始生成 embedding...");
    const vectorItems = [];
    let failed = 0;
    for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        const vec = await embed(item.text);
        if (vec) {
            vectorItems.push({
                id: item.id,
                category: item.category,
                text: item.text,
                stars: item.stars,
                vector: vec,
            });
        }
        else {
            failed++;
        }
        // 进度显示（每 10 条或最后一条）
        if ((i + 1) % 10 === 0 || i === parsed.length - 1) {
            const pct = Math.round(((i + 1) / parsed.length) * 100);
            process.stdout.write(`\r   进度：${i + 1}/${parsed.length} (${pct}%)`);
        }
    }
    console.log(""); // 换行
    if (failed > 0) {
        console.log(`⚠️ ${failed} 条 embed 失败`);
    }
    const index = {
        model: "qwen3-embedding:0.6b",
        dimensions: 512,
        updated_at: new Date().toISOString(),
        items: vectorItems,
    };
    console.log(`💾 写入索引（${vectorItems.length} 条）...`);
    saveVectorIndex(cwd, index);
    const indexPath = path.join(cwd, "0-System/memory-vectors.json");
    const stats = readFileSync(indexPath);
    const sizeKB = Math.round(stats.length / 1024);
    console.log(`✅ 完成！索引大小：${sizeKB} KB`);
    console.log(`   路径：${indexPath}`);
}
main().catch((err) => {
    console.error("❌ 执行失败：", err);
    process.exit(1);
});
//# sourceMappingURL=rebuild-index.js.map