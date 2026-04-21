# Studio 服务启动手册

> 适用场景：断电重启、系统重启、首次部署

## 服务架构

```
Studio M2 Max
├── brain (pm2)            — 主 API 服务，端口 19080
├── semantic-vision (pm2)  — MLX Qwen2-VL 语义理解，读 latest.jpg
├── vision-daemon (LaunchAgent) — 摄像头 + 人体检测，写 latest.jpg
└── Ollama                 — 本地模型推理，端口 11434（系统级，自动启动）
```

## 断电重启恢复（SSH via Mini）

```bash
# 1. 恢复 pm2 服务（brain + semantic-vision）
export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain && npx pm2 resurrect

# 2. vision-daemon 由 LaunchAgent 管理，用户登录桌面后自动启动
#    无需手动操作
```

## 首次部署（全新 Studio）

```bash
# 1. 初始化 vision venv（含 cv2 + mlx_vlm）
bash tools/vision/setup_studio.sh

# 2. 安装 LaunchAgent
cp docs/vision-daemon.plist.template ~/Library/LaunchAgents/com.mycc.brain.vision-daemon.plist
# 编辑 plist 中的路径（替换 BRAIN_ROOT）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mycc.brain.vision-daemon.plist

# 3. 启动 pm2 服务
export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain
npx pm2 start ecosystem.config.cjs
npx pm2 save

# 4. 摄像头权限（必须在 Studio 本机操作一次）
# 运行后等 macOS 弹出权限对话框，点"允许"
tools/vision/.venv-vision/bin/python3.12 tools/vision/vision_daemon.py --once
# 之后 LaunchAgent 自动获得摄像头访问权
```

## 验证命令

```bash
# pm2 状态
export PATH=/usr/local/bin:$PATH && npx pm2 list

# brain API
curl http://localhost:19080/v1/models | python3 -m json.tool | head -5

# vision-daemon（LaunchAgent）
launchctl list com.mycc.brain.vision-daemon
cat data/activity/status.json

# 摄像头实时输出
cat data/activity/latest.json | python3 -m json.tool
```

## 常见问题

### vision-daemon 摄像头打不开

**原因**：macOS TCC 权限未授给 Python.app bundle（`org.python.python`）

**修复**：
1. 在 Studio 本机 System Settings → Privacy & Security → Camera → 开启 Python
2. 或在本机 Terminal 运行一次 daemon，点击弹窗"允许"
3. 重启 LaunchAgent：`launchctl kickstart -k gui/$(id -u) com.mycc.brain.vision-daemon`

### venv Python 断链（跨机器 rsync 后）

**症状**：`vision-daemon` 报 `zsh: no such file or directory`

**原因**：venv 的 python symlink 指向 Air 路径（`/Users/rayman.chen/...`）

**修复**：
```bash
cd ~/mycc-brain/tools/vision/.venv-vision/bin
rm -f python python3 python3.12
ln -sf /opt/homebrew/bin/python3.12 python3.12
ln -sf python3.12 python3
ln -sf python3.12 python
```

### pm2 daemon 丢失（断电后）

**症状**：`pm2 list` 显示空列表，pm2 自动生成新 daemon

**修复**：`npx pm2 resurrect`（从 `~/.pm2/dump.pm2` 恢复）
