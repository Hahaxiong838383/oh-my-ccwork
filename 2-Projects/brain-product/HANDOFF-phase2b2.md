# HANDOFF: mycc-brain Phase 2B-2 视觉融合 + 声音感知

> Phase 2B-1 已完成并在线运行。本文档为后续阶段的交接。

---

## Phase 2B-1 完成状态（2026-04-08）

### 已部署运行

| 组件 | 位置 | 状态 |
|------|------|------|
| vision_daemon.py | Studio `~/mycc-brain/tools/vision/` | 运行中，1fps MobileNet-SSD |
| visual-state.ts | Studio `~/mycc-brain/dist/services/` | brain 启动时自动轮询 |
| visual-gate.ts | Studio `~/mycc-brain/dist/services/` | away→silent 门控生效 |
| /admin/api/visual-status | Studio :19080 | 路由就绪（需认证） |
| data/activity/ | Studio `~/mycc-brain/data/activity/` | latest.json + status.json + JSONL 持续写入 |

### 关键文件清单

**Python 侧（Studio ~/mycc-brain/）**：
- `tools/vision/vision_daemon.py` — 主程序，带摄像头重试逻辑
- `tools/vision/.venv-vision/` — Python venv（opencv-python-headless + numpy）
- `tools/vision/models/MobileNetSSD_deploy.{prototxt,caffemodel}` — 模型文件
- `tools/vision/requirements.txt`
- `tools/vision/setup_studio.sh` / `run_vision.sh`

**TypeScript 侧（Air 源码 → Studio dist/）**：
- `src/services/visual-state.ts` — 3s 轮询 latest.json mtime，进程级单例
- `src/services/visual-gate.ts` — 单条规则：available && present===false → silent
- `src/services/activity-observability.ts` — admin API 聚合
- `src/brain-api.ts` — 视觉门控插入点（decideProactiveAction 之后）
- `src/server.ts` — startVisualStatePolling + /admin/api/visual-status

**数据文件（Studio ~/mycc-brain/data/activity/）**：
- `latest.json` — 实时状态快照（原子写入）
- `status.json` — daemon 健康状态
- `YYYY-MM-DD.jsonl` — 日志历史（心跳 30s + 状态变化）

### 保活机制

- Studio `.zprofile` 自动启动（每次打开 Terminal 时检查并拉起）
- daemon 内置摄像头重试（30s 间隔，不退出）
- macOS 摄像头权限绑定在 Terminal.app（launchd/PM2 无法获取 TCC 权限）
- launchd plist 保留在 `~/Library/LaunchAgents/com.mycc.vision-daemon.plist` 作为备用

### 已知限制

1. **摄像头权限**: 只有 Terminal.app 子进程能访问摄像头，PM2/launchd 不行
2. **Studio 重启后**: 需要打开一次 Terminal 窗口触发 .zprofile 自动启动
3. **MobileNet-SSD 精度**: 置信度阈值固定 0.5，尚未经过长时间验证
4. **motionLevel 阈值**: 固定 0.05 区分 active/idle，可能需要调整

---

## Phase 2B-2 目标：视觉融入 user-state + 声音感知

### 要做的事

#### 1. 视觉融入 user-state.ts

当前 `user-state.ts` 的 `updateSessionState()` 纯基于文本推断 intent/mood/expertise。Phase 2B-2 需要：

- 读取 `getVisualState()` 的 activity 字段
- 将视觉 activity 作为 user-state 的一个信号源融合
- 例如：视觉 active + 文本 intent=debug → 高紧急度，回复简洁直接
- 例如：视觉 idle + 文本 intent=explore → 低紧急度，可以展开说明

**约束**：
- 不改变 `VisualState` 接口
- user-state 融合逻辑应该是可选的（视觉不可用时降级到纯文本推断）
- 不做视觉驱动的 proactive 升级（只做降级，Phase 2B-1 已锁定）

#### 2. 声音感知（环境音级别）

