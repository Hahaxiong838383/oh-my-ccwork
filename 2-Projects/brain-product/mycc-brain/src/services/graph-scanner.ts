/**
 * graph-scanner.ts — 项目级架构图谱数据生成器
 *
 * 扫描三层目录生成节点和边：
 * - 代码层（src/）：实时扫描文件 + import 依赖
 * - 数据层（DATA_DIR）：实时扫描运行时数据文件
 * - 配置层：从 deploy.sh 生成的快照 JSON 读取
 */
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, resolve, relative, extname, basename } from "path";

// ─── 类型定义 ───────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  group: string;
  layer: "code" | "data" | "config";
  type: "dir" | "file";
  desc: string;
}

export interface GraphLink {
  source: string;
  target: string;
  type: "contain" | "import" | "reference" | "dataflow";
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  meta: {
    generatedAt: string;
    codeCount: number;
    dataCount: number;
    configCount: number;
    snapshotAge: string | null;
  };
}

// ─── 代码层分组规则 ─────────────────────────────────

const CODE_GROUP_RULES: ReadonlyArray<{ pattern: RegExp; group: string }> = [
  { pattern: /^config|^mcp-config/, group: "Config" },
  { pattern: /^server|^brain-api|^mcp-entry/, group: "Entry" },
  { pattern: /^adapters\/|^openai-compat|^embedding/, group: "Adapters" },
  { pattern: /^admin\//, group: "Admin" },
  { pattern: /^eval\//, group: "Eval" },
  { pattern: /brain-context|memory-db|memory-store|conversation/, group: "Memory" },
  { pattern: /user-state|experience-stream|prediction/, group: "State" },
  { pattern: /evolution|hot-patch/, group: "Evolution" },
  { pattern: /memory-intake|memory-consolidation/, group: "Processing" },
  { pattern: /tool-registry|mcp-server|mcp-client|mcp-bridge/, group: "Tools" },
  { pattern: /^tools\//, group: "ToolImpl" },
  { pattern: /agent-loop/, group: "Agent" },
];

function inferCodeGroup(relPath: string): string {
  for (const rule of CODE_GROUP_RULES) {
    if (rule.pattern.test(relPath)) return rule.group;
  }
  const dir = relPath.split("/")[0];
  return dir || "Entry";
}

// ─── 数据层分组规则 ─────────────────────────────────

const DATA_GROUP_MAP: Record<string, string> = {
  "SOUL.md": "Identity",
  "self-model.md": "Identity",
  "user-profile.md": "Identity",
  "memory-items.md": "MemoryData",
  "memory-items-intake.md": "MemoryData",
  "MEMORY.md": "MemoryData",
  "memory-config.json": "MemoryData",
  "memory.db": "MemoryData",
  "user-memories.jsonl": "MemoryData",
  "RECENT_EVENTS.md": "Events",
  "task-log.md": "Events",
  "evolution-log.md": "Events",
  "status.md": "Status",
  "blackboard.md": "Status",
  "friction-patterns.md": "Status",
  "data_structure.md": "Status",
};

function inferDataGroup(name: string, isDir: boolean): string {
  if (isDir) return "Archive";
  return DATA_GROUP_MAP[name] ?? "Status";
}

// ─── 数据层描述 ─────────────────────────────────────

const DATA_DESC_MAP: Record<string, string> = {
  "SOUL.md": "cc 的灵魂定义（存在本质、动机、人格）",
  "self-model.md": "cc 的自我模型（能力边界+成长轨迹）",
  "user-profile.md": "川哥的结构化画像",
  "memory-items.md": "结构化记忆条目（原子事实）",
  "memory-items-intake.md": "待合并的记忆摄入缓冲",
  "MEMORY.md": "长期记忆索引",
  "memory-config.json": "记忆系统配置",
  "memory.db": "SQLite FTS5 + 向量数据库",
  "user-memories.jsonl": "用户主动添加的记忆",
  "RECENT_EVENTS.md": "24h 滚动事件流",
  "task-log.md": "任务执行日志",
  "evolution-log.md": "进化日志",
  "status.md": "当前状态快照",
  "blackboard.md": "多智能体信息黑板",
  "friction-patterns.md": "摩擦模式记录",
  "data_structure.md": "文件导航索引",
  "about-me/": "川哥的完整画像",
  "agent-memory/": "多引擎记忆分区",
  "trajectories/": "执行轨迹记录",
  "chat-memory/": "跨 session 记忆",
  "snapshots/": "定期快照",
};

// ─── 配置层分组规则 ──────────────────────────────────

function inferConfigGroup(path: string): string {
  if (path === "CLAUDE.md") return "RootConfig";
  if (path.startsWith("docs/harness/")) return "Harness";
  if (path.startsWith("docs/")) return "Docs";
  if (path.startsWith(".claude/skills/")) return "Skills";
  if (path.startsWith("multi-agent/context/")) return "AgentContext";
  if (path.startsWith("multi-agent/scripts/") || path.startsWith("multi-agent/hooks/")) return "AgentInfra";
  if (path.startsWith("multi-agent/")) return "MultiAgent";
  return "Docs";
}

// ─── 已知数据流映射（代码层→数据层） ─────────────────

const DATAFLOW_MAP: ReadonlyArray<{ code: string; data: string }> = [
  { code: "brain-context.ts", data: "RECENT_EVENTS.md" },
  { code: "brain-context.ts", data: "user-profile.md" },
  { code: "brain-context.ts", data: "memory-items.md" },
  { code: "brain-context.ts", data: "memory-items-intake.md" },
  { code: "brain-context.ts", data: "user-memories.jsonl" },
  { code: "memory-db.ts", data: "memory.db" },
  { code: "memory-db.ts", data: "memory-items.md" },
  { code: "memory-db.ts", data: "memory-items-intake.md" },
  { code: "memory-store.ts", data: "memory-items.md" },
  { code: "memory-intake.ts", data: "memory-items-intake.md" },
  { code: "memory-consolidation.ts", data: "memory-items.md" },
  { code: "experience-stream.ts", data: "memory-items.md" },
];

// ─── import 解析正则 ─────────────────────────────────

const IMPORT_RE = /(?:import\s+.*?from\s+["']\.\/(.+?)(?:\.js)?["']|import\s*\(\s*["']\.\/(.+?)(?:\.js)?["']\s*\))/g;

function parseImports(content: string): string[] {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const raw = m[1] || m[2];
    if (raw) imports.push(raw);
  }
  return imports;
}

// ─── 配置层快照类型 ──────────────────────────────────

interface ConfigSnapshot {
  generatedAt: string;
  claudeMd: boolean;
  docs: Array<{ path: string; type: "dir" | "file" }>;
  skills: string[];
  multiAgent: Array<{ path: string; type: "dir" | "file" }>;
  references: Record<string, string[]>;
}

// ─── 扫描函数 ────────────────────────────────────────

const BINARY_EXT = new Set([".db", ".db-shm", ".db-wal", ".sqlite"]);
const SKIP_DATA_FILES = new Set([".DS_Store", ".gitkeep"]);

function scanCodeLayer(srcDir: string): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  function walk(dir: string, parentId: string | null): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      const relPath = relative(srcDir, fullPath);

      if (entry.isDirectory()) {
        const dirId = `code:${entry.name}/`;
        nodes.push({
          id: dirId,
          label: `${entry.name}/`,
          group: "Folder",
          layer: "code",
          type: "dir",
          desc: `${entry.name} 目录`,
        });
        if (parentId) links.push({ source: parentId, target: dirId, type: "contain" });
        walk(fullPath, dirId);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".html")) {
        const fileId = `code:${entry.name}`;
        nodes.push({
          id: fileId,
          label: entry.name,
          group: inferCodeGroup(relPath),
          layer: "code",
          type: "file",
          desc: "",
        });
        if (parentId) links.push({ source: parentId, target: fileId, type: "contain" });
      }
    }
  }

  // src/ 根节点
  const srcId = "code:src/";
  nodes.push({ id: srcId, label: "src/", group: "Folder", layer: "code", type: "dir", desc: "源码根目录" });
  walk(srcDir, srcId);

  // 解析 import 依赖
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    if (node.type !== "file" || !node.label.endsWith(".ts")) continue;
    const filePath = findFile(srcDir, node.label);
    if (!filePath) continue;
    try {
      const content = readFileSync(filePath, "utf-8");
      const imports = parseImports(content);
      for (const imp of imports) {
        // imp 可能是 "services/brain-context" 或 "config"
        const parts = imp.split("/");
        const targetName = parts[parts.length - 1] + ".ts";
        const targetId = `code:${targetName}`;
        if (nodeIds.has(targetId) && targetId !== node.id) {
          links.push({ source: node.id, target: targetId, type: "import" });
        }
      }
    } catch {
      /* 文件读取失败跳过 */
    }
  }

  return { nodes, links };
}

