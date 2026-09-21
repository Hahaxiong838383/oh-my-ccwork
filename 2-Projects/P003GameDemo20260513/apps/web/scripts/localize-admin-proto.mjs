#!/usr/bin/env node
/**
 * localize-admin-proto.mjs —— 后台单页构建期守门（prebuild）+ 原型本地化（显式）
 *
 * ⚠️ 真源口径（2026-09-14 改口，别再按旧注释理解）：
 *   `public/admin/index.html` 是**现役真源**——生产 kidshub-ai.hahaxiong.cc/admin/ 直接 serve 它，
 *   2026-08-19（191c29763）起一直是直接手改 + 单文件 scp 部署，且页面引用的是 CDN，从来不是本脚本的产物。
 *   `admin-proto/index.source.html` 是**停更原型**（末次 cc2aa09e2，2026-08-21），比现役页少 B89 One-shot 卡 /
 *   OTA 更新说明 / 配网待认领 / 待办清单 等。旧版脚本在 prebuild 里无条件用它覆盖现役页：
 *   `npm run build` + `rsync --delete dist/` 一跑就把生产回滚（2026-09-14 发现，未发生——当前原型含
 *   2 处 svg xmlns 会先被旧外链审计当外链拦下崩掉 build，08-21 起 web build 其实一直跑不过；
 *   一旦有人顺手放行 w3.org，下一次 build 就是静默回滚）。
 *
 * 默认模式（`npm run build` 的 prebuild 自动跑）——**绝不写 public/admin/index.html**：
 *   ① 确保 vendor 资产在 public/admin/vendor/（缺则 curl 下载；--force 强制重下；--skip-vendor 跳过）
 *   ② 对现役 public/admin/index.html 跑「自闭合 Vue 组件」检查（2026-06-21 吞列事故类）→ 命中即 exit 1
 *   ③ 对比「原型本地化产物」与现役页：不同 → stderr 打印醒目告警（不改文件，exit 0，web build 照常）
 *      因此 dist/admin/index.html 永远 = 工作区的 public/admin/index.html 原样。
 *
 * 显式重生成：`node scripts/localize-admin-proto.mjs --regenerate`
 *   用原型（CDN→./vendor/ 替换后）覆盖 public/admin/index.html，四道门全过才写，否则 exit 1 不动文件：
 *   (1) 原型的 git 末次提交时间 ≥ 现役页的（原型更旧 = 回滚，拒绝；改了原型先提交再跑）
 *   (2) 现役页无未提交改动（可能是并行 session 的工作，见部署 skill 坑#4）
 *   (3) 产物零外网引用（XML 命名空间 www.w3.org 除外）
 *   (4) 产物无自闭合 Vue 组件
 *
 * 其它：--root <dir> 指定项目根（守护测试用）。守护测试：`npm run test:admin-proto`
 *   （scripts/admin-proto-guard-test.mjs，断言默认模式在任何情况下都不改现役页）。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 参数 ----------
const KNOWN_FLAGS = new Set(['--force', '--regenerate', '--skip-vendor']);
const argv = process.argv.slice(2);
let rootArg;
const flags = new Set();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') {
    rootArg = argv[++i];
    if (!rootArg) die('--root 需要一个目录参数', 2);
  } else if (KNOWN_FLAGS.has(a)) {
    flags.add(a);
  } else {
    die(`未知参数 ${a}\n用法: node scripts/localize-admin-proto.mjs [--regenerate] [--force] [--skip-vendor] [--root <dir>]`, 2);
  }
}
const ROOT = rootArg ? resolve(rootArg) : join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_REL = join('admin-proto', 'index.source.html');
const OUT_REL = join('public', 'admin', 'index.html');
const SOURCE = join(ROOT, SOURCE_REL);
const OUT = join(ROOT, OUT_REL);
const VENDOR_DIR = join(ROOT, 'public', 'admin', 'vendor');
const FORCE = flags.has('--force');
const REGENERATE = flags.has('--regenerate');
const SKIP_VENDOR = flags.has('--skip-vendor');

function die(msg, code = 1) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(code);
}
const md5 = (s) => createHash('md5').update(s).digest('hex');

// ---------- vendor 资产 ----------
/**
 * url → vendor 文件名（与 HTML 替换表一一对应）。
 * 文件名嵌版本号：nginx 对 vendor 7d 长缓存，升级依赖时文件名必变，
 * 避免同名 URL 在用户侧钉旧版 7 天（codex 审查 P1-3）。
 */
