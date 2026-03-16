/**
 * URL 内容预取器
 *
 * CLI 引擎（codex/gemini）无法直接访问外部 URL，
 * 本模块在发送 prompt 前预取内容，注入到 prompt 中。
 *
 * 支持：
 * - GitHub 仓库：shallow clone → 提取 README + 目录树 + 关键源码
 * - GitHub 文件/PR/Issue：通过 GitHub API 获取内容
 * - 通用网页：fetch HTML → 提取正文
 *
 * 2026-03-15: 初始实现
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from "fs";
import { join, basename, extname } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// ============================================================
// URL 检测
// ============================================================

/** GitHub 仓库 URL 模式（排除 Markdown 括号和常见标点） */
const GITHUB_REPO_RE = /https?:\/\/github\.com\/([^\/\s\)]+)\/([^\/\s#?\)]+)/;

/** 通用 URL 模式（排除 Markdown 尾部括号） */
const URL_RE = /https?:\/\/[^\s\)\]]+/gi;

export interface UrlContent {
  url: string;
  type: "github-repo" | "webpage" | "pdf";
  content: string;
}

/** 预取到的 PDF 二进制（供 Gemini 原生处理） */
export interface FetchedMedia {
  data: Buffer;
  mimeType: string;
  url: string;
}

export interface FetchResult {
  /** 原始消息中 URL 替换为内容后的 prompt */
  enrichedPrompt: string;
  /** 是否有内容被注入 */
  hasContent: boolean;
  /** 预取到的内容条目 */
  items: UrlContent[];
  /** 预取到的二进制文件（PDF 等，供 Gemini 多模态处理） */
  mediaBuffers?: FetchedMedia[];
}

/**
 * 检测消息中的 URL 并预取内容，注入到 prompt 中。
 *
 * @param message 用户原始消息
 * @returns 增强后的 prompt
 */
export async function fetchUrlContent(message: string): Promise<FetchResult> {
  // 从 Markdown 链接 [text](url) 和普通文本中提取 URL
  const rawUrls: string[] = [];

  // 先提取 Markdown 链接中的 URL
  const mdLinkRe = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdLinkRe.exec(message)) !== null) {
    rawUrls.push(mdMatch[2]);
  }

  // 再提取普通文本中的 URL（可能有重叠，后面去重）
  const plainUrls = message.match(URL_RE);
  if (plainUrls) {
    rawUrls.push(...plainUrls);
  }

  // 清理 URL 末尾的常见标点污染
  const cleanedUrls = rawUrls.map((u) =>
    u.replace(/[)}\]>,;:。，、！？]+$/, "").replace(/\.+$/, ""),
  );

  if (cleanedUrls.length === 0) {
    return { enrichedPrompt: message, hasContent: false, items: [] };
  }

  // 去重
  const uniqueUrls = Array.from(new Set(cleanedUrls));
  const items: UrlContent[] = [];
  const fetchedMedias: FetchedMedia[] = [];

  for (const url of uniqueUrls.slice(0, 3)) { // 最多处理 3 个 URL
    try {
      // PDF 检测：URL 以 .pdf 结尾 或 arxiv.org/pdf/ 模式
      if (isPdfUrl(url)) {
        const pdfResult = await fetchPdf(url);
        if (pdfResult) {
          fetchedMedias.push(pdfResult);
          // 同时尝试获取摘要页（arXiv abs 页面）作为文本补充
          const absUrl = getArxivAbsUrl(url);
          if (absUrl) {
            const absContent = await fetchWebpage(absUrl);
            if (absContent) {
              items.push({ url: absUrl, type: "webpage", content: absContent });
            }
          }
        }
        continue;
      }

      const ghMatch = url.match(GITHUB_REPO_RE);
      if (ghMatch) {
        const content = await fetchGitHubRepo(ghMatch[1], ghMatch[2], url);
        if (content) {
          items.push({ url, type: "github-repo", content });
        }
      } else {
        const content = await fetchWebpage(url);
        if (content) {
          items.push({ url, type: "webpage", content });
        }
      }
    } catch (err: any) {
      console.error(`[UrlFetcher] 预取失败 ${url}:`, err.message);
    }
  }

  if (items.length === 0 && fetchedMedias.length === 0) {
    return { enrichedPrompt: message, hasContent: false, items: [] };
  }

  // 构建增强 prompt：在消息前注入预取内容
  let enrichedPrompt = message;
  if (items.length > 0) {
    const contentBlock = items.map((item) => {
      const labelMap = { "github-repo": "GitHub 仓库内容", "webpage": "网页内容", "pdf": "PDF 内容" };
      const label = labelMap[item.type] || "预取内容";
      return `[${label}: ${item.url}]\n${item.content}\n[/${label}]`;
    }).join("\n\n");
    enrichedPrompt = `${contentBlock}\n\n---\n\n${message}`;
  }

  // PDF 提示：告知引擎 PDF 已作为附件传入
  if (fetchedMedias.length > 0) {
    const pdfHint = fetchedMedias.map(m =>
      `[已附带 PDF 文件: ${m.url} (${(m.data.length / 1024).toFixed(0)}KB)]`
    ).join("\n");
    enrichedPrompt = `${pdfHint}\n\n${enrichedPrompt}`;
  }

  console.log(
    `[UrlFetcher] 预取完成: ${items.length} 个文本 URL + ${fetchedMedias.length} 个 PDF, ` +
    `总内容长度: ${enrichedPrompt.length - message.length} 字符`
  );

  return {
    enrichedPrompt,
    hasContent: true,
    items,
    mediaBuffers: fetchedMedias.length > 0 ? fetchedMedias : undefined,
  };
}

