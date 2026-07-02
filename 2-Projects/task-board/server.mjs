// 零依赖看板服务 v3：多项目 + REST API + 静态托管
// 启动：node server.mjs   端口默认 8788，可用 PORT= 覆盖
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  boardDir,
  loadBoard,
  saveBoard,
  validateTask,
  nextIdInProject,
  currentTasks,
  PROJECT_COLORS,
} from "./scripts/lib.mjs";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8788;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  return text ? JSON.parse(text) : {};
}

// 在所有项目里找到任务所属的项目和引用（用于 copy-to 的源）
function findTaskEverywhere(data, id) {
  for (const [pid, proj] of Object.entries(data.projects || {})) {
    const idx = (proj.tasks || []).findIndex((t) => t.id === id);
    if (idx >= 0) return { pid, proj, idx, task: proj.tasks[idx] };
  }
  return null;
}

// 静态托管（防越界）
function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const abs = path.join(boardDir, rel);
  if (!abs.startsWith(boardDir)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return sendJson(res, 404, { error: "not found", path: rel });
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(abs).pipe(res);
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = decodeURIComponent(url.pathname);

  try {
    // ---------- 项目 API ----------
    if (method === "GET" && p === "/api/projects") {
      const data = loadBoard();
      return sendJson(res, 200, {
        currentProject: data.currentProject,
        projects: Object.entries(data.projects || {}).map(([id, pr]) => ({
          id,
          name: pr.name,
          color: pr.color,
          count: (pr.tasks || []).length,
        })),
      });
    }

    if (method === "POST" && p === "/api/projects") {
      const body = await readBody(req);
      const data = loadBoard();
      const id = (body.id || body.name || "project")
        .toString().trim().toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!id) return sendJson(res, 400, { error: "项目 id/name 不能为空" });
      if (data.projects[id]) return sendJson(res, 409, { error: `项目 ${id} 已存在` });
      const colorIdx = Object.keys(data.projects).length;
      data.projects[id] = {
        name: (body.name || id).toString().trim(),
        color: body.color || PROJECT_COLORS[colorIdx % PROJECT_COLORS.length],
        tasks: [],
      };
      data.currentProject = id;
      saveBoard(data);
      return sendJson(res, 201, { id, ...data.projects[id] });
    }

    const projPatch = method === "PATCH" && /^\/api\/projects\/([^/]+)$/.exec(p);
    if (projPatch) {
      const id = projPatch[1];
      const body = await readBody(req);
      const data = loadBoard();
      const proj = data.projects[id];
      if (!proj) return sendJson(res, 404, { error: "项目不存在", id });
      if (body.name !== undefined) proj.name = String(body.name).trim();
      if (body.color !== undefined) proj.color = String(body.color).trim();
      saveBoard(data);
      return sendJson(res, 200, { id, ...proj });
    }

    const projDel = method === "DELETE" && /^\/api\/projects\/([^/]+)$/.exec(p);
    if (projDel) {
      const id = projDel[1];
      const data = loadBoard();
      if (!data.projects[id]) return sendJson(res, 404, { error: "项目不存在", id });
      if (Object.keys(data.projects).length <= 1) {
        return sendJson(res, 400, { error: "至少保留一个项目" });
      }
      delete data.projects[id];
      if (data.currentProject === id) {
        data.currentProject = Object.keys(data.projects)[0];
      }
      saveBoard(data);
      res.writeHead(204);
      return res.end();
    }

    const activate = method === "POST" && /^\/api\/projects\/([^/]+)\/activate$/.exec(p);
    if (activate) {
      const id = activate[1];
      const data = loadBoard();
      if (!data.projects[id]) return sendJson(res, 404, { error: "项目不存在", id });
      // 收集切换前的 doing 任务，用于前端弹"复制跟进"
      const prevTasks = currentTasks(data).filter((t) => t.status === "doing");
      data.currentProject = id;
      saveBoard(data);
      return sendJson(res, 200, {
        currentProject: id,
        followUps: prevTasks.map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          fromProject: data.projects[id] ? id : id,
        })),
      });
    }

    // ---------- 任务 API（作用于当前项目）----------
    if (method === "GET" && p === "/api/tasks") {
      const data = loadBoard();
      return sendJson(res, 200, {
        updatedAt: data.updatedAt,
        currentProject: data.currentProject,
        tasks: currentTasks(data),
      });
    }

    if (method === "POST" && p === "/api/tasks") {
      const body = await readBody(req);
      const data = loadBoard();
      const proj = data.projects[data.currentProject];
      const task = {
        id: nextIdInProject(proj),
        title: String(body.title ?? "").trim(),
        status: body.status || "todo",
        priority: body.priority || "P2",
        project: data.currentProject,
        files: Array.isArray(body.files) ? body.files : [],
        notes: body.notes || "",
      };
      validateTask(task);
      proj.tasks.push(task);
      saveBoard(data);
      return sendJson(res, 201, task);
    }

    const copyTo = method === "POST" && /^\/api\/tasks\/([^/]+)\/copy-to\/([^/]+)$/.exec(p);
    if (copyTo) {
      const [, srcId, targetId] = copyTo;
      const body = await readBody(req).catch(() => ({}));
      const data = loadBoard();
      const found = findTaskEverywhere(data, srcId);
      const target = data.projects[targetId];
      if (!found) return sendJson(res, 404, { error: "源任务不存在", id: srcId });
      if (!target) return sendJson(res, 404, { error: "目标项目不存在", id: targetId });
      const src = found.task;
      const newTask = {
        id: nextIdInProject(target),
        title: src.title,
        status: "todo", // 复制后重置为 todo
        priority: src.priority || "P2",
        project: targetId,
        files: Array.isArray(src.files) ? [...src.files] : [],
        notes: (src.notes ? src.notes + "\n" : "") + `跟进自 ${found.pid}-${srcId}`,
      };
      target.tasks.push(newTask);
      saveBoard(data);
      return sendJson(res, 201, { copied: newTask, sourceKept: src });
    }

    const patchM = method === "PATCH" && /^\/api\/tasks\/([^/]+)$/.exec(p);
    if (patchM) {
      const id = patchM[1];
      const body = await readBody(req);
      const data = loadBoard();
      const tasks = currentTasks(data);
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx < 0) return sendJson(res, 404, { error: "任务不存在", id });
      const cur = tasks[idx];
      const next = { ...cur };
      for (const k of ["title", "status", "priority", "project", "notes"]) {
        if (body[k] !== undefined) next[k] = String(body[k]).trim();
      }
      if (body.files !== undefined) {
        next.files = Array.isArray(body.files) ? body.files : [];
      }
      validateTask(next);
      next.id = cur.id;
      tasks[idx] = next;
      saveBoard(data);
      return sendJson(res, 200, next);
    }

    const delM = method === "DELETE" && /^\/api\/tasks\/([^/]+)$/.exec(p);
    if (delM) {
      const id = delM[1];
      const data = loadBoard();
      const tasks = currentTasks(data);
      const before = tasks.length;
      data.projects[data.currentProject].tasks = tasks.filter((t) => t.id !== id);
      if (data.projects[data.currentProject].tasks.length === before) {
        return sendJson(res, 404, { error: "任务不存在", id });
      }
      saveBoard(data);
      res.writeHead(204);
      return res.end();
    }

    // 其它路径走静态
    return serveStatic(req, res, p);
  } catch (err) {
    const status =
      err.code === "ENOENT_BOARD" || err.message.includes("合法 JSON") ? 500 : 400;
    return sendJson(res, status, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[task-board v3] 服务已启动 → http://localhost:${PORT}`);
  console.log(`[task-board v3] 项目: /api/projects | 任务: /api/tasks | 复制: /api/tasks/:id/copy-to/:pid`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