function findFile(srcDir: string, name: string): string | null {
  // 先尝试 src/ 根
  const direct = join(srcDir, name);
  if (existsSync(direct)) return direct;
  // 尝试子目录
  for (const sub of ["services", "adapters", "admin", "eval", "tools"]) {
    const p = join(srcDir, sub, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function scanDataLayer(dataDir: string): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  if (!existsSync(dataDir)) return { nodes, links };

  const rootId = "data:0-System/";
  nodes.push({
    id: rootId,
    label: "0-System/",
    group: "Archive",
    layer: "data",
    type: "dir",
    desc: "cc 的运行时状态数据",
  });

  const entries = readdirSync(dataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DATA_FILES.has(entry.name)) continue;
    const ext = extname(entry.name);

    if (entry.isDirectory()) {
      const dirId = `data:${entry.name}/`;
      nodes.push({
        id: dirId,
        label: `${entry.name}/`,
        group: inferDataGroup(entry.name, true),
        layer: "data",
        type: "dir",
        desc: DATA_DESC_MAP[`${entry.name}/`] ?? `${entry.name} 子目录`,
      });
      links.push({ source: rootId, target: dirId, type: "contain" });
    } else if (!BINARY_EXT.has(ext) || entry.name === "memory.db") {
      const fileId = `data:${entry.name}`;
      nodes.push({
        id: fileId,
        label: entry.name,
        group: inferDataGroup(entry.name, false),
        layer: "data",
        type: "file",
        desc: DATA_DESC_MAP[entry.name] ?? entry.name,
      });
      links.push({ source: rootId, target: fileId, type: "contain" });
    }
  }

  return { nodes, links };
}

function scanConfigLayer(brainRoot: string): { nodes: GraphNode[]; links: GraphLink[]; snapshotTime: string | null } {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  const snapshotPath = join(brainRoot, "data", "graph-config-snapshot.json");
  if (!existsSync(snapshotPath)) {
    return { nodes, links, snapshotTime: null };
  }

  let snapshot: ConfigSnapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));
  } catch {
    return { nodes, links, snapshotTime: null };
  }

  // CLAUDE.md
  if (snapshot.claudeMd) {
    nodes.push({
      id: "config:CLAUDE.md",
      label: "CLAUDE.md",
      group: "RootConfig",
      layer: "config",
      type: "file",
      desc: "cc 核心配置（身份+规则+协议）",
    });
  }

  // docs/
  const docsRoot = "config:docs/";
  let hasDocs = false;
  for (const item of snapshot.docs) {
    if (item.type === "dir" && item.path === "docs") {
      nodes.push({ id: docsRoot, label: "docs/", group: "Docs", layer: "config", type: "dir", desc: "文档目录" });
      hasDocs = true;
      continue;
    }
    if (item.type === "dir") {
      const dirId = `config:${item.path}/`;
      nodes.push({
        id: dirId,
        label: `${basename(item.path)}/`,
        group: inferConfigGroup(item.path + "/"),
        layer: "config",
        type: "dir",
        desc: `${basename(item.path)} 子目录`,
      });
      if (hasDocs) links.push({ source: docsRoot, target: dirId, type: "contain" });
    } else {
      const fileId = `config:${item.path}`;
      nodes.push({
        id: fileId,
        label: basename(item.path),
        group: inferConfigGroup(item.path),
        layer: "config",
        type: "file",
        desc: basename(item.path),
      });
      // 推断父目录
      const parentDir = item.path.substring(0, item.path.lastIndexOf("/"));
      const parentId = parentDir === "docs" ? docsRoot : `config:${parentDir}/`;
      const parentExists = nodes.some((n) => n.id === parentId);
      if (parentExists) links.push({ source: parentId, target: fileId, type: "contain" });
      else if (hasDocs) links.push({ source: docsRoot, target: fileId, type: "contain" });
    }
  }

  // Skills（聚合为分类节点）
  if (snapshot.skills.length > 0) {
    const skillsRoot = "config:.claude/skills/";
    nodes.push({
      id: skillsRoot,
      label: `.claude/skills/ (${snapshot.skills.length})`,
      group: "Skills",
      layer: "config",
      type: "dir",
      desc: `${snapshot.skills.length} 个 Skill 目录`,
    });

    // 按类别聚合 skills
    const categories = categorizeSkills(snapshot.skills);
    for (const [cat, skills] of Object.entries(categories)) {
      const catId = `config:skills/${cat}`;
      nodes.push({
        id: catId,
        label: `${cat} (${skills.length})`,
        group: "Skills",
        layer: "config",
        type: "dir",
        desc: skills.join(", "),
      });
      links.push({ source: skillsRoot, target: catId, type: "contain" });
    }
  }

  // multi-agent/
  const maRoot = "config:multi-agent/";
  let hasMA = false;
  for (const item of snapshot.multiAgent) {
    if (item.type === "dir" && item.path === "multi-agent") {
      nodes.push({ id: maRoot, label: "multi-agent/", group: "MultiAgent", layer: "config", type: "dir", desc: "多智能体协同" });
      hasMA = true;
      continue;
    }
    if (item.type === "dir") {
      const dirId = `config:${item.path}/`;
      nodes.push({
        id: dirId,
        label: `${basename(item.path)}/`,
        group: inferConfigGroup(item.path + "/"),
        layer: "config",
        type: "dir",
        desc: `${basename(item.path)} 子目录`,
      });
      if (hasMA) links.push({ source: maRoot, target: dirId, type: "contain" });
    } else {
      const fileId = `config:${item.path}`;
      nodes.push({
        id: fileId,
        label: basename(item.path),
        group: inferConfigGroup(item.path),
        layer: "config",
        type: "file",
        desc: basename(item.path),
      });
      const parentDir = item.path.substring(0, item.path.lastIndexOf("/"));
      const parentId = parentDir === "multi-agent" ? maRoot : `config:${parentDir}/`;
      const parentExists = nodes.some((n) => n.id === parentId);
      if (parentExists) links.push({ source: parentId, target: fileId, type: "contain" });
      else if (hasMA) links.push({ source: maRoot, target: fileId, type: "contain" });
    }
  }

  // Reference 边（CLAUDE.md 引用链）
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const [source, targets] of Object.entries(snapshot.references)) {
    const sourceId = `config:${source}`;
    if (!nodeIds.has(sourceId)) continue;
    for (const target of targets) {
      // 引用可能指向数据层（0-System/）或配置层
      let targetId: string;
      if (target.startsWith("0-System/")) {
        targetId = `data:${target.replace("0-System/", "")}`;
      } else {
        targetId = `config:${target}`;
      }
      // 不验证目标存在性——引用关系即使目标不在图中也有意义，但为了干净先过滤
      // （跨层引用目标可能在其他层的节点中）
      links.push({ source: sourceId, target: targetId, type: "reference" });
    }
  }

  return { nodes, links, snapshotTime: snapshot.generatedAt };
}

