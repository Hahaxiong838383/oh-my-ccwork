# voice-agent EOT 迁移上线前置（两项）
> 创建：2026-08-16 | 状态：进行中（立项待启动）

## 目标

清掉 EOT ONNX 迁移（smart-turn v3.2 替换闭源 sidecar）的两个上线前置，达到可灰度状态。
背景与实测依据：`2-Projects/realtime-voice-agent/docs/EOT-ONNX-MIGRATION-BRIEF.md`（头部回填块）+
分支 `feat/eot-onnx-prototype` 的 `docs/EOT-ONNX-PROTOTYPE-REPORT.md`（三绿实测，条件 go）。

## 前置①：真实对话音频重标定（主工作量，~2–3 个工作日）

**为什么必须**：生产阈值 0.18 是旧模型分布的左尾标定值，换模型即作废；原型两个评测集
（chirp3 TTS 合成 / FLEURS 朗读）都不是自家用户分布——分布一换阈值剧烈漂移已实证
（官方集 bestF1@0.18 vs FLEURS 形态 @0.97）。**无真实数据不上线**（报告 §六）。

- [x] D1：✅ 2026-08-16 川哥拍板 a 方案，**采集口已上线灰度线**（分支 `feat/eot-snapshot`
      commit `c0cc0fc8c`，双轮 E2E 过：开关关行为回归 + 开关开真通话采到 8s wav+全事件链）。
      运维真值：env 在 `rust-worker.env`（`EOT_SNAPSHOT_DIR=/root/eot-snapshots`，
      删行+stop/start=关闭）；护栏 单 job 50 个/全局 2048MB；回滚二进制
      `voice-rust-worker.prev` 或 `.bak-20260816-pre-snapshot`。
      弱标签：`rust-worker/scripts/label_snapshots.py`（E2E 实测 1 触发点→weak=1 正确）。
      b) rtc_probe 半仿真补难例——待 D2 自然积累不足时启用。
- [ ] D2：采集量目标 ≥300 触发点样本（含思考停顿/换气/说完三类，人工标注 turn 完成与否）
- [ ] D3：eotbench eval 跑 v3.2 → 标定阈值 + MIN/MAX delay 联动（复用 `bench/analyze_eval.py`）
- [ ] D4：401ms 判停链回归 + 打断行为验证（任务书 §八 口径）

## 前置②：sherpa×ORT 1.28 统一（~1 个工作日，可与①并行）

**为什么必须**：ort rc.13 版本门只收 ORT ≥1.28（原型实测 `BadVersion` 拒载 venv 的 1.24.4），
单 ORT 方案改「统一 1.28」形态；声纹侧 sherpa 必须换链 1.28 的构建。

- [ ] S1：sherpa-onnx 源码构建链 ORT 1.28（master `cmake/onnxruntime.cmake` 已有 1.26+ 适配），
      产出 `libsherpa-onnx-c-api.so` + 复用 MS 官方 `libonnxruntime.so.1.28.0`
- [ ] S2：声纹回归——新 so 算 embedding 与 `registry.json` 旧向量（1.24.4 产）相似度对撞，
      漂移超阈则全量重注册（注册人数少，成本低）
- [ ] S3：失败回退线验证：静态 bundled 1.28 + sherpa 私有 1.24.4 并存（符号冲突实测）
- [ ] S4：落地资产「一个目录」成型：rust 二进制 + libonnxruntime.so.1.28 + so×2 + onnx×3

## 排期建议（待川哥拍板后启动）

| 时段 | 内容 |
|---|---|
| 第 1 天 | ①D1 拍板+采集口实现（若走 a 需改 worker，走灰度线先行）∥ ②S1 构建 |
| 第 2–3 天 | ①D2 采集积累（自然流量，可能跨多天挂机）∥ ②S2/S3 回归与回退验证 |
| 数据够 300 后 | ①D3 标定 + D4 回归 → 汇总 go/no-go → 灰度 |

**依赖与风险**：①D2 依赖真实通话流量（当前并发峰值 2/天级 job 数低，采集期可能拉长——
若太慢用 b 方案补）；②S1 若构建不顺走 S3 回退线，不阻塞①。
退出条件沿用报告 §七（真实集 AUC 反超不成立 / 满载 p95>200ms / 灰度劣化 / 声纹双路失败）。

## 进度记录

- 2026-08-16：立项（原型三绿收口，条件 go；本文件由 brief 头部回填块引用）
- 2026-08-16：D1 完成——采集口上线 64.90 灰度线（`feat/eot-snapshot`）。E2E 证据：
  events.jsonl 八事件链自洽（speech→224ms 静音触发→prob 0.517→437ms commit），
  wav 128000 样本尾 1.2s RMS 3593，弱标签脚本真数据跑通。**D2 数据积累已启动**：
  真实通话打 rust 线即自动攒（当前 1 个触发点），目标 ≥300 后进 D3。
