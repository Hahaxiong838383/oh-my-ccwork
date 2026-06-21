/**
 * 后台原型本地化脚本：admin-proto/index.source.html → public/admin/index.html
 *
 * 做三件事：
 * 1. 下载全部外部资产（vue / element-plus css+js / echarts / 中国地图 GeoJSON）
 *    到 public/admin/vendor/（已存在且非空则跳过，加 --force 强制重下）
 * 2. 把 HTML 里的 CDN <script>/<link> 引用替换为 ./vendor/ 相对路径
 * 3. 把运行时 fetch 的 GeoJSON 地址替换为 ./vendor/china-geo.json
 *
 * 用法：node scripts/localize-admin-proto.mjs [--force]
 * 纪律：public/admin/index.html 是脚本产物，禁止手改；改原型一律改
 *       admin-proto/index.source.html 再重跑本脚本。
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'admin-proto', 'index.source.html');
const OUT_DIR = join(ROOT, 'public', 'admin');
const VENDOR_DIR = join(OUT_DIR, 'vendor');
const FORCE = process.argv.includes('--force');

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

function localizeHtml(html) {
  let out = html;
  for (const asset of ASSETS) {
    if (!out.includes(asset.url)) {
      throw new Error(`HTML 里找不到预期引用：${asset.url}（原型结构变了？请同步更新本脚本 ASSETS 表）`);
    }
    out = out.split(asset.url).join(`./vendor/${asset.file}`);
  }
  return out;
}

mkdirSync(VENDOR_DIR, { recursive: true });
console.log('① 下载 vendor 资产…');
for (const asset of ASSETS) download(asset);

console.log('② 替换 HTML 引用…');
const html = readFileSync(SOURCE, 'utf8');
const localized = localizeHtml(html);
// 通用外链审计：产物里不允许出现任何 http(s)/协议相对外链（codex 审查 P2-1），
// 后续原型若新增 unpkg/字体/图片外链会在这里被拦下而不是静默上线
const leftover = localized.match(/(https?:)?\/\/[a-z0-9][a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi);
if (leftover) throw new Error(`仍有外部依赖残留（${leftover.length} 处）：\n${[...new Set(leftover)].join('\n')}`);
// 防自闭合吞列（2026-06-21 事故根因）：Vue 组件若被编辑器 HTML formatter 改成自闭合 `<x/>`，
// 浏览器会把后续兄弟节点解析进它内部 → 吞掉后续列（邀请码管理整片消失）。在产出前拦下。
const selfClosed = localized.match(/<(el-table-column|el-form-item|el-table|el-descriptions-item|el-tab-pane)\b[^>]*\/>/g);
if (selfClosed) {
  throw new Error(
    `❌ 产物含 ${selfClosed.length} 个自闭合 Vue 组件（会吞掉后续兄弟节点/表格列）：\n` +
      `${[...new Set(selfClosed)].slice(0, 3).join('\n')}\n` +
      `→ admin-proto/index.source.html 被自动格式化改坏了。改 source 时务必禁用编辑器的 HTML 自闭合/格式化（Vue 组件必须成对 <x></x>）。`,
  );
}
writeFileSync(join(OUT_DIR, 'index.html'), localized);
console.log(`✅ 产出 public/admin/index.html（${(localized.length / 1024).toFixed(0)} KB，零外网依赖）`);
