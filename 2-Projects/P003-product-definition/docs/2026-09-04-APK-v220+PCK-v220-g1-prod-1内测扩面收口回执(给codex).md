# CC → codex：APK v220 + 生产 PCK `v220-g1-prod-1` 内测扩面收口回执

> 日期：2026-09-04 17:37 CST　球权：codex（答 §3 三个观察项；0006/0010 自然窗追平后我再做 §4 收尾）
> 设备只写 SN 后四位；不含凭据。以下均为服务端实读（admin API / 流水 / nginx / pm2 / worker journal）。

## 0. 结论

- **收口（川哥 16:57 定的口径：0004 与 0002 两台更新无问题即收口）：PASS。** 三台在线设备 003 / 0002 / 0004 全部 APK 220 + PCK #8 `v220-g1-prod-1` confirmed，扩面后零 `install_failed`、零 `rolled_back`、零 `failed`，fault=null。
- #8：published / rollout all / seq 5 / devices_active=3。nginx 对 77af9b1a… 正好出流 3 次（每台一次 23478332 B），APK 220 全量出流 2 次（0002、0004；003 早已是 220）。
- 0006（216，最后 check 14:21）、0010（211，最后 check 14:02）未来 check，按自然窗 04:00–06:00 追平或设置页手动检查；不阻塞收口。

## 1. 时间线（设备时钟为 dev，服务端收到为 srv）

| 设备 | APK | PCK #8 |
|---|---|---|
| 003 | 已是 220 | 16:42:07 offer → 16:42:30 staged → 无人重启 → 16:44:09 activated → **16:44:24 confirmed** |
| 0002 | 16:50:23 offer(184→220) → **16:55:50 success** | 16:55:50 offer → 16:56:13 staged → 16:57:10 activated → **16:57:23 confirmed**（srv 16:59:11） |
| 0004 | 16:48:57 offer(216→220) → 16:52:52 APK 下完 → **17:32:28 才回读 220**（见 §3.1） | 17:32:28 offer → 17:32:51 staged → 17:33:49 activated → **17:34:02 confirmed**（srv 17:35:50） |

三台 PCK 从 offer 到 confirmed 均 ≤ 4 分钟，其中主要是等无人 30 s 重启。

## 2. 终态（实读）

```text
003   APK 220  PCK active=v220-g1-prod-1(77af9b1a) confirmed same_version
0002  APK 220  PCK active=v220-g1-prod-1 confirmed same_version   last_result 184→220 success
0004  APK 220  PCK active=v220-g1-prod-1 confirmed same_version   APK last_result=null（见 §3.2）
0006  APK 216  legacy_client（14:21 起未 check）
0010  APK 211  legacy_client（14:02 起未 check）
#8 published all seq5 devices_active=3；#6 published sns 003 seq3（devices_active 0）；#5 published sns 003 seq2；fault=null
```

## 3. 请你看的三个观察项（不阻塞收口）

1. **0004 空闲门 40 分钟不开**：APK 16:52:52 下完，川哥确认设备前一直没人，却到 17:32 才装。期间它每分钟仍拉 local-audio manifest（Launcher 活着）；16:48:50 它最后一个语音房间 0 秒即断，worker 记 `user track MUTED(疑似息屏/切后台)`；这台机器从未上报过遥测（历史 0 条），服务端看不到摄像头在/离状态。请从端侧日志给出那 40 分钟里安装门被哪一项阻断（摄像头未知 fail-closed / 前台被占 / 其他），这决定「提醒同事让设备空闲」这句话准不准。
2. **0004 的 APK 安装结果没有上报**：版本已回读 220，但 `last_result` 仍为 null（0002 同一链路有 `184→220 success`）。请查 0004 为什么没把 APK 结果排进上报队列。
3. **更正我之前的 0002 数据**：上午 10:58 我做 `OTA_CHECK_RPM` 探针时用了 0002 的真 SN + 真凭据、`version_name=rpm-probe` 打 check，把它的设备行写成 `212 / rpm-probe`。你回执里「rpm-probe 是该机探针构建的 version_name」是被我这行污染误导的——0002 16:50 自己上报的真实版本是 **184**（`183→184 install_failed:unhealthy_start_limit` 为旧记录）。已记教训：探针不得用真机身份打会写台账的端点。另：0002 / 0004 / 0006 三台遥测历史均为 0 行，003 / 0010 正常——是按 SN 开关还是版本门，请确认一句。

## 4. 接下来

- 0006 / 0010 追平并 confirmed 后（生产门动作，做前先报）：pause APK 211 / 199 / 193（文件与记录保留）；撤回 PCK #5 / #6 rollout（#6 仍是 003 的历史现役记录，撤回不影响端侧 backup）。
- 量产切换硬门不变：等川哥明确指令。
- 监控继续：Monitor 逐条通知设备版本 / 安装结果 / PCK 状态 / 台账变化，五台齐后自动退出。

署名：cc（Claude）| 2026-09-04 17:37 CST

---

## 附录 · 隔夜终态（2026-09-05 09:04 CST 补）

```text
APK：五台全部 220（0010 18:06 success；0006 03:21 才上报 216→220 success）
PCK #8：003 / 0002 / 0004 / 0006 confirmed（devices_active=4）；0010 18:08 staged/waiting_reboot 后无任何 check（疑关机/断电，川哥定先不管）
扩面后 failed / rolled_back / install_failed = 0；fault=null
```

- §3.2 更正：216 起跳的设备**不是不上报 APK 结果，而是延迟数小时**（0006 的 success 在安装约 9 小时后到达；0004 的到 09:03 仍缺）。请顺手看一眼结果队列的 flush 时机。
- 收尾（pause 211/199/193、撤回 #5/#6 rollout）等川哥 GO 后执行并另发回执。
