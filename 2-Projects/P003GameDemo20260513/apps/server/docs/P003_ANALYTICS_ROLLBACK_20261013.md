# P003 埋点发布回滚记录

用户于2026-10-13明确授权开发部署、更新记忆并保留回滚。本次回滚边界是公司P003后台/配置/独立埋点服务，不涉及HK2语音worker、个人站3002或实际儿童设备。

## 变更前恢复点

HK在线快照：`/opt/p003/server/backups/analytics-releases/analytics-predeploy-20261013T005846Z`。

- 源码归档：source-only.tar.gz，112文件，571510字节。
- SHA256：`d9ff628ba9a1b41beffeb1ea8946aace16f16fffb95b570a45673fb447573ad5`。
- manifest.json记录逐文件SHA；state.json记录脱敏PM2及磁盘状态。
- protected目录仅root可读：原.env.local、PM2dump、crontab、devices.db/config.db的一致在线备份。两库integrity_check均ok。
- 前基线p003-voice PID1859321；个人站kidshub-voice PID1626403。只是历史基线，不用于猜测当前PID。
- 新上线逐文件清单：`/opt/p003/server/backups/analytics-releases/analytics-release-20261013/manifest.json`，发布后以该文件及部署回执为准。

不因代码回退恢复整个config.db/devices.db，也不恢复旧PM2dump覆盖其他任务。源文件部署前和恢复前分别校验SHA，后来同事的新改动会阻止自动恢复。

## 一级：立即停止新采集

SSH登录aliyun-hk，在公司服务目录执行：

```sh
cd /opt/p003/server
python3 scripts/analytics-control.py --control /opt/p003/server/data/analytics-control.json --disable
node --env-file=.env.local deploy/analytics-config-off.mjs
```

第一条原子热关总闸，无需重启；下一请求及事务前复核都会关闭。第二条通过原admin配置API关闭analytics全局与已有SN覆盖，保留其他配置键与单调revision。凭据从root受控文件读取，不出现在argv、聊天、日志或文档。

有效设备凭据上传应返回JSON503，error_code=ANALYTICS_UPLOAD_DISABLED，Retry-After=900秒。缺省时保留埋点进程和后台只读能力，便于继续查看已收到批次。**不要删库、清seen或返回404/HTML**。

封装后的一级操作也可执行：`python3 deploy/analytics-rollback.py`。若配置API失联，脚本会失败停止后续动作；前一步总闸已经关闭。此时先恢复gateway可达再完成配置关闭，不能伪称设备已同步关闭。

## 二级：仅本次源码和后台页面回退

先预检（只读，不回写）：

```sh
cd /opt/p003/server
python3 deploy/analytics-rollback.py --code --check-only \
  --snapshot /opt/p003/server/backups/analytics-releases/analytics-predeploy-20261013T005846Z \
  --release-manifest /opt/p003/server/backups/analytics-releases/analytics-release-20261013/manifest.json
```

预检通过后同一命令去掉`--check-only`。程序依次热关总闸、通过admin配置API关上传、停本次两个timer及维护service、停p003-analytics、仅恢复发布清单与旧快照相交的src/package/admin文件、重启公司p003-voice并pm2 save。

保留新增埋点文件、.env.analytics、analytics.db及WAL/seen，供后续重新发布恢复。保留nginx的精确analytics入口和JSON503/900兜底；埋点进程停止后仍给客户端可重试响应。没有必要把nginx恢复为缺少该入口的旧版本。其他nginx locations、OTA大包规则、/myjavis和个人站不受此脚本处理。

恢复前校验当前目标等于本次release SHA；若后来被改过会拒绝覆盖，需人工对该文件作小范围合并。脚本不会清掉别人的改动、全目录删除或批量恢复业务数据。

## 数据恢复与备份

- HK独立维护任务每5分钟聚合；北京时间00:30在线一致备份，原始数据/回执14天、摘要与最小事实90天、seen内测不自动清。维护任务并不在摄入进程内重算。
- HK备份目录 `/opt/p003/server/backups/analytics-daily`，只清本工具时间戳文件，保留最近2份。
- Studio私有异机目录 `/Users/fu-121/.local/share/p003-analytics-backups/hk`，校验SHA及字节后保留7天；protected/.env.analytics保留稳定HMAC与内部秘密。文件0600/目录0700，不进入Git或交接ZIP。
- 上线回执记录实际timer/异机任务执行结果，不能以配置文件存在冒充备份已完成。Vault入口当前未在此机配置；本次不声称已回存Vault，稳定秘密已有root文件和私有异机恢复副本。

单独恢复演练只准恢复到**新的、不存在的隔离目标**：

