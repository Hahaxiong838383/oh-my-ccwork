# P003 启动连接修复：回滚记录

本次上线：2026-10-31 15:50:48 北京时间。只回滚目标 Worker 二进制；不恢复旧整份环境、窗口或数据库。

| 目标 | 当前版本 SHA-256 | 可回滚版本 SHA-256 | 备份目录 |
|---|---|---|---|
| voice-worker-rust | `52f644bb6628a818b364f829b49fcea6126eea0ddcd2a195f00522d683c2369c` | `cbe8c79124a718c913a3e1dc9e7cb7119809ef9f19b32895f206e83bdbe066f6` | `/root/rust-worker/backups/rtc-startup-rejoin-20261031T075014Z` |
| p003-search-worker | `0dc3f810bcb1fa3d43b9998a906759dafdf3c01039394409b7a2be9214b6d6f3` | `e0b511b304264593f2b8195a5ff4a3eedf9776955b8aa5f6214ff72907ccaab4` | `/opt/p003-search-canary-20261021/backups/rtc-startup-rejoin-20261031T075043Z` |

回滚前重新确认目标空闲、当前运行 SHA 仍等于本回执版本，若已有后续发布，停止套用此记录。保持原截止时间与三设备名单；回滚二进制无需关 Analytics 或恢复配置数据库。

执行顺序：

1. 核对对应备份 `manifest.json` 与 `voice-rust-worker` SHA；文件和备份均在同一服务器。
2. `systemctl stop <目标 unit>`；确认 MainPID=0、该服务 control group 无残留子进程。
3. 将对应备份二进制原子替换到当前 unit 的 ExecStart 路径，权限 0755。普通池为 `/root/rust-worker/voice-rust-worker`，P2 为 `/opt/p003-search-canary-20261021/voice-rust-worker`。
4. `systemctl start <目标 unit>`；核 `/proc/<新PID>/exe` 的 SHA、active、无自动重启，且新 PID 日志出现 `registered worker`。
5. 核 P2 健康、三设备名单、截止时间和两路并发未变；普通池天气修复仍在。保存回滚时间、前后 PID/SHA 与结果。

部署脚本自身已包含失败回滚和回滚后注册验证；上线成功并不等于本次实际执行过生产回滚。此次有意保留的基线分别为当天天气修复版和会话 24 三设备发布版。

回滚会重新引入本次启动阶段误删房间缺陷；它用于紧急恢复到已知前版，不是该故障的最终处理。

署名：codex（OpenAI）| 2026-10-31 15:50:48 CST
