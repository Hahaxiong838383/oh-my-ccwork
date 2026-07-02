import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// task-board 根目录：scripts/ 的上一级
export const boardDir = path.resolve(__dirname, "..");
export const jsonPath = path.join(boardDir, "tasks.json");
export const mdPath = path.join(boardDir, "tasks.md");

export const VALID_STATUS = ["backlog", "todo", "doing", "done"];
export const VALID_PRIORITY = ["P1", "P2", "P3"];
const statusSet = new Set(VALID_STATUS);

export const TITLE_MAP = {
  backlog: "Backlog",
  todo: "Todo",
  doing: "Doing",
  done: "Done",
};
// 注意：不要在文件末尾再 export 一次，否则报 Duplicate export

// 默认调色板：新建项目时按顺序取色
export const PROJECT_COLORS = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#3b82f6",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#84cc16",
];

// v1 → v2 迁移：把单块 tasks[] 平铺进 local-board 项目
function migrateV1(old) {
  const tasks = Array.isArray(old.tasks) ? old.tasks : [];
  // 按现有 project 字段分组；无 project 的归入 local-board
  const buckets = { "local-board": [] };
  for (const t of tasks) {
    const pid = t.project || "local-board";
    if (!buckets[pid]) buckets[pid] = [];
    buckets[pid].push(t);
  }
  const projects = {};
  let colorIdx = 0;
  for (const [pid, list] of Object.entries(buckets)) {
    projects[pid] = {
      name: pid,
      color: PROJECT_COLORS[colorIdx++ % PROJECT_COLORS.length],
      tasks: list,
    };
  }
  const currentProject = old.currentProject && projects[old.currentProject]
    ? old.currentProject
    : Object.keys(projects)[0];
  return {
    version: 2,
    updatedAt: old.updatedAt || new Date().toISOString(),
    currentProject,
    projects,
  };
}

// 读取整个看板；旧版自动迁移；解析失败抛明确错误
export function loadBoard() {
  if (!fs.existsSync(jsonPath)) {
    const err = new Error(`未找到 ${jsonPath}`);
    err.code = "ENOENT_BOARD";
    throw err;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  } catch (e) {
    const err = new Error(`tasks.json 不是合法 JSON：${e.message}`);
    err.code = "EBADJSON";
    throw err;
  }
  // 自动迁移 v1 → v2
  if (!data.version || data.version < 2) {
    data = migrateV1(data);
    saveBoard(data);
  }
  if (!data.projects || typeof data.projects !== "object") {
    throw new Error("tasks.json 缺少 projects 对象");
  }
  return data;
}

// 原子写：先写临时文件再 rename
export function saveBoard(data) {
  data.version = 2;
  data.updatedAt = new Date().toISOString();
  const tmp = jsonPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, jsonPath);
  fs.writeFileSync(mdPath, renderMd(data));
  return data;
}

// 当前项目的 tasks 数组（操作任务时用）
export function currentProjectObj(data) {
  const pid = data.currentProject;
  return data.projects[pid];
}
export function currentTasks(data) {
  const p = currentProjectObj(data);
  return p ? p.tasks : [];
}

// 校验单个任务的必要字段
export function validateTask(task) {
  if (!task.title || typeof task.title !== "string" || !task.title.trim()) {
    throw new Error("任务缺少 title");
  }
  if (task.status && !statusSet.has(task.status)) {
    throw new Error(`非法任务状态：${task.status}`);
  }
  if (task.priority && !VALID_PRIORITY.includes(task.priority)) {
    throw new Error(`非法优先级：${task.priority}`);
  }
  if (task.files && !Array.isArray(task.files)) {
    throw new Error("files 必须是数组");
  }
  return true;
}

// 扫描某项目内现有最大编号，返回下一个 T-xxx（ID 按项目自增）
export function nextIdInProject(project) {
  let max = 0;
  for (const t of project.tasks || []) {
    const m = /^T-(\d+)$/.exec(t.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "T-" + String(max + 1).padStart(3, "0");
}

// 兼容旧调用：对当前项目取下一个 id
export function nextId(tasks) {
  let max = 0;
  for (const t of tasks) {
    const m = /^T-(\d+)$/.exec(t.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "T-" + String(max + 1).padStart(3, "0");
}

// 生成 tasks.md（按项目分组）
export function renderMd(data) {
  let md = `# 本地任务看板\n\n更新时间：${data.updatedAt}\n`;
  md += `当前项目：**${data.currentProject}**\n\n`;

  const entries = Object.entries(data.projects || {});
  if (entries.length === 0) {
    md += `_暂无项目_\n`;
    return md;
  }

  for (const [pid, proj] of entries) {
    const isCur = pid === data.currentProject ? " ← 当前" : "";
    md += `## ${proj.name} \`${pid}\`${isCur}\n\n`;
    const groups = { backlog: [], todo: [], doing: [], done: [] };
    for (const t of proj.tasks || []) groups[t.status]?.push(t);
    for (const status of VALID_STATUS) {
      const list = groups[status] || [];
      if (list.length === 0) continue;
      md += `### ${TITLE_MAP[status]} (${list.length})\n\n`;
      for (const t of list) {
        md += `- **${t.id}** ${t.title}`;
        if (t.priority) md += ` · ${t.priority}`;
        md += `\n`;
        if (t.notes) md += `  - ${t.notes}\n`;
        if (t.files?.length) md += `  - 文件：${t.files.join(", ")}\n`;
      }
      md += `\n`;
    }
  }
  return md;
}
