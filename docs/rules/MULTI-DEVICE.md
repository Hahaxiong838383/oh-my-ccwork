# MULTI-DEVICE: 多设备协作

| 字段 | 值 |
|------|-----|
| 优先级 | P2 |
| 权重 | 0.60 |
| 是否常用 | 可选 |
| 是否必选 | 必选 |
| 触发条件 | 新机器初始化 / 跨设备同步 / 涉及 .env 凭据 / 家↔公司跨站大文件传输 |

## 动作

| 类型 | 处理 |
|------|------|
| 共享的（git） | CLAUDE.md、skills、文档 |
| 本地的（gitignore） | `.env`、`settings.local.json`、二进制、`current.json` |
| OS 差异 | 由 `platform.ts` 运行时处理 |

## 跨站大文件传输

满足任一条件即按大文件处理：单次数据 `>=100 MiB`、预计传输超过 `60s`、批量目录、或任务要求断点续传。

1. **Air 不直接承担家→公司的长时间跨站传输**。默认先在家庭局域网落到已验证的有线中转节点，再由该 Linux 节点向公司端发送。首选 `linux-lan`；飞牛仅在实时确认 SSH 身份、主机指纹、磁盘空间、路由和拥塞控制后使用。
2. **先做只读预检**：确认中转节点有线接口在线、目标可达、剩余空间充足，并实时读取 TCP 拥塞控制与 qdisc；不得把旧记忆里的 `bbr+fq` 当作当前事实。
3. **必须可恢复**：使用 rsync partial/partial-dir、rclone 临时文件或等价机制；中断后续传，不从零重跑。
4. **批量文件并发从 4 路开始，测量后再升到 8 路**；若重传、丢包、CPU 或磁盘等待明显恶化则回退。`rclone --transfers` 只增加文件级并发，不会自动把单个大文件拆成多路。
5. **单个大文件单独处理**：优先使用后端明确支持的单文件并发能力；否则安全分块、并发传输、目标端重组并校验。多个裸 `scp` 不是默认方案。
6. **两阶段验收**：核对字节数、文件数和 SHA-256；目标校验通过前不得删除 Air 或中转节点上的源文件。

具体命令、节点选择和验收步骤见 `.claude/skills/cross-site-file-transfer/SKILL.md`；本机 `.agents/skills/` 入口为 Codex/Grok 提供同一正文的符号链接。

## Why

mycc 跨 4 台设备（Air / Mini / Studio / NAS）协作：
- 共享内容 git push/pull 同步，零冲突
- 本地凭据每台机器独立维护，git 不追踪
- OS 差异（macOS / Linux / Windows）在代码里处理，不在配置文件里
- Air→中转仍经过家庭 Wi-Fi；中转的价值是先在局域网快速落盘，再由有线 Linux 独立完成可续传的长距离传输，避免 Air 睡眠、离网或端到端链路波动拖垮整个任务。
- 2026-08-16 实测的 `2–6%` 是 Air↔公司 EasyTier 端到端路径丢包，Air Wi-Fi 是风险因素，但不能写成已证明的唯一根因。

## 详细参考

[`docs/setup-guide.md`](../setup-guide.md) — 新机器初始化、提交规范

## 关联规则

- [`MOBILE-MYCC.md`](MOBILE-MYCC.md) — 移动端访问
- [`.claude/skills/cross-site-file-transfer/SKILL.md`](../../.claude/skills/cross-site-file-transfer/SKILL.md) — 跨站大文件操作手册
