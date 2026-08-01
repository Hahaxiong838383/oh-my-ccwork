# 飞书权限批量导入 JSON

> 用途：往飞书开发者后台「权限管理 → 批量导入/导出权限 → 导入」粘贴，
> 一次给某个 App 申请全套权限，免去几百次手动勾选。

## 两份文件，用途不同

| 文件 | 规模 | 什么时候用 |
|---|---|---|
| **`lark-import-full-safe.json`** | tenant 668 / user 512 | **默认用这份**。飞书全量减敏感域，用于把租户 Bot 能力拉齐 |
| `lark-import-user-324.json` | user 324（无 tenant 档） | 最小权限口径：只给 owner Bot 实测在用的那些 |

`full-safe` 基于飞书**全量权限**（tenant 1117 / user 590，去重 1195，62 个域），
剔除下方 11 个域后剩 tenant 668 / user 512。

⚠️ 两份的 tenant 档差异很关键：`324` 那份 tenant 是**空的**，因为
`lark-cli auth scopes` 只能查 user 档（返回 `tokenType: user`）。而部分接口只认
tenant 档——踩过的坑是读部门时缺 `contact:user.department:readonly` 的 tenant 档，
接口仍返回 `code=0`，字段却直接消失、不报错。**要能力完整就用 `full-safe`。**

## 剔除的 11 个域（464 项）

| 域 | 项数 | 为什么去掉 |
|---|---|---|
| `corehr` | 413 | 人事核心：薪酬档案、调薪记录、离职信息、员工全量档案 |
| `payroll` | 13 | 薪酬发放：发薪明细、成本分摊 |
| `security_and_compliance` | 10 | 安全合规审计：组织级审计日志 |
| `mdm` | 8 | 设备管理：企业设备、法人银行账户 |
| `attendance` | 5 | 考勤：含加班审批写入 |
| `acs` | 5 | 门禁系统：出入记录，**且可写** |
| `attendance_machine` | 3 | 考勤机：打卡记录写入 |
| `passport` | 3 | 登录凭据：含 `password:full` **密码全权限** |
| `ehr` | 2 | 人力资源：员工档案与附件 |
| `financial_access_platform` | 1 | 财务数据：**可写** |
| `verification` | 1 | 企业认证信息 |

依据是隐私墙铁律（人事/绩效/客户数据禁外派）——这些 Bot 会把对话上下文送进
外部引擎。其中 `passport:password:full`、`acs:access_record:write`、
`financial_access_platform:data:write` 属于**任何情况都不该给 agent** 的类型。

## 川哥的修正（2026-08-01）

cc 初版还剔了 5 个域，川哥逐条否决并说明了业务理由，已全部恢复：

| 域 | 项数 | 保留理由 |
|---|---|---|
| `hire` | 68 | H 平台要协助招聘 |
| `performance` | 14 | 协助飞书绩效评价 |
| `okr` | 12 | 协助绩效目标制定 |
| `admin` | 13 | 保留 |
| `trust_party` | 3 | 保留 |

`verification` 是唯一按 cc 建议去掉的。

> 注：`hire` / `performance` / `okr` 属人事域，回收前提是**这三类用于本人的
> 招聘与绩效协作**。若某个 Bot 会代人查看他人绩效，仍受隐私墙约束——
> 那是使用边界问题，不在权限清单里解决。

## 使用方法

1. 开发者后台 → 目标 App → 权限管理 → 批量导入/导出权限 → **导入**
2. 粘贴 `lark-import-full-safe.json` 全文 → 提交
3. 导入的权限作为**新增申请**，不影响已申请或已开通的（弹窗原文）
4. 提交后仍需**企业管理员审批**
5. 审批通过后复核：

```bash
node ops/verify-lark-scopes.mjs --profile tenant-standard --uid <uid>
```

## 再生成

全量权限源：`飞书全量权限 json.rtf`（川哥 2026-08-01 从后台导出）。
飞书新增权限后需重新导出再生成，**别手工往 JSON 里加条目**——
那样就分不清是飞书新增了权限，还是有人放宽了边界。

配套的人工操作清单（按 App 分节、含姓名部门与最小必做集）：
[`tasks/飞书权限开通.md`](../../../tasks/飞书权限开通.md)