在 `vision_daemon.py` 中增加麦克风采集：

- 使用 `pyaudio` 或 `sounddevice` 采集环境音
- 每秒采样一次，计算 RMS 音量级别
- 输出到 `latest.json` 新增字段：
  ```json
  {
    "audioLevel": 0.15,
    "audioMethod": "rms",
    "audioAvailable": true
  }
  ```
- 声音级别分级：
  - silence: < 0.02（安静）
  - ambient: 0.02-0.1（背景噪音）
  - speech: 0.1-0.4（说话）
  - loud: > 0.4（嘈杂）

**约束**：
- 不做语音识别（只检测音量级别）
- 不做说话人识别
- macOS 麦克风权限需要和摄像头一样处理（Terminal.app 继承）
- `requirements.txt` 新增 `sounddevice`（比 pyaudio 更轻量，无需 portaudio）

#### 3. system prompt 视觉上下文注入

在 `brain-context.ts` 或 `brain-api.ts` 中，将视觉状态作为上下文注入 system prompt：

```
## 用户环境感知
- 位置状态: 在工位 (99.7% 置信度)
- 活动状态: idle (低运动量)
- 环境声音: ambient (背景噪音)
- 感知来源: vision-daemon-v1
```

**约束**：
- 只在 `route.brain === true` 时注入
- 视觉不可用时不注入（不要注入 "视觉不可用" 这种无用信息）
- 注入位置在 stateHint 之后

### 不要做的事

- face 识别
- 语音识别（ASR）
- prediction hit 验证
- pattern-miner 接入
- resonance 接入
- active/idle 降级门控（只做 away→silent，已在 Phase 2B-1 锁定）
- 视觉驱动升级

---

## 开发环境

| 项目 | 值 |
|------|-----|
| 源码 | Air: `~/mycc/2-Projects/brain-product/mycc-brain/` |
| 运行 | Studio: `~/mycc-brain/` (rsync 部署) |
| Node | Studio: v22.14.0 (`/usr/local/bin/node`) |
| Python | Studio: 3.12.13 (brew, venv at `tools/vision/.venv-vision/`) |
| PM2 | Studio: `npx pm2`（非全局安装） |
| brain PM2 名称 | `brain`（不是 mycc-brain） |
| brain 端口 | 19080 |
| TS build | `npm run build`（tsc） |
| Studio SSH | `ssh studio` |
| Studio git | 不可用（Xcode 损坏），用 rsync 部署 |

### 部署流程

```bash
# Air 上修改代码后：
cd ~/mycc/2-Projects/brain-product/mycc-brain
npm run build  # 本地验证

# 同步到 Studio
rsync -avz src/services/visual-state.ts src/services/visual-gate.ts \
  src/services/activity-observability.ts src/brain-api.ts src/server.ts \
  studio:~/mycc-brain/src/

# Studio 上 build
ssh studio 'export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain && npx tsc'

# 重启 brain
ssh studio 'export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain && npx pm2 restart brain'
```

### Python 修改后部署

```bash
rsync -avz tools/vision/vision_daemon.py studio:~/mycc-brain/tools/vision/
# daemon 需要手动重启（kill + 重新打开 Terminal 触发 .zprofile）
ssh studio 'kill $(ps aux | grep vision_daemon | grep -v grep | awk "{print \$2}") 2>/dev/null'
# 然后在 Studio 本机打开新 Terminal 窗口
```

---

## 验收标准

### Phase 2B-2

1. `latest.json` 包含 `audioLevel` / `audioAvailable` 字段
2. `user-state.ts` 融合视觉 activity 信号
3. brain=true 的请求 system prompt 包含环境感知上下文
4. 视觉不可用时所有逻辑正常降级
5. `npm run build` 通过
6. `python3 -m py_compile vision_daemon.py` 通过

---

*创建时间：2026-04-08*
*Phase 2B-1 完成人：cc (Claude claude-opus-4-6)*
