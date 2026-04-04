---
name: cc2wechat
description: 微信 ClawBot 服务管理。启动/重启微信→Claude Code 通道，自动处理登录和守护进程。触发词："/cc2wechat"、"开启微信ClawBot"、"微信机器人"、"启动微信通道"
---

# cc2wechat — 微信 ClawBot

通过微信扫码登录，让微信聊天变成 Claude Code 的交互终端。

## 项目位置

`/home/hahaxiong83/mycc/2-Projects/cc2wechat/`

## 触发条件

- 用户说"开启微信ClawBot"、"cc2wechat"、"微信机器人"、"启动微信通道"

## 执行流程

### 1. 检查当前状态

```bash
cc2wechat status 2>&1
curl -s http://localhost:18081/health 2>/dev/null
```

### 2. 判断是否需要登录

检查是否有已存在的账号：

```bash
cat ~/.cc2wechat/aliases.json 2>/dev/null
```

#### 情况 A：daemon 正在运行 → 无需操作

health 检查通过，告知用户直接在微信发消息即可。

#### 情况 B：有账号但 daemon 没运行 → 启动

```bash
cd /home/hahaxiong83/mycc && cc2wechat start cc
```

后台运行 daemon。等待 5 秒后验证健康状态。

#### 情况 C：无账号 → 登录

```bash
cd /home/hahaxiong83/mycc && cc2wechat login --name cc
```

登录会打开浏览器显示二维码页面，**提示用户扫码**。
登录成功后自动启动 daemon。

#### 情况 D：登录信息过期/无法正常使用 → 清空重新登录

```bash
# 1. 停止所有 daemon
cc2wechat stop 2>/dev/null

# 2. 清空登录信息
rm -rf ~/.cc2wechat/
rm -rf ~/.claude/channels/wechat-channel/

# 3. 重新登录
cd /home/hahaxiong83/mycc && cc2wechat login --name cc
```

### 3. 验证服务正常

```bash
sleep 5 && curl -s http://localhost:18081/health
```

### 4. 输出状态

告知用户 daemon 状态、端口号、是否可以使用。

## 微信内聊命令

| 命令 | 说明 |
|------|------|
| `/new` | 新建对话 |
| `/exit` | 结束对话 |
| `/help` | 查看帮助 |

## 技术细节

- **Delivery**：tmux（每个用户独立 tmux session，Claude Code 运行其中）
- **权限模式**：`--permission-mode bypassPermissions`（不用 `--dangerously-skip-permissions`，后者有交互式确认框）
- **回复机制**：Claude Code 通过 `cc2wechat --text "回复"` 发回微信
- **就绪检测**：轮询 tmux pane 检测 `bypass permissions on` 字符串，约 2-5 秒就绪
- **首次创建 session 约需 5 秒**，后续消息秒注入

## 注意事项

- daemon 后台运行，用 `run_in_background` 启动
- 账号名默认 `cc`，端口 18081
- 如果遇到端口冲突，先 `cc2wechat stop` 再重试
- 项目已加入 `.gitignore`，不会上传到代码仓库
- `settings.local.json` 的 hooks 格式必须是 `{ "matcher": "", "hooks": [...] }`，否则 Claude 启动会报错
