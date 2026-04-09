# Brain 进化闭环：Baseline 重建 + 精确率调优

## 背景

进化闭环已全线接通（2026-04-08），eval + Gemini Judge + evolution-log 完整跑通。但当前 eval 结果 vs 旧 baseline 显示回归，原因是：

1. **baseline 过时**：旧 baseline 是 4/3 用原生 Gemini API 打的，现在换了 Gemini Proxy（litellm），评分基准有偏移
2. **Claude 记忆注入导致精确率下降**：新增 585 条 claude-memory-sync 条目，检索范围扩大，精确率从 0.90 降到 0.41
3. **faithfulness 下降**：记忆条目增多后，注入的噪声信息也增多，LLM 回复可能引用了不相关的记忆

## 任务清单

### Task 1: 重建 Baseline（用当前 Proxy Judge）

**目标**：用当前的 Gemini Proxy Judge 重打 baseline，消除因 Judge 切换导致的虚假回归。

**步骤**：
1. SSH 到 Mini：`ssh mini`
2. `cd ~/mycc/2-Projects/brain-product/mycc-brain`
3. 备份旧 baseline：`cp eval/baseline.tsv eval/baseline-old-native-gemini.tsv`
4. 将当前最新的 eval TSV 设为新 baseline：`cp eval/eval-2026-04-08T05-12-33.tsv eval/baseline.tsv`
5. 验证：`head -1 eval/baseline.tsv` 确认表头格式正确

### Task 2: 调优 Claude 记忆转换的精确率

**目标**：减少 claude-memory-sync 产生的噪声条目，提升检索精确率。

**关键文件**：`src/services/claude-memory-sync.ts`（在 Studio 部署，源码在 Air）

**问题分析**：
- 当前 585 条 Claude 记忆条目中很多是长段落的实现细节（GAP 代码描述、commit 历史等），对日常问答检索价值低
- brain-context.ts 的 TF-IDF 匹配会命中这些低价值条目，拉低精确率

**优化方向**：
1. **段落过滤**：在 `splitIntoParagraphs()` 中跳过代码块（```）、表格（|--|）、commit hash 等技术细节段落
2. **长度限制**：单条 item content 超过 150 字的截断或跳过（当前上限 200 字）
3. **星级降权**：project 类记忆从 ★★ 降为 ★，减少在 TF-IDF 排序中的权重
4. **namespace 细分**：把 `project/claude-cc` 按文件名进一步拆分（如 `project/claude-brain`、`project/claude-infra`），避免所有 project 记忆挤在一个 namespace 里

**验证方式**：
```bash
# Air 上编译检查
cd ~/mycc/2-Projects/brain-product/mycc-brain && npx tsc --noEmit

# 部署到 Studio
bash deploy.sh

# Mini 上跑 dry-run 检查精确率变化
ssh mini 'source ~/.nvm/nvm.sh && cd ~/mycc/2-Projects/brain-product/mycc-brain && \
  export ADMIN_USER=admin ADMIN_PASS="Hahaxiong83*#" NO_PROXY="10.9.1.155,23.226.135.149,localhost,127.0.0.1" && \
  npx tsx src/eval/eval.ts --dry-run 2>&1' | grep "精确率"
```

### Task 3: 确认 Evolution 自改进能消费 eval 结果

**目标**：确认 Studio 上 07:00 的 scheduleEvolution() 能读到新的 eval 结果并触发自改进。

**步骤**：
1. eval 结果在 Mini 的 `~/mycc/2-Projects/brain-product/mycc-brain/data/evolution-log.jsonl`
2. sync-data.sh 每 15 分钟将 Mini 的 evolution-log 推到 Studio（但当前只推 0-System 和 claude-memory，没推 brain data）
3. **需要检查**：Studio 的 evolution 读的是哪个 evolution-log？如果是 Studio 本地的 `~/mycc-brain/data/evolution-log.jsonl`，那 Mini 的 eval 结果需要同步过去
4. 如果没有同步通道，在 Mini 的 `sync-data.sh` 中增加一条：
   ```bash
   do_sync "$HOME/mycc/2-Projects/brain-product/mycc-brain/data/evolution-log.jsonl" "mycc-brain/data/evolution-log.jsonl"
   ```

## 关键凭据（已配置，直接使用）

| 凭据 | 位置 | 用途 |
|------|------|------|
| ADMIN_USER/PASS | run-eval.sh | eval 调 admin API |
| GEMINI_PROXY_KEY | run-eval.sh | Gemini Judge |
| brain .env | Studio ~/mycc-brain/.env | brain 服务配置 |
| lark-cli | Mini ~/.lark-cli/ | 飞书通知（file:// 模式） |

## 当前 eval 指标快照（2026-04-08）

```
retrieval: hitRate=0.981, precision=0.412
generation: relevance=3.63, precision=2.68, faithfulness=2.38,
            completeness=3.44, safety=4.11, creative_freedom=3.75,
            adversarial_resist=4.20
```
