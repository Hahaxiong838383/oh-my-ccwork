# P1-SI 内部 Runtime 更新验收包

状态：`READY_FOR_EXPLICIT_INTERNAL_RUNTIME_UPDATE_AUTH`

## 1. 结论

目标 Artifact 已完成源码、镜像、SQL Runtime、Hash、独立内部 Runtime 编译验证和公司 QNAP 真实 Docker 输出预演；公司 QNAP 当前状态健康且仍运行旧内部包。现在只缺川哥对新 Artifact 的“更新内部 Runtime、但不运行 Collector”独立授权。

原授权指向 Artifact `9096846710`。真实 QNAP 暂存预演发现该 Artifact 的运行态采集脚本把 Docker Go Template 中的 `\t` 当作真实制表符，导致 13 个健康 Foundation 服务被误判为异常且 restart 统计为 `null`。部署在任何旧 Runtime 替换前失败关闭；Artifact `9096846710` 已拒绝，不得继续部署，也不能把原授权继承给新 Artifact。

## 2. 公司 QNAP 当前真值

只读复核时间：`2026-08-11T15:28:05Z`。

- 公司资产：`PRNas / TS-X65 / 192.168.61.18`；
- Foundation：`/share/CACHEDEV1_DATA/ai-ontology/foundation`；
- 部署账号：`uid=1000 / gid=100`；
- active Ontology：Schema `3.3.0`，Hash `41689393289d9514d1ed9cd22455a164f1bc59286f0db16deb9235e703e6ae77`，Registry `in_sync`；
- Foundation 长期运行服务：13；异常：0；restart：0；
- Compose 一次性 `foundation-init`：`exited / exitCode=0 / restart=0`，不属于长期运行服务故障；
- 13 个长期运行服务指纹：`b11e7789fea4d8b6f62e1e0aad0ac70fb5f0ae2bd134ff8cbf799da0d6f75887`；
- 战略情报项目容器、网络、发布端口：0；
- Collector 运行目录、报告文件、Evidence 文件：0；
- 当前内部 Runtime：Commit `a7aeae25e414b570cab8ff1fdfbdc12d5d027dc5`；
- 当前内部 `.env.internal` 权限：`0600`，尚未固化 `SI_NODE_RUNTIME_IMAGE`；
- 当前内部包不包含首次运行 Evidence 编译器、验证器和 Schema。
- 当前 `.previous-backup` 来自首次安装，目标目录存在但没有 `previous-runtime.tar.gz`；它不能作为回滚归档。更新脚本必须先为现有 `a7aeae25e` Runtime 生成新归档和 SHA-256，再允许替换。

## 3. 目标发布身份

- Source Commit：`70bd73544fb29ca1b7ed1e2469353ce6ada1bb1f`；
- Runtime Workflow：`31506896848`；
- Artifact ID：`9107441466`；
- Artifact：`p1-si-runtime-70bd73544fb29ca1b7ed1e2469353ce6ada1bb1f`；
- Collector Image ID：`sha256:500d2201a2ebc0c68af5ce941f7410057233c94fe6886dfd33cdd4a0c76100dc`；
- QNAP Node Runtime Image ID：`sha256:75228afe839b63f6bef21d2ea8f4b6aa9e4c56a20ad70cec5450ca84a72f9801`；
- Node Runtime：`linux/amd64`，部署时使用 `--entrypoint node`、QNAP 非 root UID/GID、`network=none`、只读根文件系统、无端口和无 Docker Socket；
- Artifact `SHA256SUMS`：下载后全量通过；
- 010/011、19/19 强制 RLS、Domain 二次幂等、ACL fail-closed、baseline restore：通过；
- 从 Artifact 源码包独立编译 Runtime：3 来源、6 条 P003 样例、每来源 20 条上限、8 个 Registry 来源保持 paused、全部业务副作用关闭。
- 公司 QNAP 真实暂存预演：Foundation `13/13 running`、异常 `0`、restart `0`，战略情报容器/网络/端口 `0/0/0`；修复后的分隔符在 QNAP Docker 实际输出上验证通过。

## 4. 本次授权动作范围

允许：

1. 将 Artifact 和编译后的内部 Runtime 放入公司 QNAP 战略情报受控目录；
2. 校验发布 Hash、Runtime Contract 和公司 QNAP 五元组；
3. 加载新的 Collector 镜像；
4. 备份旧内部 Runtime；
5. 原子替换内部 package/config，并写入 `0600 .env.internal`；
6. 执行 `docker compose config`；
7. 重新读取并验证安装后的 Evidence Schema、编译器和验证器。

旧 Runtime 备份必须同时满足：归档非空、`tar -tzf` 可读、包含 `package/`、`config/`、`.env.internal`，并通过同目录 SHA-256 校验。任一条件失败都必须在镜像加载和目录替换前停止。

不允许：

- 不执行 Collector；
- 不启动 Orchestrator；
- 不执行 010/011 或其他数据库迁移；
- 不重启 Foundation、Agent Core、H-Lite、Connector、Gateway、Postgres、Redis 或 Qdrant；
- 不创建正式 P2、不员工投递、不写回 ERP/社媒、不激活因果关系；
- 不执行真实回滚；回滚仍需独立授权。

## 5. 影响与时间

| 项目 | 预期 |
|---|---|
| 既有业务中断 | 0 秒 |
| Foundation 重启 | 0 |
| 数据库迁移 | 0 |
| 新常驻容器 | 0 |
| 新端口 | 0 |
| Collector 运行 | 0 |
| 部署耗时 | 约 3～5 分钟 |
| 主要资源影响 | 短时磁盘 I/O、镜像加载与文件解包 |

## 6. 更新后验收

1. `SI_SOURCE_COMMIT=70bd73544fb29ca1b7ed1e2469353ce6ada1bb1f`；
2. `.env.internal` 为 `0600` 且固化 QNAP Node Runtime Image ID；
3. Evidence Schema、编译器、验证器和运行态采集脚本存在；
4. Runtime Validator：3 来源、6 条 P003 样例、8 个来源继续 paused；
5. Foundation 13 个长期服务指纹与更新前一致，异常 0、restart 0；
6. `foundation-init` 继续保持正常 `exited(0)`，不被误判为故障；
7. 战略情报容器、网络、发布端口、Collector 运行、报告和 Evidence 仍为 0；
8. active Schema、Hash 和 Registry 状态不变；
9. 生成新的内部 Runtime 部署证据，但不生成采集 Evidence。
10. 新 `.previous-backup` 指向的目录必须包含可验证的 `previous-runtime.tar.gz` 和 SHA-256 文件；回滚脚本在移动当前 Runtime 前能够重新验证它们。

## 7. 授权语句

`授权将 Artifact 9107441466 更新到公司 QNAP 内部 Runtime，但不运行 Collector、不迁移数据库、不重启 Foundation。`
