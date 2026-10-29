---
name: cross-site-file-transfer
description: 家↔公司通过 EasyTier、SSH、rsync 或 rclone 传输大文件和批量目录的安全操作手册。用户提到大文件、批量上传、跨站传输、Air 直传慢、linux-lan/飞牛中转、rsync 续传、rclone transfers、并行 scp、Studio 文件搬运时使用。
---

# 跨站大文件传输

规则入口：`~/mycc/docs/rules/MULTI-DEVICE.md`。本 Skill 负责执行步骤，Rule 负责强制边界。

## 适用范围

满足任一条件即启用：单次数据 `>=100 MiB`、预计超过 `60s`、批量目录、或要求断点续传。SSH、Codex RPC、少量配置文件等交互小流量不需要中转。

## 核心判断

- Air 不直接承担家→公司的长时间跨站传输；先在家庭 LAN 落到有线 Linux，再由中转节点独立发送。
- 源端与目标端已在同一局域网或已验证直连链路时，预检通过后直接传输；跨站中转是远距离链路的默认可靠性方案，不是所有迁移的强制跳板。
- 中转没有消除 Air 的 Wi-Fi 第一跳；它把第一跳缩短为局域网落盘，并把长时间跨站任务移交给常在线、有线、可续传的节点。
- ⚠️ **中转买的是「可靠性/无人值守」，不是「更快」。总耗时很可能比直传更长，别按提速来预期或汇报。**
  2026-08-16 实测（同一时刻，单流 20MB 到 dev198）：
  Air(WiFi) `0.28 MB/s` · linux-lan(有线+BBR) `0.19` · 飞牛(有线+BBR，i5-8500 六核 load 0.28) `0.15`
  —— 两台有线机**都比 Air 慢**；中转总耗时 `131.6s`（5.5s 落盘 + 126s 跨站）vs 直传 `70.4s`。
  当时丢包 Air `15%` / linux-lan `30%`：丢包高到这个量级，有线相对 Wi-Fi 的优势被跨网拥塞完全淹没。
  **要按速度选路，必须当场分别实测两段**，不能沿用「有线+BBR 所以更快」的推论。
- **丢包有强时段性**：同日 `3.3%`(下午) → `15~30%`(晚高峰)，两侧分属移动/联通，指向跨网互联点拥塞。
  ⇒ 任何吞吐数字必须带同时刻丢包否则不可比；**避开晚高峰的收益可能大于任何选路与调参**。
- `rclone --transfers N` 是多文件并发，不是单文件分片。单个大文件需要后端明确支持的单文件并发，或安全分块后并行。
- BBR 只影响 Linux 节点自己发起的 TCP 流；每次任务都要实时检查，不能用旧文档代替当前状态。

## 1. 选择中转节点

默认使用 `linux-lan`。2026-08-16 实时基线为：有线接口在线、到 Studio 走 `easytier0`、TCP 拥塞控制为 `bbr`、`net.core.default_qdisc=fq`；但有线和 EasyTier 接口当时实际 qdisc 为 `fq_codel`，因此不得笼统汇报“当前 bbr+fq”。

飞牛可作备选，但使用前必须确认：

1. 使用仓库设备真值获得正确节点名、SSH 用户和地址。
2. 主机指纹已知且匹配；禁止用 `StrictHostKeyChecking=no` 接受未知主机。
3. 磁盘、路由、TCP 拥塞控制和实际接口 qdisc 均通过实时检查。

## 2. 只读预检

```bash
# Air：确认源大小、文件数和工具能力
du -sh "$SOURCE"
find "$SOURCE" -type f | wc -l
rsync --version | head -3
command -v rclone || true

# linux-lan：确认磁盘、路由、BBR 和实际 qdisc
ssh linux-lan 'df -h "$HOME"; ip route get 10.10.10.12; \
  sysctl net.ipv4.tcp_congestion_control net.core.default_qdisc; \
  tc qdisc show dev enp0s31f6; tc qdisc show dev easytier0'

# 目标：只读确认可达和空间；目标别名按设备真值选择
ssh studio-mesh 'df -h "$HOME"'
```

任一项失败就停止，不先改网络、代理或拥塞控制。

## 2.1 同站直传与含空格的远端路径

Studio→NAS、雷电直连或其他已验证同站链路可直接使用 rsync，但仍要做源大小、目标空间、主机指纹和断点续传预检。

macOS 自带 openrsync 2.6.9 的远端路径会再经过一层远端 shell 解析：

- 仅用本地引号包住 `host:"/path with spaces/"`，不保证远端把完整路径视为一个参数，可能静默写入空格前截断的同级目录。
- 优先在远端参数中保留字面反斜杠，例如 `host:/path\ with\ spaces/`；或使用不含空格的临时入口/软链接，完成后在同卷原子移动到正式目录。
- 正式传输开始后立即从目标端核对精确路径、文件数、逻辑字节数和父目录下是否出现意外同级目录。对空目标的 dry-run 只能证明传输可执行，不能单独证明远端路径解析正确。

## 3. 第一阶段：Air → 家庭中转

Air 当前 `rsync` 兼容 2.6.9，不要直接套用新版才有的 `--info=progress2`、`--append-verify` 或 `--protect-args`。使用兼容的 partial-dir 续传：

```bash
rsync -a --partial --partial-dir=.rsync-partial --progress \
  "$SOURCE/" "linux-lan:$STAGE/"
```