// ============================================================
// GitHub 仓库预取
// ============================================================

/** 值得提取的源码扩展名 */
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".swift", ".kt",
  ".vue", ".svelte", ".lua", ".sh", ".bash", ".zsh",
]);

/** 需要跳过的目录 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "__pycache__",
  ".next", ".nuxt", "vendor", "venv", ".venv", "coverage",
  ".cache", ".turbo", ".output",
]);

/**
 * Shallow clone GitHub 仓库，提取关键内容。
 *
 * 提取内容（按优先级）：
 * 1. README.md（完整）
 * 2. 目录树（2 层深度）
 * 3. 关键源码文件（入口文件、核心模块，总量限制 8000 字符）
 */
async function fetchGitHubRepo(
  owner: string,
  repo: string,
  originalUrl: string,
): Promise<string | null> {
  // 清理 repo 名（去掉 .git 后缀等）
  const cleanRepo = repo.replace(/\.git$/, "");
  const cloneUrl = `https://github.com/${owner}/${cleanRepo}.git`;
  const tmpDir = join(tmpdir(), `cc-github-${randomUUID().substring(0, 8)}`);

  console.log(`[UrlFetcher][GitHub] Cloning ${owner}/${cleanRepo} → ${tmpDir}`);

  try {
    mkdirSync(tmpDir, { recursive: true });

    // shallow clone（最小化下载，30s 超时）
    execSync(
      `git clone --depth 1 --single-branch ${cloneUrl} ${tmpDir}`,
      { timeout: 30_000, stdio: "pipe" },
    );

    const parts: string[] = [];

    // 1. README
    const readme = findReadme(tmpDir);
    if (readme) {
      const readmeContent = readFileSync(readme, "utf-8");
      const trimmed = readmeContent.length > 3000
        ? readmeContent.substring(0, 3000) + "\n...(README 截断)"
        : readmeContent;
      parts.push(`## README\n\n${trimmed}`);
    }

    // 2. 目录树（2 层）
    const tree = buildTree(tmpDir, 2);
    parts.push(`## 目录结构\n\n\`\`\`\n${tree}\n\`\`\``);

    // 3. 关键源码
    const sourceFiles = findKeySourceFiles(tmpDir);
    if (sourceFiles.length > 0) {
      const sourceBlock = sourceFiles.map((f) => {
        const rel = f.path.replace(tmpDir + "/", "");
        return `### ${rel}\n\n\`\`\`${extname(f.path).slice(1)}\n${f.content}\n\`\`\``;
      }).join("\n\n");
      parts.push(`## 关键源码\n\n${sourceBlock}`);
    }

    // 4. package.json / pyproject.toml / go.mod（项目元信息）
    const metaFiles = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml"];
    for (const mf of metaFiles) {
      const metaPath = join(tmpDir, mf);
      if (existsSync(metaPath)) {
        const metaContent = readFileSync(metaPath, "utf-8");
        const trimmed = metaContent.length > 1500
          ? metaContent.substring(0, 1500) + "\n...(截断)"
          : metaContent;
        parts.push(`## ${mf}\n\n\`\`\`\n${trimmed}\n\`\`\``);
        break; // 只取第一个匹配的
      }
    }

    const result = parts.join("\n\n");

    // 总量控制：最多 12000 字符
    if (result.length > 12000) {
      return result.substring(0, 12000) + "\n\n...(内容截断，仅展示关键部分)";
    }

    return result;
  } catch (err: any) {
    console.error(`[UrlFetcher][GitHub] Clone 失败:`, err.message?.substring(0, 200));
    // 降级：尝试通过 GitHub API 获取基本信息
    return fetchGitHubApiInfo(owner, cleanRepo);
  } finally {
    // 清理临时目录
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 静默
    }
  }
}

