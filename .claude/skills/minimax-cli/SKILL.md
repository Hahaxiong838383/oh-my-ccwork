---
name: minimax-cli
description: MiniMax AI 平台 CLI 工具。调用 MiniMax-M2.5 聊天、生成图片/视频/音乐/TTS 语音、Agent 多步工具调用。触发词："/minimax"、"minimax"、"MiniMax"、"生成语音"、"TTS"、"AI视频"、"AI音乐"、"AI图片生成"
allowed-tools: bash
---

# MiniMax CLI

MiniMax 平台的非官方 CLI 工具（v0.7.1），支持与 MiniMax-M2.5 聊天、多模态媒体生成、Agent 模式。

## 安装信息

- **二进制路径**: `/home/hahaxiong83/mycc/.local/bin/minimax`
- **配置文件**: `~/.minimax/config.toml`
- **Skills 目录**: `~/.minimax/skills/`（已安装 19 个内置 skill）
- **源码**: `/tmp/MiniMax-CLI`（从 GitHub 编译）
- **API Key 环境变量**: `MINIMAX_API_KEY`
- **中国区 Base URL**: `https://api.minimaxi.com`

## 首次使用

```bash
# 1. 设置 API Key（从 https://platform.minimax.io 获取）
export MINIMAX_API_KEY="your-key"

# 2. 或写入配置文件
mkdir -p ~/.minimax
cat > ~/.minimax/config.toml << 'EOF'
api_key = "YOUR_MINIMAX_API_KEY"
base_url = "https://api.minimaxi.com"  # 中国区用这个
default_text_model = "MiniMax-M2.5"
EOF

# 3. 运行诊断
/home/hahaxiong83/mycc/.local/bin/minimax doctor
```

## 核心功能

### 1. 交互式聊天（TUI）
```bash
minimax                          # 启动交互式 TUI
minimax -p "写一首诗"             # 一次性提问（非交互式）
```

### 2. 模式切换（TUI 内按 Tab）
| 模式 | 说明 |
|------|------|
| Normal | 普通聊天，操作需审批 |
| Plan | 先设计再执行 |
| Agent | 多步工具调用，shell/付费工具需审批 |
| YOLO | 全自动，危险模式 |
| RLM | 大文件/大上下文专用 |
| Duo | 玩家-教练对抗式自动编码 |

### 3. 媒体生成（需 API 额度）
- **图片生成**: image-01 模型
- **视频生成**: video-01 模型
- **音乐生成**: music-01 模型
- **TTS 语音**: speech-01/02 模型（支持语音设计、克隆）

### 4. 代码审查
```bash
minimax review                   # 对 git diff 进行代码审查
minimax coding --help            # 编码模式选项
```

### 5. Session 管理
```bash
minimax sessions --limit 50      # 列出历史 session
minimax --resume latest          # 恢复最近 session
minimax --resume <id-prefix>     # 按 ID 恢复
```

### 6. Runtime API 服务
```bash
minimax serve --http --host 127.0.0.1 --port 7878 --workers 2
```

### 7. MCP 服务器模式
```bash
minimax serve                    # 作为 MCP stdio server 运行
```

## 内置 Skills（19 个）

| Skill | 用途 |
|-------|------|
| voiceover-studio | 专业配音工作室 |
| video-studio | 视频制作 |
| audiobook-studio | 有声书制作 |
| social-media-kit | 社交媒体内容套件 |
| music-video-generator | MV 生成 |
| ad-commercial-kit | 广告制作 |
| product-photography-kit | 产品摄影 |
| educational-course-kit | 教育课程制作 |
| game-asset-generator | 游戏素材生成 |
| language-learning-kit | 语言学习工具 |
| short-drama-kit | 短剧制作 |
| trailer-teaser-generator | 预告片生成 |
| meditation-wellness-kit | 冥想/健康音频 |
| voice-podcast-kit | 播客制作 |
| interactive-story-kit | 互动故事 |
| storybook-lesson | 绘本教学 |
| music-promo-pack | 音乐推广套件 |
| photo-learning | 摄影教学 |
| audiobook-workshop | 有声书工坊 |

## cc 使用场景

1. **需要 TTS/语音合成时** -> `minimax -p "用 speech-02 生成..."` 或启动 TUI
2. **需要 AI 视频/图片/音乐生成时** -> 启动 TUI 进入 Agent 模式
3. **需要大文件处理时** -> 使用 RLM 模式
4. **需要代码审查时** -> `minimax review`
5. **作为 MCP 工具提供给其他 Agent** -> `minimax serve`

## 触发词

- "/minimax"
- "minimax"
- "MiniMax"
- "生成语音"、"TTS"、"语音合成"
- "AI视频生成"、"AI音乐"、"AI图片生成"
- "MiniMax聊天"
- "minimax review"、"minimax 代码审查"

## 注意事项

- 媒体生成（图片/视频/音乐/TTS）会消耗 API 额度（付费）
- API Key 需要从 https://platform.minimax.io 获取
- 中国区用户设置 base_url 为 `https://api.minimaxi.com`
- YOLO 模式危险，会自动执行 shell 命令，谨慎使用
