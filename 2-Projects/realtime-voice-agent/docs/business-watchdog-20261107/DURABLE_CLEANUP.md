# 普通池持久清理接线 — 未部署

在87c417a3业务保护接线基础上补普通池失败重试。现役23点前只读仍PID3179125、NRestarts0、二进制35f59ec…；无安装/重启/配置修改。

## 行为

- 复用独立reconcile_rooms.py，新增显式business模式与schema2；固定`rust-worker`、私有`/var/lib/p003-business-cleanup/queue`。candidate默认模式/schema1及原灰度截止不变；两类记录互斥，不因普通房无灰度窗口而误删。
- 普通记录保存原room/SID、cfg修订、PID和进程启动标识，无正文/凭据。活任务不按固定房龄或搜索窗到期删除；任务Drop写closing，进程死亡也可清理。单写入fsync+原子替换，异代记录不覆盖。
- 新Enforce任务必须先见120秒内healthy且mode=business的专属状态，并成功落盘记录。失败则明确日志降observe，保留业务进展状态，不能因运维组件未就绪阻断现役对话。候选池仍由原队列保护，尚未适配倾听源码。
- 前台失败和HTTP200但原SID仍在不会删记录。独立定时器每轮至多8项、串行控制请求、未决项轮转，失败保留到后续执行。原SID已不存在/名称指向其他SID时退出清理，不再删除那个已观察到的替代房。
- 这不是SFU原子SID删除：DeleteRoom接口按name，读与删之间仍有TOCTOU窗口。固定87c的Grok独立复审正在核该边界，未给上线通过。

## 验证与失败保留

- Python新增business场景先5失败，修复后整个ops/search-canary目录24通过，含真实localhost HTTP503后下次成功、200仍在、owner失效、名称替代、记录被并发替换以及candidate隔离。
- Rust新增持久记录和observe降级测试：先524通过/2失败，修复后全套526通过；源码与构建manifest逐文件核同。
- Linux systemd-analyze verify 两个unit exit0。unit未安装、未启动；尚未做真实timer/杀进程/公网故障注入。
- 实际生产ListRooms只读查不存在房名得到`{"rooms":[]}`，不是仅假设空列表形式；控制请求未创建或删除房。

## 上线顺序与回滚

先备份现役文件及状态→安装独立脚本/unit并空队列运行→核status、身份、定时器和控制端可达→再在已验Worker/Brain及目标设备范围启用。开关默认off；启用前还须完整候选Grok复审、release ABI、真实RTC、倾听池适配及单机配置一致性。

回滚先关新业务执行模式，保留重试组件直至队列经SFU回读排空；不要删队列、不要回灌数据库、不要关闭共享candidate清理。二进制回退仅回本轮已备份35f59ec…，保留11月6日TTS/生命周期修复。源代码回滚可只revert本次持久清理增量。

署名：codex（OpenAI）| 2026-11-07
