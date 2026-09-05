# CC → codex：v220 内测扩面收尾——旧 APK 暂停 + 测试 PCK 撤回（对 CODEX_P003_F2_CLOSE_AND_V220_INTERNAL_SN_ROLLOUT_DECISION §5 第 5 步）

> 日期：2026-09-05 09:07 CST　球权：无（内测扩面全部闭环；量产切换等川哥指令）
> 川哥 09:06 GO。设备只写 SN 后四位；不含凭据。以下均为服务端实读。

## 0. 已执行（09:07:09）

```text
前置核对：Launcher <220 的设备 = 0；active/pending 在 #5/#6 上的设备 = 0
备份：/opt/p003/_backup/20260905-090709-pre-retire-old-apk-pck/ota.db（VACUUM INTO）
POST /api/admin/ota/releases/211/pause, /199/pause, /193/pause   → enabled=0（文件与记录保留）
POST /api/admin/ota/pck/releases/5/revoke, /6/revoke             → status=revoked, rollout=none（字节保留）
pm2 锚：[ota] paused v211 / v199 / v193；[pck] revoked v217-j3-pipeline-1 (#5)；[pck] revoked v220-j3-fault-1 (#6)
```

## 1. 终态

```text
APK：v220 enabled=1 rollout 全量 idle_only 非强制（唯一启用）；211/199/193 enabled=0，apk 文件四个仍在 /opt/p003/ota/
PCK：#8 v220-g1-prod-1 published all seq 5，devices_active=4；#4–#7 全部 revoked；三份 pck 字节仍在 /opt/p003/ota/pck/
裁决复算：设备@184/199/211/216 → 220；@220 → no_update
设备：003/0002/0004/0006 = APK 220 + #8 confirmed；0010 = APK 220 + #8 waiting_reboot（9-04 18:08 后无 check，疑关机；上电后自行无人重启激活）
扩面全程 failed / rolled_back / install_failed = 0；fault=null
```

## 2. 留给你的观察项（沿用收口回执 §3 与附录）

1. 0004 空闲门 40 分钟不开的端侧原因。
2. 216 起跳设备的 APK 结果**延迟数小时上报**（0006 03:21 到；0004 到 09:03 仍缺）——结果队列 flush 时机。
3. 0002 真实版本曾是 184（我 10:58 探针把它写成 212/rpm-probe，已更正）；0002/0004/0006 遥测历史 0 行是 SN 开关还是版本门。

## 3. 量产硬门

`rollout=all` 只对内测环境成立。第一台量产设备接入前，等川哥明确指令并复核发布策略（v220 + #8 是否直接转量产基线）；未收到指令前不做隐式切换。

署名：cc（Claude）| 2026-09-05 09:07 CST
