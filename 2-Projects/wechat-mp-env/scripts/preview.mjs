#!/usr/bin/env node
/**
 * 微信小程序 · 预览（生成二维码，手机扫）
 *
 * 用法:
 *   node scripts/preview.mjs                       # 在当前目录找 project.config.json
 *   node scripts/preview.mjs --project ~/mp/app
 *   node scripts/preview.mjs --page pages/index/index --query "a=1"
 *   node scripts/preview.mjs --out /tmp/qr.png
 *
 * 依赖: mp-env 里装的 miniprogram-ci（全局共享，不必每个项目装）
 * 凭证: 代码上传密钥，默认 ~/.mycc-secrets/private.<appid>.key
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`预览小程序并生成二维码

  --project <dir>   项目目录（含 project.config.json），默认当前目录
  --appid <id>      覆盖 project.config.json 里的 appid
  --key <path>      代码上传密钥，默认 ~/.mycc-secrets/private.<appid>.key
  --out <file>      二维码输出路径，默认 /data/home-studio/artifacts/<项目>/preview-<ts>.png
  --page <path>     预览指定页面
  --query <str>     预览参数，如 "a=1&b=2"
  --robot <n>       CI 机器人编号 1-30，默认 1
  --desc <text>     备注
`);
  process.exit(0);
}

const projectPath = path.resolve(args.project || process.cwd());
const cfgPath = path.join(projectPath, 'project.config.json');
if (!fs.existsSync(cfgPath)) {
  console.error(`[x] 找不到 ${cfgPath}\n    先进入小程序项目目录，或用 --project 指定`);
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const appid = args.appid || cfg.appid;
if (!appid) { console.error('[x] project.config.json 里没有 appid，用 --appid 指定'); process.exit(2); }

const keyPath = args.key || path.join(os.homedir(), '.mycc-secrets', `private.${appid}.key`);
if (!fs.existsSync(keyPath)) {
  console.error(`[x] 找不到上传密钥: ${keyPath}\n    在 mp.weixin.qq.com → 开发管理 → 开发设置 → 小程序代码上传 生成后放到该路径（600）`);
  process.exit(2);
}

const projName = cfg.projectname || path.basename(projectPath);
const outDir = path.join('/data/home-studio/artifacts', projName);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const qrOut = args.out || path.join(outDir, `preview-${stamp}.png`);
fs.mkdirSync(path.dirname(qrOut), { recursive: true });

let ci;
try {
  ci = require('miniprogram-ci');
} catch {
  console.error('[x] 没找到 miniprogram-ci。先在 mp-env 里 npm/pnpm install（见 README）');
  process.exit(2);
}

(async () => {
  const project = new ci.Project({
    appid, type: 'miniProgram', projectPath, privateKeyPath: keyPath,
    ignores: ['node_modules/**/*'],
  });
  console.log(`[*] 项目: ${projectPath}\n[*] appid: ${appid}\n[*] 二维码: ${qrOut}`);
  const result = await ci.preview({
    project,
    desc: args.desc || `preview ${stamp}`,
    setting: { es6: true, minify: false },
    robot: Number(args.robot || 1),
    qrcodeFormat: 'image',
    qrcodeOutputDest: qrOut,
    ...(args.page ? { pagePath: args.page } : {}),
    ...(args.query ? { searchQuery: args.query } : {}),
    onProgressUpdate: (t) => process.stdout.write(`\r[.] ${JSON.stringify(t).slice(0, 120)}    `),
  });
  process.stdout.write('\n');
  console.log('[✓] 预览完成');
  console.log(JSON.stringify(result, null, 2));
  console.log(`[i] 手机微信扫码: ${qrOut}`);
})().catch((e) => {
  console.error('\n[x] 预览失败:', e && (e.message || e));
  process.exit(1);
});
