---
name: home-studio-boot-maintenance
description: 核验 home-studio 重启后的系统、数据与关键服务，排查 Plymouth/GDM 启动收尾卡住，维护已有开机保护及回滚；用于“重启了检查一下”“启动异常修复”，重启前文件保全使用 home-studio-reboot-preservation。
---

# home-studio 重启验收与启动维护

适用主机 `hahaxiong-home-studio`（Ubuntu，用户 `hahaxiong83`）。检查请求先只读；已有故障修复授权内继续必要操作。重启验收本身不触发再次重启，也不批量重启业务服务。准备重启、临时文件保全与恢复转用 `~/mycc/.claude/skills/home-studio-reboot-preservation/SKILL.md`。

## 真源与入口

- 先读 HOME/项目规则、`~/mycc/docs/rules/HOME-STUDIO-STORAGE.md`、共享记忆最新相关事件；核真实主机和 `/data` 挂载。证据放 `/data/home-studio/maintenance/<本次目录>/`，未挂载则停止该处写入；只读诊断仍可继续。
- 修复源码与安装/回滚唯一入口：`~/mycc/4-Assets/scripts/home-studio-boot/`，先读其 `README.md`；不要复制一份 guard 或绕过安装器手改同名系统文件。源码留 NVMe，证据/导出留 data。
- 通用重启验收和服务探针见 [references/post-reboot-checks.md](references/post-reboot-checks.md)；要修改启动配置时读 [references/plymouth-repair.md](references/plymouth-repair.md)。已验实例和跨智能体接线见 [references/verified-case.md](references/verified-case.md)。历史 boot ID、PID、文件数仅用于对照，不作新一轮固定期望。

## 先区分三个状态

1. **仍在启动窗口**：读取 boot ID、开机时刻/单调时间、guard timer 的实际触发时间与等待状态。已安装的 timer 默认开机 90 秒执行；此前 `starting`、原 wait activating、timer waiting 不能直接判为保护失败。在剩余窗口内分段观察，每次等待不超过 60 秒，不手动触发保护来冒充自动验收。
2. **启动收尾成功**：systemd 为 `running`，启动 jobs 清空，系统/用户 failed 为空；原 wait 为 active/exited、Result=success、ExecMainStatus=0。一次性 guard 执行后 inactive/dead 是正常退出，需结合本 boot 日志/Result 判断。timer enabled 只证明接线，不能证明本次执行。
3. **仍有异常**：timer 到期不等于 guard 必须瞬间完成；区分尚未调度、等待依赖、正在执行和已失败，结合本次启动时间与实际加载的45秒服务上限判断，不能在第91秒就判超时。guard 报错、原 wait timeout 或系统 degraded 时保留证据并查具体失败分支；180秒是原 wait 从自身启动起算的等待上限，触发后不能算修复。不要 reset-failed 清除验收证据或仅杀 wait 制造完成表象。

## 验收层次

- **在线修复**：同 boot 的原 daemon/wait 确实消失，wait 正常成功、系统收尾，GDM/业务 PID 与修复前一致、健康载荷有效。命令退出 0 不是完成条件。
- **原 wait 已超时**：上述“原 wait 正常成功”判据已无法补成历史事实。保存失败快照，再为实际故障准备有明确范围的恢复；当前恢复状态与本次启动失败分别报告，不能清除 failed 后追认原 boot 成功。此时不要盲目重跑只适用于 activating/start 的安装救援；修复后的自动开机路径用新 boot 验收。
- **真实重启**：先证明 boot ID 已变化；只用本 boot 的时间和日志。若重现无屏卡住，应看到 guard 的 `action=quit/result=completed/quit_exit=0`，随后 systemd running；正常启动直接完成时 `action=noop` 也可验正常开机，但不宣称本次覆盖了故障恢复分支。新 boot 的业务 PID 应重新采集，不能要求等于旧 boot。
- **数据/应用**：核 data 的设备 UUID、迁移链接、恢复入口、关键应用有效载荷、记忆监听和既有 timer。路径可读、内容哈希、NAS 恢复是不同层次；本次只需要增量/可读性检查时，不重复全量机械盘扫描。
- **长期结论**：一次真实重启通过支持本机当前版本和已覆盖条件，不等于任意硬件/升级情形都通过。驱动日志是否新异常要对比旧 boot；GDM active 不等于用户屏幕已独立验收。

## 持久化交接

把本 boot ID、触发时刻、前后状态、采样范围、实际变更和未验边界写到本次证据目录；敏感探针只保存状态/大小/选择的健康字段。更新共享 `0-System/RECENT_EVENTS.md`、必要的原子 item 和 task-log，明确覆盖旧的“待安装/待重启验收”状态。沿用共享写锁并只提交本任务增量，其他智能体从共享记忆及本技能继续维护。
