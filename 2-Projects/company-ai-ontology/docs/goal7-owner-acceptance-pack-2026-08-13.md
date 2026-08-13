# Goal 7 Owner Acceptance 验收包

日期：2026-08-13（Asia/Shanghai）

状态：`ENGINEERING_EVIDENCE_VERIFIED / OWNER_DECISION_PENDING`

## 1. 川哥需要拍板什么

本次只确认 Goal 7 `P1-PROD-READINESS` 的工程证据是否可接受，不授权或自动启动以下事项：

- 产品研究部整库导入；
- 10 名真实员工 Canary；
- Route B 或公司专用 CPA 凭据切换；
- P1-SI Collector、010/011、七日 Shadow；
- 正式 P2、员工任务投递；
- ERP 或社交媒体写回；
- 因果关系激活。

## 2. 固定验收身份

| 项目 | 当前值 |
|---|---|
| Company QNAP | `PRNas / TS-X65 / 192.168.61.18` |
| Foundation Root | `/share/CACHEDEV1_DATA/ai-ontology/foundation` |
| Workflow | `31663036837` Attempt `1` |
| Artifact | `9166921089` |
| Manifest | `1.6.0` |
| Ontology Commit | `4a158d1d17141da905e9206dd54013cdac987039` |
| H-Lite Commit | `baa00bf07089a3caf5fe6318aac28cb73bd5ae13` |
| Agent Core | `2026-08-12.3` |
| Knowledge Connector | `2026-08-11.1` |
| H-Lite | `2026-08-12.1` |
| Route A | `operational` |
| Route B | `disabled` |

## 3. 五份工程 Evidence

| Evidence | SHA-256 | 验收结果 |
|---|---|---|
| `runtime-verification.json` | `3b561a6c3c926ef15049a2239e870f11223435332be8c9d04e68b241ac5f76d8` | Linux/PostgreSQL Runtime、9 项 Release Hash、双仓 Commit 通过 |
| `worker-readback.json` | `18a226287dc314370ce3098d61bcff0fbe4e6290b81639de5634831ace539b70` | `cpa-openai-compatible / grok-4.5 / route-a`，HTTP 与 ledger 一致 |
| `authority-canary.json` | `df6bce0a671cd98a5dedc67403d76a4b604f59f63854bdc7d625ad7ed65c5e4a` | `7/7`，撤权 `0.015 秒`，拒绝路径正文读取 `0` |
| `deployment-evidence.json` | `33553687c87a727d021b181e8b6f5367fe3b25bed4fe96e896344cf1f6f9cbfb` | 三组件切换 `18.18 秒`，Foundation 稳定 |
| `rollback-drill-evidence.json` | `b636568b0d37969f4e1cdf81b4f590ee81933fc010ffb988aef7fce30304ed79` | 候选→旧版→候选 `34.709 秒`，012 保留 |

工程证据编译器已重新读取上述文件，确认双仓 Commit、组件版本、原始 Evidence Hash 和时间顺序一致。缺少 `owner-acceptance.json` 时，最终 Acceptance 编译器按设计失败关闭。

## 4. 2026-08-13 线上只读复核

- 公司 QNAP 五元组一致；
- Foundation `13/13 running`；
- unhealthy `0`；
- restart total `0`；
- active Ontology Schema `3.3.0`；
- Registry `in_sync`；
- Agent Core Source Commit `4a158d1d1...`；
- Knowledge Connector Source Commit `4a158d1d1...`；
- H-Lite Source Commit `baa00bf...`，模式 `active`；
- 战略情报容器 `0`；
- Goal 7 lock/partial `0`。

## 5. 已知限制

- 当前 Worker 仍使用 `temporary_personal_credential`；公司专用 CPA 和 Route B 后补；
- 宿主断电、`SIGKILL`、半程 WorkCase 的 lease/fencing 恢复属于 Goal 8；
- 来源最终决定仍为 `0/8`；
- P003 最终决定仍为 `0/36`；
- 四角色真实权限 UAT 仍为 `0/4`；
- P1-SI-H 七日 `PUBLISH=false` Shadow 仍为 `0/7`。

## 6. 验收选择

### 接受

川哥明确回复以下语义即可：

> 我确认接受 Goal 7 P1-PROD-READINESS 的五份工程 Evidence，允许生成 Evidence-bound Owner Acceptance；该确认不授权 Collector、010/011、七日 Shadow、正式 P2、员工投递、ERP/社媒写回或其他后续生产动作。

收到该独立确认后，Agent 才可使用受控记录器生成 `owner-acceptance.json`，再编译和验证 `goal7-acceptance.json`。

### 不接受或有条件接受

请指出需要补验的 Evidence 或限制项；在条件关闭前不生成 Owner Acceptance。

## 7. 验收后的边界

Goal 7 Owner Acceptance 完成后，整个 P1-SI Goal 仍保持 active。下一步仍需来源 `8/8 final`、P003 `36/36 final`、四角色 UAT `4/4`、新的最终不可变发布包、P1-SI-H 独立部署授权及七个真实自然日 Shadow，才能进入 Goal Completion 编译。
