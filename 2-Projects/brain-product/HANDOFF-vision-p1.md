# HANDOFF: brain 视觉 P1 — 自进化基础设施

> P0 已完成（minicpm-v 语义 + 变化感知 + 历史 + look_at MCP）。
> 本次 P1 让 brain 视觉系统具备自进化能力：自适应扫描 + 记忆沉淀 + 行为模式学习。

---

## 三个并行子任务

### 子任务 A: 扫描频率自适应（Python daemon）

**目标**：无人时省 GPU，有变化时立即反应。

**改动文件**：`tools/vision/semantic_vision_daemon.py`（已是 v3）

**实现**：
1. 将固定 `args.interval`（15s）改为动态 interval：
   - `present=True` → 15s（有人，保持高频）
   - `present=False` → 60s（无人，省 GPU）
   - 检测到 `scene_changed` 或 `person_arrived/left` → 下次 sleep 设为 3s（立即重扫确认）
2. 在 main() 循环末尾，根据上一次的 present 和 change_event 计算 `next_interval`
3. debug 日志打印 interval 切换：`[semantic-vision] interval: 15s → 60s (person left)`
4. `semantic-status.json` 新增 `currentInterval` 字段

**关键约束**：
- `--interval` 参数保留，作为 present=True 时的基准值
- 不引入新依赖
- VERSION 保持 `semantic-vision-v3`（小改不升版本）

### 子任务 B: 视觉记忆沉淀（TS 新模块）

**目标**：高质量视觉观察自动写入 memory-items.md，接入已有记忆巩固管线。

**新建文件**：`src/services/visual-memory.ts`
**修改文件**：`src/server.ts`（启动时调用）

**实现**：

`visual-memory.ts` 核心逻辑：
1. 定时器（每 10 分钟执行一次）读取 `semantic-history-{today}.jsonl` 最近 40 条
2. 聚合统计：
   - 常见物品 top5（从所有 rawText 中用关键词提取，累计计数排序）
   - 在位时间段（连续 present=true 的起止时间）
   - 场景变化次数
3. 与 `data/visual-memory-last.json`（上次聚合结果）对比，如果有显著变化（新物品出现、在位模式变化），生成一条记忆
4. 写入 `data/memory-items-visual.md`（独立文件，不直接改 memory-items.md，由每日巩固合并）

记忆格式：
```markdown
## [visual]

- 川哥工位常见物品：双显示器、机械键盘、笔记本电脑、水杯、手机（2026-04-08 观察）
- 今日在位时段：09:30-12:15, 14:00-19:20，共约 8h（2026-04-08）
- 工位环境特征：白色墙壁、荧光灯照明、两把黑色网状椅（2026-04-08 观察）
```

`server.ts` 改动：在 `startVisualStatePolling()` 之后调用 `startVisualMemory(dataDir)`

**关键约束**：
- 用 `readFileSync` 同步读历史文件（与 visual-state 风格一致）
- 不引入 NLP 库，物品提取用预定义关键词列表
- 每日最多写入 5 条视觉记忆（防膨胀）
- 文件路径：`{dataDir}/visual-memory-last.json`（聚合缓存）+ `{dataDir}/../memory-items-visual.md`（记忆输出）

### 子任务 C: 行为模式学习（TS 脚本 + brain-api 注入）

**目标**：每日从视觉历史聚合用户行为模式，brain 回答时引用习惯数据。

**新建文件**：`scripts/daily-visual-digest.ts`
**修改文件**：`src/brain-api.ts`（formatEnvironmentHint 注入习惯）

**daily-visual-digest.ts 实现**：

独立可执行脚本（`npx tsx scripts/daily-visual-digest.ts`），由 scheduler 每日 04:30 调用。

1. 读取昨天的 `data/activity/semantic-history-{yesterday}.jsonl`
2. 聚合：
```json
{
  "date": "2026-04-08",
  "firstSeen": "09:32",         // 第一次 present=true
  "lastSeen": "19:18",          // 最后一次 present=true
  "totalPresentMinutes": 485,    // 总在位分钟数
  "presenceSegments": [          // 在位时段
    {"start": "09:32", "end": "12:15"},
    {"start": "14:02", "end": "19:18"}
  ],
  "topObjects": ["显示器", "键盘", "手机", "水杯", "笔记本"],  // 出现频率 top5
  "sceneChanges": 12,            // 场景变化次数
  "personArrivals": 3,           // 到达次数（含午休回来）
  "personDepartures": 3          // 离开次数
}
```
3. 追加到 `data/patterns/visual-digest.jsonl`（一天一行，滚动保留 30 天）
4. 计算 7 天滑动平均写入 `data/patterns/visual-habits.json`：
```json
{
  "updatedAt": "2026-04-08",
  "avgArrival": "09:45",
  "avgDeparture": "19:30",
  "avgPresentHours": 7.8,
  "typicalBreak": "12:15-14:00",
  "frequentObjects": ["显示器", "键盘", "手机", "水杯", "笔记本"],
  "daysAnalyzed": 7
}
```

