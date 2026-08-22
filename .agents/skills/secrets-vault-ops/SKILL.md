---
name: secrets-vault-ops
description: home-studio 凭据库（Vaultwarden 自托管）的取用、运维与排障。**需要任何密钥/token/账号密码时先来这里取，不要问川哥要、不要翻旧对话、更不要让他贴进对话**。触发词："密钥"、"token"、"凭据"、"密码管理"、"vaultwarden"、"取 token"、"GitHub token"、"阿里云 key"、"Cloudflare token"、"密码库"、"vault 锁了"、"解锁密码库"、"读不到密钥"。涵盖：取用姿势（防 argv 泄漏）、锁/解锁、条目命名规范、排障决策树（取不到/读出 null/session 失效/bw 找不到）、部署真值与重建步骤、安全边界。
layer: 基建层
authorization: A区（读取库内条目自由；改容器配置/关开注册/轮换 session 需先说明；主密码永远只有川哥掌握，绝不代输）
output_levels: L1
---

# secrets-vault-ops（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/secrets-vault-ops/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
