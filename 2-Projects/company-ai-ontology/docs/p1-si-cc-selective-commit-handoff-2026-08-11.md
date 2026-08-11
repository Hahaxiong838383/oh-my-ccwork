# P1-SI cc 选择性提交与 Runtime Workflow 交接

日期：2026-08-11（Asia/Shanghai）

状态：`engineering_verified / codex_commit_and_deploy_authorized`

## 1. 结论

P1-SI-B～G 工程代码、QNAP 隔离 PostgreSQL Runtime、文档、共享记忆和 Skill 已完成当前层级验证。川哥已于 `2026-08-11` 明确授权 codex 完成本 Goal 的选择性提交、推送和内部工程 Runtime 部署；仍不得使用 `git add .` 或 `git add -A`。

提交后只运行 Runtime Workflow；即使 CI 通过，也不得自动部署、迁移生产数据库、启动 Shadow 或重启任何 Foundation 服务。

## 2. 允许纳入本次提交的范围

1. `.github/workflows/p1-si-runtime-verify.yml`；
2. `.claude/skills/company-ai-ontology/SKILL.md`；
3. `0-System/RECENT_EVENTS.md`；
4. `0-System/memory-items.md`；
5. `2-Projects/company-ai-ontology/` 下本 Goal 的全部已修改和新增文件。

明确排除：

- `.claude/launch.json`；
- `.claude/skills/evomap-assets/`；
- `.claude/skills/kidshub-growth-insight/`；
- `.claude/skills/mycc/current.json`；
- `.claude/skills/scheduler/history.md`；
- `.claude/skills/xray/`；
- `2-Projects/kidshub-growth-insight/`；
- `2-Projects/ai-engineering-briefs/`；
- `2-Projects/geo-engine/`；
- 其他不属于 P1-SI 的并发脏文件。

## 3. 提交前复核

当前验收：

- Ontology Contracts：`61/61`；
- Collector：`9/9`；
- Strategic Intelligence：`67/67`；
- package validate、Node/Shell/JSON、YAML、`git diff --check` 和目标差异敏感扫描通过；
- 公司 QNAP 隔离 Runtime：010/011、19/19 强制 RLS、Domain Persistence、二次幂等、ACL fail-closed、baseline restore 全部 verified；
- Foundation 13 个服务前后指纹一致、restart 0，临时容器、Volume 和验证目录已清零；
- 正式 readiness `0/7`、内部 readiness `1/4`、Goal Completion `0/8`，均继续失败关闭。

建议提交信息：

```text
feat(ontology): complete P1-SI engineering runtime chain
```

## 4. 推送后执行

从新的已推送 Commit 手动触发：

```bash
gh workflow run p1-si-runtime-verify.yml --ref main
```

Workflow 必须真实输出：

- `candidate_migrations=verified`；
- `tables=19`；
- `forced_rls=19`；
- `domain_persistence=verified`；
- `domain_persistence_idempotent=verified`；
- `acl_fail_closed=verified`；
- `baseline_restore=verified`。

Artifact 必须使用 Release Manifest `1.2.0 / P1-SI-F-shadow-candidate-gated`，并保持 `productionDeploymentAuthorized=false / publish=false`。

## 5. CI 后仍关闭

1. 内部工程 Shadow 的独立部署授权；
2. 8 个来源最终审批；
3. 36 条 P003 最终审核；
4. 四角色真实成员权限 UAT；
5. Goal 7 Owner Acceptance；
6. 生产部署、数据库迁移和服务动作的当次授权；
7. 七个真实上海自然日 `PUBLISH=false` Shadow；
8. 川哥第七日 Owner Acceptance。
