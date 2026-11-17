#!/usr/bin/env node
/**
 * 微信小程序 · 上传开发版
 *
 * 用法:
 *   node scripts/upload.mjs -v 1.0.0 -d "首个版本"
 *   node scripts/upload.mjs --project ~/mp/app -v 1.0.1 -d "修复登录"
 *
 * 上传成功后在 mp.weixin.qq.com → 版本管理 → 开发版本 可见，
 * 之后在后台「提交审核」→「发布」（无 API，只能人工点）。
 */
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
    } else if (a === '-v') { out.version = argv[++i]; }
    else if (a === '-d') { out.desc = argv[++i]; }
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`上传小程序开发版

  --project <dir>   项目目录，默认当前目录
  -v, --version     版本号（必填）
  -d, --desc        版本备注
  --appid <id>      覆盖 project.config.json 的 appid
  --key <path>      代码上传密钥，默认 ~/.mycc-secrets/private.<appid>.key
  --robot <n>       CI 机器人编号 1-30，默认 1
  --info <file>     把包大小等信息写到文件
`);
  process.exit(0);
}

if (!args.version) { console.error('[x] 缺版本号：-v 1.0.0'); process.exit(2); }

const projectPath = path.resolve(args.project || process.cwd());
const cfgPath = path.join(projectPath, 'project.config.json');
if (!fs.existsSync(cfgPath)) { console.error(`[x] 找不到 ${cfgPath}`); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const appid = args.appid || cfg.appid;
if (!appid) { console.error('[x] 没有 appid'); process.exit(2); }

const keyPath = args.key || path.join(os.homedir(), '.mycc-secrets', `private.${appid}.key`);
if (!fs.existsSync(keyPath)) {
  console.error(`[x] 找不到上传密钥: ${keyPath}\n    后台生成后放这里（chmod 600）`);
  process.exit(2);
}

let ci;
try { ci = require('miniprogram-ci'); }
catch { console.error('[x] 没找到 miniprogram-ci（见 README 安装）'); process.exit(2); }

(async () => {
  const project = new ci.Project({
    appid, type: 'miniProgram', projectPath, privateKeyPath: keyPath,
    ignores: ['node_modules/**/*'],
  });
  console.log(`[*] 上传 ${path.basename(projectPath)} v${args.version} (appid=${appid}, robot=${args.robot || 1})`);
  const result = await ci.upload({
    project,
    version: String(args.version),
    desc: args.desc || '',
    setting: { es6: true, minify: true, autoPrefixWXSS: true },
    robot: Number(args.robot || 1),
    onProgressUpdate: (t) => process.stdout.write(`\r[.] ${JSON.stringify(t).slice(0, 120)}    `),
  });
  process.stdout.write('\n');
  console.log('[✓] 上传成功');
  console.log(JSON.stringify(result, null, 2));
  if (args.info) { fs.writeFileSync(args.info, JSON.stringify(result, null, 2)); console.log(`[i] 详情: ${args.info}`); }
  console.log('[i] 下一步：mp.weixin.qq.com → 版本管理 → 开发版本 → 提交审核');
})().catch((e) => {
  console.error('\n[x] 上传失败:', e && (e.message || e));
  if (String(e && e.message).match(/ip|白名单|whitelist/i)) {
    console.error('[i] 像是 IP 白名单问题：家宽 IP 会变，见 docs/PITFALLS.md 1.1');
  }
  process.exit(1);
});
