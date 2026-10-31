---
name: fnmedia-ext-maintenance
description: 维护飞牛影视 fnmedia-ext 独立加固插件，诊断手机/TV播放与卡顿，验证选线预取，处理插件更新、官方升级复连及恢复；不用于普通NAS文件管理或其他影视应用。
---

# fnmedia-ext 维护

目标是保留官方飞牛影视的可升级性，并用实际媒体证据判断播放问题。技能不授予额外操作权限，按用户当前任务和已有授权执行；不要因技能中的部署流程把只读咨询变成部署。

## 真源与入口

- 运维真源：`~/home-lan/`，先读该仓 `CLAUDE.md`、项目 `2-Projects/P01-家里局域网与飞牛/README.md` 与最新带日期报告。IP、SSH别名用前查 `user_hardware` 记忆及设备台账；旧报告里的“不可达”不是永久状态。
- 补丁、构建锁、维护器：`4-Assets/Code/fnmedia-ext-hardening/`；可信源码运行树：`runtime/fnmedia-ext-managed/source`。版本以 `BUILD-MANIFEST.json` 和本次运行态核对，不以本技能或旧日志推断。
- 私有Git快照：`~/mycc/2-Projects/home-lan/fnmedia-ext/`，只从home-lan已提交blob更新，记录 `SOURCE-MANIFEST.json`；不是第二个运维工作区。
- NAS应用管理用官方 `trim-cli` 技能与已有OAuth；该CLI不提供影视Media API。插件管理使用真实影视管理员会话，凭据只从密码库引用，不打印Cookie、签名URL或密钥。

## 按任务读取

- 播放失败、卡顿、自动选线、预取或并发代码变更：读 [播放诊断与资源语义](references/playback.md)。
- 安装升级、上游变化、官方升级后复连、停用/恢复：读 [升级与恢复](references/deployment.md)。

## 不可混淆的边界

1. 用户正在观看时先取已有日志、版本和指标；普通排障不自行重启、切线、改开关或做竞争带宽的压力测速。已有授权覆盖具体中断操作时按授权执行，无需重复询问。
2. 不修改官方二进制、manifest、nginx或数据库；独立插件可逆接管socket。每次HTTP请求验证官方影视会话，缓存按用户隔离，回源保留SafeAsyncClient的SSRF约束；HMAC只证明链接完整性。
3. 媒体清单首次返回后锁定来源；旧 `line+auto=1` 不代表允许自动换源。源间相同段号并不代表相同时间轴。
4. 验收分别写明隔离路由/鉴权fixture、生产匿名负例、NAS真源正文、用户实播反馈、逐端量化A/B。用户说更流畅是有效实播反馈；不能换算为卡顿比例或P95达标。缺少测量写“尚未验证/不能证明”，不要写成“未达标”；后者需要实际失败证据。
5. 上游代码变动进入 `needs_review` 是加固保护；保留用户随时触发更新的入口、定时版本检查与NAS每日内容刷新，不以直接覆盖加固换取版本号追平。

## 交付记录

记录实际版本、源提交/包摘要、已验证层次、未验证项和可用恢复点。总结经验写入 `~/mycc/0-System/RECENT_EVENTS.md` 与原子 `memory-items.md`；只读后追加并加共享锁。不要把凭据、用户数据或原始播放URL写入记忆/Git。文档更新无需重跑生产代码全套回归；实现变化按受影响路径验证。
