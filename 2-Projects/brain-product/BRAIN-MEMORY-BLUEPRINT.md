# Brain 多模态记忆系统蓝图

> 沉淀时间：2026-04-04
> 来源：cc + 川哥对话规划

---

## 核心目标：同构异体

brain (Studio) 和 mycc (Air) 共享相同的记忆架构和机制，但各自维护独立的记忆内容。
类比：人类大脑生理结构一样，记忆内容不同。

**约束**：brain 机制最多落后 Air 一两个版本。

---

## 一、架构定位

brain 不是独立的记忆系统，是 mycc 记忆架构的 TypeScript 实现。

```
memory-spec.md（单一真相源，版本化）
      │
  ┌───┴───┐
  │       │
Air mycc  Studio brain
提示词实现  TypeScript 实现
CLAUDE.md  services/*.ts
独立记忆    独立记忆
```

---

## 二、五维对齐验证

| # | 维度 | 验证问题 |
|---|------|---------|
| 1 | 摄入 | 同一段对话，两边提取出的原子事实是否一致？ |
| 2 | 存储 | 格式（命名空间/星级/#base/Δ/时间戳）是否一致？ |
| 3 | 矛盾检测 | 新事实+已有记忆，冲突判定和处理是否一致？ |
| 4 | 检索 | 同一 query，返回的类别和条目是否一致？ |
| 5 | 遗忘/巩固 | 同组记忆经过时间衰减后，保留/归档/删除是否一致？ |

**验证手段**：Eval 驱动合规测试（tests/memory-spec/），用例先行代码后跟。

---

## 三、当前差距（brain vs Air v5.6）

