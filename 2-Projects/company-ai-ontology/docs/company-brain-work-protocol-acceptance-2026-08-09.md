# Company Brain Work Protocol v1.0 生产验收报告

日期：2026-08-09（Asia/Shanghai）

## 结论

Goal 4 `P0-EPI + Company Brain Work Protocol v1.0` 已在公司 QNAP 完成生产部署并切换为 `active`。本轮只激活 Intake、Scope、Authority、Context、Evidence、Synthesis、Response；Decision、Plan、Execution、Verification、Learning 仍为 `contract_only` 灰色阶段。

本轮没有导入产品研究部整库，没有启用真实 ERP 或社媒写回，没有执行 10 名真实员工 Canary。

## 生产锚点

- 资产：公司 QNAP `prnas` / `prnas-pub`，型号 `TS-X65`，地址 `192.168.61.18`。
- 项目根：`/share/CACHEDEV1_DATA/ai-ontology/foundation`。
- Schema：`3.1.0`。
- Ontology Hash：`117074b5e6b0ace0d8dfdde853e313b6f7f8b09fab63789702e92515ddf3f244`。
- Active 元素：46 Object、24 Link、5 Function、2 Action、5 Policy、8 Constraint，共 90 个。
- Agent Core：`2026-08-09.1`。
- Work Protocol：`1.0.0 / active`。
- H 引擎：`grok-4.5`，当前临时使用个人 CPA Key，仍需切换公司专用凭据与同厂冗余。
- H 控制面：`v1.52.0`。

## 验收结果

### 契约与数据库

- Ontology Contracts `8/8` 通过，Goal 4 变更被判定为 additive compatible。
- Agent Core `28/28` 通过。
- Migration 007 创建 6 张运行表、Tenant RLS、复合租户外键、append-only 事件、脱敏 View 和最小角色权限。
- 生产补齐 `ontology_app` 对 `work.brain_case_status_v1`、`epistemic.answer_basis_v1` 的读取权限；真实状态接口不再出现 `42501`。
- Registry 只有一个 active 版本，本地 Hash 与 active Hash 一致；历史版本保留用于回滚。

### 认识闭环正负验证

使用明确标记为 fixture 的 ERP 和社媒证据，完成五类生产验证：

| 场景 | Evidence | 认识状态 | 确定性结论 |
|---|---:|---|---|
| fresh ERP 支持事实 | 1 | medium | 允许 |
| ERP 支持 + 社媒反证 | 2 | low / conflicting | 阻止 |
| 过期 ERP 事实 | 1 | low / stale | 阻止 |
| Principal 存在但无 ACL | 0 | insufficient | 阻止，且不调用 H 引擎 |
| Principal 不存在 | 0 | permission_denied | 阻止，且不调用 H 引擎 |

无权限响应未出现 fixture 标题、URL、人员或正文。测试结束后 fixture Knowledge Resource/ACL/Chunk 已清理，测试 Principal 已禁用；WorkCase 和 append-only 事件保留为审计证据。

### Shadow 与 Active

- `shadow` 模式先完成 fresh/conflict/stale/no-ACL/missing-principal 验收，不改变员工回复合同。
- 正负验证通过后切换 `WORK_PROTOCOL_MODE=active`。
- Active 模式结构化回答由 Response Validator 校验；过期、冲突或证据不足时强制降级为 `low/insufficient`。
- Prompt 只接收当前 WorkCase 的最小 Permissioned Evidence Package v2，不提供数据库直连或业务写回能力。

### 完整自检、恢复和安全

- Foundation 12 个容器健康；唯一 LAN 暴露仍为 `192.168.61.18:19080`。
- PostgreSQL、Qdrant、Redis、Prometheus 无新增宿主机端口。
- 完整 `verify.sh` 通过：唯一 active Registry、RLS、最小权限、H-Lite、Agent Core、Knowledge Connector、Action Gateway、备份、WAL 和资源读数正常。
- 真实回滚到 Schema `3.0.0`、Agent Core `2026-08-08.4` 和旧 Caddy 路由成功；随后恢复 `3.1.0`、Agent Core `2026-08-09.1` 和 active Work Protocol 成功。
- Agent Core 重启前后同一 WorkCase 的 Stage/Event 回放签名保持一致。
- Agent Core、Ontology Registry、Gateway 恢复后 `restart_count=0`。
- 最近 60 分钟关键服务日志中，已配置敏感值命中 0，通用 Key/Bearer 模式命中 0。
- 发布前数据库完整 dump 与 Schema dump 校验通过，已有 5 份验证基础备份和持续 WAL。

## H 控制面验收

- 未认证访问 `/admin/company-ontology` 跳转管理员登录。
- 认证后页面显示 `H 平台 v1.52.0`、8/8 运行组件就绪、Agent Core `2026-08-09.1`、Schema `3.1.0` 和 `grok-4.5`。
- 页面显示最近 3 个 WorkCase、Evidence Map、Answer Basis；三个 WorkCase 的 Goal 5 五个阶段共 15 个灰色节点。
- 真实浏览器控制台错误 0；页面宽度等于视口宽度，无横向溢出。
- 控制面只展示脱敏投影，不展示证据正文、人员标识、文档 URL、Token 或凭据。

## 本轮发现并修复的 P0

1. 应用角色缺少稳定 View 的 `SELECT`，导致 Work Protocol 状态接口 42501。
2. Connector/Store 未把 sourceSystem、validUntil、supports/contradicts 等字段映射到 Evidence Package，生产反证语义会丢失。
3. Principal 存在但 Evidence 为 0 时仍调用 H 引擎，现已改为策略层失败关闭。
4. 完整验收器把旧版 Registry 元素数 71 写死，现改为按唯一 active 版本和 Hash 对账。
5. 通过 stdin 直接执行远端脚本会被 `docker compose exec -T` 抢占，现固化为“先传文件、再执行”。

## 下一步

1. Goal 5：P0-DEC，激活 DecisionCase、Decision Lineage、P2/Task、Action Result、Verification 和 Learning。
2. 并行完成公司专用 CPA Key/账号与同厂冗余。
3. 完成 `department/openchat` 主体映射和受控 `chat/group` 授权语义后，再单独审批产品研究部整库导入。
4. Goal 5 大框架稳定后再执行 Goal 3 的 10 名真实员工 Canary；它仍是 20/50 人放量前硬门禁。
