/**
 * 本地 LLM 调用封装（MLX OmniCoder-9B-4bit）
 *
 * OpenAI 兼容 API，端口 8899
 * 用途：飞书消息意图分类（零成本替代关键词匹配）
 */
import { appendFileSync } from "fs";
/**
 * 路由分类 System Prompt
 *
 * 设计原则：
 * 1. 中文 prompt（用户消息 95% 是中文，减少跨语言理解损耗）
 * 2. 优先级从高到低：pipeline > codex > gemini > cc
 * 3. 用具体例子而非抽象描述（7B 模型靠例子学得快）
 * 4. cc 是兜底，宁可多分给 codex/gemini 也不要全堆给 cc
 */
const ROUTER_SYSTEM_PROMPT = `你是消息路由器。根据用户消息判断应该交给哪个引擎处理。只回复引擎名，不要回复其他任何内容。

四个引擎：
codex — 写代码、改代码、调试、重构、代码审查、写测试、论文调研、arxiv、文献综述
gemini — 抓取新闻、采集信息、爬取数据、IPO报告、知识库查询、RSS、搜索资讯、早报简报
pipeline — 需要"分析/总结/调研 + 写入飞书/文档/知识库"的组合任务（两步都有才选pipeline）
cc — 闲聊、问答、规划、决策、架构设计、看看/帮我看、不确定时选cc

判断规则（按优先级）：
1. 同时包含"分析/总结/调研"和"写入/发到/同步到飞书/文档/知识库" → pipeline
2. 包含"写入飞书/写入文档/发到群/创建文档/更新表格" → codex
3. 包含 github.com 链接 → cc
4. 包含 arxiv 链接、"论文/调研/文献/理论雷达/前沿论文" → codex
5. 包含"写代码/写脚本/写程序/实现/开发/重构/debug/代码审查/写测试" → codex
6. 包含"抓取/采集/爬取/新闻/资讯/早报/简报/IPO报告/知识库/wiki" → gemini
7. 包含非github的URL + "分析/总结/调研" → gemini
8. "/" 开头的命令：/theory-radar /collect /github-radar /ipo-report → codex或gemini（看命令含义）
9. 其余 → cc

示例：
"帮我写一个Python爬虫" → codex
"重构这个模块的错误处理" → codex
"抓取最新AI新闻发给我" → gemini
"采集今日热点" → gemini
"分析这篇论文写入知识库" → pipeline
"总结全文同步到飞书文档" → pipeline
"写入飞书表格" → codex
"你好" → cc
"帮我看看这个设计方案" → cc
"最近黄金怎么样" → cc
"/theory-radar" → codex
"/collect" → gemini
"/ipo-report" → gemini`;
const LOCAL_LLM_URL = "http://localhost:8899/v1/chat/completions";
const LOCAL_LLM_MODEL = "mlx-community/Qwen2.5-7B-Instruct-4bit";
const LOCAL_LLM_TIMEOUT = 3000; // 3 秒超时，超时 fallback 回关键词
const LOCAL_LLM_LOG = "/tmp/local-llm.log";
function log(msg) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
    try {
        appendFileSync(LOCAL_LLM_LOG, line);
    }
    catch { }
}
/**
 * 检查本地模型服务是否可用
 */
export async function isLocalLLMAvailable() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const res = await fetch("http://localhost:8899/v1/models", {
            signal: controller.signal,
        });
        clearTimeout(timeout);
        return res.ok;
    }
    catch {
        return false;
    }
}
/**
 * 调用本地模型进行消息意图分类
 *
 * @returns "cc" | "codex" | "gemini" | "pipeline" | null（null 表示调用失败，需 fallback）
 */
export async function classifyIntentLocal(message) {
    const startTime = Date.now();
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), LOCAL_LLM_TIMEOUT);
        const res = await fetch(LOCAL_LLM_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: LOCAL_LLM_MODEL,
                messages: [
                    {
                        role: "system",
                        content: ROUTER_SYSTEM_PROMPT,
                    },
                    {
                        role: "user",
                        content: message,
                    },
                ],
                max_tokens: 10,
                temperature: 0,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok)
            return null;
        const data = (await res.json());
        const raw = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "";
        // 严格匹配四个合法值
        const cleaned = raw.replace(/[^a-z]/g, "");
        const elapsed = Date.now() - startTime;
        if (["codex", "gemini", "pipeline", "cc"].includes(cleaned)) {
            log(`✅ "${message.substring(0, 40)}" → ${cleaned} (${elapsed}ms)`);
            return cleaned;
        }
        // 模型输出不规范，fallback
        log(`⚠️ "${message.substring(0, 40)}" → 输出不规范: "${raw}" (${elapsed}ms)`);
        return null;
    }
    catch (err) {
        const elapsed = Date.now() - startTime;
        const isTimeout = err instanceof Error && err.name === "AbortError";
        log(`❌ "${message.substring(0, 40)}" → ${isTimeout ? "超时" : String(err)} (${elapsed}ms)`);
        return null;
    }
}
//# sourceMappingURL=local-llm.js.map