# 视频优化报告

生成时间：2026-07-06T14:06:38.933Z

## 策略

- 原视频不覆盖，保留在 `public/media/`。
- 网页预览版输出到 `public/media-optimized/`。
- 封面图输出到 `public/media-posters/`。
- 转码参数：H.264, CRF 28, preset slow, yuv420p, `+faststart`, 去音轨。
- 尺寸上限：横屏宽 1280，竖屏高 1280，保持比例。

## 总览

- 原始总量：608.2MB
- 优化后总量：51.4MB
- 节省：556.8MB (91.6%)

## 明细

| 原文件 | 原尺寸 | 新尺寸 | 原体积 | 新体积 | 节省 | 输出 | 封面 |
|---|---:|---:|---:|---:|---:|---|---|
| `public/media/futurus-hud/full-window-hud-live.mp4` | 1920x1080 | 1280x720 | 169.4MB | 2.3MB | 98.6% | `public/media-optimized/futurus-hud/full-window-hud-live.mp4` | `public/media-posters/futurus-hud/full-window-hud-live.jpg` |
| `public/media/futurus-hud/mass-production-hud.mp4` | 1080x1920 | 720x1280 | 100.2MB | 6.5MB | 93.5% | `public/media-optimized/futurus-hud/mass-production-hud.mp4` | `public/media-posters/futurus-hud/mass-production-hud.jpg` |
| `public/media/auto-show/beijing-auto-show-2024.mp4` | 1080x1920 | 720x1280 | 100.4MB | 7.3MB | 92.7% | `public/media-optimized/auto-show/beijing-auto-show-2024.mp4` | `public/media-posters/auto-show/beijing-auto-show-2024.jpg` |
| `public/media/eye-gesture-interaction/20260319-090647.mp4` | 1280x720 | 1280x720 | 16.1MB | 3.3MB | 79.6% | `public/media-optimized/eye-gesture-interaction/20260319-090647.mp4` | `public/media-posters/eye-gesture-interaction/20260319-090647.jpg` |
| `public/media/eye-gesture-interaction/20260319-090658.mp4` | 1280x720 | 1280x720 | 19.2MB | 3.8MB | 80.3% | `public/media-optimized/eye-gesture-interaction/20260319-090658.mp4` | `public/media-posters/eye-gesture-interaction/20260319-090658.jpg` |
| `public/media/eye-gesture-interaction/20260319-090714.mp4` | 1280x720 | 1280x720 | 17.1MB | 3.0MB | 82.8% | `public/media-optimized/eye-gesture-interaction/20260319-090714.mp4` | `public/media-posters/eye-gesture-interaction/20260319-090714.jpg` |
| `public/media/eye-gesture-interaction/20260319-090720.mp4` | 1280x720 | 1280x720 | 42.3MB | 2.2MB | 94.9% | `public/media-optimized/eye-gesture-interaction/20260319-090720.mp4` | `public/media-posters/eye-gesture-interaction/20260319-090720.jpg` |
| `public/media/multimodal-interaction/clip-01.mp4` | 960x540 | 960x540 | 4.7MB | 1.5MB | 67.3% | `public/media-optimized/multimodal-interaction/clip-01.mp4` | `public/media-posters/multimodal-interaction/clip-01.jpg` |
| `public/media/multimodal-interaction/clip-02.mp4` | 960x920 | 960x920 | 2.1MB | 837.6KB | 61.2% | `public/media-optimized/multimodal-interaction/clip-02.mp4` | `public/media-posters/multimodal-interaction/clip-02.jpg` |
| `public/media/multimodal-interaction/demo-v2.mp4` | 1292x720 | 1280x714 | 13.6MB | 1.8MB | 86.6% | `public/media-optimized/multimodal-interaction/demo-v2.mp4` | `public/media-posters/multimodal-interaction/demo-v2.jpg` |
| `public/media/multimodal-robot/clip-01.mp4` | 540x960 | 540x960 | 1.5MB | 363.7KB | 75.5% | `public/media-optimized/multimodal-robot/clip-01.mp4` | `public/media-posters/multimodal-robot/clip-01.jpg` |
| `public/media/multimodal-robot/clip-02.mp4` | 540x960 | 540x960 | 2.6MB | 803.5KB | 69.7% | `public/media-optimized/multimodal-robot/clip-02.mp4` | `public/media-posters/multimodal-robot/clip-02.jpg` |
| `public/media/multimodal-robot/clip-03.mp4` | 540x960 | 540x960 | 4.1MB | 1.1MB | 73.5% | `public/media-optimized/multimodal-robot/clip-03.mp4` | `public/media-posters/multimodal-robot/clip-03.jpg` |
| `public/media/multimodal-robot/clip-04.mp4` | 544x960 | 544x960 | 4.6MB | 2.6MB | 43.0% | `public/media-optimized/multimodal-robot/clip-04.mp4` | `public/media-posters/multimodal-robot/clip-04.jpg` |
| `public/media/mimic-robot/1527325414605.mp4` | 544x960 | 544x960 | 4.3MB | 2.6MB | 39.3% | `public/media-optimized/mimic-robot/1527325414605.mp4` | `public/media-posters/mimic-robot/1527325414605.jpg` |
| `public/media/mimic-robot/VID_20180514_213207.mp4` | 1280x720 | 720x1280 | 24.3MB | 2.3MB | 90.6% | `public/media-optimized/mimic-robot/VID_20180514_213207.mp4` | `public/media-posters/mimic-robot/VID_20180514_213207.jpg` |
| `public/media/mimic-robot/VID_20180514_214137.mp4` | 1280x720 | 720x1280 | 4.6MB | 546.8KB | 88.5% | `public/media-optimized/mimic-robot/VID_20180514_214137.mp4` | `public/media-posters/mimic-robot/VID_20180514_214137.jpg` |
| `public/media/mimic-robot/VID_20180514_215121.mp4` | 1920x1080 | 1080x1920 | 26.9MB | 3.3MB | 87.6% | `public/media-optimized/mimic-robot/VID_20180514_215121.mp4` | `public/media-posters/mimic-robot/VID_20180514_215121.jpg` |
| `public/media/mimic-robot/VID_20180515_102033.mp4` | 1920x1080 | 1080x1920 | 21.9MB | 2.1MB | 90.5% | `public/media-optimized/mimic-robot/VID_20180515_102033.mp4` | `public/media-posters/mimic-robot/VID_20180515_102033.jpg` |
| `public/media/mimic-robot/VID_20180518_165951.mp4` | 1280x720 | 720x1280 | 21.8MB | 2.1MB | 90.5% | `public/media-optimized/mimic-robot/VID_20180518_165951.mp4` | `public/media-posters/mimic-robot/VID_20180518_165951.jpg` |
| `public/media/ar-hud-demo/driver-view-loop.mp4` | 1470x630 | 1280x548 | 6.5MB | 1.1MB | 83.1% | `public/media-optimized/ar-hud-demo/driver-view-loop.mp4` | `public/media-posters/ar-hud-demo/driver-view-loop.jpg` |

## 回滚

- 若压缩版观感不满意，将数据引用从 `/media-optimized/...` 改回 `/media/...`。
- 封面可保留，不影响播放。
