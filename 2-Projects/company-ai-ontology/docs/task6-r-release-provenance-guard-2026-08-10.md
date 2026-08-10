# Task 6-R：Release Provenance Guard

## 结论

Task 6-R 已完成生产工程闭环。当前 H 控制面为 `v1.58.2`，Source Commit `8f63fb9296bdb3cc5c658181f3d2fb78f986d919`，Release ID `20260810-175955-h-control-1.58.2`，50 个运行文件 `release.state=in_sync`、`mismatchCount=0`。发布停启跨 1 秒、`NRestarts=0`，真实 Chrome 白盒 `99/99`；Bridge、员工私人 Bot、Agent Core、Domain Connector 和公司 QNAP 未重启。

## 要解决的问题

H 控制面的版本号只能证明进程声明了哪个版本，不能证明生产服务器上的 Dashboard、Whitebox、Server 和版本文件确实来自同一个已评审提交。Goal 6 UAT 曾出现“`/healthz` 版本正确，但生产目标文件落后”的源码漂移，因此发布证据必须从单一版本标签升级为：

```text
已推送 Source Commit
  + 发布批次 Release ID
  + 生产目标文件 SHA-256 集合
  + 运行时重新计算结果
  + API / 浏览器读回
```

## 已实现契约

发布 Manifest Schema 为 `1.0.0`，包含：

- `sourceCommit`：40 位 Git 提交；
- `releaseId`：唯一发布批次；
- `version`：H 控制面版本；
- `generatedAt`：Manifest 生成时间；
- `fileSetHash`：排序后的目标文件路径与 SHA-256 的整体哈希；
- `files[]`：目标文件相对路径与 SHA-256。

运行时只公开脱敏摘要：

- `sourceCommit`；
- `releaseId`；
- `fileSetHash`；
- `state`：`in_sync` / `drifted` / `unverified`；
- `trackedFiles`；
- `mismatchCount`；
- `checkedAt`。

不公开生产主机路径、文件内容、凭据、内部错误正文或不一致文件名。

## 运行规则

1. Manifest 只能从发布提交解包后的暂存目录生成，不能从当前生产目录或未提交工作区生成。
2. Server 启动后按 10 秒缓存重新计算目标文件哈希。
3. `/healthz.release` 与认证后的 Ontology 看板使用同一个 Inspector，不通过公网递归调用自身。
4. `drifted` 或 `unverified` 会把总体状态降为 `degraded`，但不会把仍可达的公司大脑误报为 `offline`。
5. 发布后必须同时验证回环 `/healthz`、公网 `/healthz`、认证看板和真实浏览器组件卡。
6. 任何 Source Commit、文件集合哈希或不一致数不符都会触发发布脚本自动回滚。

## 本地验收范围

- Manifest 构建、Schema 校验、路径穿越防护和符号链接拒绝；
- `in_sync → drifted → 恢复后 in_sync` 文件篡改负测；
- 缺失或内部不一致 Manifest 的 `unverified` 失败关闭；
- 10 秒缓存与强制重新检查；
- `/healthz` 和 Ontology 状态接线；
- 看板新增第 12 张“H 控制面发布”卡；
- 发布脚本生成、安装、备份、回滚和发布后对账静态测试；
- 浏览器验收新增 Source Commit、文件集合哈希和 12 组件断言。

## 生产闭环证据

最终发布已验证：

- 已推送提交与本地发布文件一致；
- `v1.58.2` 控制面 `289/289`、默认治理批次 `307/307`；
- 管理员密码来源文件格式有效，未输出密码内容；
- 生产服务 active，当前版本 `v1.58.2`；
- `/srv/h-control/.env` 属主和 `0600` 权限正确；
- 公网健康检查为 200，未登录管理页继续 302；
- 发布 Manifest 跟踪 50 个运行文件，Source Commit、文件集合哈希和公网读回一致；
- 回滚备份为 `/srv/h-control/backups/20260810-175955-h-control-1.58.2`；
- 真实 Chrome `99/99`，控制台错误、失败请求、卡片/连线碰撞和横向溢出均为 0。

后续规则：

1. 发布准备与正式操作之间必须重新 fetch 并读取生产版本、启动时间、文件哈希和 Manifest；
2. 同版本运行文件一致但 Manifest 缺失时只做零重启补签；
3. 新版本必须从已推送 Source Commit 构建完整运行时清单、暂存测试、备份和单次重启；
4. Runtime Source Commit 与发布 Tool Commit 分开记录；
5. `engineering_verified` 与 `owner_accepted` 继续分开记录。
