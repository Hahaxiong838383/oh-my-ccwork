# 视频预览优化维护说明

## 背景

2026-07-06 排查发现个人站视频预览慢，主因不是 nginx：线上 `/media/` 已支持 `video/mp4`、`Accept-Ranges: bytes` 和 `206 Range`。真正瓶颈是原视频体积/码率过高，且部分 MP4 的 `moov` 元数据在文件尾部，浏览器即使 `preload="metadata"` 也会额外扫尾。

## 本次调整

- 原视频保留在 `public/media/`，不覆盖、不删除。
- 新增网页预览版视频：`public/media-optimized/`。
- 新增视频封面：`public/media-posters/`。
- 批量转码脚本：`scripts/optimize-videos.mjs`。
- 压缩报告：`docs/video-optimization-report.md`。
- 页面数据引用从 `/media/...` 切到 `/media-optimized/...`：
  - `src/data/videos.ts`
  - `src/data/projects.ts`
- 视频库使用显式 `thumbnail`，项目详情页通过 `/media-optimized/foo.mp4` 自动推导 `/media-posters/foo.jpg`。
- 视频播放器使用原始视频比例显示，禁止用 `aspect-video + object-cover` 强制裁切竖屏素材。

## 转码策略

`node scripts/optimize-videos.mjs` 会执行：

- H.264 (`libx264`)、`CRF 28`、`preset slow`、`yuv420p`。
- `-movflags +faststart`，把 `moov` 元数据移到文件头，提升 metadata/首帧加载速度。
- 默认去掉音轨；以语音内容为核心的视频加入 `audioPreservedInputs`，保留 AAC 96kbps，避免压缩后失去核心信息。
- 横屏最大宽 1280，竖屏最大高 1280，保持比例。
- 同步生成 JPG poster。

2026-07-06 批次见 `docs/video-optimization-report.md`：原始约 `608.2MB`，优化后约 `51.4MB`，节省约 `91.6%`。2026-07-17 新增全双工语音 Agent 视频：16MB → 6.7MB，保留 AAC 音轨。

## 维护规则

1. 新增视频时，先放原片到 `public/media/`。
2. 把新视频路径加入 `scripts/optimize-videos.mjs` 的 `inputs`。
3. 若视频依赖语音内容，同时加入 `audioPreservedInputs`；然后运行 `node scripts/optimize-videos.mjs`。
4. 在页面数据里引用 `/media-optimized/...`，封面引用 `/media-posters/...`。
5. 运行 `npm run build`，确认页面构建通过。

## 回滚

如果压缩版观感不满意：

- 将 `src/data/videos.ts` 和 `src/data/projects.ts` 里的 `/media-optimized/` 改回 `/media/`。
- poster 可保留；不影响播放。
- 原片仍在 `public/media/`，无需恢复文件。

## 注意

- 不要删除 `public/media/` 原视频；它是回滚源和高质量母版。
- 不要用 `git add .`；本项目在 mycc monorepo 下，按 `COLLAB-RULES.md` 只添加个人站相关具体路径。
- 部署时要同步 `public/media-optimized/` 和 `public/media-posters/`，否则页面会引用 404。
- 竖屏视频应保持竖屏展示；若改播放器样式，优先使用 `object-contain` 或自然高度，不要改回固定 16:9 裁切。
