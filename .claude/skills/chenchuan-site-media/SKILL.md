---
name: chenchuan-site-media
description: 陈川个人站视频上传、统一压缩、封面生成、SQLite 入库、韩国服务器部署、播放故障修复与回滚验收。用于用户提到“个人站视频”“上传视频”“按其他视频格式压缩”“视频打不开”“media-optimized”“视频管理”时。
---

# 个人站视频维护

## 边界

- 项目：`2-Projects/chenchuan-site/`。
- 功能开发使用隔离 worktree 和 `codex/public-voice-mirror`，禁止在脏 `main` 工作区混改。
- 生产真源先实时确认；当前常用目标为 `aliyun-kr:/var/www/chenchuan-site`、PM2 `chenchuan-site`，不可只凭旧 README 决定。
- 不运行全量 `git add`，不带入其他 Agent 的改动。
- 上传媒体和单行入库通常不需要 `next build` 或重启 PM2；不要为了刷新列表无意义重启站点。

## 资产规范

每个可恢复视频保留三层 Git 资产：

1. 原片：`public/media/<group>/<name>.mp4`
2. 网页版：`public/media-optimized/<group>/<name>.mp4`
3. 封面：`public/media-posters/<group>/<name>.jpg`

统一压缩参数来自 `scripts/optimize-videos.mjs`：

```text
H.264 / libx264
CRF 28
preset slow
yuv420p
+faststart
横屏宽度不超过 1280；竖屏高度不超过 1280；始终保持原比例
```

- 视觉效果类演示沿用默认静音预览。
- 语音对话是核心价值时，把路径加入 `audioPreservedInputs`，保留 AAC 96kbps 立体声。
- 禁止把竖屏素材裁成横屏；前端使用 `object-contain` 和自然高度。
- 单文件超过 GitHub 普通 100MB 上限时，只精确忽略该原片；优化版、封面、脚本和报告仍入 Git。原片必须保留在素材目录、生产节点和回滚备份。

## 元数据

- 把条目加入 `scripts/seed-videos.mjs`，ID 稳定、`published=1`、时长取真实探测值。
- 数据库 `url` 保存 `/media/...` 原片路径；公开页面的 `getVideos()` 会映射成 `/media-optimized/...`。
- 明确写 `thumbnail=/media-posters/...jpg`，不要依赖空封面。
- 同源视频关联相同 `project_slug`，说明要指出本段与旧视频的关系和本次侧重点。
- 生产目录缺少历史 seed 脚本时，不要直接运行全量 seed；先在隔离临时数据库验证，再只向正式库插入目标行，避免复活旧占位内容。

## 生产双目录

韩国 Nginx 的媒体路径不是完全对称：

- 公网 `/media/...`：读取 `/var/www/chenchuan-site/media/...`
- 公网 `/media-optimized/...`：读取 `/var/www/chenchuan-site/public/media-optimized/...`
- 公网 `/media-posters/...`：读取 `/var/www/chenchuan-site/public/media-posters/...`

因此部署原片时同时保留：

- 源码/恢复层：`/var/www/chenchuan-site/public/media/...`
- Nginx 运行层：`/var/www/chenchuan-site/media/...`

只同步 `public/media/...` 会导致原片公网 404，并出现 `X-Media-Fallback: hk`。

## 上线顺序

1. 用 `ffprobe` 记录原片编码、方向、时长、分辨率、体积和音轨。
2. 更新压缩清单、seed 和 `docs/video-optimization-report.md`。
3. 生成网页版与封面，校验 `moov` 前置、分辨率、音轨策略和压缩比例。
4. 在生产创建时间戳回滚目录。
5. 先逐个检查脚本/报告是否存在；使用 `better-sqlite3 backup()` 生成在线一致性数据库快照，备份存在的文件，并为上线前不存在的文件写 absence marker。不要让一个缺失脚本中断整个回滚记录。
6. 以精确文件清单同步资产；使用 SHA-256 比对本地和生产字节。
7. 在生产隔离临时数据库运行 seed 验证目标行。
8. 正式数据库只插入或更新目标视频行。
9. 等待 `/videos` 的 ISR 刷新。首次请求可能返回旧页并后台重生成，必须再次请求确认新卡片可见。

## 验收

必须全部满足：

- `/videos` HTTP 200，HTML 出现标题、说明、正确排序、优化视频路径和封面路径。
- 原片与优化版均支持 `Range: bytes=0-1023`，返回 206；封面返回 200。
- 原片正常路径不得出现 `X-Media-Fallback`。
- 真实浏览器找到目标 `<video>`，实际 `currentSrc` 指向优化版。
- 播放至少 2 秒，`readyState=4`、`currentTime>2`、分辨率正确、`error=null`。
- PM2 保持 `online`，无非预期重启。

HTTP 200 或文件存在都不能单独作为播放成功结论。

## 工具兼容

- macOS rsync 不接受所有 Linux 简写权限参数，跨平台使用 `--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r`。
- macOS 常见 `shasum -a 256`，Linux 常见 `sha256sum`；先探测再调用。
- 本地 `better-sqlite3` 原生绑定缺失时，不要重建共享 `node_modules`；使用生产现有依赖和隔离临时数据库验证 seed。
- Playwright 包装脚本没有执行位时通过 `bash <wrapper>` 调用；媒体探针使用单表达式 `eval`，校验 `readyState/currentTime/error`。

## 回滚

- 在回滚说明中列出数据库精确删除/恢复方式、四个生产媒体路径和本次新增脚本。
- 优先执行目标行删除和目标文件移除；全库恢复只作紧急兜底，避免覆盖备份后产生的新访问数据。
- 记录回滚目录并在体验确认后的记忆、提交说明中保留。
