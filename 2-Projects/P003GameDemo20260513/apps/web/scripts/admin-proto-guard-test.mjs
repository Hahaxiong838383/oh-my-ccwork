#!/usr/bin/env node
/**
 * admin-proto-guard-test.mjs —— 守护 localize-admin-proto.mjs「绝不在 prebuild 里覆盖现役 admin 页」
 *
 * 背景（2026-09-14）：public/admin/index.html 是现役真源（生产直接 serve），比 admin-proto/index.source.html
 * 新 23 天；旧脚本在 prebuild 无条件用原型覆盖它 → `npm run build` + `rsync --delete dist/` 会回滚生产。
 * 本测试把新行为钉死：默认模式在任何情况下都不写现役页；--regenerate 在原型更旧/现役页脏时必须拒绝。
 *
 * 用法：npm run test:admin-proto
 * 负向验证：LOCALIZE_SCRIPT=<旧版脚本> npm run test:admin-proto  → 必须变红
 *   （旧脚本不认 --root/--skip-vendor，会去动真仓文件；本测试跑前快照、每步跑后自动还原真仓现役页。）
 *
 * 用例：
 *  R1 真仓·默认模式：exit 0、现役页 md5 不变；stdout 有「无漂移」或 stderr 有「已漂移」告警
 *  R2 真仓·--regenerate：原型 git 提交早于现役页时必须 exit 1 且 md5 不变（不满足前提则跳过）
 *  F1 夹具·无漂移：现役页 == 原型产物 → 默认 exit 0、无告警、不写
 *  F2 夹具·现役页更新（手改后提交，原型旧）：默认 exit 0 不写 + 告警；--regenerate exit 1 不写
 *  F3 夹具·原型更新且现役页干净：--regenerate exit 0，现役页 = 原型产物（零 CDN、5 处 ./vendor/）
 *  F4 夹具·原型更新但现役页有未提交改动：--regenerate exit 1 不写
 *  F5 夹具·现役页含自闭合 el-table-column：默认 exit 1 不写
 *  F6 夹具·现役页缺失：默认 exit 1 不生成
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT = process.env.LOCALIZE_SCRIPT
  ? resolve(process.env.LOCALIZE_SCRIPT)
  : join(HERE, 'localize-admin-proto.mjs');
const SOURCE_REL = 'admin-proto/index.source.html';
const OUT_REL = 'public/admin/index.html';
const md5 = (s) => createHash('md5').update(s).digest('hex');
const count = (s, t) => s.split(t).length - 1;

const CDN = {
  epCss: 'https://cdn.jsdelivr.net/npm/element-plus@2.9.1/dist/index.css',
  vue: 'https://cdn.jsdelivr.net/npm/vue@3.4.21/dist/vue.global.prod.js',
  epJs: 'https://cdn.jsdelivr.net/npm/element-plus@2.9.1/dist/index.full.min.js',
  echarts: 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js',
  geo: 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json',
};

/** 最小原型：含脚本 ASSETS 表全部 5 个 CDN 引用 + 一个 XML 命名空间（验证 w3.org 不被当外链） */
function protoHtml(marker) {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<link rel="stylesheet" href="${CDN.epCss}">`,
    `<script src="${CDN.vue}"></script>`,
    `<script src="${CDN.epJs}"></script>`,
    `<script src="${CDN.echarts}"></script>`,
    '</head><body>',
    '<div id="app"><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '<el-table><el-table-column prop="a"></el-table-column></el-table>',
    `<!-- ${marker} -->`,
    '</div>',
    `<script>fetch('${CDN.geo}');</script>`,
    '</body></html>',
    '',
  ].join('\n');
}

// ---------- 运行被测脚本 ----------
function run(args, cwd = ROOT) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------- 夹具 git（与用户全局配置隔离，提交时间可控） ----------
function gitFx(dir, args, extraEnv = {}) {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=fixture',
      '-c', 'user.email=fixture@test',
      '-c', 'commit.gpgsign=false',
      '-c', `core.hooksPath=${join(dir, '.nohooks')}`,
      ...args,
    ],
    {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extraEnv },
    },
  ).trim();
}
function commitFx(dir, msg, isoDate) {
  gitFx(dir, ['add', '-A']);
  gitFx(dir, ['commit', '-q', '-m', msg], { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate });
}
const T1 = '2026-01-01T00:00:00+0800';
const T2 = '2026-01-02T00:00:00+0800';

const scratch = mkdtempSync(join(tmpdir(), 'admin-proto-guard-'));
function fixture(name) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'admin-proto'), { recursive: true });
  mkdirSync(join(dir, 'public', 'admin'), { recursive: true });
  mkdirSync(join(dir, '.nohooks'), { recursive: true });
  gitFx(dir, ['init', '-q']);
  return {
    dir,
    src: join(dir, SOURCE_REL),
    out: join(dir, OUT_REL),
    writeProto: (marker) => writeFileSync(join(dir, SOURCE_REL), protoHtml(marker)),
    readOut: () => readFileSync(join(dir, OUT_REL), 'utf8'),
    /** 用被测脚本自己生成「原型产物」形态的现役页（同时覆盖「现役页缺失 + --regenerate → 生成」分支） */
    seedOutFromProto: () => {
      const r = run(['--regenerate', '--skip-vendor', '--root', dir], dir);
      assert.equal(r.status, 0, `夹具生成现役页失败：\n${r.stdout}\n${r.stderr}`);
      assert.ok(existsSync(join(dir, OUT_REL)), '夹具：--regenerate 未生成现役页');
    },
  };
}

// ---------- 真仓现役页安全网：每次跑完若被改动，立刻还原 ----------
const REAL_OUT = join(ROOT, OUT_REL);
const realSnapshot = readFileSync(REAL_OUT, 'utf8');
const realMd5 = md5(realSnapshot);
let restoredTimes = 0;
function assertRealUntouched(label) {
  const now = existsSync(REAL_OUT) ? md5(readFileSync(REAL_OUT, 'utf8')) : '(missing)';
  if (now !== realMd5) {
    writeFileSync(REAL_OUT, realSnapshot);
    restoredTimes++;
    assert.fail(`${label}：真仓 ${OUT_REL} 被改动（md5 ${realMd5} → ${now}），已自动还原`);
  }
}
function gitEpoch(dir, rel) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', rel], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}

// ---------- 用例 ----------
const cases = [];
const c = (name, fn) => cases.push({ name, fn });

c('R1 真仓·默认模式(prebuild 路径)：不写现役页、exit 0、有漂移判定输出', () => {
  const r = run([]);
  assertRealUntouched('R1');
  assert.equal(r.status, 0, `exit=${r.status}\n${r.stderr}`);
  assert.ok(
    r.stdout.includes('无漂移') || r.stderr.includes('已漂移'),
    `缺少漂移判定输出\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  );
});

