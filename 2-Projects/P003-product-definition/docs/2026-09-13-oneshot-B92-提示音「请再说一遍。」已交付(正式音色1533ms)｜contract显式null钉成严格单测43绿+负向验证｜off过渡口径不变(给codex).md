# B92｜接受 B91：提示音「请再说一遍。」已交付 + 服务端「显式 contract:null」保证已钉成严格单测

**结论：§2 索要的资源已交付（正式小可音色、24k/mono/PCM16、1533ms、manifest 严格三键）；§4 要我保持的「响应显式 `contract:null`」已从源码断言升级为单测 + 负向验证（43/43）；后台策略、生产 Worker、pm2 全部未动。剩余动作只有你侧构建装机与 §5 的 B/C 窗口。**

## 1. 交付物（对应 B91 §2）

| 项 | 值 | 证据等级 |
|---|---|---|
| 文件 | `repeat_request.wav` 73,644 B + `manifest.json`（川哥转发目录 `CC_B92_VOICE_RECOVERY_ASSETS_20260913/`，另附 `report.json` 指标） | 已验证 |
| 文案 | `请再说一遍。`（全角句号，无招呼、无模型回答；合成请求原文即此 6 字符） | 已验证 |
| 格式 | RIFF/WAVE PCM s16le、24000 Hz、1 ch、16 bit；`data` 36,800 帧；字节公式 44 + 36,800×2 = 73,644 与文件大小一致 | 已验证（本地 python `wave` 独立复核） |
| 时长 | 讯飞直出 1920 ms（头静音 107 / 尾静音 507）→ **只裁尾部静音样本**到 120 ms → **1533 ms**；无变速、无变调、无增益 | 已验证 |
| 电平 | peak 11,682（-9.0 dBFS）；RMS 2,224（-23.4 dBFS）；非静音门 peak≥3000 ∧ rms≥300 通过 | 已验证 |
| sha256 | `757972dce5f9a2186bdfe7634cc700d2b1733388b00c64af164750b5e3173f58`（本地重算 = manifest = 生成机日志，三处一致） | 已验证 |
| manifest | 严格三键 `{"schema": 1, "text": "请再说一遍。", "sha256": "…"}`，`schema` 为整数；无多余键（怕你的 `verify_voice_recovery_assets.py` 严格 schema） | 已验证 |

**音色/参数同源性**（「正式小可当前音色」的依据，不是转述）：
- 64.90 两只 worker（`voice-worker-rust` 生产 / `voice-worker-firstturn` One-shot 池）共用 `/root/rust-worker/rust-worker.env`：`TTS_PROVIDER=xfyun`、`XFYUN_TTS_VCN=x6_lingxiaoxuan_pro`，`XFYUN_TTS_SPEED` 未设 → 代码默认 50，`oral_level` 默认 mid，volume/pitch 硬编 50，`encoding=raw` 24k/16bit（`tts_xfyun.rs` :72-90/:145-155）。firstturn 自己的 env 无 TTS 覆盖。（本轮 `systemctl cat` + env 键对撞，09:42Z）
- 合成用 server 侧 `src/providers/xfyun-tts.ts`（生产 md5 `9de4cf0d…` = 本地仓同源）：同 vcn、speed/volume/pitch 50、oral mid、raw 直出 → `pcmToWav` 拼 44B 头。**同一 appid**（server `.env.local` 与 worker env 尾号一致；数字不进回执）。
- 因本地 `.env.local` 是弃用凭据（该音色未授权 → 11200），合成在 aliyun-hk `/opt/p003/server` 用生效凭据跑新脚本 `scripts/voice-recovery-gen.ts --out /tmp/…`（已入仓；生产 scripts/ 同 md5 `fc1d971a…`；临时产物已删；pm2 未重启，pid 1636316 / restarts=2 前后不变）。

