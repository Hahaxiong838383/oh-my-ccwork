# Task 6-R：Release Provenance Guard

## 结论

Task 6-R 已完成本地工程实现、专项测试、选择性提交、推送和只读发布准备检查。发布 Source Commit 为 `916ee03c4a22028d5b78c1aee72d37b98ceb9fdb`，准备状态为 `change_readiness=ready`。当前生产 H 控制面仍是健康的 `v1.56.2`，尚未部署、重启或改变生产流量；待川哥单独授权后发布 `v1.57.0`。

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

## 仍待完成

只读发布检查已验证：

- 已推送提交与本地发布文件一致；
- `v1.57.0` 控制面测试通过；
- 管理员密码来源文件格式有效，未输出密码内容；
- 生产服务 active，当前版本 `v1.56.2`；
- `/srv/h-control/.env` 属主和 `0600` 权限正确；
- 公网健康检查为 200，未登录管理页继续 302；
- 发布归档 SHA-256 为 `6513532aef76a79bbfb0b4098ae8505f92dbe5cefaab41d75aa0e93f12310b7d`；
- `restart_executed=false`。

下一步：

1. 川哥确认预计影响和回滚门禁后，单独授权生产重启；
2. 发布 `v1.57.0`，发布脚本只执行一次 `systemctl restart h-control`；
3. 完成回环、公网、管理员登录、发布对账和真实 Chrome 验收；
4. 分开记录 `engineering_verified` 与 `owner_accepted`。
