# GROK 隔离终验（只复核）

**结论：`SCOPED_SERVER_SDK_PASS`。** 本轮未跑测试、未 SSH。7 场景、2 轮、10 次执行。不是 Android 四项全 PASS，也不是全量 canary。磁盘探针等于第 2 轮 `3004af66…`；第 1 轮 `59dbb6c6…` 失败保留。进度稿已被第 2 轮结束记录覆盖。

## 证据

主池 capacity1（两轮）：`max_jobs=1` 时 `active_jobs=1, available=false`，第二房 4 秒无 `job_assignment`，`capacity_no_overadmit=true`。释放后 147ms / 411ms 内新房 `input_ready`，恢复房有双方 final 与 `played_frames` 512/520。`capacity_decline_logged=false`：无超卖指未分配第二 job，没有 “at full capacity” 文案。

no-subscribe 以第 2 轮为准。两池在首条 provider PCM 时检查点均为 `output_ready=false`、`voiced_ms=0`、`fatal_already=false`；随后精确 5s fail-closed，且有 `pipeline failed → closing job`。首 PCM 到 fatal 为 5068ms、5075ms（界 4900–7000），并禁止 `played_frames>=1`。删房信号对齐 job 数，`forced_cleanup_count=0`。下一房 SID 不同，ASR+TTS 为 3930ms/512 帧与 4070ms/528 帧。

第 1 轮倾听 `no_subscribe` 保留 `wrong_close_reason`：当时已有 5s 原因、首 PCM、0 声、空轨、自然删房；没有时间字段和下一房。第 2 轮只重跑主 capacity、主 no-subscribe、倾听 no-subscribe。

主池 prestart（第 1 轮）：同房 `uVJZ3Usr`、1 job、replacement accepted=1，新轨 `3dXXB83U` 不同于 `PdatPMqJ`，随后 3960ms、512 帧。身份是合成 SDK。

主池 Worker（第 1 轮）：私有 SFU 踢掉 agent 后旧房 `oqNeEgGL` 关闭；`replace.request` 之后 terminate 再 exec，隔离 PID 9466→9555，sha 仍为现役 main。新房 `ui9uFaXF`，job=2，replacement 信号 0，恢复 3940ms、512 帧。不含同房热迁移，也不证明 Android 旧 publication 拒绝。

## 生产与边界

两轮前后 PID/NRestarts/sha 不变：main 4183959/0/`8a953489…`；listening 4170463/0/`517f5290…`；search 2446060/0/`56f6878f…`。生产未变，隔离进程已停，强制清理均为 0。

边界：loopback 私有 SFU + `v389-isolated-*` + 合成 LLM；现役原字节。倾听 capacity/candidate 不在范围（信号与事件为 0）。runner 哈希未入账。无必须补测项。