/** 查找 README 文件（大小写不敏感） */
function findReadme(dir: string): string | null {
  const candidates = ["README.md", "readme.md", "Readme.md", "README.rst", "README.txt", "README"];
  for (const name of candidates) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 构建目录树（指定深度）。
 */
function buildTree(dir: string, maxDepth: number, prefix: string = "", depth: number = 0): string {
  if (depth >= maxDepth) return "";

  const entries = readdirSync(dir).filter((name) => {
    return !name.startsWith(".") && !SKIP_DIRS.has(name);
  }).sort();

  const lines: string[] = [];
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) dirs.push(entry);
      else files.push(entry);
    } catch {
      files.push(entry);
    }
  }

  // 先输出目录
  for (const d of dirs) {
    lines.push(`${prefix}${d}/`);
    const sub = buildTree(join(dir, d), maxDepth, prefix + "  ", depth + 1);
    if (sub) lines.push(sub);
  }

  // 再输出文件（最多 20 个）
  for (const f of files.slice(0, 20)) {
    lines.push(`${prefix}${f}`);
  }
  if (files.length > 20) {
    lines.push(`${prefix}... (${files.length - 20} more files)`);
  }

  return lines.join("\n");
}

interface SourceFile {
  path: string;
  content: string;
}

/**
 * 找到关键源码文件并读取内容。
 *
 * 优先级：
 * 1. 入口文件（index.ts, main.py, main.go 等）
 * 2. src/ 或 lib/ 下的顶层文件
 * 3. 其他源码文件
 *
 * 总内容限制 8000 字符。
 */
function findKeySourceFiles(rootDir: string): SourceFile[] {
  const entryNames = new Set([
    "index.ts", "index.js", "main.ts", "main.js", "main.py", "main.go",
    "app.ts", "app.js", "app.py", "server.ts", "server.js",
    "mod.rs", "lib.rs", "main.rs",
  ]);

  const allFiles: Array<{ path: string; priority: number }> = [];

  function walk(dir: string, depth: number): void {
    if (depth > 4) return;
    const entries = readdirSync(dir).filter((n) => !n.startsWith(".") && !SKIP_DIRS.has(n));

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (SOURCE_EXTS.has(extname(entry)) && stat.size < 50_000) {
          let priority = 3;
          const lowerEntry = entry.toLowerCase();
          if (entryNames.has(lowerEntry)) priority = 1;
          else if (dir.includes("/src") || dir.includes("/lib")) priority = 2;
          allFiles.push({ path: fullPath, priority });
        }
      } catch {
        // skip
      }
    }
  }

  walk(rootDir, 0);

  // 按优先级排序
  allFiles.sort((a, b) => a.priority - b.priority);

  const result: SourceFile[] = [];
  let totalChars = 0;
  const MAX_SOURCE_CHARS = 8000;
  const MAX_FILE_CHARS = 2000;

  for (const f of allFiles) {
    if (totalChars >= MAX_SOURCE_CHARS) break;
    if (result.length >= 8) break; // 最多 8 个文件

    try {
      let content = readFileSync(f.path, "utf-8");
      if (content.length > MAX_FILE_CHARS) {
        content = content.substring(0, MAX_FILE_CHARS) + "\n// ...(文件截断)";
      }
      result.push({ path: f.path, content });
      totalChars += content.length;
    } catch {
      // skip
    }
  }

  return result;
}

// ============================================================
// GitHub API 降级（clone 失败时）
// ============================================================

