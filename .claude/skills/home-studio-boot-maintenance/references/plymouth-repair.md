# Plymouth/GDM 故障修复与回滚

仅在用户已授权解决启动故障时执行本节变更。先查已部署版本与当前条件；已健康且源码一致时直接验收，不重复安装。

## 已知故障与适用条件

本机 GDM 在无显示器时可能尚未完成 greeter 首屏/注册，未发出 Plymouth 交接；系统 `starting`、原 wait 持续 activating，但 failed 列表为空。四个 DRM 输出均 disconnected 是实测条件。已安装 guard 仅在以下条件同时成立时正常 `plymouth quit`：

- 至少发现一个 DRM 接口，全部可读且精确为 disconnected；无接口/读取失败/unknown 不当作无屏。
- GDM active/running、有效 PID、稳定至少 10 秒；刚 active 只额外等待一次 10 秒后重查。
- 原 wait 仍 activating/start，`/run/plymouth/pid` 对应存活的 plymouthd；动作前重核，避免热插拔或 PID 改变。

connected 显示器、GDM 失败或 PID 不符时停止自动修复路径并定位实际故障，不能扩大无屏补丁的作用域。普通用户 `plymouth --ping` 失败可能是权限，不证明 daemon 消失。i915/LSPCON 错误需对比旧 boot；本次历史实例中早已存在，不作为改驱动/内核的依据。

## 不能破坏的接线

- 本机 `gdm.service` 明确 `Conflicts=plymouth-quit.service`；直接启动系统的 quit unit 可能停掉 GDM。修复脚本直接调用官方 `/usr/bin/plymouth quit`，不停止 GDM、不 mask 原 wait。
- timer 挂 `timers.target`，OnBootSec=90s、AccuracySec=1s；service 在 GDM 后运行。不要排到正在等 Plymouth 的 graphical/multi-user target 后，也不要加 `Before=plymouth-quit-wait.service` 制造排序环。
- quit 自身 10 秒上限，随后核原 daemon 消失、wait success/0、GDM PID 保持；guard 总启动上限 45 秒。原 wait 的180秒上限只是显性失败兜底，不是成功路径。
- root 服务执行 root 拥有的系统脚本；维护工作树只作源码，不能把 root unit 指向普通用户可写 checkout。

## 安装、更新、撤销

读取 `~/mycc/4-Assets/scripts/home-studio-boot/README.md` 和当前 `install.py`，先保存相关状态；在授权范围内使用现有脚本：

```bash
sudo /usr/bin/python3 -I /home/hahaxiong83/mycc/4-Assets/scripts/home-studio-boot/install.py install
```

安装器先完成当前卡住的交接，再安装原 wait 的超时 drop-in 和 reload：旧任务可能早已超过180秒，倒序会先把它打成失败。目标必须原先不存在，或与同包已安装清单完全一致。升级时分别比较“已装文件↔旧版root manifest”和“旧版↔新包”：前者偏离意味着未知/并发修改，应查清归属；只有后者不同是正常版本差异。保存旧包与证据、审查修改后，按已有升级授权撤销匹配清单的旧版并安装新版；部分安装先调查，不能覆盖冲突或删除 `manifest.json` 绕过校验。

遇到 sudo 密码要求，先完成具体可审查安装包、验证和回滚；若工具能操作用户可见的安全终端，由智能体发起已准备的命令，用户仅完成系统认证。若当前工具只有不可见的 agent PTY，明确说明这一限制，交付一条已准备的命令供用户在可见终端执行；不要让用户编写脚本。Codeg 终端入口为「切换终端」，Ctrl+J / Mac Cmd+J；后端创建 PTY 不代表用户界面可见。无需重新索取已经授予的修复权限；密码只进系统提示，不发聊天，不经容器等其他通道绕过认证。

撤销入口：

```bash
sudo /usr/bin/python3 -I /home/hahaxiong83/mycc/4-Assets/scripts/home-studio-boot/install.py uninstall
```

它按 root 控制清单 `/var/lib/home-studio-boot-guard/manifest.json` 验 SHA，仅移除本包；发现文件被并发改动时停止。撤销不会重新启动已经退出的 Plymouth，也不重启 GDM/业务。不要为了测试回滚而撤销健康生产配置；代码变动时先跑现有行为单测（本案例12项）和含drop-in的单元校验，真实启停操作另按本次任务授权执行。

修复完成后按主技能验收在线与真实重启两层。已有真实重启证据仅覆盖当时部署版本；后续变更需要新的对应验证。
