---
name: youtube-download
description: 下载 YouTube 视频（yt-dlp + ffmpeg，走本机 xray 代理）。可指定 4K/2160p/60fps 等清晰度，自动选最佳视频流 + 音频流合并落盘。底层 yt-dlp 也支持 1000+ 站点（B 站/Vimeo/Twitter 等），但本 skill 场景与代理默认针对 YouTube。触发词："/youtube-download"、"下载 YouTube"、"下载油管视频"、"下载这个视频链接"、"youtube.com/watch"、"youtu.be/"、"下载 4K 60fps"
---

# youtube-download — YouTube 视频下载

基于 [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) + `ffmpeg`。YouTube 在境内需翻墙，**必走本机 xray 代理**（mixed inbound `127.0.0.1:10808`，SOCKS5/HTTP 都收，详见记忆 `feedback_xray_video_routing` / `user_hardware`）。

## 触发条件

- 用户给的链接形如 `https://www.youtube.com/watch?v=<id>` 或 `https://youtu.be/<id>`
- 用户说"下载 YouTube / 油管视频"、"下载这个视频（带 4K/60fps 等清晰度要求）"
- 触发词：`/youtube-download`

## 铁律

1. **先列格式再下**（`-F`），确认用户要的清晰度/帧率真实存在，禁止凭 `bestvideo` 盲下就报"完成"。
2. **下完必 `ffprobe` 验证**分辨率/帧率/编码，不能只信文件名或进度条 100%（[[feedback_artifact_not_just_generator_committed]]）。
3. 默认下载到 `~/Downloads/`，除非用户指定别处。**不要下进 mycc 仓**（大文件不进 git）。

## 0. 前置：装工具 + 确认代理通

```bash
# 0.1 工具（首次；已装则秒过）
which yt-dlp ffmpeg || brew install yt-dlp ffmpeg

# 0.2 确认代理能通 YouTube（本机 shell 的 env 代理在非交互/sandbox 下可能是空的，
#     所以命令里显式 --proxy，不依赖环境变量）
curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 \
  --proxy socks5h://127.0.0.1:10808 https://www.youtube.com
# 期望 200。若 000/超时 → xray 没起或节点挂了，查 ~/xray/ + 记忆 project_xray
```

> `socks5h` 让 DNS 也走代理，避免本地 DNS 泄露/污染。等价 `curl` 的 `--socks5-hostname`。

## 1. 列格式，确认目标清晰度存在

```bash
yt-dlp -F --proxy socks5h://127.0.0.1:10808 "<URL>" 2>&1 \
  | grep -Ei "2160|1440|1080|60 |4320|id +ext"
```

读 `RESOLUTION` + `FPS` 列。YouTube 高清档的规律：

| 目标 | 典型 format id | 编码 | 说明 |
|------|---------------|------|------|
| 4320p60 (8K) | 571/272 | vp9/av01 | 少数视频才有 |
| **2160p60 (4K)** | **315** (vp9) / 401 (av01) | vp9/av01 | webm 容器，仅 video-only |
| 1440p60 | 308 (vp9) | vp9 | webm |
| 1080p60 | 299 (avc1) / 303 (vp9) | avc1/vp9 | 299 是 mp4 |
| 最佳音频 | 251 (opus) / 140 (m4a) | opus/aac | 单独流，需合并 |

⚠️ format id **不是固定**的，以 `-F` 实际输出为准。**4K/1440p 通常只有 vp9/av01（webm），没有 mp4(avc1) 原生流**——avc1 一般封顶 1080p60。

## 2. 下载 + 合并

**优先用清晰度选择器（跨视频通用，不写死 id）：**

```bash
cd ~/Downloads && yt-dlp --proxy socks5h://127.0.0.1:10808 \
  -f "bestvideo[height<=2160][fps=60]+bestaudio/bestvideo[height<=2160]+bestaudio/best" \
  --merge-output-format mkv --newline \
  -o "%(title)s [%(id)s].%(ext)s" "<URL>"
```

- `[height<=2160][fps=60]` = 4K 60fps；换 1440/1080 或去掉 `[fps=60]` 即其他档。
- `/bestvideo...+bestaudio/best` 是降级链：目标档取不到时不至于失败。
- 也可 `-f "315+bestaudio"` 直接锁 `-F` 里确认过的那条 4K60 流（最精确）。

**容器为什么用 mkv（关键决策）：**

- 4K/1440p 是 **vp9/av01 + opus 音频**。vp9+opus 装进 `.mp4` 后 **macOS QuickTime 播放器不认**（黑屏/无声）。
- `mkv` 是 vp9/opus 的自然容器，**无损直合（不重编码，秒完成）**，用 **IINA / VLC** 直接放。
- 只有当源有 avc1(mp4) 流（≤1080p60）且用户明确要 mp4/剪辑软件兼容时，才 `--merge-output-format mp4`。要 4K 的 mp4 必须重编码（`-c:v libx264`，慢且掉质量），下前先跟用户确认。

## 3. 验证（ffprobe，禁止只信文件名）

```bash
f="<下好的文件>"
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,codec_name \
  -of default=noprint_wrappers=1 "$f"
# r_frame_rate=60/1 且 height 达标 才算真拿到 4K60
ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 "$f"
```

向用户报告：分辨率 / 帧率 / 编码 / 时长 / 大小 / 文件路径。

## 常见坑

- **下载慢/中途反爬/限速**：多半不是 yt-dlp 问题，是 xray 视频流节点漂移（同会话 IPv4/IPv6 落到两个国家被 YouTube 判代理）。锁单一国家 IPv4 节点，详见 [[feedback_xray_video_routing]]（`~/xray/access.log` 看 `[socks -> 节点]`）。
- **`Requested format is not available`**：目标 fps/清晰度该视频没有 → 回 §1 重看 `-F`，放宽选择器。
- **只字幕/播放列表**：加 `--write-auto-subs --sub-lang zh-Hans,en` 下字幕；整播放列表默认全下，单条视频用 watch?v= 链接即可。
- **年龄限制/会员视频**：需 `--cookies-from-browser chrome`（从浏览器读登录态）。
- **env 代理为空**：cc 的 sandbox/非交互 shell 里 `$http_proxy` 可能是空的，所以本 skill 所有命令都显式 `--proxy`，不依赖 env（[[feedback_lan_service_doh_and_client_proxy_block]]）。
