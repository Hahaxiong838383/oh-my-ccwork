# 已验案例与技能发现入口

用于对照历史证据、找回资料和维护接线；不是当前机器状态的替代品。

## 2026-11-02 实机链路

- 首次 boot `2b56a574-c4c0-4f3d-bb80-aca124ced145`，17:01:24启动，无屏 GDM/Plymouth 交接残留。18:06:17 用户在可见终端完成 sudo 安装，直接 quit 成功；系统由 starting 恢复 running，GDM/GNOME与业务进程保持。本 boot timer 随安装触发的是正常 no-op。
- 用户18:10:32再次真实重启，boot `27febd99-b2d7-43ce-bce4-2313820abe38`。只读观察到85.7秒仍在启动窗口；guard在90.656秒自动执行真实 quit，0.088秒完成，systemd running、jobs/failed0。此轮没有手动触发保护，180秒失败上限未触发。
- 同 boot 五应用有效响应、3记忆入口path/11timer正常；data原UUID挂载、10迁移链接、11找回入口和88归档工作树可读。该轮文件核验是路径/可读性，未重复全量SHA，也未重新执行NAS恢复。
- 修复源码commit `0b2780d5`，12项单测及systemd单元/drop-in校验通过。维护时核当前文件/已加载配置，不按历史SHA覆盖后续批准修改。

证据真源 `/data/home-studio/maintenance/boot-guard-20261102/`：`before.json`、`validation.json`、`after-system.json`、`after-services.json`，以及 `reboot-{system,services,files,transition}-27febd99.json`；最新状态看 `status.json` 和 README 后续记录。重启前私密保全 `/data/home-studio/archives/reboot-20261102/README.md`，原 `/tmp` 工作树需要按索引恢复到持久 NVMe 工作区，不能重新依赖已经被清除的旧临时路径。

## 单一技能源与多智能体接线

正文真源 `~/mycc/.claude/skills/home-studio-boot-maintenance/`；入口使用目录软链指向同一处，避免分叉。共享 `0-System` 记录技能名和路径，使没有自动技能发现的 runtime 也可按需读取。具体已验证入口及未验缓存边界以接线验收记录为准。

2026-11-02接线与验收：

| 智能体 | 共享入口 | 本轮证据层次 |
|---|---|---|
| Codex | `~/.agents/skills/<skill>/` | 本机会话已有的技能发现根；新链接、正文和引用可读且同源 |
| Claude | `~/.claude/skills/<skill>/` | 全局入口已接线、正文可读且同源 |
| Grok | 实际inspect返回 `~/.agents/skills/<skill>/` | `grok inspect --json` 真机发现两技能；不能只按随包文档推断它最终选了Claude入口 |
| Hermes | `~/.hermes/skills/<skill>/` | 原生followlinks扫描器发现两技能；未单独覆盖完整disabled/platform过滤 |

两技能指 `home-studio-boot-maintenance` 与 `home-studio-reboot-preservation`；Hermes保全入口在本轮补齐。证据 `skill-native-discovery.json` 与 `skill-installation.json` 位于上述维护目录。Grok完整inspect可能含MCP配置，只在内存筛选本技能名称/路径，不输出或落盘整个对象。

其他runtime可从共享记忆读取同一真源；新增引擎时沿用它实际支持的发现/导入机制。不要为“全部都知道”改写整个引擎配置、重启活跃智能体或把新建软链说成旧会话已热加载。发现层通过不等于模型自动选择、已有会话prompt缓存刷新；无法验证的层次明确保留边界。
