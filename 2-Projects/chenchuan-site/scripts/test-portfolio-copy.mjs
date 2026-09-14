/**
 * 个人站文案回归：node scripts/test-portfolio-copy.mjs
 * 只读源码及 2026-08-29 上线基线，不依赖构建、服务、数据库或生产凭据。
 * 不检查 radar 第三方资讯，也不扫描后端真实供应商接口的内部标识。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: siteRoot,
  encoding: 'utf8',
}).trim()
const repoPrefix = relative(repoRoot, siteRoot).split(sep).join('/')
const baseline = '7b9f8e8b'

const authoredData = [
  'src/data/projects.ts',
  'src/data/profile.ts',
  'src/data/timeline.ts',
  'src/data/articles.ts',
  'src/data/classic-demos.ts',
  'src/data/videos.ts',
  'src/data/patents.ts',
]
const allowedModules = new Set([
  ...authoredData,
  'src/lib/experience.ts',
  'src/lib/chat/system-prompt.ts',
  'src/lib/chat/replay-prompt.ts',
])
const moduleCache = new Map()

function sourceFor(path, revision) {
  if (!revision) return readFileSync(resolve(siteRoot, path), 'utf8')
  try {
    return execFileSync('git', ['show', `${revision}:${repoPrefix}/${path}`], {
      cwd: siteRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error(`无法读取 ${revision} 的 ${path}；请在包含上线基线的源码仓运行。`)
  }
}

function loadData(path, revision) {
  assert(allowedModules.has(path), `不允许载入非内容模块：${path}`)
  const key = `${revision ?? 'working'}:${path}`
  if (moduleCache.has(key)) return moduleCache.get(key)
  const source = sourceFor(path, revision)
  const compiled = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true,
  })
  const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  assert.equal(errors.length, 0, `${path} 语法错误：${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')}`)
  const exports = {}
  moduleCache.set(key, exports)
  vm.runInNewContext(compiled.outputText, {
    exports,
    module: { exports },
    require(specifier) {
      assert(specifier.startsWith('@/'), `内容模块不能载入外部依赖：${specifier}`)
      return loadData(`src/${specifier.slice(2)}.ts`, revision)
    },
  }, { filename: key, timeout: 1000 })
  return exports
}

function stringEntries(value, path = '') {
  if (typeof value === 'string') return [[path, value]]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => stringEntries(child, `${path}.${key}`))
}

function mediaPaths(project) {
  return [
    ...(project.images ?? []),
    ...(project.videos ?? []).flatMap((video) => [video.url, video.poster]),
  ].filter((value) => typeof value === 'string' && value && value !== '#')
}

function arxivLinks(articles) {
  return Array.from(articles).flatMap((article) =>
    Array.from(article.content.matchAll(/https:\/\/arxiv\.org\/abs\/[0-9.]+/g), (match) => match[0]),
  ).sort()
}

let passed = 0
const failures = []
function check(name, test) {
  try {
    test()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}\n${error.message}`)
  }
}

const projects = loadData('src/data/projects.ts').projects
const previousProjects = loadData('src/data/projects.ts', baseline).projects
const projectsBySlug = new Map(Array.from(projects, (project) => [project.slug, project]))
const articles = loadData('src/data/articles.ts').articles
const previousArticles = loadData('src/data/articles.ts', baseline).articles
const mirror = loadData('src/lib/chat/system-prompt.ts')
const textPrompt = mirror.getStrategicMirrorPrompt()
const voicePrompt = mirror.getStrategicMirrorVoicePrompt()

check('14 个旧项目 slug 全部保留，只新增 H 平台，无重复', () => {
  const oldSlugs = Array.from(previousProjects, (project) => project.slug)
  assert.equal(oldSlugs.length, 14, '上线基线应为 14 个项目')
  assert.equal(projectsBySlug.size, projects.length, '项目 slug 重复')
  assert.deepEqual(
    Array.from(projectsBySlug.keys()).sort(),
    [...oldSlugs, 'h-platform-ai-assistant'].sort(),
  )
})

check('首页六个精选项目顺序正确', () => {
  assert.deepEqual(Array.from(projects).filter((project) => project.featured).map((project) => project.slug), [
    'ai-hardware-voice-prototype',
    'h-platform-ai-assistant',
    'myjavis-voice-companion',
    'company-strategic-intelligence-ai',
    'evodesk-ai-work-os',
    'full-window-ar-hud-ai-cockpit',
  ])
})

check('旧项目的视频 URL、封面和图片仍在原项目；视频列表媒体保留', () => {
  for (const previous of previousProjects) {
    const current = projectsBySlug.get(previous.slug)
    assert(current, `缺少旧项目 ${previous.slug}`)
    const retained = new Set(mediaPaths(current))
    for (const path of mediaPaths(previous)) assert(retained.has(path), `${previous.slug} 丢失媒体 ${path}`)
  }
  const currentVideos = loadData('src/data/videos.ts').videos
  const oldVideos = loadData('src/data/videos.ts', baseline).videos
  const currentByUrl = new Map(Array.from(currentVideos, (video) => [video.url, video]))
  for (const oldVideo of oldVideos) {
    if (!oldVideo.url || oldVideo.url === '#') continue
    const currentVideo = currentByUrl.get(oldVideo.url)
    assert(currentVideo, `视频列表丢失 ${oldVideo.url}`)
    if (oldVideo.thumbnail) assert.equal(currentVideo.thumbnail, oldVideo.thumbnail, `${oldVideo.url} 封面变化`)
  }
})

check('关联项目不悬空，每项技术简述非空，纯文本项目字段无裸 Markdown 加粗', () => {
  for (const project of projects) {
    for (const related of project.relatedSlugs ?? []) assert(projectsBySlug.has(related), `${project.slug} 关联不存在的 ${related}`)
    assert.equal(typeof project.brief?.stack, 'string', `${project.slug} 缺少 brief.stack`)
    assert(project.brief.stack.trim(), `${project.slug} 技术简述为空`)
    assert(project.fullDescription?.trim(), `${project.slug} 详情为空`)
    for (const [path, value] of stringEntries(project, project.slug)) assert(!value.includes('**'), `${path} 裸露 Markdown 加粗`)
  }
})

check('H 详情保留记忆管理、上下文检索、Harness、隔离和后台运行机制', () => {
  const h = projectsBySlug.get('h-platform-ai-assistant')
  assert(h)
  const full = h.fullDescription
  for (const [label, pattern] of [
    ['记忆管理', /记忆[\s\S]*查看[\s\S]*修改[\s\S]*分类[\s\S]*保留期限/],
    ['偏好冲突由用户确认', /助手设定与长期偏好[\s\S]*冲突[\s\S]*用户确认/],
    ['混合检索与注入限制', /全文和向量检索[\s\S]*筛选去重[\s\S]*长度限制/],
    ['跨引擎 Harness', /Agent Harness[\s\S]*不同引擎[\s\S]*规则[\s\S]*工具[\s\S]*权限/],
    ['凭据和记忆隔离', /每个人的凭据与记忆分开/],
    ['后台任务与送达', /Worker[\s\S]*调度[\s\S]*热加载[\s\S]*待发送队列[\s\S]*发送回执/],
    ['运行阶段', /真实多用户使用[\s\S]*仍在改进/],
  ]) assert.match(full, pattern, `H 详情缺少：${label}`)
  for (const term of ['Node.js', 'SQLite', 'ai-memory', 'Bubblewrap']) assert(full.includes(term), `H 详情缺少 ${term}`)
  const details = [full, ...h.highlights].join('\n')
  assert.match(details, /执行结束与结果送达分别记录/, '不能把执行完成等同于结果送达')
  assert.match(details, /保留个人配置/, 'Harness 应保留个人定制')
  assert.match(textPrompt, /不承诺绝不丢任务或维护完全无感/, 'AI 镜像缺少运行可靠性边界')
})

check('KidsHub 与 MyJavis 详情均说明共用 Rust 全双工基座，阶段不混写', () => {
  const kids = projectsBySlug.get('ai-hardware-voice-prototype').fullDescription
  const myjavis = projectsBySlug.get('myjavis-voice-companion').fullDescription
  for (const [name, full, other] of [['KidsHub', kids, 'MyJavis'], ['MyJavis', myjavis, '小可']]) {
    assert(full.includes(other), `${name} 缺少共同基座的另一项目`)
    assert.match(full, /共用 Rust 重写的实时双向全双工/, `${name} 缺少 Rust 共用语音基座`)
    assert(full.includes('LiveKit/WebRTC'), `${name} 缺少音频传输技术`)
  }
  assert.match(kids, /成长玩法已在真机验证[\s\S]*one-shot 完成专项验收，待合包发布/)
  assert.match(kids, /长期使用[\s\S]*继续观察/, '不能把持续使用效果写成已证实')
  assert.match(myjavis, /调整主动提醒的时机/, '保留主动提醒的迭代阶段')
  assert.match(textPrompt, /不等于原生端到端语音模型/, '全双工不能夸写成端到端模型能力')
})

check('AI 文本和语音保持身份透明、发布边界与有依据的合作推荐', () => {
  for (const prompt of [textPrompt, voicePrompt]) {
    assert(prompt.includes('不是陈川本人'))
    assert(prompt.includes('待与成长玩法合包发布'))
    assert(prompt.includes('岗位匹配时明确建议进一步沟通'))
    assert(prompt.includes('明显错配时诚实说明'))
    assert(prompt.includes('不保证结果'))
  }
})

check('原有四篇文章入口及十五条 arXiv 链接完整保留', () => {
  assert.equal(previousArticles.length, 4)
  const slugs = Array.from(articles, (article) => article.slug)
  assert.equal(new Set(slugs).size, slugs.length, '文章 slug 重复')
  assert.deepEqual(slugs.sort(), Array.from(previousArticles, (article) => article.slug).sort())
  assert.equal(arxivLinks(previousArticles).length, 15)
  assert.deepEqual(arxivLinks(articles), arxivLinks(previousArticles))
})

check('本站自撰数据和 AI 讲解无禁用表述（排除第三方 radar）', () => {
  const prohibited = [
    /91[.．]5\s*%?/i,
    /Gemini/i,
    /四\s*(?:个\s*)?(?:AI\s*)?引擎/i,
    /\b(?:ERP|GEO)\b/i,
    /零返工/,
    /4\s*[-–—~～至]\s*6\s*(?:x|×|倍)/i,
  ]
  const entries = authoredData.flatMap((path) => stringEntries(loadData(path), path))
  entries.push(...stringEntries(mirror, 'AI 镜像'))
  entries.push(['AI 文本提示词', textPrompt], ['AI 语音提示词', voicePrompt])
  const replay = loadData('src/lib/chat/replay-prompt.ts')
  for (const demo of loadData('src/data/classic-demos.ts').CLASSIC_DEMOS) {
    for (const step of demo.routing) {
      entries.push([`决策示例 ${demo.id}/${step.stage}`, replay.buildReplayPrompt({ ...step, question: demo.question })])
    }
  }
  for (const [path, value] of entries) {
    for (const pattern of prohibited) assert(!pattern.test(value), `${path} 命中 ${pattern}`)
  }
})

console.log(`\n个人站文案回归：${passed} 项通过，${failures.length} 项失败。基线 ${baseline}。`)
if (failures.length) process.exitCode = 1
