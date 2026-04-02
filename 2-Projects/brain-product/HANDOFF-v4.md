# mycc-brain v0 实施方案 — 交接文档

> 创建时间：2026-04-02 17:00 | 创建者：cc (Claude Opus 4.6)
> Session：v3 评审 → 简化路径讨论 → 云端 API 先行 → v0 方案定稿
> 前序文档：HANDOFF-v3.md（v3 完整架构）、PROPOSAL.md（v2 方案）

---

## 一、方案演化脉络

```
v1 (brain.yaml 规范)
  → v2 (经验流 + 三循环 + 微调闭环)
  → v3 (brain 是入口 + 多端触达 + 模型回链路)
  → v0 (先验证机制，再搞模型)  ← 当前
```

### 为什么从 v3 退到 v0？

v3 架构完整但一上来就要：新服务 + 本地模型 + 硬件部署 + 多端接入。经过讨论达成共识：

**brain 的价值在机制层（经验流 + 记忆注入 + hot-patch），不在模型层。用云端 API 先跑通机制，比在本地 27B 上磕硬件问题快 10 倍。**

v0 = 用最小改动验证 brain 机制，跑两周收集数据，再决定 v3 哪些值得做。

---

## 二、现有资产盘点（关键修正）

| 资产 | 状态 | 说明 |
|------|------|------|
| **mycc 后端** | ✅ 可用 | Node.js 原生 HTTP，端口 18080，已有 /chat /history /memory/*，5 个飞书 bot，context-loader（向量检索+TF-IDF+时间衰减+RRF 融合+LLM 重排），memory-db（SQLite+向量），scheduler |
| **cc-remote V4** | ✅ 运行中 | Mini 上 Caddy(:19443) + FRP → 阿里云 relay，**公网域名 `cli4.hahaxiong.cc`**，暗色 Web Panel，3 个 ttyd 终端，api.py 会话管理 |
| **飞书 bot** | ✅ 已集成 | mycc 后端原生 5 bot 并行（@larksuiteoapi/node-sdk），事件订阅+消息收发+会话隔离 |
| **OpenClaw 微信** | 📦 可装 | `@tencent-weixin/openclaw-weixin` 官方 npm 包，ClawBot 插件 |
| **OpenClaw 飞书** | 📦 可装 | `@larksuiteoapi/feishu-openclaw-plugin` 官方出品（备选，已有原生集成） |
| **mycc.dev** | ❌ 已废弃 | 不再使用，需要新建 WebUI |
| **Mini mycc 目录** | ✅ 有仓库 | 可 git pull 最新代码 |
| **context-loader** | ✅ 强大 | 向量+关键词+时间衰减+MMR 去重+LLM 重排+RRF 融合，3000 chars 注入 |

### 关键修正（相比上轮讨论）

1. **mycc.dev 是残留，不再使用** → 需要新建 Chat WebUI
2. **mycc 后端用 Claude Agent SDK（spawn CLI 子进程），不是直调 API** → 需要加 API 直调适配器
3. **cc-remote V4 域名是 `cli4.hahaxiong.cc`**（不是 cli.hahaxiong.top）
4. **飞书/微信的 OpenClaw 官方集成都有现成 npm 包** → GitHub 上有社区资源

---

## 三、v0 架构

### 3.1 总体架构

```
你（手机/电脑/任何设备）
    │
    ├── 浏览器 → https://cli4.hahaxiong.cc/brain/  ← Chat WebUI（新建）
    ├── 飞书   → 飞书 bot（已有，mycc 后端原生集成）
    └── 微信   → OpenClaw ClawBot → webhook → mycc 后端（Phase 2）
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│  mycc 后端（升级版）— Mini 上运行，端口 18080              │
│                                                           │
│  现有能力（不动）：              新增（v0 改动）：           │
│  ├── /chat (SSE 流式)           ├── Claude API 直调适配器  │
│  ├── /history/*                 ├── DeepSeek API 适配器    │
│  ├── /memory/*                  ├── /correct (用户纠正)    │
│  ├── context-loader (记忆注入)   ├── 经验流 JSONL 写入      │
│  ├── memory-db (SQLite+向量)    ├── hot-patch 注入 hook    │
│  ├── chat-memory (会话管理)     └── 路由判断逻辑            │
│  ├── scheduler (定时任务)                                  │
│  ├── health-monitor                                       │
│  └── feishu bot ×5                                        │
└──────────────────────────┬───────────────────────────────┘
                           │
          ┌────────────────┼────────────────────┐
          ▼                ▼                    ▼
   Claude API         DeepSeek API         本地 Ollama
   (主力)              (日终编译)           (未来 cc-v{N})
```

### 3.2 公网访问（复用 cc-remote V4）

```
Mini M4 (10.9.1.54)
┌──────────────────────────────────────────────────┐
│  Caddy (:19443)                                   │
│    ├── /               → cc-remote 管理面板 (已有) │
│    ├── /brain/*        → Chat WebUI 静态文件 (新增) │
│    ├── /brain-api/*    → mycc 后端 :18080 (新增)   │
│    ├── /claude/*       → ttyd (已有)               │
│    ├── /codex/*        → ttyd (已有)               │
│    ├── /gemini/*       → ttyd (已有)               │
│    └── /api/*          → cc-remote api.py (已有)   │
│                                                    │
│  FRP 隧道 → 阿里云 HK relay → cli4.hahaxiong.cc   │
└──────────────────────────────────────────────────┘

访问方式：
- Chat WebUI：https://cli4.hahaxiong.cc/brain/
- 终端面板：  https://cli4.hahaxiong.cc/
- Basic Auth 认证（cc-remote 已有）
```

### 3.3 请求处理流程（brain 机制）

```
用户输入（任意入口：WebUI / 飞书 / 微信）
    │
    ▼
① context-loader 查记忆（已有，向量+关键词+时间衰减+RRF）
    │
    ▼
② 注入 hot-patches（新增：从 hot-patches.jsonl 读取最近纠正）
    │
    ▼
③ 路由判断（新增）
    ├── 默认 → Claude API（主力）
    ├── /local 前缀 → Ollama 本地模型（未来）
    └── /deep 前缀 → DeepSeek API（便宜）
    │
    ▼
④ API 调用 → 生成回复 → SSE 流式返回用户
    │
    ▼
⑤ 异步写入经验流 JSONL（新增，不阻塞响应）
    │
    ▼
⑥ 如果用户纠正（调 /correct）→ 写入 contrast + hot-patch
```

### 3.4 经验流 Schema

```jsonc
// data/experiences/2026-04-03.jsonl（一天一个文件，追加写入）
{
  "id": "exp_20260403_143021_a7f3",
  "ts": "2026-04-03T14:30:21+08:00",
  "conversation_id": "conv_20260403_1430_ab12",
  "turn_index": 3,
  "source": "web | feishu | wechat | cli",
  "model": "claude-sonnet-4-20250514",
  "route": "claude_api | deepseek_api | local_ollama",
  "latency_ms": 1200,
  "surprise": null,          // v0 不打分，全量记录
  "tags": [],
  "user_input": "发个飞书通知给团队",
  "model_output": "好的，我帮你...",
  "contrast": null            // 有纠正时填写
}
```

### 3.5 hot-patch 机制

```jsonc
// data/hot-patches.jsonl
{
  "id": "hp_20260403_1502",
  "created_at": "2026-04-03T15:02:00+08:00",
  "source_experience_id": "exp_20260403_143021_a7f3",
  "rule": "飞书通知限速时立即切换 open-feishu-mcp，不重试原方法",
  "context": "飞书通知发送",
  "status": "active"          // active | merged | expired
}

// 注入方式：/chat 请求前，读取 active 状态的 patch（最多 10 条），
// 拼接到 system prompt 末尾的「近期纠正」section
```

### 3.6 Chat WebUI 设计

**技术方案**：单文件 HTML + Tailwind CSS，跟 cc-remote V4 panel 同风格（暗色主题 Apple 风格）

**核心功能**：
- 消息输入 + SSE 流式渲染（Markdown + 代码高亮）
- 对话历史列表（侧边栏，调 /history/list）
- 新建/切换/删除对话
- 纠正功能：长按消息 → 弹出纠正框 → 调 /correct
- 手机端响应式适配
- 模型切换：下拉选择 Claude / DeepSeek / Local

**认证**：复用 cc-remote V4 的 Basic Auth（Caddy → nginx 外层处理）

**部署位置**：`2-Projects/cc-remote-v4/brain-ui/`，Caddy 路由 `/brain/*`

---

## 四、具体改动清单

### 4.1 mycc 后端改动

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `adapters/api-direct.ts` | **新建** | Claude API 直调适配器（@anthropic-ai/sdk），SSE 流式，不 spawn CLI |
| `adapters/deepseek.ts` | **新建** | DeepSeek API 适配器（OpenAI 兼容格式，改 baseURL） |
| `adapters/ollama-direct.ts` | **新建** | Ollama 本地模型适配器（未来用，先占位） |
| `adapters/index.ts` | **修改** | 加路由逻辑：根据配置/请求参数选择适配器 |
| `services/experience-stream.ts` | **新建** | 经验流 JSONL 写入（异步，按日分文件） |
| `services/hotpatch.ts` | **新建** | hot-patch 读写 + 注入逻辑 |
| `http-server.ts` | **修改** | 新增 /correct 路由 + 在 /chat 流程中插入 hook |
| `.env` | **修改** | 新增 ANTHROPIC_API_KEY、DEEPSEEK_API_KEY |

### 4.2 cc-remote V4 改动

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `brain-ui/index.html` | **新建** | Chat WebUI 单文件 SPA |
| `Caddyfile` | **修改** | 新增 /brain/* 和 /brain-api/* 路由 |

### 4.3 Caddyfile 新增路由

```caddyfile
# 现有的 :19443 block 里加两段

# Brain Chat WebUI
handle /brain/* {
    uri strip_prefix /brain
    root * /Users/rayman.chen/mycc/2-Projects/cc-remote-v4/brain-ui
    file_server
}

# Brain API 反代（指向 mycc 后端）
handle /brain-api/* {
    uri strip_prefix /brain-api
    reverse_proxy localhost:18080 {
        transport http {
            read_timeout 0
            write_timeout 0
        }
    }
}
```

---

## 五、执行计划

### Phase 1：API 直调 + 经验流（3 天）

| 天 | 任务 | 验证标准 |
|----|------|---------|
| D1 | Claude API 直调适配器 + DeepSeek 适配器 | curl /chat 用 API 而非 spawn CLI 回复 |
| D2 | 经验流写入 + hot-patch 读写注入 | 每次对话自动记录 JSONL，hot-patch 注入可见 |
| D3 | /correct 接口 + contrast 对比对 | 纠正后下次对话 system prompt 带纠正规则 |

### Phase 2：WebUI + 公网（2 天）

| 天 | 任务 | 验证标准 |
|----|------|---------|
| D4 | Chat WebUI（单文件 HTML，暗色主题） | 浏览器能流式聊天，有对话历史 |
| D5 | Caddy 路由 + 后端部署到 Mini + 联调 | cli4.hahaxiong.cc/brain/ 可用 |

### Phase 3：IM 通道（2 天）

| 天 | 任务 | 验证标准 |
|----|------|---------|
| D6 | 飞书 bot 对接（已有基础，切换到 API 适配器） | 飞书群里 @bot 用 API 回复 |
| D7 | 微信 OpenClaw ClawBot 接入 | 微信发消息 → webhook → brain 回复 |

### 验证期（2 周）

收集经验流数据，手动浏览，评估：
- 日均交互量
- 纠正频率
- 经验流数据质量
- 哪些场景用云端、哪些该切本地

### Phase 4（验证后决策）

| 指标 | 决策 |
|------|------|
| 经验流 >100 条/周 | 值得做日终编译器 |
| 纠正 >20 条 | 有足够 DPO 数据 |
| 高频重复问题 | 该切本地模型了 |
| 云端成本 >$20/月 | 该切本地模型了 |

---

## 六、与 v3 的关系

v0 是 v3 的**验证子集**：

| v3 完整架构 | v0 先做 | v0 不做（验证后再决定） |
|------------|---------|----------------------|
| brain 服务骨架 | ✅ 复用 mycc 后端 | — |
| 经验流写入 | ✅ 每次对话自动记录 | 惊讶度评估（全量记录） |
| hot-patch | ✅ 纠正立刻生效 | 日终编译器（手动浏览） |
| 记忆注入 | ✅ context-loader 已有 | 行为适应表 adaptations.yaml |
| 多端入口 | ✅ WebUI + 飞书 + 微信 | 语音 / 视觉 / CLI |
| 路由判断 | ✅ 规则路由 | 模型路由 |
| 微调闭环 | ❌ 不做 | SFT/DPO/QLoRA 全部推后 |
| 日终编译器 | ❌ 不做 | 等经验流数据够了再说 |

**v0 验证的核心假设**：经验流 + hot-patch 机制能显著降低用户纠正频率。如果两周后纠正频率没有下降，说明 brain 机制的价值假设需要重新审视。

---

## 七、风险

| 风险 | 严重度 | 应对 |
|------|--------|------|
| Claude API 成本超预期 | 中 | 监控日均 token，设 $20/月警报线；高频场景切 DeepSeek |
| mycc 后端部署到 Mini 的兼容性 | 中 | Node.js + SQLite + 向量库需要在 Mini 上验证 |
| 经验流数据量不足 | 低 | 主动使用，把飞书日常沟通都走 brain |
| hot-patch 堆积 | 低 | 日终手动 review，active 超过 20 条时提醒清理 |

---

## 八、关键文件索引

| 文件 | 说明 |
|------|------|
| `2-Projects/brain-product/HANDOFF-v4.md` | **本文档** |
| `2-Projects/brain-product/HANDOFF-v3.md` | v3 完整架构交接 |
| `2-Projects/brain-product/PROPOSAL.md` | v2 方案（待更新） |
| `.claude/skills/mycc/scripts/src/` | mycc 后端源码 |
| `.claude/skills/mycc/scripts/src/adapters/` | 适配器目录（要加 API 直调） |
| `.claude/skills/mycc/scripts/src/services/context-loader.ts` | 记忆注入（已有） |
| `2-Projects/cc-remote-v4/` | cc-remote V4 全套 |
| `2-Projects/cc-remote-v4/Caddyfile` | Caddy 路由配置 |
| `2-Projects/cc-remote-v4/panel/` | 管理面板 UI |

---

## 九、SSH 信息

- **Mini**: `ssh rayman.chen@10.9.1.54`（密码 Hahaxiong83），Ollama :11434
- **Studio**: `ssh fu-121@10.9.1.155`（密码 1234），MLX :8000
- **cc-remote V4 公网**：`https://cli4.hahaxiong.cc/`
- **mycc 后端默认端口**：18080

---

## 十、关键决策记录

1. **云端 API 先行，不等本地模型** → 验证机制比优化成本重要
2. **复用 mycc 后端，不新建服务** → 已有 60% 能力（记忆注入、飞书、会话管理）
3. **Chat WebUI 挂在 cc-remote V4 下** → 复用公网通道 + 认证 + 暗色主题
4. **飞书用已有原生集成，微信用 OpenClaw ClawBot** → 不重复造轮子
5. **经验流前两周不做惊讶度评估，全量记录** → 避免冷启动校准问题
6. **v0 不做微调、不做日终编译** → 用数据说话，验证后再决定
