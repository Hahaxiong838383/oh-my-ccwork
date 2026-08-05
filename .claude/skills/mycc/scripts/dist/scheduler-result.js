export const SCHEDULER_RESULT_PREFIX = "SCHEDULER_RESULT";
export const SCHEDULER_UNKNOWN_SUMMARY = "⚠️ 引擎完成，业务结果未知";
export function buildSchedulerPrompt(task, timestamp) {
    const skillLine = task.skill && task.skill !== "-"
        ? `1. 执行技能：${task.skill}（位置：.claude/skills/${task.skill.replace("/", "")}）`
        : "1. 无需执行特定技能，直接完成任务";
    return `[定时任务] ${task.name}

时间：${timestamp}
任务：${task.desc}

---
执行要求：
${skillLine}
2. 只执行任务本身，不要发送任何飞书通知。
3. 禁止调用 /tell-me、lark-cli、send_message、feishu_openapi_call 或任何飞书发送工具。
4. 任务结束后最后一行必须输出结构化结果，格式如下：
${SCHEDULER_RESULT_PREFIX} {"status":"success|failed|skipped","summary":"一句话结果","error":"失败原因，可省略"}

重要：只执行上述任务，不要执行任何其他定时任务或额外操作。通知目标由 Scheduler 统一决定，Agent 不拥有通知目标选择权。完成后立即结束。`;
}
export function extractSchedulerEventText(event) {
    const parts = [];
    if (typeof event.text === "string")
        parts.push(event.text);
    const delta = event.delta;
    if (delta && typeof delta.text === "string")
        parts.push(delta.text);
    const appendTextBlocks = (value) => {
        if (!Array.isArray(value))
            return;
        for (const block of value) {
            if (!block || typeof block !== "object")
                continue;
            const maybeText = block.text;
            if (typeof maybeText === "string")
                parts.push(maybeText);
            const maybeContent = block.content;
            if (typeof maybeContent === "string")
                parts.push(maybeContent);
            appendTextBlocks(maybeContent);
        }
    };
    appendTextBlocks(event.content);
    const message = event.message;
    appendTextBlocks(message?.content);
    return parts.join("\n");
}
export function parseSchedulerResult(output) {
    const line = output
        .split(/\r?\n/)
        .reverse()
        .find((candidate) => candidate.includes(SCHEDULER_RESULT_PREFIX));
    if (!line) {
        return { status: "unknown", summary: SCHEDULER_UNKNOWN_SUMMARY };
    }
    const jsonText = line
        .slice(line.indexOf(SCHEDULER_RESULT_PREFIX) + SCHEDULER_RESULT_PREFIX.length)
        .trim()
        .replace(/^`+|`+$/g, "");
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch {
        return { status: "unknown", summary: SCHEDULER_UNKNOWN_SUMMARY, error: "结构化结果 JSON 非法" };
    }
    if (!parsed || typeof parsed !== "object") {
        return { status: "unknown", summary: SCHEDULER_UNKNOWN_SUMMARY, error: "结构化结果不是对象" };
    }
    const rawStatus = parsed.status;
    if (rawStatus !== "success" && rawStatus !== "failed" && rawStatus !== "skipped") {
        return { status: "unknown", summary: SCHEDULER_UNKNOWN_SUMMARY, error: "结构化结果 status 无法判断" };
    }
    const rawSummary = parsed.summary;
    const rawError = parsed.error;
    const summary = sanitizeSchedulerText(typeof rawSummary === "string" && rawSummary.trim() ? rawSummary : defaultSummary(rawStatus));
    const error = typeof rawError === "string" && rawError.trim()
        ? sanitizeSchedulerText(rawError)
        : undefined;
    return { status: rawStatus, summary, error };
}
export function schedulerEngineErrorResult(summary, error) {
    return {
        status: "failed",
        summary: sanitizeSchedulerText(summary),
        error: sanitizeSchedulerText(error instanceof Error ? error.message : String(error)),
    };
}
export function formatSchedulerHistoryStatus(result) {
    if (result.status === "success")
        return `✅ 成功: ${sanitizeSchedulerText(result.summary)}`;
    if (result.status === "failed")
        return `❌ 失败: ${sanitizeSchedulerText(result.error || result.summary)}`;
    if (result.status === "skipped")
        return `⏭️ 跳过: ${sanitizeSchedulerText(result.summary)}`;
    return SCHEDULER_UNKNOWN_SUMMARY;
}
export function formatSchedulerNotification(taskName, timestamp, result) {
    const title = result.status === "success"
        ? "✅ 定时任务成功"
        : result.status === "failed"
            ? "❌ 定时任务失败"
            : result.status === "skipped"
                ? "⏭️ 定时任务跳过"
                : SCHEDULER_UNKNOWN_SUMMARY;
    const lines = [
        `${title}：${taskName}`,
        `时间：${timestamp}`,
        `结果：${sanitizeSchedulerText(result.summary)}`,
    ];
    if (result.error)
        lines.push(`错误：${sanitizeSchedulerText(result.error)}`);
    return lines.join("\n");
}
export async function sendSchedulerResultNotification(task, timestamp, result, sink) {
    const text = formatSchedulerNotification(task.name, timestamp, result);
    if (isGroupNotificationOptIn(task.desc)) {
        return { target: "group", delivered: sink.sendGroup ? await sink.sendGroup(text) : false };
    }
    return { target: "owner_p2p", delivered: await sink.sendOwnerP2P(text) };
}
export function isGroupNotificationOptIn(desc) {
    return /(?:^|[\s；;，,])notify:group(?:$|[\s；;，,])/.test(desc);
}
export function sanitizeSchedulerText(input, maxLength = 220) {
    const redacted = input
        .replace(/https?:\/\/[\w.-]*(?:feishu|larksuite|webhook)[^\s)]+/gi, "[REDACTED_URL]")
        .replace(/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_=-]{32,})\b/g, "[REDACTED]")
        .replace(/(app[_-]?secret|secret|token|password|passwd|authorization|webhook|sign|key)\s*[:=]\s*[^\s,，;；]+/gi, "$1=[REDACTED]")
        .replace(/[\r\n|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}
function defaultSummary(status) {
    if (status === "success")
        return "任务完成";
    if (status === "failed")
        return "任务失败";
    return "任务跳过";
}
//# sourceMappingURL=scheduler-result.js.map