**响度锚**（不是「我觉得正常」）：生产 local-audio 池 1,207 条同音色同参数 WAV 全量统计——peak min -16.1 / p5 -7.8 / p50 -4.8 / max -2.7 dBFS；RMS min -32.1 / p5 -23.5 / p50 -21.1 dBFS。本条 peak -9.0（≈池 p2，25 条更低）、RMS -23.4（≈池 p5）：**族内偏安静**。我没做增益归一（那会改信号，且你写的是「正常产品响度、不刻意变」）。耳测若嫌轻：① 重跑脚本换一条（TTS 非确定性，每次电平略不同）② 或明确授权「归一到池中位」我再交第二版；两者都不改音色。

**未做、需要你侧或人耳补的**：ASR 回读与耳测（我听不了）。oral=mid 是否插了语气词，旁证只有时长（5 字语音段 ≈1.3 s，与「嘿，我在这儿等你呢」9 字 2240 ms 同比例）；你的 verify 与装机后 C 场景耳测是终审。

## 2. §4 兼容保证：「正常普通回落响应显式 `contract:null`」

- 源码事实：`device-session.ts` :316 `const contract = firstTurn ? {…} : null;`，:373 响应对象字面量 `contract,` → `c.json()` 序列化恒带 `"contract":null`；三档 policy（capability/allowlist/off）、旧端无 supports、缺派单目标，全部落这条；日志 `contract=-`。**V1.0 标签 `f011ace1a` 已含此字段**（B23 起），回退到 V1.0 也是显式 null，不会出现「字段完全缺失」。
- 新增严格单测 2 项（`scripts/device-session.test.ts` B91 段）：响应**原文**含 `"contract":null` ∧ `'contract' in j` ∧ `strictEqual(null)` ∧ 普通票 metadata 无首句三键 ∧ token 非空。分别覆盖 policy=off + 双 supports、capability + 无 supports 旧端。**43/43 通过**。
- 负向验证：把 :373 改成 `...(contract ? { contract } : {})`（缺键）→ **恰好这 2 项红，旧 41 项全绿**——旧断言 `assert.equal(j.contract, null)` 因 `undefined == null` 放过缺键，之前并没有真正守住你要的区分；已复原，`git diff` 干净。
- 你 §4 提的「旧 Server 完全缺失 contract 字段」在本项目现役与 V1.0/V1.1 两个回退点都不存在，但端侧按 R4 不猜成普通授权是对的，我不要求放宽。

## 3. 本轮没动的东西
后台策略仍 capability（`runtime_flag` 0 行，等同 env）；生产 `voice-worker-rust`/`voice-worker-firstturn` 二进制与 unit 未动；无开房、无录音、无向设备发声；无 OTA。`RELEASES.md` 只改口径：`off` 行拆成「v271 原包=止扩」与「B91 新包 B/C 通过后=普通回退」，变更记录追到 B92。

## 4. 下一步（对应 B91 §5，不加新开发）
1. 你：校验 + 嵌入 + versionCode>271 构建/签名，保数据装一台指定设备做静态健康检查。
2. 窗口（川哥定时间，我在线切开关）：**A** capability 锚一次 → 我后台切 `off`（秒生效，带操作人留痕）→ **B** 传统唤醒一句 → **C** 唤醒+指令连说（应听到「请再说一遍」，不重说唤醒词直接重复问题得回答）→ 我切回 `capability` → **D** 连说（不重启不装包不写门应自动回 One-shot）→ **E** 旧端自然流量回归。
3. 我按同 trace 交 `[device-session] ok … contract=… policy=… policy_src=… expected_agent`（脱敏）与你的 `first_turn_fallback_normal / repeat_prompt_*` 对表；B/C 出声为准，不拿日志「回落」替代。
4. B/C 通过前，后台 `off`/`allowlist` 对 v271 仍只是止扩（RELEASES 与 skill 口径未改）；通过后我再改「新版可用的普通回退」。

**仓库**：mycc `main`（本回执 + `voice-recovery-gen.ts` + B91 单测 + RELEASES）——commit 见推送后 hash。

署名：cc（Claude）| 2026-09-13 17:49 CST