async function fetchGitHubApiInfo(owner: string, repo: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { "User-Agent": "mycc-bot" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;

    const parts = [
      `## ${data.full_name}`,
      data.description ? `\n${data.description}` : "",
      `\n- Language: ${data.language || "N/A"}`,
      `- Stars: ${data.stargazers_count}`,
      `- Forks: ${data.forks_count}`,
      `- Last updated: ${data.updated_at}`,
      data.topics?.length > 0 ? `- Topics: ${data.topics.join(", ")}` : "",
    ];

    // 尝试获取 README
    try {
      const readmeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/readme`,
        { headers: { "User-Agent": "mycc-bot", "Accept": "application/vnd.github.v3.raw" }, signal: AbortSignal.timeout(10_000) },
      );
      if (readmeRes.ok) {
        const readmeText = await readmeRes.text();
        const trimmed = readmeText.length > 3000
          ? readmeText.substring(0, 3000) + "\n...(README 截断)"
          : readmeText;
        parts.push(`\n## README\n\n${trimmed}`);
      }
    } catch {
      // 静默
    }

    return parts.filter(Boolean).join("\n");
  } catch (err: any) {
    console.error(`[UrlFetcher][GitHub API] 降级也失败:`, err.message);
    return null;
  }
}

// ============================================================
// PDF 预取
// ============================================================

/** 检测 URL 是否指向 PDF 文件 */
function isPdfUrl(url: string): boolean {
  const lower = url.toLowerCase();
  // 直接 .pdf 结尾
  if (lower.endsWith(".pdf")) return true;
  // arXiv PDF 页面：arxiv.org/pdf/xxxx
  if (/arxiv\.org\/pdf\//i.test(lower)) return true;
  return false;
}

/** arXiv PDF URL → abs URL（获取摘要页） */
function getArxivAbsUrl(url: string): string | null {
  const match = url.match(/arxiv\.org\/pdf\/([^\s?#]+)/i);
  if (match) {
    // 去掉 .pdf 后缀（如果有）
    const id = match[1].replace(/\.pdf$/i, "");
    return `https://arxiv.org/abs/${id}`;
  }
  return null;
}

/**
 * 下载 PDF 文件（作为二进制 buffer）。
 * Gemini API 原生支持 PDF 解析。
 * 限制 20MB，超过则跳过。
 */
async function fetchPdf(url: string): Promise<FetchedMedia | null> {
  const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20MB
  try {
    console.log(`[UrlFetcher][PDF] 下载: ${url}`);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; mycc-bot/1.0)",
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "follow",
    });

    if (!res.ok) {
      console.error(`[UrlFetcher][PDF] HTTP ${res.status}: ${url}`);
      return null;
    }

    const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_PDF_SIZE) {
      console.warn(`[UrlFetcher][PDF] 文件过大 (${(contentLength / 1024 / 1024).toFixed(1)}MB)，跳过: ${url}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    if (data.length > MAX_PDF_SIZE) {
      console.warn(`[UrlFetcher][PDF] 下载后文件过大 (${(data.length / 1024 / 1024).toFixed(1)}MB)，跳过`);
      return null;
    }

    console.log(`[UrlFetcher][PDF] 下载完成: ${(data.length / 1024).toFixed(0)}KB`);
    return { data, mimeType: "application/pdf", url };
  } catch (err: any) {
    console.error(`[UrlFetcher][PDF] 下载失败 ${url}:`, err.message);
    return null;
  }
}

// ============================================================
// 通用网页预取
// ============================================================

/**
 * 获取网页内容（提取正文，去除 HTML 标签）。
 * 简化版，不引入 cheerio 等依赖。
 */
async function fetchWebpage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; mycc-bot/1.0)",
        "Accept": "text/html,application/xhtml+xml,text/plain",
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    // 只处理文本类型
    if (!contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
      return null;
    }

    let text = await res.text();

    // 简单 HTML → 纯文本转换
    if (contentType.includes("html")) {
      // 移除 script/style/nav/header/footer
      text = text.replace(/<(script|style|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, "");
      // 移除 HTML 标签
      text = text.replace(/<[^>]+>/g, " ");
      // 解码 HTML 实体
      text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
      // 压缩空白
      text = text.replace(/\s+/g, " ").trim();
    }

    // 限制长度
    if (text.length > 5000) {
      text = text.substring(0, 5000) + "\n...(内容截断)";
    }

    return text || null;
  } catch (err: any) {
    console.error(`[UrlFetcher][Webpage] 获取失败 ${url}:`, err.message);
    return null;
  }
}
