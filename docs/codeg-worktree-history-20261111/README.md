# Codeg 独立工作树会话显示修复

后续用户截图仍有两个工作树“暂无会话”，视觉尚未收口。已补真实 HTTP→wrapper→store→侧栏行的新旧对照，见 [截图复核](SCREENSHOT-FOLLOWUP.md)。下文是首轮修复记录，不能用首轮模块回归代替真实页面验收。

结论：已修复当前 0.34.0 前端对独立工作树委派会话的过滤；实际列表模块及真实 API 快照重放通过。浏览器不可用，尚未核对用户刷新后的真实画面。P003 业务生产没有修改。

Grok 会话 251 位于 folder 53，parent 为 13，任务和结果正文保留。之前只用 includeChildren:true 查询记录便判断可见，漏了前端默认查询和 upsert 过滤；“暂无会话”不等于记录丢失。

修改范围是部署中的两个 workspace store bundle。首次加载显式包含 child，最终只保留普通顶层会话及独立工作树内的跨文件夹 delegate；同目录 child、loop、未知父关系保持原行为。没有直接改会话数据库、原生 ID 或委派关系，也没有重启智能体。

## 截图中的其它入口
+
+- 倾听池 folder 44 已有 10 个真实 Grok 委派会话，统一显示过滤修复覆盖这些会话。
+- 小程序短信登录 folder 38 和语音天气 folder 50 原来确实没有会话。通过原生 thread/fork 截至主13最后完成轮次创建历史快照，分别导入为会话 253、254；每份 201 轮，native 状态 idle。没有 turn/start，也没有复制/编辑数据库行。
+- 快照是主13截至 2026-11-11 已完成边界的完整历史，不是这两个工作树独有的新开发记录，也不会自动同步后续消息。源13及原251保留。
+- 创建原件见 native-forks.json/source-boundary.json/IMPORT-RESULT.json。回滚入口时仅处理新增快照 253/254，不动原会话；当前没有删除任何记录。
+
+## 验证
+
- 原编译模块 RED：首次加载无法找到会话 251。
- 两个修复后实际模块各 9 项，共 18 项通过：初始列表、父会话保留、同目录/同工作树子任务隔离、loop 隔离、事件更新、未知父关系及删除保护。
- 用真实 API 快照运行两个模块，251 和 13 均进入最终列表投影；没有把测试 fixture 冒充真实数据。
- 原生正文 2 轮，任务及结果均存在；摘要和 SHA 见 CONTENT-VERIFICATION.json，全文不提交。
- 两个部署文件及 HTTP 内容 SHA 与候选核同，见 APPLIED.json 和 manifest.json。
- CUA 无启用的浏览器，iab 也不可用；focus_conversation HTTP API 返回 501。页面需刷新加载，实际视觉确认未完成。

## 记忆与技能

本地共享记忆只追加本任务规则，保留其它任务正文；原件、候选及逐文件回执保存在私有备份目录。记忆文件未跟踪，不把代码 push 说成完整共享记忆已入库；本任务规则镜像见 MEMORY-RULE.md。

技能正文与参考案例在 `.claude/skills/codeg-worktree-history/`，多引擎入口在 `.agents/skills/codeg-worktree-history/`。今后工作树任务必须交付可见会话和可打开的真实正文，不能以目录/ID/后台查询存在替代验收。

## 重放与回滚

私有原件目录：`/Users/fu-121/.local/state/codeg-worktree-visibility-20261111`。不提交完整编译包、全部会话列表、原生会话正文或完整共享记忆。

`prepare_patch.py` 从该目录的 manifest-before.json 和 *.before 生成候选并核 SHA，严格限定当前两个资源，不适用于其它构建。`store-visibility.test.cjs` 接受实际 bundle 路径；可选第三参数为私有真实 API 快照。测试直接装载编译模块，mock 只用于状态和传输依赖。

```sh
python3 rollback_assets.py --backup-dir /Users/fu-121/.local/state/codeg-worktree-visibility-20261111
# 上句只核验。需要回滚时在同一命令追加 --apply。
```

回滚工具预核全部 before/after SHA，逐文件写前再核，原子恢复原件；有漂移就停止。它不是多文件事务：中断时按已输出 restored 的文件核现场，不能回灌数据库或盲盖新版本。回滚后重新核 HTTP SHA 并刷新。此补丁尚未合入 Codeg 应用源码，上游升级会覆盖，届时需在对应源码实现同等判定并重新构建验证。

## Grok 调研反馈接收

已独立核 Grok 分支 tip 与远端均为 7c01430392e3120d7c97098d3416affb21fb373f，工作树干净。语料的 df4d1a6… 是脚本按紧凑 JSON 序列化所得内容哈希，原始缩进文件哈希为 4120d04…；按脚本算法复核一致，并非语料漂移。逐行结果重算：251 场景/263 轮，基线 223，通过候选配置 225，新增失败 0，只新增命中 2 条。

这仅是产物一致性检查，没有独立重跑 Linux CLI、实现补丁、验声学或发布 P003 生产。不能把研究完成或这次 Codeg 显示修复当作自然话术能力已经补齐。

署名：codex（OpenAI）| 2026-11-11
