# voice-agent EOT 迁移上线前置（两项）
> 创建：2026-08-16 | 状态：**暂停——D3 判 NO-GO，待真实用户数据重测**（2026-08-30）

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
- [x] D2：测试数据口径达标（两周 2086 触发点，川哥开发测试流量；**真实用户口径未完成**，采集口继续攒）
- [x] D3：✅ 2026-08-30 完成，**判 NO-GO**——v3.2 自家分布 AUC 0.705（旧 0.683，领先仅 0.022），预注册判据 <0.75 落锤。详见 `docs/EOT-D3-CALIBRATION-REPORT.md`（feat/eot-onnx-prototype `5380adb9d`）
- [~] D4：随 NO-GO 暂停。重启条件：真实儿童用户数据 ≥500 触发点重测 AUC ≥0.80

## 前置②：sherpa×ORT 1.28 统一（~1 个工作日，可与①并行）

**为什么必须**：ort rc.13 版本门只收 ORT ≥1.28（原型实测 `BadVersion` 拒载 venv 的 1.24.4），
单 ORT 方案改「统一 1.28」形态；声纹侧 sherpa 必须换链 1.28 的构建。

- [x] S1：✅ 2026-08-16 CI 源码构建过（workflow `sherpa-ort128`，sherpa v1.13.5 ×
      MS ORT 1.28.0；官方预编译全部 ≤1.27.1 被版本门拒，SONAME 实证）。产物三证：
      ldd 链 `.so.1` 解析 ort128、GetVersionString 运行时报 1.28.0、glibc ≤2.39。
      ⚠️ MS ORT SONAME 是 major-only `libonnxruntime.so.1`（部署文件名照此）。
- [x] S2：✅ 真实采集语音对撞（新构建 spk_embed vs venv 现役路径同 wav）：
      **cos=1.000000，max_abs_diff=3.9e-6，norm 两侧同 12.7370** →
      **registry.json 旧向量直接复用，无需重注册**（注：sherpa 1.13.3→1.13.5 与
      ORT 1.24.4→1.28.0 双变量同验，结论对落地组合有效）。
- [x] S3：跳过——主线通过回退线无需启用；验证方法在原型报告 §一 留案，需要时再验。
- [x] S4：资产可用性已证（产物 sha256 见 CI run 31900716526 的 SHA256SUMS；
      64.90 测试目录已删防分叉，重拉凭 artifact/重跑 workflow）。
      真·「一个目录」组装归生产化移植阶段（原型报告 §六 工作量 4）。

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
- 2026-08-16：前置② 完成——S1 CI 构建（判据曾套错 SONAME 形态红过一轮，MS ORT 是
  major-only `.so.1`，已修）+ S2 对撞 cos=1.000000（registry 免重注册）+ S3 跳过 +
  S4 资产已证。**两个上线前置只剩 D2 数据积累与 D3 标定**。
- 2026-08-30：D3 标定完成，**NO-GO**。真实自由对话分布上 v3.2 无优势（0.705 vs 0.683），
  chirp3→真实域迁移翻车（FLEURS 教训二次应验）；当前判停体验实为 delay 参数兜底，换模型
  非杠杆。半天成本免掉 2 天白投+体验倒退灰度。迁移线暂停；采集口照跑，真实用户数据到量
  零成本重测；sherpa×1.28 与采集口资产不作废。若真实分布仍自由对话形态 → 判停正道改
  ASR/语义融合，另行立项。
