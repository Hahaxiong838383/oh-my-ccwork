# P1-SI Artifact 9108034290 内部 Runtime 更新验收

状态：`ACCEPTED_INTERNAL_RUNTIME_UPDATED_NOT_RUN`

## 结论

Artifact `9108034290` 已更新到公司 QNAP `internal_engineering_shadow` Runtime。更新只执行不可变发布校验、旧 Runtime 备份、Collector 镜像加载、Compose 配置校验和 package/config/env 原子切换；未运行 Collector、未迁移数据库、未重启 Foundation，也未执行真实回滚。

## 发布身份

- Source Commit：`0342fcd3991fc88e32f1f68750b837112717db67`；
- Runtime Workflow：`31508346323`；
- Artifact ID：`9108034290`；
- Collector Image：`sha256:26db1ddd56c21cf7e50586efb5953da158b98437f36d5701c6f21e8dfb8c9ab9`；
- QNAP Node Image：`sha256:75228afe839b63f6bef21d2ea8f4b6aa9e4c56a20ad70cec5450ca84a72f9801`；
- Release Manifest SHA-256：`d6fcdb61de6711d3e3792da00f31932abec9f1f568da366e146b38fe12b03901`。

## 实机验收

| 项目 | 更新前 | 更新后 | 结论 |
|---|---:|---:|---|
| Foundation 长期服务 | 13/13 running | 13/13 running | 不变 |
| Foundation 异常 | 0 | 0 | 不变 |
| Foundation restart | 0 | 0 | 不变 |
| Foundation 指纹 | `b11e7789fea4` | `b11e7789fea4` | 完全一致 |
| 战略情报容器 | 0 | 0 | 未启动 |
| 战略情报网络 | 0 | 0 | 未创建 |
| 发布端口 | 0 | 0 | 未创建 |
| `strategic_intelligence` Schema | absent | absent | 未迁移 |
| 战略情报表 | 0 | 0 | 未迁移 |
| Collector 状态文件 | 0 | 0 | 未运行 |
| 报告文件 | 0 | 0 | 未运行 |

active Ontology 继续为 Schema `3.3.0`、Hash `41689393289d9514d1ed9cd22455a164f1bc59286f0db16deb9235e703e6ae77`，Registry 继续 `in_sync`。`foundation-init` 继续为正常的 `exited(0) / restart=0`。

## 回滚证据

旧 Commit `a7aeae25e414b570cab8ff1fdfbdc12d5d027dc5` 已备份到公司 QNAP 冷备份卷。归档非空、tar 可读，包含 package/config/.env.internal 并通过 SHA-256 校验。真实回滚尚未执行，仍需独立授权。

## 当前边界

- 8 个来源继续 `paused / license pending / compliance pending`；
- 内部 Runtime 仍固定 `PUBLISH=false / countsTowardProductionShadow=false`；
- 首次一次性 Collector 运行次数为 0；
- 正式 P2、员工投递、ERP 写回、社媒写回和因果激活均保持 0；
- 生产 Shadow、数据库迁移、服务重启和真实回滚继续分别等待独立授权。

## 下一门禁

下一步只可在获得明确授权后执行一次 `internal_engineering_shadow` Collector，验证 3 个公开来源、每来源最多 20 条、仅保存 Hash、临时资源归零和业务副作用为 0。该结果不计入正式七日 Shadow。