const ASSETS = [
  {
    url: 'https://cdn.jsdelivr.net/npm/vue@3.4.21/dist/vue.global.prod.js',
    file: 'vue-3.4.21.global.prod.js',
    minBytes: 100_000,
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/element-plus@2.9.1/dist/index.css',
    file: 'element-plus-2.9.1.css',
    minBytes: 200_000,
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/element-plus@2.9.1/dist/index.full.min.js',
    file: 'element-plus-2.9.1.full.min.js',
    minBytes: 500_000,
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js',
    file: 'echarts-5.5.0.min.js',
    minBytes: 500_000,
  },
  {
    url: 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json',
    file: 'china-geo-v3.json',
    minBytes: 500_000,
  },
];

function download(asset) {
  const dest = join(VENDOR_DIR, asset.file);
  if (!FORCE && existsSync(dest) && statSync(dest).size >= asset.minBytes) {
    console.log(`  ↻ 已存在，跳过：${asset.file}`);
    return;
  }
  console.log(`  ↓ 下载：${asset.url}`);
  // curl 走 shell 代理环境变量（node fetch 不认 HTTPS_PROXY，故用 curl）；
  // 先落 .tmp 校验通过再 rename——中断/半成品不污染正式文件（codex 审查 P2-2）
  const tmp = `${dest}.tmp`;
  try {
    execFileSync('curl', ['-fsSL', '--retry', '2', '-o', tmp, asset.url], { stdio: 'inherit' });
    const size = statSync(tmp).size;
    if (size < asset.minBytes) {
      throw new Error(`${asset.file} 下载产物过小（${size}B < ${asset.minBytes}B），疑似被劫持/错误页`);
    }
    renameSync(tmp, dest);
    console.log(`  ✓ ${asset.file}（${(size / 1024).toFixed(0)} KB）`);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ---------- 纯函数：本地化 + 审计 ----------
function localizeHtml(html) {
  let out = html;
  for (const asset of ASSETS) {
    if (!out.includes(asset.url)) {
      throw new Error(`原型里找不到预期引用：${asset.url}（原型结构变了？请同步更新本脚本 ASSETS 表）`);
    }
    out = out.split(asset.url).join(`./vendor/${asset.file}`);
  }
  return out;
}

/** 外链审计：http(s)/协议相对外链去重列表；XML 命名空间（xmlns="http://www.w3.org/…"）不是网络请求，排除。 */
function externalRefs(html) {
  const hits = html.match(/(https?:)?\/\/[a-z0-9][a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi) ?? [];
  return [...new Set(hits)].filter((u) => !/^https?:\/\/www\.w3\.org\//i.test(u));
}

/**
 * 防自闭合吞列（2026-06-21 事故根因）：Vue 组件若被编辑器 HTML formatter 改成自闭合 `<x/>`，
 * 浏览器会把后续兄弟节点解析进它内部 → 吞掉后续列（邀请码管理整片消失）。
 */
function selfClosedVueTags(html) {
  return html.match(/<(el-table-column|el-form-item|el-table|el-descriptions-item|el-tab-pane)\b[^>]*\/>/g) ?? [];
}

// ---------- git 辅助（拿不到一律返回 null，调用方按「无法判定」处理） ----------
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
function gitLastCommit(relPath) {
  const out = git(['log', '-1', '--format=%ct%x09%h%x09%ci', '--', relPath]);
  if (!out) return null;
  const [ct, hash, date] = out.split('\t');
  return { epoch: Number(ct), hash, date };
}
/** true=有未提交改动（含未跟踪）；false=干净；null=git 不可用 */
function gitDirty(relPath) {
  const out = git(['status', '--porcelain', '--', relPath]);
  return out === null ? null : out.length > 0;
}
/** 覆盖 current → next 的行数账：deleted=现役会丢的行，added=原型会带回的行；git 不可用返回 null */
function diffNumstat(current, next) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-proto-diff-'));
  try {
    const a = join(dir, 'current.html');
    const b = join(dir, 'next.html');
    writeFileSync(a, current);
    writeFileSync(b, next);
    let out = '';
    try {
      out = execFileSync('git', ['diff', '--no-index', '--numstat', '--', a, b], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err) {
      out = err?.stdout?.toString() ?? ''; // 文件不同 git diff 退出码 1，numstat 仍在 stdout
    }
    const m = out.match(/^(\d+)\t(\d+)\t/m);
    return m ? { added: Number(m[1]), deleted: Number(m[2]) } : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const fmtCommit = (c) => (c ? `${c.hash} ${c.date}` : '（git 无记录）');
const daysBetween = (a, b) => ((b - a) / 86_400).toFixed(1);

// ---------- 主流程 ----------
if (SKIP_VENDOR) {
  console.log('① vendor 资产：--skip-vendor 跳过');
} else {
  mkdirSync(VENDOR_DIR, { recursive: true });
  console.log('① 确认 vendor 资产…');
  for (const asset of ASSETS) download(asset);
}

const currentExists = existsSync(OUT);
const current = currentExists ? readFileSync(OUT, 'utf8') : null;

let generated = null;
let protoError = null;
if (!existsSync(SOURCE)) {
  protoError = `原型不存在：${SOURCE_REL}`;
} else {
  try {
    generated = localizeHtml(readFileSync(SOURCE, 'utf8'));
  } catch (err) {
    protoError = err.message;
  }
}

if (!REGENERATE) {
  // ===== 默认模式（prebuild）：只守门，不写现役页 =====
  if (!currentExists) {
    die(
      `${OUT_REL} 不存在。它是现役真源（git 跟踪、生产直接 serve），本脚本不会用停更原型替它生成。\n` +
        `   恢复：git checkout -- ${OUT_REL}\n` +
        `   确要从原型生成（会得到 2026-08-21 的旧页面）：加 --regenerate`,
    );
  }
  console.log(`② 检查现役 ${OUT_REL}（${(current.length / 1024).toFixed(0)} KB，md5 ${md5(current)}）…`);
  const bad = selfClosedVueTags(current);
  if (bad.length) {
    die(
      `现役 ${OUT_REL} 含 ${bad.length} 个自闭合 Vue 组件（会吞掉后续兄弟节点/表格列）：\n` +
        `${[...new Set(bad)].slice(0, 3).join('\n')}\n` +
        `→ 多半是编辑器 HTML 自闭合/格式化改坏的。Vue 组件必须成对 <x></x>，修好再 build。`,
    );
  }
  const ext = externalRefs(current);
  if (ext.length) {
    console.log(`  ℹ️ 现役页含 ${ext.length} 处外网引用（历史如此：页面直接用 CDN，未走本地化）：\n    ${ext.join('\n    ')}`);
  }

  console.log('③ 对比原型本地化产物 vs 现役页…');
  if (protoError) {
    console.warn(`  ⚠️ 原型不可用，跳过对比：${protoError}`);
  } else if (generated === current) {
    console.log('  ✅ 现役页 == 原型本地化产物（无漂移）');
  } else {
    const src = gitLastCommit(SOURCE_REL);
    const out = gitLastCommit(OUT_REL);
    const stat = diffNumstat(current, generated);
    const age =
      src && out && out.epoch > src.epoch ? `（比现役页旧 ${daysBetween(src.epoch, out.epoch)} 天）` : '';
    console.warn(
      [
        '',
        '┌─ ⚠️  admin 原型已漂移——本脚本【没有】改动 public/admin/index.html ─────────────',
        `│ 现役真源 ${OUT_REL}`,
        `│     md5 ${md5(current)}  git ${fmtCommit(out)}`,
        `│ 停更原型 ${SOURCE_REL}`,
        `│     产物 md5 ${md5(generated)}  git ${fmtCommit(src)}${age}`,
        stat
          ? `│ 若用原型覆盖：现役页会丢 ${stat.deleted} 行、带回旧内容 ${stat.added} 行 = 回滚生产功能`
          : '│ 若用原型覆盖：现役页内容会被旧原型替换 = 回滚生产功能',
        `│ 本次 build 的 dist/admin/index.html = 现役页原样（安全）。`,
        `│ 想让原型重新成为真源：把改动合进 ${SOURCE_REL} 并提交后，显式跑`,
        '│     node scripts/localize-admin-proto.mjs --regenerate',
        '└──────────────────────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
  }
  console.log(`✅ 守门通过，${OUT_REL} 未改动`);
  process.exit(0);
}

// ===== --regenerate：显式用原型覆盖现役页，四道门 =====
if (protoError) die(`无法从原型生成：${protoError}`);
console.log('② --regenerate 门控…');
if (currentExists) {
  if (generated === current) {
    console.log(`  ✅ 现役页已与原型本地化产物一致，无需重生成`);
    process.exit(0);
  }
  const src = gitLastCommit(SOURCE_REL);
  const out = gitLastCommit(OUT_REL);
  if (!src || !out) {
    die(
      `无法用 git 判定原型与现役页谁更新（原型 ${fmtCommit(src)} / 现役 ${fmtCommit(out)}）。\n` +
        `   两个文件都必须已提交且 git 可用，才允许重生成。`,
    );
  }
  if (src.epoch < out.epoch) {
    const stat = diffNumstat(current, generated);
    die(
      `拒绝重生成：原型比现役页旧 ${daysBetween(src.epoch, out.epoch)} 天，覆盖 = 回滚生产功能。\n` +
        `   原型 ${SOURCE_REL}  ${fmtCommit(src)}\n` +
        `   现役 ${OUT_REL}  ${fmtCommit(out)}\n` +
        (stat ? `   覆盖将丢掉现役页 ${stat.deleted} 行、带回旧内容 ${stat.added} 行。\n` : '') +
        `   要走原型路线：先把现役页的改动合进原型并提交（提交时间要晚于现役页），再跑本命令。`,
    );
  }
  const dirty = gitDirty(OUT_REL);
  if (dirty !== false) {
    die(
      dirty === null
        ? `无法判定 ${OUT_REL} 是否有未提交改动（git 不可用），拒绝覆盖。`
        : `${OUT_REL} 有未提交改动（可能是并行 session 的工作），拒绝覆盖。先提交或还原它再跑。`,
    );
  }
}
console.log('③ 审计产物…');
const leftover = externalRefs(generated);
if (leftover.length) {
  die(`产物仍有外部依赖残留（${leftover.length} 处）：\n${leftover.join('\n')}`);
}
const selfClosed = selfClosedVueTags(generated);
if (selfClosed.length) {
  die(
    `产物含 ${selfClosed.length} 个自闭合 Vue 组件（会吞掉后续兄弟节点/表格列）：\n` +
      `${[...new Set(selfClosed)].slice(0, 3).join('\n')}\n` +
      `→ ${SOURCE_REL} 被自动格式化改坏了。改原型时务必禁用编辑器的 HTML 自闭合/格式化（Vue 组件必须成对 <x></x>）。`,
  );
}
mkdirSync(dirname(OUT), { recursive: true });
const stat = currentExists ? diffNumstat(current, generated) : null;
writeFileSync(OUT, generated);
console.log(
  `✅ 已用原型重生成 ${OUT_REL}（${(generated.length / 1024).toFixed(0)} KB，md5 ${md5(generated)}，零外网依赖）` +
    (stat ? `，相对原现役页 +${stat.added} / -${stat.deleted} 行` : ''),
);