上例按目录传输；单文件应去掉源路径末尾的 `/`。再次运行同一命令即可复用 partial 数据。路径含敏感信息时不要把路径或文件名写入聊天、日志、Skill 或 Git。

第一阶段完成后记录：

```bash
(cd "$SOURCE" && find . -type f ! -path './.rsync-partial/*' -print0 | \
  LC_ALL=C sort -z | xargs -0 shasum -a 256) > /tmp/source.sha256
ssh linux-lan "cd '$STAGE' && find . -type f ! -path './.rsync-partial/*' -print0 | \
  LC_ALL=C sort -z | xargs -0 sha256sum" > /tmp/stage.sha256
cmp /tmp/source.sha256 /tmp/stage.sha256
```

上例用于目录并保持相同相对路径口径；单文件直接在两端执行 SHA-256 并比较。不一致时不得进入第二阶段或删除步骤。

## 4. 第二阶段：中转 → 公司

### 批量目录

已有经批准的 rclone SFTP remote 时：

```bash
ssh linux-lan 'rclone copy /path/to/stage/ studio-sftp:/path/to/dest/ \
  --transfers 4 --checkers 8 --progress'
```

先测 4 路，再试 8 路；只有吞吐提高且重传、CPU、磁盘等待没有明显恶化才保留 8。不要把 `8` 写成永久固定值。

若中转节点没有 rclone，不得静默全局安装；先按 `LOCAL-DEPS` 规则处理。可暂用单路 rsync 保证正确性，再决定是否安装 rclone。

### 单个大文件

- `--transfers 8` 对单文件无效。
- 先检查目标后端是否明确支持单文件并发；SFTP 参数与 rclone 版本相关，先查本机 `rclone help backend sftp`，不要凭记忆硬编码。
- 若单文件仍受单流限制，使用固定大小分块、并行传输、目标端按顺序重组，并对原文件和重组文件做 SHA-256。磁盘空间不足以同时保留原文件、分块和重组文件时不得使用分块方案。
- 多个裸 `scp` 只作为受控实验，不作为默认生产流程；它的失败恢复和完整性收口弱于 rsync/rclone。

手工分块的重连必须保持**每块一个写入方**：锁覆盖读取现有长度、启动传输、等待子进程退出的整个区间。
重试前停止并回收上一轮 SSH/worker；只查主线程 children 或 `PPid=1` 会漏掉线程创建、被 subreaper 接管的进程。
记录任务所属 PID/进程组并核目标文件仍无旧写入者，不按宽泛进程名清理。
每块期望总长为 `min(块大小, 源总长 - 块起点)`，续传只接收期望总长减去已核现存长度的剩余部分；超长块隔离后重下，不能截断便宣称完整。
源应冻结或验前后清单，逐块长度正确仍须重组全量 SHA 一致。脚本补了锁但未重跑故障场景时，记录修正尚未验证。

## 5. 观测与自动回退

每档并发至少观察吞吐、失败数、CPU、磁盘等待和 TCP 重传。出现以下情况时降低当前并发（8→4，4→单路）；长度或校验异常先停止相关写入并查明原因：

- 平均吞吐没有提高或波动明显扩大。
- SSH/SFTP 重试、超时或校验失败增加。
- 中转节点 CPU 或磁盘成为新瓶颈。
- EasyTier 路径退化为高延迟 relay，或目标路由改变。

## 6. 最终验收与清理

1. 传输前生成源端全文件 SHA-256 清单；传输后重算源端清单，确认传输期间源没有变化。
2. 目标端核对精确路径、总逻辑字节数、文件数、符号链接和全文件 SHA-256，目标清单必须与源端逐字节一致。
3. 对同一白名单执行 rsync dry-run，要求变更 0 行、stderr 0 行，并确认 `.rsync-partial` 为 0。
4. 在删除源之前，把根项 JSON、files-from、源前后清单、目标清单、rsync stats、dry-run 和汇总写入目标 `_verification/`；验收证据必须先于不可逆清理落盘。
5. 源删除必须由用户明确授权，并严格按已验收的根项白名单执行；删除后再次确认根项剩余 0 和磁盘空间变化。
6. POSIX `R/W/X` 检查不能发现 macOS ACL 的 `deny delete`。删除前扫描 `find ... -acl`、`ls -leO` 和不可变标志；只移除阻塞已授权白名单删除的精确 ACL/标志，不扩大权限范围。
7. 空且不可读的目录应从候选中排除并保留，不为完成归档擅自修改权限。
8. QNAP/BusyBox 环境不保证存在 `unlink` 命令；临时文件只按精确路径使用普通 `rm "$path"` 清理，禁止宽泛 glob 或 `rm -f`，并复查残留为 0。

## 禁止事项

- 不把 Air 端到端 `2–6%` 丢包全部归因于 Wi-Fi；它是风险因素，不是已证明的唯一根因。
- 不把 BBR 写成“网络自动加速”；它只作用于相应 Linux 发送端的 TCP 流。
- 不自动接受未知 SSH host key，不猜飞牛用户名，不把密码或 token 放进命令参数。
- 不因传输慢就盲改 EasyTier、Xray、MTU、KCP 或系统 qdisc；先做 A/B 测量。
- 不把 rsync 的成功统计等同于“写入了用户指定目录”；含空格目标必须从目标端独立确认实际落点。
