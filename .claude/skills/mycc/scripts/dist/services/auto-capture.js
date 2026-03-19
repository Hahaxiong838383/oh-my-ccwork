/**
 * Auto-Capture Memory Service
 *
 * 对话结束后，异步调用 Codex 提取新的原子记忆条目并写入 memory-items.md。
 * 设计原则：
 * - 完全非阻塞（fire-and-forget），不影响用户体验
 * - 仅在有实质性内容时触发（过滤闲聊、空回复等）
 * - Codex 使用 danger-full-access 直接读写 memory-items.md
 *
 * 基于 OpenViking Memory Plugin 的 agent_end hook 思路。
 */
import { runCliEngine } from "../adapters/cli-engine.js";
import * as path from "path";
/** 最短触发长度（用户消息 + 回复合计字符数） */
const MIN_CONTENT_LENGTH = 100;
/** 冷却时间：同一个 session 最少间隔多久触发一次（ms） */
const COOLDOWN_MS = 60_000; // 1 分钟
/** 单个回复最大字符数（超过截断，避免 prompt 过大） */
const MAX_REPLY_CHARS = 2000;
/** 最近触发时间记录（sessionId → timestamp） */
const lastCaptureTime = new Map();
/**
 * 判断内容是否值得提取记忆。
 * 过滤条件：纯闲聊、太短、命令等。
 */
function shouldCapture(userMsg, assistantReply) {
    const total = userMsg.length + assistantReply.length;
    if (total < MIN_CONTENT_LENGTH)
        return false;
    // 过滤命令消息
    if (userMsg.startsWith("/"))
        return false;
    // 过滤纯确认/感谢类短对话
    const trivial = /^(好的?|谢谢|感谢|ok|thanks?|👍|嗯|哦|好吧|明白了?|知道了?)$/i;
    if (trivial.test(userMsg.trim()))
        return false;
    return true;
}
/**
 * 构建发给 Codex 的提取 prompt。
 */
function buildCapturePrompt(userMsg, assistantReply, memoryFilePath) {
    const truncatedReply = assistantReply.length > MAX_REPLY_CHARS
        ? assistantReply.substring(0, MAX_REPLY_CHARS) + "\n...(截断)"
        : assistantReply;
    return `你是一个记忆提取器，任务是从以下对话中提取**新的、可复用的原子事实**，追加到记忆文件。

## 对话内容

**用户说：**
${userMsg}

**助手回复：**
${truncatedReply}

## 记忆文件路径

${memoryFilePath}

## 提取规则

1. **先读取文件**，了解现有内容和分类结构。
2. 只提取**新的、具体的、可独立检索的原子事实**。不重复已有内容。
3. 使用正确的命名空间：
   - \`[user/*]\` — 关于用户的跨项目偏好、习惯、方法论
   - \`[project/*]\` — 关于 mycc 项目的技术、路径、配置、决策
4. 叶子原则：每条 Item 是最小可用单元，不写概要性描述。
   - ✅ \`- FEISHU_APP_ID=cli_xxx 是 cc 通道的飞书 App ID\`
   - ❌ \`- 完成了飞书集成\`（太概要）
5. 如果没有值得提取的新事实，**直接输出 "NO_NEW_FACTS" 即可，不要修改文件**。
6. 每次最多追加 3 条，宁可少不要多。
7. 追加到最相关的分类下，没有合适分类就追加到 \`[project/状态]\`。

## 操作

请执行：读文件 → 判断哪些是新事实 → 追加到文件（或输出 NO_NEW_FACTS）。`;
}
/**
 * 触发 Auto-Capture（fire-and-forget）。
 * 在对话轮次结束后调用，异步提取记忆，不阻塞主流程。
 *
 * @param sessionId 会话 ID（用于冷却控制）
 * @param userMessage 用户原始消息
 * @param assistantReply 助手最终回复
 * @param cwd 工作目录（mycc 根目录）
 */
export function triggerAutoCapture(sessionId, userMessage, assistantReply, cwd) {
    // 内容过滤
    if (!shouldCapture(userMessage, assistantReply)) {
        return;
    }
    // 冷却控制
    const now = Date.now();
    const last = lastCaptureTime.get(sessionId) ?? 0;
    if (now - last < COOLDOWN_MS) {
        console.log(`[AutoCapture] 冷却中（${Math.round((COOLDOWN_MS - (now - last)) / 1000)}s 后可再次触发），跳过`);
        return;
    }
    lastCaptureTime.set(sessionId, now);
    const memoryFilePath = path.join(cwd, "0-System/memory-items.md");
    const prompt = buildCapturePrompt(userMessage, assistantReply, memoryFilePath);
    console.log(`[AutoCapture] 触发 Codex 记忆提取 (session=${sessionId.substring(0, 8)}...)`);
    // fire-and-forget，不 await
    runCliEngine("codex", prompt, cwd, {
        reasoningEffort: "high",
        timeout: 120_000, // 2 分钟足够
    }).then((result) => {
        if (result.error === "USER_ABORTED")
            return;
        if (result.error) {
            console.warn(`[AutoCapture] Codex 提取失败: ${result.error.substring(0, 100)}`);
            return;
        }
        const output = result.output.trim();
        if (output.includes("NO_NEW_FACTS")) {
            console.log(`[AutoCapture] 无新事实，跳过写入`);
        }
        else {
            console.log(`[AutoCapture] 记忆提取完成 (output=${output.length} chars)`);
        }
    }).catch((err) => {
        console.warn(`[AutoCapture] 未预期错误:`, err);
    });
}
//# sourceMappingURL=auto-capture.js.map