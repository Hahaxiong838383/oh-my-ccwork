# P1-SI 四职能角色真实权限 UAT

日期：2026-08-11（Asia/Shanghai）

状态：`pending_member_sessions / deployment_blocked`

## 1. 目的

本 UAT 用于证明飞书 API 返回的角色配置已经在四名真实成员的登录会话中生效。API 配置正确、过滤器 `is_invalid=false` 或角色成员数正确，都不能替代本验收。

验收只验证权限边界，不代表来源合规批准、P003 因果关系批准或产品决策完成。

## 2. 角色范围

| 角色键 | 允许编辑类别 | 预期可编辑记录 | 预期不可编辑记录 |
|---|---|---:|---:|
| `product_user` | 产品定义、儿童用户场景、渠道、AI 技术、隐私合规 | 30 | 6 |
| `ai_rd` | 产品定义、儿童用户场景、AI 技术 | 18 | 18 |
| `brand` | 渠道、销售和竞争 | 6 | 30 |
| `toc_offline_channel` | 渠道、销售和竞争 | 6 | 30 |

旧 `P1-SI P003 联合审核员` 角色成员必须保持 0。

## 3. 每名成员必测步骤

1. 使用该角色已绑定的真实飞书成员账号登录，不使用管理员代测或共享账号。
2. 打开《公司战略情报 P1-SI 审核工作台》，确认“来源合规审批”表不可访问。
3. 在本人允许编辑的类别中选择一条仍为 `pending` 的记录，只在人工审核字段写入临时 UAT 标记，保存成功后立即恢复原值。
4. 在本人不允许编辑的类别中选择一条记录，确认编辑或保存被拒绝；不得通过管理员权限、复制表或其他入口绕过。
5. 分别确认不能新增记录、删除记录、复制 Base、下载数据或修改视图。
6. 确认临时编辑已经恢复，记录仍为 `pending / inactive`，没有形成审批、P2、员工投递或业务写回。
7. 将测试时间、角色键、通过/失败结果和脱敏证据引用写入受控验收文件；不得把页面正文、实名 Principal、证据截图或链接正文放入 Git、共享记忆或公开报告。

任一测试失败时立即停止后续审核，保留失败证据并修复权限；不得把其他角色的成功结果外推到该角色。

## 4. 受控验收文件

从以下模板复制到 `~/work-private/company-ai-ontology/reviews/` 或批准的公司受控目录：

`deploy/qnap/strategic-intelligence/config/reviewer-role-access-acceptance.template.json`

真实文件必须：

- 四个角色测试全部完成；
- 每个角色绑定真实 `memberPrincipal`、测试时间和受控证据引用；
- 所有允许/拒绝项为 `true`；
- `legacyBroadRoleMemberCount=0`；
- `memberExperienceVerified=true`；
- 由安全负责人设置 `securityOwnerAccepted=true` 并提供接受引用。

## 5. 机器验证

```bash
node deploy/qnap/strategic-intelligence/scripts/validate-reviewer-role-access-acceptance.mjs \
  /受控目录/reviewer-role-access-acceptance.json
```

验证器只输出角色数量、验收时间和 Evidence Hash，不输出成员身份或证据正文。模板、缺任一角色、未回滚临时编辑、未分配类别可编辑、来源表可访问或安全负责人未接受时必须失败关闭。

部署 readiness 还必须提供：

```bash
SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE=/受控目录/reviewer-role-access-acceptance.json \
npm run readiness --prefix deploy/qnap/strategic-intelligence
```

该文件只是七项门禁之一；来源最终审批、P003 最终审核、Goal 7、不可变发布包和当次部署授权仍需独立通过。