// ─── Skills 分类 ────────────────────────────────────

function categorizeSkills(skills: string[]): Record<string, string[]> {
  const categories: Record<string, string[]> = {};

  const rules: Array<{ pattern: RegExp; category: string }> = [
    { pattern: /^lark-|^feishu/, category: "飞书" },
    { pattern: /collect|radar|news|theory/, category: "采集" },
    { pattern: /desktop|cc-eye|cc-lite|cc-remote/, category: "硬件" },
    { pattern: /xray|ssh|restart|fnos/, category: "运维" },
    { pattern: /netease|ncm/, category: "音乐" },
    { pattern: /design|dashboard|simplify/, category: "设计" },
    { pattern: /investigate|retro|attention|decision/, category: "分析" },
    { pattern: /scheduler|mycc|setup|loop|multi-session/, category: "系统" },
    { pattern: /skill-creator|agent-orchestration|mem0|evomap|claude-api/, category: "开发" },
    { pattern: /plan-ceo|office-hours|read-gzh|tell-me|gold/, category: "工具" },
  ];

  for (const skill of skills) {
    let matched = false;
    for (const rule of rules) {
      if (rule.pattern.test(skill)) {
        (categories[rule.category] ??= []).push(skill);
        matched = true;
        break;
      }
    }
    if (!matched) {
      (categories["其他"] ??= []).push(skill);
    }
  }

  return categories;
}

