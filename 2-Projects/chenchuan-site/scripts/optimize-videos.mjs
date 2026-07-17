import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const inputs = [
  'public/media/futurus-hud/full-window-hud-live.mp4',
  'public/media/futurus-hud/mass-production-hud.mp4',
  'public/media/auto-show/beijing-auto-show-2024.mp4',
  'public/media/ai-agent/full-duplex-streaming-voice-agent.mp4',
  'public/media/eye-gesture-interaction/20260319-090647.mp4',
  'public/media/eye-gesture-interaction/20260319-090658.mp4',
  'public/media/eye-gesture-interaction/20260319-090714.mp4',
  'public/media/eye-gesture-interaction/20260319-090720.mp4',
  'public/media/multimodal-interaction/clip-01.mp4',
  'public/media/multimodal-interaction/clip-02.mp4',
  'public/media/multimodal-interaction/demo-v2.mp4',
  'public/media/multimodal-robot/clip-01.mp4',
  'public/media/multimodal-robot/clip-02.mp4',
  'public/media/multimodal-robot/clip-03.mp4',
  'public/media/multimodal-robot/clip-04.mp4',
  'public/media/mimic-robot/1527325414605.mp4',
  'public/media/mimic-robot/VID_20180514_213207.mp4',
  'public/media/mimic-robot/VID_20180514_214137.mp4',
  'public/media/mimic-robot/VID_20180514_215121.mp4',
  'public/media/mimic-robot/VID_20180515_102033.mp4',
  'public/media/mimic-robot/VID_20180518_165951.mp4',
  'public/media/ar-hud-demo/driver-view-loop.mp4',
]

const audioPreservedInputs = new Set([
  'public/media/ai-agent/full-duplex-streaming-voice-agent.mp4',
])

const outRoot = 'public/media-optimized'
const posterRoot = 'public/media-posters'
const reportPath = 'docs/video-optimization-report.md'

function ffprobe(file) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration,size,bit_rate:stream=width,height,codec_name,bit_rate,r_frame_rate',
    '-of', 'json',
    file,
  ], { encoding: 'utf8' })
  return JSON.parse(raw)
}

function mediaPath(input) {
  return input.replace(/^public\/media\//, '')
}

function optimizedPath(input) {
  return path.join(outRoot, mediaPath(input))
}

function posterPath(input) {
  return path.join(posterRoot, mediaPath(input)).replace(/\.mp4$/i, '.jpg')
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024).toFixed(1)}KB`
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${cmd} failed with exit ${result.status}`)
  }
}

const rows = []
for (const input of inputs) {
  const info = ffprobe(input)
  const stream = info.streams[0]
  const out = optimizedPath(input)
  const poster = posterPath(input)
  mkdirSync(path.dirname(out), { recursive: true })
  mkdirSync(path.dirname(poster), { recursive: true })

  const width = Number(stream.width)
  const height = Number(stream.height)
  const isPortrait = height > width
  const scale = isPortrait
    ? 'scale=-2:min(1280\\,ih)'
    : 'scale=min(1280\\,iw):-2'

  const keepAudio = audioPreservedInputs.has(input)
  const videoArgs = [
    '-y',
    '-i', input,
    '-map_metadata', '-1',
    '-vf', scale,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '28',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  ]
  if (keepAudio) {
    videoArgs.push('-c:a', 'aac', '-b:a', '96k', '-ac', '2')
  } else {
    videoArgs.push('-an')
  }
  videoArgs.push(out)

  console.log(`\n[video] ${input} -> ${out} (${keepAudio ? 'AAC 96k' : 'no audio'})`)
  run('ffmpeg', videoArgs)

  console.log(`[poster] ${input} -> ${poster}`)
  run('ffmpeg', [
    '-y',
    '-ss', '1',
    '-i', input,
    '-map_metadata', '-1',
    '-frames:v', '1',
    '-vf', scale,
    '-q:v', '4',
    poster,
  ])

  const oldSize = statSync(input).size
  const newSize = statSync(out).size
  rows.push({
    input,
    out,
    poster,
    oldSize,
    newSize,
    saved: oldSize - newSize,
    ratio: newSize / oldSize,
    oldResolution: `${width}x${height}`,
    newResolution: `${ffprobe(out).streams[0].width}x${ffprobe(out).streams[0].height}`,
    audio: keepAudio ? 'AAC 96kbps' : '无',
  })
}

const totalOld = rows.reduce((sum, row) => sum + row.oldSize, 0)
const totalNew = rows.reduce((sum, row) => sum + row.newSize, 0)
const now = new Date().toISOString()
const lines = [
  '# 视频优化报告',
  '',
  `生成时间：${now}`,
  '',
  '## 策略',
  '',
  '- 原视频不覆盖，保留在 `public/media/`。',
  '- 网页预览版输出到 `public/media-optimized/`。',
  '- 封面图输出到 `public/media-posters/`。',
  '- 转码参数：H.264, CRF 28, preset slow, yuv420p, `+faststart`。默认去音轨；语音类素材按 allowlist 保留 AAC 96kbps。',
  '- 尺寸上限：横屏宽 1280，竖屏高 1280，保持比例。',
  '',
  '## 总览',
  '',
  `- 原始总量：${formatBytes(totalOld)}`,
  `- 优化后总量：${formatBytes(totalNew)}`,
  `- 节省：${formatBytes(totalOld - totalNew)} (${((1 - totalNew / totalOld) * 100).toFixed(1)}%)`,
  '',
  '## 明细',
  '',
  '| 原文件 | 原尺寸 | 新尺寸 | 原体积 | 新体积 | 节省 | 音频 | 输出 | 封面 |',
  '|---|---:|---:|---:|---:|---:|---|---|---|',
  ...rows.map((row) =>
    `| \`${row.input}\` | ${row.oldResolution} | ${row.newResolution} | ${formatBytes(row.oldSize)} | ${formatBytes(row.newSize)} | ${((1 - row.ratio) * 100).toFixed(1)}% | ${row.audio} | \`${row.out}\` | \`${row.poster}\` |`,
  ),
  '',
  '## 回滚',
  '',
  '- 若压缩版观感不满意，将数据引用从 `/media-optimized/...` 改回 `/media/...`。',
  '- 封面可保留，不影响播放。',
]
writeFileSync(reportPath, `${lines.join('\n')}\n`)
console.log(`\n[report] ${reportPath}`)
