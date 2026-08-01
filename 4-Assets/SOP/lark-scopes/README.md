# 飞书权限批量导入 JSON

> 用途：往飞书开发者后台「权限管理 → 批量导入/导出权限 → 导入」粘贴，
> 一次给某个 App 申请全套权限，免去几百次手动勾选。

## 文件

| 文件 | 内容 |
|---|---|
| `lark-import-user-324.json` | **user 档 324 项**，已剔除禁止给 Bot 的域 |

## 口径

以 owner Bot 实测持有的 **334 项**为基线（`lark-cli auth scopes`，2026-08-01 导出），
剔除下列禁止域后剩 **324 项**：

| 禁止域 | owner 实际持有 | 说明 |
|---|---|---|
| `hire` 招聘 | 10 | 唯一实际剔除的 |
| `corehr` 人事核心 | 0 | owner 本来就没有 |
| `payroll` 薪酬发放 | 0 | 同上 |
| `security_and_compliance` 合规审计 | 0 | 同上 |
| `mdm` 设备管理 | 0 | 同上 |

后四个 owner 一项都没有——某些租户 App 却持有几十项，那是开通时勾「全选」
带进来的，不是按需申请。这也是为什么它们该被回收。

## ⚠️ tenant 档是空的，这不是疏忽

`lark-cli auth scopes` **只能查 user 档**（返回里 `tokenType: user`，命令也没有
任何指定 token 类型的参数），所以平台侧拿不到 owner 的 tenant 档真值，
这里不敢编一份填进去。

**这会有实际后果**：部分接口只认 tenant 档。踩过的坑——通讯录读部门时，
只有 user 档而缺 `contact:user.department:readonly` 的 **tenant 档**，
接口仍返回 `code=0`，但部门字段**直接消失**，不报错。

要补 tenant 档，用后台同一个弹窗的**「导出」**页从 owner Bot 导一份出来，
那份会带 tenant 档；把它给 cc，可以据此生成对标 JSON。

## 使用方法

1. 开发者后台 → 目标 App → 权限管理 → 批量导入/导出权限 → **导入**
2. 粘贴 `lark-import-user-324.json` 全文 → 提交
3. 导入的权限作为**新增申请**，不影响已申请或已开通的（弹窗原文如此）
4. 提交后仍需**企业管理员审批**
5. 审批通过后复核：

```bash
node ops/verify-lark-scopes.mjs --profile tenant-standard --uid <uid>
```

## 复核与再生成

数据源是 `ops/data/lark-scope-baseline.json`（feishu-grok-bridge 仓）。
owner 权限变动后需重新导出基线再生成，别手工往 JSON 里加条目——
那样就分不清是飞书新增了权限，还是有人放宽了边界。

配套的人工操作清单（按 App 分节、含姓名部门与最小必做集）：
[`tasks/飞书权限开通.md`](../../../tasks/飞书权限开通.md)
