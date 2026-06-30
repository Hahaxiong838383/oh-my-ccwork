# 回滚记录：theory-radar 每日飞书流同步个人站

## 变更时间

- 2026-06-26

## 变更目标

- 将 multica/QNAP 管理的 `theory-radar` 每日飞书流扩展为同源同步个人站。
- 去掉飞书第 3 条消息末尾的自动化署名/发送方标识。
- 将 mini 上旧的每 3 天独立推送 launchd 卸载，脚本和 plist 保留为手动兜底。

## 上线记录

- live skill 已更新：`2026-06-26T03:03:31Z`
- live skill hotfix：`2026-06-26T03:19:27Z`，将个人站同步校验从固定 8 篇改为 4-8 篇，适配当天 arXiv 实际不足 8 篇的情况。
- 手动补偿推送：`2026-06-26` 已通过 mini `~/theory-radar/push-to-site.py` 只推个人站，webhook 返回 `{"ok":true,"date":"2026-06-26","papers":6}`，未重复发送飞书。
- live skill 更新命令执行位置：mini `/Users/rayman.chen/bin/multica`
- 更新后校验：live skill 内容与本地 `theory-radar-SKILL.md` 完全一致。
- 旧 launchd 状态：`cc.theory-radar-push` 已卸载，plist 保留在 mini `~/Library/LaunchAgents/cc.theory-radar-push.plist`。

## 涉及对象

| 对象 | ID / 路径 |
|------|-----------|
| multica skill | `6b8ca900-ba60-4d68-aaa5-f7f161af2fac` |
| autopilot | `93bef85d-c8a9-4667-a786-6baa8e040fc7` |
| 本地 skill 源 | `2-Projects/multica-team-deploy/theory-radar-agent/theory-radar-SKILL.md` |
| 上线前快照 | `2-Projects/multica-team-deploy/theory-radar-agent/theory-radar-SKILL.rollback-20260626-before-site-sync.md` |
| live 上线前快照 | `2-Projects/multica-team-deploy/theory-radar-agent/theory-radar-SKILL.live-rollback-20260626-before-site-sync.md` |
| 个人站 webhook | `https://my.chenchuan.cc/api/radar-webhook` |

## 回滚命令

### 1. 回滚本地源文件

```bash
cd /Users/rayman.chen/mycc
cp 2-Projects/multica-team-deploy/theory-radar-agent/theory-radar-SKILL.live-rollback-20260626-before-site-sync.md \
  2-Projects/multica-team-deploy/theory-radar-agent/theory-radar-SKILL.md
```

### 2. 回滚 live multica skill

```bash
multica skill update 6b8ca900-ba60-4d68-aaa5-f7f161af2fac \
  --content-file /Users/rayman.chen/mycc/2-Projects/multica-team-deploy/theory-radar-agent/theory-radar-SKILL.live-rollback-20260626-before-site-sync.md \
  --output json
```

如果当前机器没有 `multica` CLI，需在可访问 multica 工作区的机器上执行同一命令，或先使用项目内对应版本 CLI。

### 3. 恢复旧的个人站独立推送链路

若后续停用了旧 launchd，可按下面方式恢复 mini 上每 3 天独立推送：

```bash
ssh mini-pub 'launchctl load ~/Library/LaunchAgents/cc.theory-radar-push.plist'
```

旧链路脚本位置：

- mini: `~/theory-radar/daily-radar-push.sh`
- mini: `~/theory-radar/push-to-site.py`
- 本地源参考：`.claude/skills/theory-radar/scripts/`

## 验证点

- 飞书仍收到 3 条消息。
- 飞书消息末尾不出现“署名/Agent 小组/发送方标识”。
- multica issue comment 记录 3 个真实 `message_id`。
- 个人站 webhook 返回 `{"ok":true,...}`。
- `/radar` 页面显示当天报告。
- `rg 'RADAR_WEBHOOK_TOKEN|CODEX_API_GATEWAY_KEY|GEMINI_PROXY_KEY'` 不应在 git 跟踪文件中发现明文。

## 回滚触发条件

- 飞书发送失败或重复发送。
- 个人站 webhook 连续失败且影响每日任务收尾。
- multica agent 因新增步骤超时或无法完成 issue。
- 发现 secret 被写入日志、comment 或 git 文件。