```sh
python3 scripts/analytics-backup.py \
  --restore /opt/p003/server/backups/analytics-daily/analytics-<实际时间戳>.sqlite3 \
  --restore-to /opt/p003/server/backups/analytics-restore-drill/<新的文件名>.sqlite3
```

检查integrity_check、accepted行数和seen行数，不覆盖现役库。真需要恢复丢失的生产库时，先关闸、停止摄入、保存现役残留、选一致备份，并确保原稳定HMAC密钥同时恢复；属于数据恢复操作，应单独核对恢复点与新旧数据，不能拿代码回退脚本代替。

## 回退后验收

1. upload=false，总闸false；有效设备上传JSON503/900，端侧pending仍保留。
2. 3001公司健康、原admin登录/旧Worker页面可用；个人站3002 PID/状态不因本次操作改变。
3. nginx -t通过、原OTA/其他入口仍在；pm2 save与pm2-root启用状态已核对。
4. 已接收数据库与seen保留。重新发布时稳定HMAC不轮换；同设备同ID重试应duplicated，不重复贡献。
5. 更新回执/记忆记录实际回退时间、代码SHA和未完成联调项。

署名：codex（OpenAI）| 2026-10-13

## 专用运行时与 checkpoint 回退边界

analytics独立运行时为 `/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node`，由主控核验官方SHA后安装；不升级系统Node或语音/个人站。ANALYTICS_NODE_PATH供PM2/maintenance显式选择。共享analytics writer拒绝旧SQLite3.51.2等未修WAL-reset版本，不能以改回系统Node绕过失败启动。

关闭总闸时独立checkpoint仍每10秒singleflight推进（30秒有界deadline；Linux nice10+ionice2/7，健康过期60秒），便于保留已有WAL；停p003-analytics时SIGTERM/SIGINT会清timer及child，WAL/DB/seen和专用runtime均保留。代码回退后重新发布仍用安全专用runtime，检查FULL=2、auto=0、checkpoint.last_success_ms及wal_pressure，再决定开灰度。不要手工删除WAL；256MiB准入硬闸/503数值10秒保护未结算客户端。采集停止、timer停止和数据恢复不混同，不因代码回退恢复旧config.db/devices.db或清seen。

## 协作部署互斥与后来编辑保护

release-apply、rollback（含check-only）和prepare-env共用 `/opt/p003/server/.analytics-deploy.lock` 原子mkdir锁；持锁时其他参与工具立即失败，不穿插部署。正常退出只删除本次创建且身份相同的锁目录；异常进程被kill可能留锁，不自动猜测过期。主控确认没有参与进程后才人工处理残留锁。热关总闸的analytics-control.py仍可独立执行，不以源码部署锁阻断紧急停止采集。

release记录目标原内容SHA、inode/device/模式/时间戳及父目录身份，临时文件准备后整体复核，并在每次replace前再次复核；rollback在关配置/停服务之后重新整体预检、持有当时身份快照，再逐个replace前复核。prepare-env保存最初.env.local原bytes/身份，临时env写入后换回前比较，变化则拒绝覆盖后来其他键。此协议覆盖参与工具互撞和可检测的later edit，不承诺抵挡不遵守锁的外部编辑者在最终检查与rename之间的微小CAS间隙。

发布源码和manifest采用临时文件fsync、原子replace、父目录fsync；manifest0600。中途失败不能称整批发布成功，保留原始bundle和上一份完整manifest供主控比较；部分源码可能已换入，需按bundle逐文件核对后修复发布回执。所有这些操作都不恢复业务DB，不删analytics accepted/seen，不恢复旧config/devices快照。

PM2启动使用 `pm2 start deploy/analytics.config.cjs --only p003-analytics`。当前PM2只把*.config.cjs识别为配置；analytics.ecosystem.cjs保留为共享定义，由config wrapper加载，不将它直接作为CLI入口。第一次直接运行误创建的analytics.ecosystem仅在exec_path完全匹配本发布文件时清理；不得删除其它PM2应用。

PM2实际应用入口为 `deploy/analytics-start.ts`，它显式调用与staging共用的bootstrap。实机RED证明PM2的argv[1]是ProcessContainerFork.js，不能依赖CLI main判断启动。启动缺少配置时只输出固定错误并exit1；正式验收须同时检查3006 ready、FULL=2、auto=0、10秒checkpoint和三重关闭状态。

Studio异机拉取使用安装器的 `--direct-ssh` 参数，保留aliyun-hk别名的同一用户、私钥和严格known_hosts校验，仅在该专用备份任务禁用代理；不更改全局SSH配置。原因是本次代理链出现SSH banner超时，而同一HK别名直连实测成功。若公网直连不可用，回执必须显示拉取失败，不能把HK本机备份当异机成功；每日00:45及每小时补拉由私有LaunchAgent执行，保留7天。
