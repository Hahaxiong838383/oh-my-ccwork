// 校验 / 整理 tasks.json 并重新生成 tasks.md
// 命令行用法不变：node scripts/sync-taskboard.mjs
import {
  loadBoard,
  saveBoard,
  validateTask,
  currentTasks,
} from "./lib.mjs";

const data = loadBoard();

// 校验每个项目的每条任务
let total = 0;
for (const [pid, proj] of Object.entries(data.projects || {})) {
  for (const task of proj.tasks || []) {
    if (!task.id) throw new Error(`项目 ${pid} 有任务缺少 id：${JSON.stringify(task)}`);
    validateTask(task);
    total++;
  }
}

saveBoard(data);

const summary = Object.entries(data.projects || {})
  .map(([pid, p]) => `${pid}=${(p.tasks || []).length}`)
  .join(" ");
console.log(`[task-board] 同步完成（项目 ${summary}，共 ${total} 条）`);