**brain-api.ts 改动**：

在 `formatEnvironmentHint()` 中，如果 `data/patterns/visual-habits.json` 存在且 updatedAt 在 7 天内：
```
## 用户习惯（视觉学习）
- 通常到达: 09:45 | 通常离开: 19:30 | 日均在位: 7.8h
- 午休时段: 12:15-14:00
- 工位常见物品: 显示器、键盘、手机、水杯、笔记本
```

读取方式：启动时读一次 + 每小时刷新（不在热路径读文件）。

**关键约束**：
- 脚本用 `tsx` 执行（项目已有 tsx）
- 无新 npm 依赖
- visual-habits.json 不存在时优雅降级（不注入习惯信息）
- `data/patterns/` 目录不存在时自动创建

---

## 文件分工（三个 Agent 并行）

| Agent | 文件 | 子任务 |
|-------|------|--------|
| A（Python） | `tools/vision/semantic_vision_daemon.py` | 频率自适应 |
| B（TS 新模块） | 新建 `src/services/visual-memory.ts` + 改 `src/server.ts` | 视觉记忆沉淀 |
| C（TS 脚本+注入） | 新建 `scripts/daily-visual-digest.ts` + 改 `src/brain-api.ts` | 行为模式学习 |

文件无重叠，可安全并行。

## 不要改的文件

- `tools/vision/vision_daemon.py`
- `src/services/visual-gate.ts`
- `src/services/visual-state.ts`
- `src/mcp-entry.ts`

---

## Studio 部署

公网环境用 `studio-pub` SSH 别名（经 Mini 跳板）。

```bash
# Python
rsync -avz -e "ssh -o ProxyJump=mini-pub" tools/vision/semantic_vision_daemon.py studio-pub:~/mycc-brain/tools/vision/

# TS 源码
rsync -avz -e "ssh -o ProxyJump=mini-pub" \
  src/services/visual-memory.ts src/server.ts src/brain-api.ts \
  scripts/daily-visual-digest.ts \
  studio-pub:~/mycc-brain/src/services/ 2>/dev/null; \
rsync -avz -e "ssh -o ProxyJump=mini-pub" src/server.ts src/brain-api.ts studio-pub:~/mycc-brain/src/ ; \
rsync -avz -e "ssh -o ProxyJump=mini-pub" scripts/daily-visual-digest.ts studio-pub:~/mycc-brain/scripts/

# Build + restart
ssh studio-pub 'export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain && npx tsc && npx pm2 restart brain'

# 重启 semantic daemon
ssh studio-pub 'kill $(ps aux | grep semantic_vision | grep -v grep | awk "{print \$2}") 2>/dev/null; sleep 1; cd ~/mycc-brain && nohup tools/vision/.venv-vision/bin/python3 tools/vision/semantic_vision_daemon.py --data-dir data/activity --debug > data/activity/semantic-daemon.log 2>&1 &'
```

注意：公网通过 Mini 跳板，rsync 需要 `-e "ssh -o ProxyJump=mini-pub"`。如果 `studio-pub` 已配置 ProxyJump 则直接用。

---

## 验收标准

### 子任务 A: 频率自适应
1. daemon 日志显示 interval 在 15s/60s/3s 间切换
2. `semantic-status.json` 有 `currentInterval` 字段

### 子任务 B: 视觉记忆沉淀
3. `data/visual-memory-last.json` 有聚合数据
4. `data/memory-items-visual.md` 有 `## [visual]` 条目
5. `npm run build` 通过

### 子任务 C: 行为模式学习
6. 手动执行 `npx tsx scripts/daily-visual-digest.ts` 成功
7. `data/patterns/visual-digest.jsonl` 有数据
8. `data/patterns/visual-habits.json` 有 7 天平均
9. brain-api 注入习惯信息（curl 测试可见）

---

*创建时间：2026-04-08*
*规划人：cc (Claude claude-opus-4-6)*
