---
name: p003-deploy-ops
description: P003 KidsHub 三端(家长端 parent / 体验台 web / admin 后台 / 后端 server)部署 + 邀请码运营管理 SOP（含血泪坑清单）。触发词："/p003-deploy"、"P003 部署"、"部署家长端/体验台/admin"、"P003 邀请码管理"、"加 P003 后台功能"、"P003 上线/发版"。涵盖:按改了哪端的部署步骤(server rsync+pm2 / admin scp from git / parent build base / web full build)、**两端 server 部署(公司侧 p003-voice·gemini 全量版 + 个人站 kidshub-voice·DeepSeek 精简版,不同源·同步要适配)**、邀请码 CRUD/上限/昵称备注、admin DOM 内 Vue 坑、并行 session 防污染、生产 E2E 铁律。
---

# p003-deploy-ops（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/p003-deploy-ops/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
