# Scheduler Skill 技术总结

> 2026-01-26 端到端测试通过，记录当前状态供后续迭代

---

## 一句话说明

**mycc 后端每分钟检查 tasks.md，时间匹配就唤醒指定引擎执行任务，并按结构化业务结果落 history。**

---

## 当前架构

```
tasks.md (任务文档)
    ↓ 每60秒读取
mycc scheduler 模块
    ↓ 时间匹配 ±2分钟
    ↓ 检查锁（防重复）
    ↓ 构造无通知权限的任务 Prompt
Claude / Codex / Gemini (执行任务)
    ↓
SCHEDULER_RESULT 结构化结果
    ↓
history.md + owner P2P 单次通知
```

---

## 文件结构

```
.claude/skills/scheduler/
├── SKILL.md        # Skill 定义（触发词、说明）
├── README.md       # 本文档
├── tasks.md        # 任务列表（用户编辑）
├── history.md      # 执行历史（自动记录）
└── scripts/
    └── daemon.sh   # 守护进程脚本
```

---

## 已解决的问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 任务重复触发 4-6 次 | touch 文件不是原子操作 | 改用 `mkdir` 原子锁 |
| 同一任务在 ±2 分钟窗口内多次触发 | 锁 key 用当前时间 | 改用任务时间作为锁 key |
| cc 无法访问项目文件 | workingDirectory 未传 | daemon.sh 加 PROJECT_DIR 参数 |
| cc 无法写 /tmp/ | acceptEdits 不允许项目外写入 | 改写项目内文件 |
| curl 响应被截断 | daemon 循环干扰 | curl 后台运行 + wait |
| 引擎正常退出但业务失败被记成功 | 只看 adapter/CLI 退出状态 | 改为解析 `SCHEDULER_RESULT`，`failed` 必记失败 |
| Agent 自行搜索并发送群通知 | Prompt 要求调用 `/tell-me` | 收回通知控制权，Scheduler 默认只发 owner P2P |

---

## 结果与通知协议

- Agent 最后一行必须输出：`SCHEDULER_RESULT {"status":"success|failed|skipped","summary":"...","error":"..."}`。
- `status=failed` 必须记为失败，即使 Claude/Codex/Gemini 引擎退出码为 0。
- 无标记、JSON 非法或无法判断时，记录 `⚠️ 引擎完成，业务结果未知`，不能写成功。
- 定时任务结果默认仅发送 owner 私聊；Agent 不拥有通知目标选择权；群通知必须显式授权。
- 找不到合法 P2P 目标时只记录“通知未送达”，不得自动搜索群聊、选择最近聊天或广播。

## 可选群通知配置

默认不开启群通知。只有任务说明包含 `notify:group`，且环境变量 `SCHEDULER_NOTIFY_GROUP_ENABLED=true`、`SCHEDULER_NOTIFY_GROUP_CHAT_ID` 同时配置时，Scheduler 才会发送到该群；否则 fail-closed。

---

## 权限说明

cc-webui 支持的 permissionMode：
- `default` - 需要用户确认
- `plan` - 规划模式
- `acceptEdits` - 自动接受编辑（当前使用）

**限制**：acceptEdits 只允许写 workingDirectory 内的文件。

---

## 待迭代方向

### 功能增强
- [ ] 支持 cron 表达式（更灵活的时间规则）
- [ ] 任务依赖（A 完成后触发 B）
- [ ] 失败重试机制
- [ ] 执行超时处理

### 体验优化
- [ ] Web 界面管理任务
- [ ] 任务执行日志可视化

### 稳定性
- [ ] daemon 崩溃自动重启
- [ ] 多实例防冲突
- [ ] 健康检查接口

---

## 使用示例

tasks.md 中添加任务：
```markdown
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 08:00 | 每日初始化 | /morning | 更新日期、清理昨日 |
| 22:00 | 日志审计 | /check-log | 审计今日日志 |
```

---

*最后更新：2026-08-05*
