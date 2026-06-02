# multica 自动更新(通知优先)

> 川哥 2026-06-02 钦定**通知优先**策略:每日查上游 release,有新版飞书通知,**不自动应用**(避免无人值守半夜把生产改坏)。

## 组件

| 文件 | 部署到 mini | 作用 |
|------|------------|------|
| `multica-update-check.sh` | `~/bin/multica-update-check.sh` | 检查脚本:查上游 latest release → 比对 mini binary 版本 → semver 判新 → 去重 → 飞书通知 |
| `com.multica.update-check.plist.example` | `~/Library/LaunchAgents/com.multica.update-check.plist` | launchd 每日 10:00 触发(部署时替换 `__USER_HOME__` + `__MULTICA_USER_ID__`) |

## 逻辑

```
launchd 每日 10:00
  → curl github api latest release (走 xray proxy)
  → multica --version 拿当前版本
  → semver 比较 (sort -V), 只在 latest > current 通知
  → state 文件去重 (同一版本只通知一次)
  → curl sidecar /status 拿权威 open_id (不硬编码)
  → 05_agent_spawn.sh wrapper 发飞书 (复用 expiry_watcher 同款已验证路径)
```

## 设计要点

- **通知优先,不自动应用**:消息里给手动更新命令(QNAP docker compose pull / mini binary 重下),川哥自评回归风险后再动
- **open_id 走 sidecar 权威源**:不硬编码(防 [[feedback_llm_uuid_handcopy]] 类一字之差,虽然脚本是确定性的但保持范式一致)
- **semver 判新**:`sort -V` + 只在 latest 严格大于 current 时通知,防降级/异常 tag 误报
- **去重 state**:`~/.multica-update-check.state` 记录已通知版本,同版本不重复打扰
- **proxy**:GitHub API 走 xray(境外),本地服务 NO_PROXY 直连

## 部署

```bash
scp auto-update/multica-update-check.sh mini:~/bin/ && ssh mini 'chmod +x ~/bin/multica-update-check.sh'
ssh mini 'sed -e "s|__USER_HOME__|$HOME|g" -e "s|__MULTICA_USER_ID__|<真实 user id>|g" \
  > ~/Library/LaunchAgents/com.multica.update-check.plist' < auto-update/com.multica.update-check.plist.example
ssh mini 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.multica.update-check.plist'
```

## 实测(2026-06-02 部署)

- mini binary v0.3.12 vs 上游 v0.3.13 → 正确检测 + 飞书通知川哥 ✅
- 第二次跑去重跳过 ✅
- launchd 已装,每日 10:00 触发

## 手动跑一次

```bash
ssh mini 'MULTICA_NOTIFY_USER_ID=<user-id> bash ~/bin/multica-update-check.sh'
```
