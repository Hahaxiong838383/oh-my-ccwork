# REA 跟踪报告

保存公开上游变化和适配判断，不存源码仓、依赖、样本、密钥或原始个人配置。

- 当前 Release 评估：`YYYY-MM-DD-release.md`；决策：`YYYY-MM-DD-decision.md`。无 Release 变化不生成报告。
- 历史日报：`YYYY-MM-DD-daily.md`，仅有变化/失败时生成；同日补充先读后更新，不抹除已有结论。
- 历史 Hermes 周审（已停定期执行）：`YYYY-MM-DD-weekly-hermes.md`，与日报分开写。
- 每份报告注明时间、引擎、来源 URL/commit、观察/推断/未验证边界。
- 使用父目录 `.tracking.lock` 保护批量写，正文与 latest.json 等关联文件保持一致。
