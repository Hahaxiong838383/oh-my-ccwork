# home-studio 无显示器启动收尾保护

用于修复 Ubuntu 24.04 的 GDM 无显示器启动时未完成 Plymouth 交接、系统长期停留 `starting` 的已观察故障。安装需要正常管理员认证；代码准备与离线测试不代表已经部署。

## 行为与边界

- 每次开机 90 秒后由系统 timer 运行；DRM 接口必须非空、全部可读且全部 `disconnected`，GDM 必须 active/running 至少 10 秒，原 wait 必须仍在 activating/start，PID 必须对应活着的 plymouthd。
- 满足全部条件后直接执行官方 `plymouth quit`（10 秒超时），核实原 daemon 已退出、wait 正常成功、GDM PID 未变。正常完成过的启动直接 no-op；拒绝分支和退出失败有明确 journal/failed unit 证据。
- 原等待器加 180 秒超时，避免未知故障无限等待。触发该上限是 degraded 故障，不等于图形启动恢复。保护服务自己的启动上限 45 秒；仅对刚 active、不足 10 秒的 GDM 额外等待 10 秒再完整检查一次。
- 不重启 GDM/业务进程，不 mask 原服务，不调用 `systemctl start plymouth-quit.service`：后者与本机 GDM 有 Conflicts，会停止 GDM。
- 不修改内核、显卡驱动、GRUB、数据挂载、凭据或网络。该措施针对本次确定的启动交接故障，不能保证任意硬件或未来升级故障永不发生。

## 安装与撤销

在用户可见的本机/Codeg 终端中运行（密码只输入终端提示，不写进聊天、命令参数或脚本）：

```bash
sudo /usr/bin/python3 -I /home/hahaxiong83/mycc/4-Assets/scripts/home-studio-boot/install.py install
```

安装器仅接受该包的目标路径原本不存在；不会覆盖未知已有配置。它先安装 root 拥有的 guard，完成当前卡住的交接，再写入 drop-in、daemon-reload 并 enable timer，防止当前已超过 180 秒的旧任务被新超时先打断。root 控制状态与 SHA256 清单在 `/var/lib/home-studio-boot-guard/manifest.json`。失败自动删除字节仍匹配的本次新增文件；若其他管理员并发修改，停止而不覆盖。

撤销（不重启桌面，不撤销已经完成的正常 Plymouth 退出）：

```bash
sudo /usr/bin/python3 -I /home/hahaxiong83/mycc/4-Assets/scripts/home-studio-boot/install.py uninstall
```

## 验收

```bash
python3 -B -m unittest discover -s /home/hahaxiong83/mycc/4-Assets/scripts/home-studio-boot -p 'test_*.py' -v
python3 -B /home/hahaxiong83/mycc/4-Assets/scripts/home-studio-boot/plymouth_guard.py --check
systemctl is-system-running
systemctl list-jobs --no-pager
systemctl --failed --no-pager
systemctl is-enabled home-studio-plymouth-guard.timer
systemctl show plymouth-quit-wait.service -p ActiveState -p SubState -p Result -p ExecMainStatus -p TimeoutStartUSec
journalctl -b -u home-studio-plymouth-guard.service --no-pager
```

在线应见 systemd `running`、启动 jobs 清空、原 wait active/exited + success/0、timeout 3min，GDM/Codeg/codex-lb/P01 等 PID 与业务健康保持。timer active/elapsed 也是已触发一次的正常状态。真正的下次重启还必须核新 boot ID、timer 本 boot 的执行/正常 no-op、自动挂载及业务响应；不要把在线验收等同于真实开机验收。

## 诊断依据（2026-11-02）

boot `2b56a574-c4c0-4f3d-bb80-aca124ced145`，17:01:24 开机，GDM 1357 / GNOME Shell 1693 稳定；Plymouth daemon 335 / wait 1343 持续等待，六个启动任务未收尾。四个 DRM 输出均 disconnected；GNOME 打包代码在无 primaryMonitor 时等待显示器，greeter 未完成 GDM 注册，与交接缺失一致。i915 LSPCON 错误旧 boot 已存在，不把它认定为本次新故障。

原数据保全与重启检查证据：`/data/home-studio/archives/reboot-20261102/`。本次实施证据：`/data/home-studio/maintenance/boot-guard-20261102/`。实际是否安装、在线修复及下一次开机是否验收，以该目录最新状态和系统实时回读为准。
