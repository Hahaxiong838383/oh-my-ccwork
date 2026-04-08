# HANDOFF: brain 视觉语义质量提升（从「能跑」到「能用」）

> Phase 2B-1/2B-2 已打通全链路。本次任务专注提升语义视觉质量，让 brain 真正能回答「我在不在」「穿什么」「附近有什么」。

---

## 当前问题

效果差的三个根因：

1. **模型太弱**：semantic_vision_daemon.py 用 `mlx-community/Qwen2-VL-2B-Instruct-4bit`（2B-4bit），描述能力极差
2. **present=false 时跳过 VLM**：第 233 行直接写死「当前工位无人」不调模型，工位物品信息全丢
3. **brain-api 注入太弱**：formatEnvironmentHint 只注入结构化标签，rawText 里的丰富描述被丢弃

## Studio 可用模型（已验证在线）

| 模型 | 引擎 | 大小 | 用途 | 推荐 |
|------|------|------|------|------|
| minicpm-v | Ollama | 5.5GB | 中文场景描述，细节丰富 | **主力** |
| moondream | Ollama | 1.7GB | 英文快扫，速度快 | 备用快扫 |
| Qwen2-VL-2B-4bit | mlx_vlm | ~1.2GB | 当前在用，效果差 | 弃用 |

**推荐方案**：semantic daemon 改用 Ollama **minicpm-v** 做场景描述。这是 cc-eye 之前用的精扫模型，中文描述能力远超 Qwen2-VL-2B。

Ollama 路径：`/usr/local/bin/ollama`（非交互 shell 里 `which ollama` 找不到，需要绝对路径或设 PATH）。

## cc-eye 原始架构参考

cc-eye 的 camera_daemon.py（`2-Projects/cc-eye/camera_daemon.py`）架构：
- 快扫（moondream，10s 间隔，英文一句话）
- 精扫（minicpm-v，60-120s 间隔，中文 2-3 句详细描述）
- prompt 风格：自然语言描述，不要求 JSON

cc-eye 的精扫 prompt（效果好的版本）：
```
简洁描述这个场景：
1) 有谁在，在做什么
2) 桌上/房间里的重要物品
3) 有什么变化或异常。
2-3句话。
```

当人在时，会加前缀：
```
[重要提示：画面中的人是川哥（我的老板）。描述时请直接称呼他的名字，不要说'一名男子'。]
```

## 改动计划

### 改动 1: semantic_vision_daemon.py — 换用 Ollama minicpm-v

**核心改动**：
- 把 `mlx_vlm` 的 `SemanticScanner` 替换为通过 Ollama HTTP API（`http://localhost:11434/api/generate`）调用 minicpm-v
- Ollama 视觉 API 需要 base64 编码图片：`POST /api/generate { model: "minicpm-v", prompt: "...", images: ["base64..."] }`
- 去掉 `mlx_vlm` 依赖（import 失败不再 sys.exit）

**prompt 改动**：
- 不要求输出 JSON，改为自然语言中文描述（cc-eye 验证过效果好）
- 人在时用 cc-eye 的精扫 prompt（描述人物+物品+动作）
- 人不在时也调模型：prompt 改为「描述这个工位场景：桌上有什么物品，环境怎样。1-2句话。」
- max_tokens 提到 300

**后处理**：
- rawText 保存完整的自然语言描述
- 用简单规则从 rawText 提取 person_appearance / nearby_objects / scene_summary
- 提取失败时，rawText 本身就是 scene_summary

**降级**：
- Ollama 不可用时降级回 mlx_vlm（如果可用）或写 semanticAvailable=false

### 改动 2: brain-api.ts — formatEnvironmentHint 注入 rawText

当前 formatEnvironmentHint 只注入结构化标签（场景摘要、人物外观、附近物体），丢失了 rawText 的丰富细节。

改动：
- 当 rawText 可用且非 "unknown" / "当前工位无人" 时，直接注入：`- 摄像头实时画面: {rawText}`
- 这样 brain 拿到的是模型原始描述，回答「你看到什么」时有具体内容可引用

为此需要：
- `visual-state.ts` 的 VisualState 接口新增 `rawText: string | null`
- `visual-state.ts` pollOnce 从 semantic-latest.json 读取 rawText
- `brain-api.ts` formatEnvironmentHint 使用 rawText

### 改动 3: semantic_vision_daemon.py — 去掉 present=false 跳过

当前第 233 行：`if present is False:` → 直接写死「当前工位无人」。

改为：无论 present 是否 false，都调模型描述画面。present=false 时用简化 prompt（「描述工位环境和桌面物品」），present=true 时用完整 prompt（「描述人物+物品+动作」）。

---

## 要改的文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `tools/vision/semantic_vision_daemon.py` | 重写 SemanticScanner | 换 Ollama minicpm-v + 新 prompt + 去掉 present=false 跳过 |
| `src/services/visual-state.ts` | 小改 | VisualState 接口加 rawText，pollOnce 读 rawText |
| `src/brain-api.ts` | 小改 | formatEnvironmentHint 注入 rawText |

## 不要改的文件

- `tools/vision/vision_daemon.py` — 底层摄像头 daemon 不动
- `src/services/visual-gate.ts` — 门控规则不动
- `src/server.ts` — 路由不动

---

## Studio 环境

| 项目 | 值 |
|------|-----|
| Ollama 路径 | `/usr/local/bin/ollama` |
| Ollama API | `http://localhost:11434` |
| minicpm-v 模型 | 已拉取，5.5GB |
| moondream 模型 | 已拉取，1.7GB |
| Python venv | `~/mycc-brain/tools/vision/.venv-vision/` |
| semantic daemon 当前进程 | PID 87740，需要 kill 后重启 |
| brain PM2 | `npx pm2 restart brain` |
| TS build | `export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain && npx tsc` |
| 部署方式 | Air rsync → Studio（git 不可用） |

### rsync 命令模板

```bash
# Python
rsync -avz tools/vision/semantic_vision_daemon.py studio:~/mycc-brain/tools/vision/

# TS
rsync -avz src/services/visual-state.ts src/brain-api.ts studio:~/mycc-brain/src/ && \
rsync -avz src/services/visual-state.ts studio:~/mycc-brain/src/services/

# Studio build + restart
ssh studio 'export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain && npx tsc && npx pm2 restart brain'

# 重启 semantic daemon
ssh studio 'kill $(ps aux | grep semantic_vision | grep -v grep | awk "{print \$2}") 2>/dev/null; sleep 1; cd ~/mycc-brain && nohup tools/vision/.venv-vision/bin/python3 tools/vision/semantic_vision_daemon.py --data-dir data/activity --debug > data/activity/semantic-daemon.log 2>&1 &'
```

---

## 验收标准

1. `cat data/activity/semantic-latest.json` 的 rawText 是 2-3 句中文自然语言描述（不是 JSON 模板）
2. 人在时，rawText 包含人物衣着/动作/桌面物品
3. 人不在时，rawText 描述工位环境和桌面物品（不是写死「当前工位无人」）
4. 在 Admin UI 测试对话中问「我穿什么衣服」「桌上有什么」能得到具体回答
5. `npm run build` 通过
6. `python3 -m py_compile semantic_vision_daemon.py` 通过

---

## 禁止

- 不做 face recognition / ASR
- 不做 prediction / resonance / evolution 接入
- 不改 visual-gate.ts 门控规则
- 不改 vision_daemon.py 底层摄像头逻辑
- 不用 gemma4（太大，19GB，会抢 brain 其他模型的资源）

---

*创建时间：2026-04-08*
*诊断人：cc (Claude claude-opus-4-6)*
