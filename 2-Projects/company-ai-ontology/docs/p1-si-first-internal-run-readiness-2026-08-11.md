# P1-SI 首次内部一次性采集授权包

状态：`COMPLETED_ACCEPTED_FOR_INTERNAL_ENGINEERING`

## 结论

Artifact `9108034290` 已完成首次真实内部 Collector，并通过机器 Evidence 验收：3 个来源全部成功、各 20 条、总计 60 条、正文保留 0、Foundation 稳定、临时资源归零、五类业务副作用为 0。该 Evidence 不计入正式七日 Shadow。

首次尝试在 Collector 启动前发现 Foundation 网络名配置错误：部署默认值 `company-ai-foundation_data` 与 Foundation 固定网络 `company_ai_data` 不一致。该尝试来源请求、Snapshot 和副作用均为 0，并生成失败 Evidence。修复 0600 环境并通过 Compose config 后完成授权的一次真实采集。

## 本次拟执行动作

仅执行一次 `internal_engineering_shadow` oneshot Collector：

| 来源 | 接口类型 | 最大条数 | 保存级别 |
|---|---|---:|---|
| arXiv 官方 API | 公开 API | 20 | reference-only / hash-only |
| Federal Register 官方 API | 公开 API | 20 | reference-only / hash-only |
| GitHub 指定白名单仓库 Releases | 公开 API | 20 | reference-only / hash-only |

总上限 60 条；保留期 3 天；不保存正文，`bodyBase64=null`。飞书出口关闭，不调用个人站 Webhook，不读取个人站目录或个人凭据。

## 明确不执行

- 不执行 010/011 或其他数据库迁移；
- 不启动常驻 Orchestrator；
- 不重启 Foundation、Agent Core、H-Lite、Connector、Gateway、Postgres、Redis 或 Qdrant；
- 不发布飞书文档、卡片或全员 Bot 消息；
- 不创建正式 P2、不下发员工任务；
- 不写回 ERP 或社交媒体系统；
- 不激活任何 P003 因果关系；
- 不计入正式七日 Shadow；
- 不执行真实回滚。

## 运行后机器验收

1. 三个来源都必须成功，且每来源不超过 20 条；
2. 所有 Snapshot 必须 `hash_only / bodyBase64=null`；
3. Foundation 更新前后保持 13/13、异常 0、restart 0、指纹一致；
4. 临时 Collector 容器、Compose 网络和发布端口运行后全部归零；
5. 正式 P2、员工投递、ERP 写回、社媒写回和因果激活均为 0；
6. 成功或失败都生成 0600、Schema 校验通过的机器 Evidence；
7. Evidence 固定 `countsTowardProductionShadow=false / eligibleForProductionShadow=false`。

## 预计影响

| 项目 | 预期 |
|---|---|
| Foundation 业务中断 | 0 秒 |
| Foundation 重启 | 0 |
| 数据库迁移 | 0 |
| 常驻新容器 | 0 |
| 新公网端口 | 0 |
| 真实外部请求 | 最多 3 个公开来源，各一次 |
| 最大条目 | 60 |
| 预计耗时 | 约 2～5 分钟 |
| 失败处理 | 清理临时容器/网络，生成失败 Evidence，停止后续动作 |

## 当前门禁证据

在 `INTERNAL_ENGINEERING_RUN_APPROVED=NO` 下调用安装后的正式脚本，返回退出码 1 和 `explicit internal engineering run approval missing`；调用前后状态文件、Evidence 文件和战略情报容器均为 0，证明未授权路径在网络及运行副作用前拒绝。

## 执行结果

- arXiv：20 条；
- Federal Register：20 条；
- GitHub 白名单仓库 Releases：20 条；
- Raw Snapshot：3，全部 Hash-only；
- 重复：0；
- Candidate Report：已生成但未发布；
- Evidence：0600，Schema 验证通过；
- Foundation：13/13、异常 0、restart 0、指纹一致；
- 临时容器、网络、发布端口：0；
- 正式 P2、员工投递、ERP/社媒写回、因果激活：0。
