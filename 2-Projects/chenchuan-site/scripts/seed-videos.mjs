#!/usr/bin/env node
// 一次性 seed 视频库（managed_videos 表）。幂等：INSERT OR IGNORE，不覆盖 admin 已编辑的条目。
// 用法：node scripts/seed-videos.mjs   （在项目根，自动定位 data/analytics.db）
// 生产：在 VPS /var/www/chenchuan-site 下跑一次即可。
import Database from 'better-sqlite3'
import { resolve, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

const DB_PATH = process.env.ANALYTICS_DB_PATH || resolve(process.cwd(), 'data/analytics.db')
mkdirSync(dirname(DB_PATH), { recursive: true })
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

// 与 src/lib/analytics/db.ts 同 schema（幂等建表，独立于 app 也能跑）
db.exec(`
  CREATE TABLE IF NOT EXISTS managed_videos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    url TEXT NOT NULL,
    thumbnail TEXT,
    duration TEXT,
    tags TEXT,
    project_slug TEXT,
    published INTEGER DEFAULT 1,
    sort INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_managed_videos_published ON managed_videos(published);
  CREATE INDEX IF NOT EXISTS idx_managed_videos_sort ON managed_videos(sort);
`)

const MIMIC_DESC = '2018 年协作机械臂 Mimic 镜像交互原型——手部动作实时映射到机械臂关节。'
const MIMIC_TAGS = ['机械臂', 'Mimic 交互', '人机协作']
const mimic = (n, file, duration) => ({
  id: `mimic-${n}`,
  title: `Mimic 机械臂镜像交互 · 演示 ${n}`,
  description: MIMIC_DESC,
  url: `/media/mimic-robot/${file}`,
  thumbnail: '',
  duration,
  tags: MIMIC_TAGS,
  project_slug: 'robotic-arm-icecream',
  published: 1,
  sort: 20 + n,
})

const VIDEOS = [
  // RK3588 端侧多模态识别（生产已上线，sort=-1 稳定置顶）
  { id: 'rk3588-edge-multimodal', title: 'RK3588 端侧多模态边缘计算', description: '基于 RK3588 部署端侧多模态模型，采用 InspireFace 检测级联 HSEmotion-b2 表情识别，在本地实现毫秒级表情、坐姿等状态识别与实时反馈。', url: '/media/edge-ai/rk3588-expression-posture-recognition.mp4', thumbnail: '/media-posters/edge-ai/rk3588-expression-posture-recognition.jpg', duration: '0:24', tags: ['RK3588', '端侧 AI', '多模态识别', '边缘计算'], project_slug: null, published: 1, sort: -1 },
  // 眼动+手势（已接通）→ 眼动多模态项目
  { id: 'eye-1', title: '眼动+手势 多模态交互演示 1', description: '基于 FaceMesh 眼动追踪与手势识别的多模态交互原型，展示注视预选与捏住抓取的融合交互。', url: '/media/eye-gesture-interaction/20260319-090647.mp4', thumbnail: '', duration: '0:27', tags: ['眼动追踪', '手势交互', '多模态'], project_slug: 'eye-gesture-multimodal', published: 1, sort: 1 },
  { id: 'eye-2', title: '眼动+手势 多模态交互演示 2', description: '注视高亮蹦跳效果与捏住优先抓取机制的联动演示，实现自然直觉的空间交互体验。', url: '/media/eye-gesture-interaction/20260319-090658.mp4', thumbnail: '', duration: '0:33', tags: ['眼动追踪', '手势交互', '空间计算'], project_slug: 'eye-gesture-multimodal', published: 1, sort: 2 },
  { id: 'eye-3', title: '眼动+手势 多模态交互演示 3', description: '气泡锁定与视觉增强效果，通过校准精度优化实现精准的注视-手势协同操作。', url: '/media/eye-gesture-interaction/20260319-090714.mp4', thumbnail: '', duration: '0:29', tags: ['气泡交互', '校准优化', '人机交互'], project_slug: 'eye-gesture-multimodal', published: 1, sort: 3 },
  { id: 'eye-4', title: '眼动+手势 多模态交互完整流程', description: '完整展示从注视预选到手势确认的多模态交互全流程，包括眼动校准、气泡识别与拖拽操作。', url: '/media/eye-gesture-interaction/20260319-090720.mp4', thumbnail: '', duration: '1:13', tags: ['多模态交互', '完整流程', 'Embodied AI'], project_slug: 'eye-gesture-multimodal', published: 1, sort: 4 },
  // AR HUD（已接通，duration 修正为真实 ~15s）→ 智能座舱项目
  { id: 'arhud-1', title: 'AR HUD 展车路测实录', description: '智能座舱 AR HUD 在真实道路场景下的功能演示，包括导航叠加、车道偏离预警、前车碰撞预警等。', url: '/media/ar-hud-demo/driver-view-loop.mp4', thumbnail: '', duration: '0:15', tags: ['AR HUD', '路测'], project_slug: 'ar-hud-smart-cockpit', published: 1, sort: 5 },
  // Mimic 机械臂 ×8（本次新上）→ 机械臂项目
  mimic(1, 'VID_20180514_213207.mp4', '0:24'),
  mimic(2, 'VID_20180514_215121.mp4', '0:19'),
  mimic(3, 'VID_20180518_165951.mp4', '0:19'),
  mimic(4, 'VID_20180515_102033.mp4', '0:13'),
  mimic(5, 'VID_20180514_214137.mp4', '0:07'),
  mimic(6, '1527325414605.mp4', '0:28'),
  // mimic-7 / mimic-8 已由川哥手动删除，永久移除（见下方 PURGE_IDS，确保不复活）
  // === 川哥补传原始素材（2026-06-15，projects.ts 项目页早已引用、文件一直缺失，现补全）===
  // 大视频(>100MB)走 .gitignore + VPS 直传；小视频入 git。替代了原 legacy-hud-1 待核实占位。
  { id: 'full-window-hud-live', title: '全车窗 HUD 概念车实拍', description: '全车窗 HUD 概念车实拍——整块前挡风玻璃化作 AR 显示屏，导航、预警、信息分区呈现。', url: '/media/futurus-hud/full-window-hud-live.mp4', thumbnail: '', duration: '1:09', tags: ['AR HUD', '全车窗', '概念车'], project_slug: 'full-window-ar-hud-ai-cockpit', published: 1, sort: 6 },
  { id: 'mass-production-hud', title: '量产 AR HUD 及全车窗显示产品', description: '量产级 AR HUD 与全车窗显示产品全景演示，涵盖多场景信息叠加与人机交互。', url: '/media/futurus-hud/mass-production-hud.mp4', thumbnail: '', duration: '3:26', tags: ['AR HUD', '量产', '全车窗'], project_slug: 'full-window-ar-hud-ai-cockpit', published: 1, sort: 7 },
  { id: 'auto-show-2024', title: '2024 北京车展 · 未来黑科技人机交互', description: '2024 北京车展现场记录——未来黑科技与人机交互新纪元（中国汽车报报道）。', url: '/media/auto-show/beijing-auto-show-2024.mp4', thumbnail: '', duration: '3:33', tags: ['北京车展', '人机交互', 'AR HUD'], project_slug: 'ar-hud-smart-cockpit', published: 1, sort: 8 },
  { id: 'multimodal-1', title: '单摄像头手势远程控制 · 演示 1', description: '基于单摄像头的手势识别远程控制原型演示。', url: '/media/multimodal-interaction/clip-01.mp4', thumbnail: '', duration: '0:23', tags: ['多模态', '手势控制'], project_slug: 'eye-gesture-multimodal', published: 1, sort: 9 },
  { id: 'multimodal-2', title: '单摄像头手势远程控制 · 演示 2', description: '手势远程控制原型的第二段演示。', url: '/media/multimodal-interaction/clip-02.mp4', thumbnail: '', duration: '0:10', tags: ['多模态', '手势控制'], project_slug: 'eye-gesture-multimodal', published: 1, sort: 10 },
  { id: 'multimodal-demo', title: '多模态交互演示', description: '多模态交互综合演示视频。', url: '/media/multimodal-interaction/demo-v2.mp4', thumbnail: '', duration: '0:24', tags: ['多模态交互'], project_slug: 'eye-gesture-multimodal', published: 1, sort: 11 },
  // 多模态互动机器人现场记录 ×4（2026-06-15 补传，projects.ts slam-service-robot 项目引用）
  { id: 'mm-robot-1', title: '多模态互动机器人 · 现场记录 1', description: '多模态互动服务机器人现场记录。', url: '/media/multimodal-robot/clip-01.mp4', thumbnail: '', duration: '0:07', tags: ['多模态', '服务机器人'], project_slug: 'slam-service-robot', published: 1, sort: 12 },
  { id: 'mm-robot-2', title: '多模态互动机器人 · 现场记录 2', description: '多模态互动服务机器人现场记录。', url: '/media/multimodal-robot/clip-02.mp4', thumbnail: '', duration: '0:13', tags: ['多模态', '服务机器人'], project_slug: 'slam-service-robot', published: 1, sort: 13 },
  { id: 'mm-robot-3', title: '多模态互动机器人 · 现场记录 3', description: '多模态互动服务机器人现场记录。', url: '/media/multimodal-robot/clip-03.mp4', thumbnail: '', duration: '0:19', tags: ['多模态', '服务机器人'], project_slug: 'slam-service-robot', published: 1, sort: 14 },
  { id: 'mm-robot-4', title: '多模态互动机器人 · 现场记录 4', description: '多模态互动服务机器人现场记录。', url: '/media/multimodal-robot/clip-04.mp4', thumbnail: '', duration: '0:28', tags: ['多模态', '服务机器人'], project_slug: 'slam-service-robot', published: 1, sort: 15 },
  // 规划中占位（无文件）→ 默认下架，补文件后改 url 上架
  { id: 'plan-slam', title: 'SLAM 机器人自主导航演示', description: '基于视觉 SLAM 的服务机器人在商业环境中的自主导航、避障与人机交互演示。', url: '#', thumbnail: '', duration: '2:15', tags: ['SLAM', '机器人'], project_slug: 'slam-service-robot', published: 0, sort: 100 },
  { id: 'plan-icecream', title: '机械臂无人冰激凌站全流程', description: '六轴协作机械臂自动完成冰激凌制作的全流程演示，从下单到出餐。', url: '#', thumbnail: '', duration: '1:58', tags: ['机械臂', '无人零售'], project_slug: 'robotic-arm-icecream', published: 0, sort: 101 },
  { id: 'plan-vibecoding', title: 'Vibecoding 工作流演示', description: '使用 Claude Code 进行日常开发的真实工作流演示，展示 AI 如何参与产品全流程。', url: '#', thumbnail: '', duration: '5:20', tags: ['Vibecoding', 'Claude Code'], project_slug: null, published: 0, sort: 102 },
]

const now = Date.now()
const stmt = db.prepare(`
  INSERT OR IGNORE INTO managed_videos
    (id, title, description, url, thumbnail, duration, tags, project_slug, published, sort, created_at, updated_at)
  VALUES (@id, @title, @description, @url, @thumbnail, @duration, @tags, @project_slug, @published, @sort, @created_at, @updated_at)
`)
const tx = db.transaction((items) => {
  let inserted = 0
  for (const v of items) {
    const r = stmt.run({
      ...v,
      tags: JSON.stringify(v.tags),
      created_at: now,
      updated_at: now,
    })
    inserted += r.changes
  }
  return inserted
})

const inserted = tx(VIDEOS)
// 永久移除：旧占位 + 川哥手动删除的 mimic-7/8（每次 seed 都删，确保绝不复活）
const PURGE_IDS = ['legacy-hud-1', 'mimic-7', 'mimic-8']
for (const id of PURGE_IDS) db.prepare('DELETE FROM managed_videos WHERE id = ?').run(id)
const total = db.prepare('SELECT COUNT(*) AS n FROM managed_videos').get().n
const pub = db.prepare('SELECT COUNT(*) AS n FROM managed_videos WHERE published=1').get().n
console.log(`[seed-videos] 新插入 ${inserted} 条（已存在的跳过），表内共 ${total} 条，上架 ${pub} 条`)
db.close()
