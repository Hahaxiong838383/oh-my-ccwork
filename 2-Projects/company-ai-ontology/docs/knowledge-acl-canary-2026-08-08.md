# Knowledge Connector ACL 生产 Canary 验收

日期：2026-08-08（Asia/Shanghai）

## 结论

Knowledge Connector `2026-08-08.3` 已部署到公司 QNAP，两个 ACL P0 的生产 Canary、真实员工撤权、跨部门与链接直猜负测、镜像回滚和测试数据清理均通过。当前生产恢复为原单资源 fail-closed 配置，公开空间自动发现和启动自动同步保持关闭；产品研究部整库导入仍未批准。

## 生产身份与部署

- 公司资产五元组：用途为公司、SSH 别名 `prnas/prnas-pub`、型号 `TS-X65`、地址 `192.168.61.18`、根目录 `/share/CACHEDEV1_DATA/ai-ontology/foundation`。
- 发布源码来自 Git 提交 `c5d1ded5a`，关键文件 SHA-256 与本地一致，部署到版本化只读发布目录。
- 变更前保存 Compose、600 权限环境文件、旧源码、容器状态、Knowledge Schema dump 和校验清单。
- 旧镜像标签：`rollback-20260808-232809`；新镜像标签：`release-2026-08-08.3-c5d1ded5a`。
- 生产重建只影响 Knowledge Connector；其他 Ontology 组件未重启。

## 测试矩阵

| 场景 | 结果 | 生产证据 |
|---|---|---|
| 文档直接人员授权 | 通过 | 资源 active/known，人员 ACL 存在，授权员工 Evidence 1 |
| 明确空间继承 | 通过 | 文档 ACL 含 `wikispaceid` 时出现 `feishu_space_member` ACL |
| 无空间继承 | 通过 | 文档 ACL 不含 `wikispaceid` 时空间成员 ACL 为 0 |
| ACL 接口失败 | 通过 | `skipped/unknown`，ACL 0，Chunk 0 |
| 正文可读但 ACL 失败 | 通过 | 预检确认正文接口可读；Connector 正式同步仍未调用正文并保持 ACL/Chunk 0 |
| 有权员工检索 | 通过 | Agent Core HTTP 200，permissionFiltered=true，目标 Evidence 1 |
| 无权员工检索 | 通过 | Agent Core HTTP 200，Evidence 0，无目标命中 |
| 真实员工撤权 | 通过 | 飞书协作者真实移除后，旧 ACL 消失，撤权员工 Evidence 0 |
| 撤权后仍授权人员 | 通过 | 其他仍授权人员 Evidence 1 |
| 跨部门越权 | 通过 | 另一部门在职 Principal Evidence 0 |
| 原始 Token / 链接直猜 | 通过 | 撤权员工两种查询均 Evidence 0 |
| 文档删除 | 通过 | Connector fail-closed，ACL 0，Chunk 0 |

员工权限从飞书移除到重新同步并完成负测的观测时间为 `37,757ms`。该数值是本轮实测，不代表永久 SLA；正式导入时仍需建立持续撤权监控。

## 回滚与恢复

1. 把旧镜像重新标记为 active 并仅重建 Knowledge Connector。
2. `/healthz` 返回版本 `2026-08-08.2`、健康、未自动同步。
3. 把新镜像恢复为 active 并再次只重建 Connector。
4. `/healthz` 返回版本 `2026-08-08.3`、健康、`restart_count=0`、未自动同步。
5. 备份清单 SHA-256 复核通过。

## 清理与最终状态

- 临时飞书文档已删除，临时员工协作者已先行撤权。
- 4 条 Canary Resource 已从知识表删除；QNAP 和本机保存过的 Token、员工 OpenID、候选 ACL 文件均已清理。
- 最终生产知识表：Resource 1、ACL Entry 0、Chunk 0；原单资源继续因 `1063004` fail-closed。
- Connector `2026-08-08.3`、Agent Core、H-Lite、Action Gateway、Registry、Postgres、Qdrant、Redis 和 Gateway 均健康，`restart_count=0`。
- Connector 最近 30 分钟严重错误日志计数为 0；公网回环状态已返回 `2026-08-08.3`。

## 仍未放行

- 未正式导入产品研究部 1,222 个节点。
- `department/openchat` 原始成员类型映射仍属于 P1。
- `chat/group` 授权前仍需定义当前会话 Principal 证据、用途边界和撤权语义。
- P1 完成后仍需由用户单独批准整库导入资源范围、时间窗口和回滚窗口。