// ─── 主入口 ──────────────────────────────────────────

export function buildGraphData(
  brainRoot: string,
  dataDir: string,
  layer?: "code" | "data" | "config",
): GraphData {
  const allNodes: GraphNode[] = [];
  const allLinks: GraphLink[] = [];
  let snapshotAge: string | null = null;
  let codeCount = 0;
  let dataCount = 0;
  let configCount = 0;

  // 代码层
  if (!layer || layer === "code") {
    const srcDir = join(brainRoot, "src");
    if (existsSync(srcDir)) {
      const code = scanCodeLayer(srcDir);
      allNodes.push(...code.nodes);
      allLinks.push(...code.links);
      codeCount = code.nodes.length;
    }
  }

  // 数据层
  if (!layer || layer === "data") {
    const data = scanDataLayer(dataDir);
    allNodes.push(...data.nodes);
    allLinks.push(...data.links);
    dataCount = data.nodes.length;
  }

  // 配置层
  if (!layer || layer === "config") {
    const config = scanConfigLayer(brainRoot);
    allNodes.push(...config.nodes);
    allLinks.push(...config.links);
    configCount = config.nodes.length;
    if (config.snapshotTime) {
      const age = Date.now() - new Date(config.snapshotTime).getTime();
      const hours = Math.floor(age / 3600000);
      snapshotAge = hours < 1 ? "刚刚" : hours < 24 ? `${hours}h 前` : `${Math.floor(hours / 24)}d 前`;
    }
  }

  // 数据流边（代码层↔数据层）——仅当两层都在时
  if (!layer) {
    const nodeIds = new Set(allNodes.map((n) => n.id));
    for (const df of DATAFLOW_MAP) {
      const sourceId = `code:${df.code}`;
      const targetId = `data:${df.data}`;
      if (nodeIds.has(sourceId) && nodeIds.has(targetId)) {
        allLinks.push({ source: sourceId, target: targetId, type: "dataflow" });
      }
    }

    // 跨层 reference 边：过滤掉目标不存在的
    const finalLinks = allLinks.filter((l) => {
      if (l.type !== "reference") return true;
      return nodeIds.has(l.target as string);
    });
    allLinks.length = 0;
    allLinks.push(...finalLinks);
  }

  return {
    nodes: allNodes,
    links: allLinks,
    meta: {
      generatedAt: new Date().toISOString(),
      codeCount,
      dataCount,
      configCount,
      snapshotAge,
    },
  };
}
