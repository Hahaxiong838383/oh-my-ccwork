# 重启后只读验收

用于实际重启检查，避免把配置、进程自述或旧 boot 的成功当作本次恢复。

## 系统与启动保护

```bash
hostname
cat /proc/sys/kernel/random/boot_id
uptime -s
systemctl is-system-running
systemctl list-jobs --no-pager
systemctl --failed --no-pager
systemctl --user is-system-running
systemctl --user --failed --no-pager
systemctl show gdm.service plymouth-quit-wait.service graphical.target multi-user.target home-studio-plymouth-guard.service home-studio-plymouth-guard.timer -p Id -p ActiveState -p SubState -p Result -p ExecMainStatus -p MainPID -p NRestarts -p TimeoutStartUSec -p UnitFileState -p LastTriggerUSec -p TimersMonotonic -p ExecMainStartTimestampMonotonic -p ExecMainExitTimestampMonotonic
journalctl -b -u home-studio-plymouth-guard.service -u plymouth-quit-wait.service --no-pager
```

`ExecMainStartTimestampMonotonic` 是开机后的微秒数，除以 1e6 得本次触发秒数；与 `time.monotonic()` 对照，不拿本地墙钟偏差推断 timer 失效。只看当前 boot 的 journal；可用 `-o json` 的 `_BOOT_ID` 绑定证据。guard 的成功 JSON 本身还须与 wait/系统终态独立交叉验证。

确认 `/usr/local/libexec/home-studio-plymouth-guard.py`、两个 `/etc/systemd/system/home-studio-plymouth-guard.*`、原 wait 的 `90-home-studio-bounded-wait.conf` 与当前维护源码哈希一致、root 拥有且普通用户不可写；回读已加载的超时与 timer enable 链，不能只检查磁盘上的文本。

## 数据与找回

```bash
findmnt -n -o SOURCE,UUID,FSTYPE,TARGET,OPTIONS /data
```

按存储规则和当前 fstab 核设备；2026-11-02 基线为 ext4 `/dev/sda1`、UUID `14a1228a-798b-44b9-b994-877c110d263a`，设备名可变化，迁盘时以已批准的新真源为准。逐项解析存储规则中的旧路径，确认仍是软链接、实际目标正确且可读。按最新归档 README 找恢复脚本、清单、Git 外部元数据；不主动恢复旧 PID/socket/锁，不在冷归档中继续开发。

## 业务与智能体入口

先查本机实际 unit/绑定，以下为已验证基线，发生迁移时跟随较新的共享记录：

| 服务 | unit（用户级） | 探针与有效载荷 |
|---|---|---|
| Codeg | `codeg-server.service` | POST `http://127.0.0.1:3080/api/health`，JSON `{}`，现有 `~/.local/share/codeg/token` 只在内存读取作为 Bearer；200、非空 JSON、status=ok |
| codex-lb | `codex-lb.service` | GET `http://127.0.0.1:2455/health/ready`，200、status=ok、database=ok |
| P01 | `p01-invest-research.service` | GET `http://10.10.10.23:18765/api/health`，200、非空 JSON、status=ok |
| Backrest | `backrest.service` | 现有 `http://127.0.0.1:9898/v1.Backrest/GetConfig` 探针，返回中核已批准计划存在；不要输出完整配置或凭据 |
| 微信 | 查当前用户 unit 与实际容器 | 基线为 `10.10.10.23:3001` 的 HTTPS 认证首页；需有效 HTML、应用进程、无 OOM/异常重启，连接方式沿用现有本机配置 |

同一 boot 在线修复前后核 PID/NRestarts；跨重启核新启动时刻、active/running 和稳定性。Codeg 无认证 GET 返回 401 是预期，不等于服务坏了。使用本机直连探针避免环境代理干扰；配置需先经 `cfgview.py` 遮蔽查看，不打印 token、完整 argv/env、业务数据或 HTTP 认证头。认证失败时报告具体层次，不能绕过认证或将 API 不可读判成服务不存在。

从当前 unit 清单与上次已存证据枚举记忆同步/agent-entry 的 path 和关键 timer，逐个核 enabled/active、运行结果；不可把历史“3/11”数量写死来证明新环境完整。原临时桌面会话/诊断 unit 若按设计不持久化，标预期不运行，不为了全绿擅自重建。