| 机制 | Air (已有) | Brain (当前) | 差距 |
|------|-----------|-------------|------|
| 摄入 | 六维度扫描 + LSTM 实时写入门 | 关键词「记住」触发 | 大 |
| 存储 | memory-items.md (#base/Δ/supersedes) | user-memories.jsonl (扁平) | 大 |
| 矛盾检测 | 写入时实时三步法 (ASMR) | 无 | 大 |
| 检索 | 四路 RRF + 因果链扩展 | 四路 RRF (已有) + user-memory 简单匹配 | 中 |
| 遗忘 | eventDate/90d/120d + Δ≥3巩固 | 无 | 大 |
| 自进化 | experience → diagnosis → auto-fix | 已有（同） | 小 |
| Profile | 每周自动重建 user-profile.md | 无 | 中 |

---

## 四、实施路线

### Phase 1: 规范抽取（文档）
- 从 `docs/memory-system.md` 抽取 `docs/memory-spec.md`
- 机制描述与执行指令分离
- 加版本号

### Phase 2: brain 实现规范（TypeScript）

| 模块 | 对应 spec | 改造 |
|------|----------|------|
| `memory-store.ts` | 存储格式 | 新建：读写 memory-items.md，支持 #base/Δ |
| `intake.ts` | 摄入规则 | 重写：LLM 六维度自动提取（替换 tryAutoSaveMemory） |
| `contradiction.ts` | 矛盾检测 | 新建：写入时三步法 |
| `consolidation.ts` | 遗忘与巩固 | 新建：定时任务 |
| `brain-context.ts` | 检索策略 | 小改：加因果链 + hitCount |
| `profile-builder.ts` | Profile | 新建：每周重建 |

### Phase 3: 版本同步机制
- brain 启动时检查 spec 版本
- 落后时在 Admin UI 进化面板显示警告
- 新增 eval 用例 → brain 跑测 → 红色=待适配

### Phase 4: 多模态感觉适配器

| 适配器 | 输入 | 状态 |
|--------|------|------|
| ChatAdapter | 用户打字 | 已有 |
| VisionAdapter | cc-eye 摄像头 | 已有 cc-eye V3 |
| AudioAdapter | 麦克风 → Whisper STT | 待建 |
| SpeechAdapter | TTS 输出 | 已有 TTS 缓存 |
| AmbientAdapter | 智能家居状态 | 已有 cc-lite |

所有适配器产出统一 SensoryEvent → transcript 文本 → 进入同一条摄入管道。

### Phase 5: 元记忆层 (HOT)
- brain 知道自己知道什么（MemoryMeta）
- 空检索记录 = 知识空白
- 主动学习：命中率低时主动询问

---

## 七、最终方案：规则驱动，而非代码驱动（2026-04-04 确认）

> 关键转折：不把记忆规则翻译成 TypeScript 代码，而是让 brain 的 LLM 直接读同一份规则文档执行。

### 为什么

| 对比 | TypeScript 实现（旧方案） | LLM 规则驱动（新方案） |
|------|-------------------------|---------------------|
| 同步成本 | Air 改规则 → 手动改 TS → 跑 eval | Air 改规则 → 自动生效 |
| 开发量 | 6 个新模块 | 1 个 post-hook + 1 个 scheduler |
| 版本落后 | 每次 Air 升级都要适配 | 零落后 |
| 灵活性 | 硬编码 | 改文本即调整 |

### 架构

```
用户消息 → brain-context.ts 检索 → 主模型回复用户
                                      ↓ 异步
                          [post-hook: 记忆处理模型]
                          prompt = memory-rules.md + 对话
                          输出 JSON：{facts, keywords, dimension}
                                      ↓
                          写入 data/memory-items.md

                          [每日 04:00: 巩固模型]
                          prompt = memory-rules.md + 全量 items
                          任务：矛盾检测 + Δ巩固 + 过期清理
```

### 规则共享

```
mycc/docs/memory-rules.md ← 单一真相源（Git）
  ├── Air: CLAUDE.md include
  └── Brain: post-hook 读取作为 prompt
```

### LLM 选型

#### 可插拔接口设计

brain 的记忆 LLM 不绑定具体模型，通过配置切换：

```typescript
// config.ts 中新增
memoryLLM: {
  intake: { provider: "ollama", model: "qwen2.5:7b" },      // 每轮对话后提取
  consolidation: { provider: "dashscope", model: "qwen3.5-27b" }, // 每日巩固
}
```

provider 可选：`ollama`（本地）、`dashscope`（通义）、`deepseek`（DeepSeek API）。
任何场景的模型都可以独立替换，不影响其他场景。

#### 推荐配置

| 场景 | 推荐模型 | 位置 | 理由 |
|------|---------|------|------|
| **对话后事实提取** | qwen2.5:7b | Studio 本地 Ollama | 中文强、30tok/s快、零成本、4.7GB不影响主模型 |
| **每日巩固/遗忘** | qwen3.5-27b | DashScope API | 矛盾检测需强推理、每日1次成本可忽略 |
| **降级/备选** | qwen2.5:14b | 可安装 | 提取质量不够时升级，多占4GB |

**不推荐 gemma4:26b**：中文指令跟随弱（已验证），且 16GB 内存压力大。

#### 降级策略

| 风险 | 降级 |
|------|------|
| 本地模型提取质量不够 | config 切到 qwen2.5:14b 或 API |
| API 不可用 | 巩固延迟到下一天 |
| 内存不够并行 | 等主模型空闲后串行 |

---

## 八、实施路线（更新）

| Phase | 做什么 | 工作量 |
|-------|--------|--------|
| **P0** | 从 memory-system.md 抽取 `memory-rules.md` | 0.5h |
| **P1** | post-response hook + memory-items.md 读写器 | 1 session |
| **P2** | 每日巩固 scheduler（矛盾检测 + 遗忘） | 0.5 session |
| **P3** | Admin UI 记忆面板（可视化 items + 健康度） | 1 session |
| **P4** | 多模态 adapter 接入 | 按需 |

---

## 五、与意识理论的映射

| 理论 | 在记忆系统中的体现 |
|------|-------------------|
| GWT | 所有模态统一为文本后进入同一检索空间 |
| HOT | 元记忆层：知道自己的记忆状态和空白 |
| IIT | 矛盾检测 + 因果链：新旧记忆的一致性 |
| RPT | 检索→命中→hitCount++→晋升 的循环反馈 |
| AST | 摄入门控 = 注意力选择模型 |
| PP | 空检索 = 预测误差；主动学习 = 误差最小化 |

---

## 六、关键设计原则

1. **不重复造轮子**：brain 实现 Air 已验证的机制，不发明新机制
2. **用例先行**：每次 Air 升级记忆 → 先写 eval 用例 → 再适配 brain 代码
3. **读共享写独立**：brain 可读 Air 的记忆副本作为参考，但写入只写自己的
4. **文本统一**：所有感觉模态转为文本后处理，记忆层不存原始多媒体
5. **NAS 不是依赖**：NAS 只做备份，brain 机制不依赖 NAS 同步
