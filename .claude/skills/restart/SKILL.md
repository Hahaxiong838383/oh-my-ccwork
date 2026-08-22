---
name: restart
description: 服务重启与状态验证。重启所有后台进程并验证服务恢复正常。触发词："/restart"、"重启服务"、"重启后端"、"kill进程"、"服务状态"
---

# restart - 服务重启与状态验证

> 重启所有后台进程并验证服务恢复正常。触发词："/restart"、"重启服务"、"重启后端"、"kill进程"、"服务状态"

## 触发条件

- 用户说"重启"、"restart"、"kill 进程"、"服务状态"、"检查进程"
- 飞书通道异常需要重启时

## 执行流程

### 1. 状态快照（重启前）

```bash
# 列出所有相关进程
echo "=== claude 进程 ===" && ps aux | grep -i claude | grep -v grep
echo "=== mycc 后端 ===" && lsof -i :18080 2>/dev/null || echo "无 18080 占用"
echo "=== node 后台进程 ===" && ps aux | grep "node.*tsx.*index.ts" | grep -v grep
```

记录当前终端的 PID（不能 kill 自己）：
```bash
# 当前终端 claude 进程（交互式，有 tty）
ps aux | grep -i claude | grep -v grep | grep 's0[0-9][0-9]' | awk '{print $2}'
```

### 2. Kill 进程

**保护当前终端进程**，kill 其余所有 claude 相关进程：

```bash
MY_PID=$(ps aux | grep -i claude | grep -v grep | grep 's0[0-9][0-9]' | awk '{print $2}' | head -1)
ps aux | grep -i claude | grep -v grep | awk '{print $2}' | grep -v "^${MY_PID}$" | while read pid; do
  echo "killing $pid"
  kill $pid 2>/dev/null
done
```

同时 kill mycc 后端（如果 daemon 没自动拉起会手动重启）：
```bash
lsof -i :18080 -t 2>/dev/null | xargs kill 2>/dev/null
```

等待 2 秒让进程退出：
```bash
sleep 2
```

### 3. 验证进程已清理

```bash
echo "=== 存活检查 ===" && ps aux | grep -i claude | grep -v grep
# 应该只剩当前终端进程
```

### 4. 重启 mycc 后端

检查 daemon 是否自动拉起：
```bash
lsof -i :18080 2>/dev/null
```

如果没有自动拉起，手动启动：
```bash
cd /Users/rayman.chen/mycc
.claude/skills/mycc/scripts/node_modules/.bin/tsx .claude/skills/mycc/scripts/src/index.ts start &
sleep 3
```

### 5. 验证服务恢复

```bash
# 端口监听
lsof -i :18080

# 健康检查
curl -s http://localhost:18080/health

# 连接信息
cat .claude/skills/mycc/current.json | python3 -m json.tool

# 进程总览
ps aux | grep -i claude | grep -v grep
```

### 6. 输出状态报告

以表格形式汇报：

| 检查项 | 状态 |
|--------|------|
| 旧进程已清理 | ? |
| mycc 后端 (18080) | ? |
| health 检查 | ? |
| tunnel URL | ? |
| 当前终端保留 | ? |

## 注意事项

- **绝对不能 kill 当前终端的 claude 进程**（通过 tty 标识区分）
- mycc 后端有 launchd daemon，通常会自动拉起
- 如果 tunnel URL 变了，需要通知用户更新连接
- evomap heartbeat 进程被 kill 后不会自动拉起（非关键服务）
- 重启后飞书 WebSocket 通道需要 ~5s 重新连接

## 相关文件

| 文件 | 说明 |
|------|------|
| `.claude/skills/mycc/scripts/src/index.ts` | mycc 后端入口 |
| `.claude/skills/mycc/current.json` | 运行时连接信息 |
| `install-daemon.sh` | daemon 安装脚本 |
| `uninstall-daemon.sh` | daemon 卸载脚本 |
