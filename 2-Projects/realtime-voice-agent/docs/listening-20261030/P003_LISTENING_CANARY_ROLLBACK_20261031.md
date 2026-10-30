# P003 倾听独立候选回滚记录

状态：2026-10-31部署为关闸待联调。已完成恢复预检及本地15文件字节恢复检查，未在生产执行回滚演练。

## 固化点

- 主Brain真实备份：`/opt/p003/backups/listening-20261030`，含15文件manifest、restore/payload、main.env.before/after、nginx.before/after、listening-config.before.json、search-flags.before.json、rollback-main-standby.py。环境备份含凭据，仅服务器受限目录保留。
- 候选Brain：`/opt/p003/listening-canary-20261030`，service `p003-listening-brain`。
- 候选Worker：`/opt/p003-listening-canary-20261030`，service `p003-listening-worker`；单独 `p003-listening-room-cleanup.service/.timer`。
- 普通Worker保持PID1546073，原搜索Worker保持PID1652015；原搜索Brain保持PID3151603；Analytics保持PID3192914。
- 主Brain重启后PID3296061，PM2重启计数40→41。新候选Worker最终PID1711812，自动重启次数0。
- 新Worker编译commit `985eeedea59beeef01c7821370e086a99005a87a`，运行SHA `29c84c8d3d508534faa9c4948b978521a41b5e7cd95cfbd2914324682b141421`。
- 原搜索Worker SHA `82a55342af43d0c35bb4b624ff2366394d6cf28aeb81f659233616f4ff11136b`；普通Worker SHA `a00744bfb55478e9d549d19f8712e643e2d9234901aa81e3cb93855c4b5ceb2d`。
- 原搜索window SHA `ca222d61d796576b1fdeb73d2d2e180e704c4b369e6262bc07c4cdc28ccb1331`，到期2026-11-02 11:19 CST，保持不变。

## 当前待机阶段回滚

适用前提：倾听revision仍为4、总闸关闭、搜索派单保持旧P2，两台未切换。先核查当前状态，不直接套用到之后的已开窗状态。

1. 语音服务器确认新候选jobs=0、关房队列为空；执行：

```sh
systemctl disable --now p003-listening-worker.service p003-listening-room-cleanup.timer
systemctl stop p003-listening-room-cleanup.service
```

2. Brain服务器先执行只读恢复预检：

```sh
python3 /opt/p003/backups/listening-20261030/rollback-main-standby.py
```

预检校验15文件after SHA、主env、Nginx、原搜索配置、倾听revision4且关闸。任何漂移都会停止，不覆盖后续变更。

3. 预检通过后执行：

```sh
python3 /opt/p003/backups/listening-20261030/rollback-main-standby.py --apply
```

脚本关闭独立Brain，恢复15文件及原env/Nginx，受控重启主Brain并核health。仅恢复倾听配置行到旧字段形态，以**新revision5**保留审计连续性；其他配置、设备资料、埋点数据及新审计表保留。不得整体回灌config.db或devices.db。

4. 核主Brain健康、普通/旧搜索Worker PID及SHA不变、旧窗口截止/名单/agent未变、非目标仍普通派单。原倾听后台回到旧版展示。新候选目录和日志保留作取证。

如已切到新candidate或配置revision变化，以上自动脚本会拒绝；先关闭倾听，等待撤权/关房，恢复经现场核准的旧派单及其窗口后制定定向回滚。不要强改SHA检查或把旧数据库覆盖回去。

## 发布与运维边界

- Main仅一个authority；候选倾听worker-ready/lease/close/summary/feedback经精确Nginx路径归主Brain。
- 新候选有独立实例身份、key、数据/队列/socket，不与旧候选复用调度agent。
- 新候选保留启动UTF-8审计与RES_OPTIONS等待预算；两个drop-in仅作用新unit。
- 合成搜索验收两条任务已取消；不留待向设备补播的验收结果。
- 原搜索后台observer仍指旧P2，切流前必须处理对应候选显示/编辑目标。
- Android合同SHA不变：mode `c055866fad0e9b69cdd75c526eeb2fee6ad97899641d792be63037a064bf2411`；HTTP `86825d6281da13fdf17c32b04d5c9dcb4edf71ceb69257d839aacb9df0a99f1e`；fixtures `c58dd98ade3329d04e5c9b7622e7e4668c33483b38cd804f37257e5baa6d415b`。

署名：codex（OpenAI）| 2026-10-31 00:12 CST