c('R2 真仓·--regenerate：原型 git 提交早于现役页 → 必须拒绝且不写', () => {
  const src = gitEpoch(ROOT, SOURCE_REL);
  const out = gitEpoch(ROOT, OUT_REL);
  if (src === null || out === null || src >= out) {
    console.log(`    （跳过：前提不成立 原型=${src} 现役=${out}）`);
    return;
  }
  const r = run(['--regenerate']);
  assertRealUntouched('R2');
  assert.equal(r.status, 1, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /拒绝重生成/);
});

c('F1 夹具·无漂移：现役页 == 原型产物 → 默认 exit 0、无告警、不写', () => {
  const fx = fixture('f1');
  fx.writeProto('v1');
  fx.seedOutFromProto();
  commitFx(fx.dir, 'proto+out', T1);
  const before = md5(fx.readOut());
  const r = run(['--skip-vendor', '--root', fx.dir], fx.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(md5(fx.readOut()), before, '默认模式不该写现役页');
  assert.ok(r.stdout.includes('无漂移'), `应报无漂移\n${r.stdout}`);
  assert.ok(!r.stderr.includes('已漂移'), `不该有漂移告警\n${r.stderr}`);
});

c('F2 夹具·现役页手改并提交、原型旧：默认不写+告警；--regenerate 拒绝', () => {
  const fx = fixture('f2');
  fx.writeProto('v1');
  fx.seedOutFromProto();
  commitFx(fx.dir, 'proto+out', T1);
  writeFileSync(fx.out, fx.readOut() + '<!-- hand edit: new feature card -->\n');
  commitFx(fx.dir, 'hand edit out', T2);
  const before = md5(fx.readOut());

  const d = run(['--skip-vendor', '--root', fx.dir], fx.dir);
  assert.equal(md5(fx.readOut()), before, '默认模式改动了现役页');
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stderr, /已漂移/);
  assert.match(d.stderr, /没有】改动/);

  const g = run(['--regenerate', '--skip-vendor', '--root', fx.dir], fx.dir);
  assert.equal(md5(fx.readOut()), before, '--regenerate 在原型更旧时改动了现役页');
  assert.equal(g.status, 1, `exit=${g.status}\n${g.stdout}\n${g.stderr}`);
  assert.match(g.stderr, /原型比现役页旧/);
});

