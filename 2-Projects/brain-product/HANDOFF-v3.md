# mycc-brain v3.0 方案设计 — 交接文档

> 创建时间：2026-04-02 14:30 | 创建者：cc (Claude Opus 4.6)
> Session：PROPOSAL v2 二次评审 → v3 架构修正 → 硬件验证 → 横向竞品对比

---

## 一、已完成的工作

### 1. PROPOSAL.md 二次评审 + 发散思考
- 考察了 4 种替代路线（编译器模型、对比学习、免疫系统、遗传编程），确认当前方案近最优
- 新增 2 个增强：日终整理定位为「经验编译器」+ 经验流增加 contrast 对比字段
- 发现 5 个遗漏风险 + 2 个逻辑漏洞

### 2. v3 两次关键架构修正
- **修正 1**：微调模型必须回到生产链路（不是训练完搁置），接管 3 个位置（生存模式主力 + 惊讶度评估 + 简单编译）
- **修正 2**：brain 是日常入口（不是后台辅助），交互入口包括微信(OpenClaw iLink)/飞书(SDK)/Web(mycc.dev)/语音(MiGPT)/视觉(cc-eye)/CLI，CC 降级为开发调试工具

### 3. 硬件探测 + 模型部署方案
- SSH 连接 Studio (M2 Max 32GB) 和 Mini (M4 32GB)，确认硬件规格
- 读取了 Qwen3.5-27B-4bit 评测报告（86.4% 准确率，19.5 tps）
- 确定部署方案 B：Mini 做生产主力 + Studio 做微调工坊
- **Mini Ollama 已升级到 0.19.0（MLX 后端），预期 decode 速度翻倍**

### 4. 横向竞品对比
- 8 个系统 × 7 维度矩阵（Mem0/Letta/EvoAgentX/AIOS/CC/LangGraph/Superpowers）
- OpenClaw vs Harness V2 vs v3 重新定位
- DSPy/Inspect AI 路线降级为可选增强

### 5. 飞书文档更新
- v3 方案文档：https://futurus.feishu.cn/wiki/ZsHzwguLQicQ1IkO0s3cFZ36ntc（已用 v3 架构重写 + 追加竞品对比附录）
- 二次评审文档：https://www.feishu.cn/wiki/EZcJwROQYiF9S0kNLmiclb9anbb（第一份飞书文档，v2 阶段产出）
- 本地 PROPOSAL.md 已更新为 v2（需要再更新为 v3）

---

## 二、v3 核心架构共识

### 2.1 定位
**个人认知 OS + 自进化闭环，brain 是日常入口，本地模型是日常伙伴，CC 是开发工具。**

### 2.2 端到端闭环
```
你（多端）→ brain 机制层 → 本地 cc-v{N} → 回复
                ↓ 自动
          经验流写入（含 contrast 对比对）
                ↓ 每晚
          日终编译器 → 记忆更新 + SFT/DPO 数据
                ↓ 月级
          Studio QLoRA 微调 → cc-v{N+1}
                ↓ 部署回 Mini
          替换生产模型 → prompt 压缩 → 飞轮加速
```

### 2.3 硬件
| 设备 | 角色 | 状态 |
|------|------|------|
| Mini M4 32GB (10.9.1.54) | 生产主力（brain 服务 + cc-v{N} + 4B 惊讶度） | Ollama 0.19 MLX ✅ |
| Studio M2 Max 32GB (10.9.1.155) | 微调工坊（QLoRA 训练） | MLX 已装，需下载 14B 基座 |
| Air M5 32GB | 开发机（CC） | 当前在用 |

### 2.4 交互入口
微信(OpenClaw iLink) / 飞书(SDK/lark-cli) / Web(mycc.dev) / 语音(MiGPT) / 视觉(cc-eye) / CLI / CC(辅助)

---

## 三、待完成 / 待评审

### 待评审（下个 session 重点）
1. **v3 架构完整性**：brain 服务骨架设计是否遗漏关键环节？
2. **经验流 schema**：contrast 字段设计是否够用？还需要什么字段？
3. **微调闭环的可行性**：14B QLoRA 在 Studio M2 Max 上的训练速度预估？50 条 SFT 够不够验证？
4. **多端入口优先级**：7 个入口，Phase 1 先接哪几个？
5. **日终编译器的 prompt 设计**：编译器的 system prompt 怎么写？输出格式怎么约束？
6. **风险应对是否充分**：惊讶度校准、灾难性遗忘、存储膨胀的应对方案是否够具体？

### 待实施（确认后执行）
| 优先级 | 任务 | 预计工作量 |
|--------|------|-----------|
| P0 | brain HTTP API 骨架（Mini 常驻服务） | 2 天 |
| P0 | 接入 mycc web（手机端） | 1 天 |
| P0 | 经验流 JSONL schema + 写入逻辑 | 0.5 天 |
| P0 | hot-patches 机制（纠正即时生效 + contrast） | 1 天 |
| P1 | 接入飞书机器人 | 1 天 |
| P1 | 接入微信（OpenClaw iLink） | 1 天 |
| P1 | 惊讶度评估（4B few-shot） | 1 天 |
| P2 | 日终编译器脚本（DeepSeek API） | 2-3 天 |
| P3 | SFT 数据转换 + 首次微调验证 | 2-3 天 |

### 待决策
1. **PROPOSAL.md 是否需要更新到 v3**？（当前本地文件是 v2，飞书文档已是 v3）
2. **Studio 磁盘 23GB 紧张**——是否需要清理或外接存储？

---

## 四、关键文件

| 文件 | 说明 |
|------|------|
| `2-Projects/brain-product/PROPOSAL.md` | 本地方案文档（v2，需更新到 v3） |
| `2-Projects/brain-product/HANDOFF.md` | 上一个 session 的交接文档（v1→v2 讨论） |
| `2-Projects/brain-product/HANDOFF-v3.md` | **本交接文档（v2→v3 评审 + 硬件 + 竞品）** |
| `2-Projects/qwen-eval/report_20260402_1137.md` | Qwen3.5-27B-4bit 评测报告 |
| 飞书 v3 方案 | https://futurus.feishu.cn/wiki/ZsHzwguLQicQ1IkO0s3cFZ36ntc |
| 飞书二次评审 | https://www.feishu.cn/wiki/EZcJwROQYiF9S0kNLmiclb9anbb |
| 飞书选型分析 | https://futurus.feishu.cn/wiki/W4XJwr7ZXiyOZwkJOEqceO00nCL |

---

## 五、SSH 信息（供下个 session 使用）

- **Studio**: `ssh -o StrictHostKeyChecking=no fu-121@10.9.1.155`（密码 1234），MLX :8000
- **Mini**: `ssh -o StrictHostKeyChecking=no rayman.chen@10.9.1.54`（密码 Hahaxiong83），Ollama 0.19 :11434
- 两台通过雷电直连 192.168.100.2

---

## 六、本次讨论的关键洞察

1. **brain 是入口，不是后台**——日常高频交互应该直接走 brain + 本地模型，CC 只是开发工具
2. **微调不是目的，回到链路才是**——cc-v{N} 必须部署回 Mini 替换旧模型，接管 3 个位置
3. **对比对比单点记录值钱 10 倍**——用户纠正自带 DPO 信号，必须保存错误版本
4. **日终整理 = 经验编译器**——输出 6 种编译产物，不只是记忆更新
5. **规则应该趋于收敛**——周期循环加入压缩合并，防止膨胀
6. **Ollama 0.19 MLX 后端已就绪**——Mini 升级完成，decode 速度预期翻倍
