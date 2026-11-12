# Grok 固定候选最终独立验收

日期：2026-11-12T08:07:58+08:00　｜　角色：Grok 独立验收（不写生产、不改业务源）
固定运行 SHA：`ac21c2d75648a4fa4fc49b18adb2ef0f9a4f7e84`
文档 HEAD：`a760634f655187c0e33c754f73c781e8238f4c07`（仅后来证据文档，三份业务源码与固定 SHA 字节一致）
生产基线：`36f18f55b31c07472b480add33152390b3899032`
旧候选 `b0426e1e` 不是现候选。

**给主13：单C内测服务端隔离合同 PASS，可按三文件+开C scope/grant 发布。生产未变更。不得声称生产低延迟或 p50<50ms 通过。真人/家长token/页面/T04 未验。**

## 1. 本人本轮实际核了什么

用 `git archive ac21c2d7` 独立目录 + 本机 `/Users/fu-121/.local/node-v24/bin/node` v24.19.0。不是 265 未冻结副本，也不是主13代跑旧矩阵回执。

| 项 | 结果 | 日志 SHA256 |
|---|---|---|
| 三业务文件 archive/git/tar 对拍 | 与 CANDIDATE.json after SHA 一致 | 见 GROK-FINAL.json |
| mini008-dashboard 真 HTTP+SQLite | **16/16** | `199b6a2dcc3609b183d48bce40a33749f083aa015c1474fe3fb91be86d0f03db` |
| 旧 telemetry 回归 | **37/37** | `d7d7bdc86baf85691fc7b794fcac3c56336924b4567f3b2523d33591e1163809` |
| grok-isolated-accept 打在固定 SHA | **36/36** | `a2984d3dd74f80ef82824f7ad5ef5a929ad1fbfb8280e946c50d5ad89cb5fb70` |
| 小库 EXPLAIN 命中新索引双边 | PASS | `fa45b401f2b1722f07a6060d6aeb50fb28516c8171e9cc5601fd012903999ecb` |
| 基线 36f18 源码保索引回写 | 索引保留，旧 focus/posture accepted，integrity ok | `50fa565d9fb2de2203cdaa2016a348efdb82e1501a573ae937365d77e7d6623a` |

未重复 216000 行捕获。Brain Node22 93 项与 Analytics Node24 11 项沿用已完成隔离记录；Node22 跑 history 的 11 失败原日志保留。

## 2. 合同门

| 门 | 判定 |
|---|---|
| owner / epoch / grant / scope 失效隐藏 Ark | PASS |
| normal 保留 0 与 null；GM/unknown 不转 normal、不漏 1400 | PASS |
| usage 缺测 null；短段 round0 available；旧 today 0 兼容 | PASS |
| 跨沪日切分；首次接收不因 duplicate 刷新 | PASS |
| 同 ID 冲突不改分钟；异 ID 重叠 reject | PASS |
| 新 `idx_tel_focus_sn_end` 回滚旧代码可继续写，索引保留 | PASS |
| 无第二钱包 / 新 usage 路由 / TTL 删除 / Analytics 补余额 | PASS |

C 尾号 `02000031` 仍未开 scope/grant。本轮未改线上、未发短信、未清库、未改 owner。

## 3. 性能（桌面隔离证据，非生产预算）

沿用主13固定 archive 的 216000 行对照（`candidate-ac21.json` SHA `be204bb998dcd18d01b0e9a221b82da49fccb0d889c4df36247041c1080e50ca`），本轮不重跑：

- usage p50：360.92ms → **126.55ms**
- 新 focus 摄入 p50：约 273ms → **1.37ms**
- 优先目标 p50<50ms：**未达到**
- 本轮小库计划：`USING INDEX idx_tel_focus_sn_end (sn=? AND <expr>>? AND <expr><?`

同步窗口扫描仍在。单C内测可接受该桌面改善；**生产语音低延迟未通过、也未测。**

## 4. 最小真实验收边界

只覆盖：隔离 loopback HTTP、临时 SQLite、合成 JWT/SN/grant、三份业务 src vs 基线。  
不覆盖：公网家长 GET、真机 focus_segment、授权后 unknown/normal 真值、OTA mini008 安装、页面视觉。

发布面仍是两份 replace + 新增 `src/ark/dashboard.ts`。回滚恢复 before 两份并删除新增 dashboard；保留索引与全部事件。

## 5. 裁决

- 隔离服务端：**PASS**
- 单C内测发布：**READY_WITH_CONDITIONS**（主13统一发布；逐文件 before SHA；C 开 scope/grant 保持 epoch2/原 owner；Worker/Analytics 不随本次重启）
- 阻断项：无（服务端隔离）。真人全链仍待 T01–T06。