c('F3 夹具·原型更新且现役页干净：--regenerate 写入，产物零 CDN、5 处 ./vendor/', () => {
  const fx = fixture('f3');
  fx.writeProto('v1');
  fx.seedOutFromProto();
  commitFx(fx.dir, 'proto+out', T1);
  fx.writeProto('v2-newer-proto');
  commitFx(fx.dir, 'proto v2', T2);
  const r = run(['--regenerate', '--skip-vendor', '--root', fx.dir], fx.dir);
  assert.equal(r.status, 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  const out = fx.readOut();
  assert.ok(out.includes('v2-newer-proto'), '现役页应含新原型内容');
  assert.equal(count(out, 'cdn.jsdelivr.net') + count(out, 'geo.datav.aliyun.com'), 0, '产物不应残留 CDN');
  assert.equal(count(out, './vendor/'), 5, '产物应有 5 处 ./vendor/ 引用');
  assert.ok(out.includes('http://www.w3.org/2000/svg'), 'xmlns 命名空间应原样保留');
});

c('F4 夹具·原型更新但现役页有未提交改动：--regenerate 拒绝且不写', () => {
  const fx = fixture('f4');
  fx.writeProto('v1');
  fx.seedOutFromProto();
  commitFx(fx.dir, 'proto+out', T1);
  fx.writeProto('v2');
  commitFx(fx.dir, 'proto v2', T2);
  writeFileSync(fx.out, fx.readOut() + '<!-- uncommitted parallel-session edit -->\n');
  const before = md5(fx.readOut());
  const r = run(['--regenerate', '--skip-vendor', '--root', fx.dir], fx.dir);
  assert.equal(md5(fx.readOut()), before, '现役页脏时 --regenerate 不该写');
  assert.equal(r.status, 1, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /未提交改动/);
});

c('F5 夹具·现役页含自闭合 el-table-column：默认 exit 1 且不写', () => {
  const fx = fixture('f5');
  fx.writeProto('v1');
  fx.seedOutFromProto();
  writeFileSync(fx.out, fx.readOut().replace('<el-table-column prop="a"></el-table-column>', '<el-table-column prop="a"/>'));
  commitFx(fx.dir, 'proto+broken out', T1);
  const before = md5(fx.readOut());
  const r = run(['--skip-vendor', '--root', fx.dir], fx.dir);
  assert.equal(md5(fx.readOut()), before, '默认模式不该写现役页');
  assert.equal(r.status, 1, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /自闭合/);
});

c('F6 夹具·现役页缺失：默认 exit 1、不用原型生成', () => {
  const fx = fixture('f6');
  fx.writeProto('v1');
  commitFx(fx.dir, 'proto only', T1);
  const r = run(['--skip-vendor', '--root', fx.dir], fx.dir);
  assert.equal(r.status, 1, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(!existsSync(fx.out), '默认模式不该生成现役页');
  assert.match(r.stderr, /不存在/);
});

// ---------- 执行 ----------
console.log(`admin-proto guard test · 被测脚本 ${SCRIPT}`);
console.log(`真仓现役页 ${OUT_REL} md5 ${realMd5}`);
let failed = 0;
try {
  for (const { name, fn } of cases) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
    }
  }
} finally {
  // 最后再兜一次底：不论哪一步（含旧脚本负向验证）动了真仓现役页，都还原
  if (existsSync(REAL_OUT) ? md5(readFileSync(REAL_OUT, 'utf8')) !== realMd5 : true) {
    writeFileSync(REAL_OUT, realSnapshot);
    restoredTimes++;
  }
  rmSync(scratch, { recursive: true, force: true });
}
if (restoredTimes) console.log(`  ⚠️ 真仓 ${OUT_REL} 被改动 ${restoredTimes} 次，已全部还原为 md5 ${realMd5}`);
if (failed) {
  console.error(`\n❌ admin-proto guard：${failed}/${cases.length} 用例失败`);
  process.exit(1);
}
console.log(`\n✅ admin-proto guard：${cases.length}/${cases.length} 通过（现役页 md5 ${realMd5} 全程未变）`);
