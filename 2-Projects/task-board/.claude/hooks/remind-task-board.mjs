// UserPromptSubmit Hook：每次用户提交消息时，注入 task-board Skill 提醒。
// stdin 收到 Claude Code 的 JSON（含 prompt 字段）；stdout 返回 JSON，
// 通过 hookSpecificOutput.additionalContext 把提醒追加到模型上下文。
import fs from "node:fs";

let raw = "";
try {
  raw = fs.readFileSync(0, "utf-8");
} catch {
  // 无 stdin（手动测试）时直接退出
  process.exit(0);
}

// 无数据或 tty（非 Claude Code 调用）时静默退出，避免误触发
if (!raw || !raw.trim()) process.exit(0);

let prompt = "";
try {
  const parsed = JSON.parse(raw);
  prompt = (parsed && parsed.prompt) || "";
} catch {
  // 非 JSON 输入：可能是误调用，静默退出
  process.exit(0);
}

const REMINDER = `【task-board Skill 提醒】你正在含本地任务看板的项目里工作（server.mjs 运行在 http://localhost:8788）。
请按 .claude/skills/task-board/SKILL.md 规则维护看板：
- 若用户消息描述的是一个【开发/修复/重构/文档类】明确任务，且该任务尚不存在：先用 curl POST http://localhost:8788/api/tasks 建任务（status=doing），再做实际工作。
- 完成时 PATCH /api/tasks/:id 改为 done，补 files 与 notes。
- 仅闲聊/提问/查看时不要建任务。
- 若 API 连不上，回退到直接读写 task-board/tasks.json + 跑 node scripts/sync-taskboard.mjs。
判断标准：用户当前消息是否要求你"动手做某件具体的事"。是→建任务；否→跳过。`;

// 通过 additionalContext 注入（Claude Code UserPromptSubmit Hook 协议）
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: REMINDER,
    },
  })
);
