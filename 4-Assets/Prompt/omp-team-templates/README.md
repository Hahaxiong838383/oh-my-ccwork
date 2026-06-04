# omp Team 模式 prompt 模板（v3 高 stake/高难度专用）

> 用途：mycc team 模式 v3 的标准调用脚本,封装"A 双发实现"和"B 三发评审"两个核心动作
> 入参：cc 写好 `/tmp/p.md` (任务/AC) 和（可选）`/tmp/review.md` (评审内容),然后跑对应脚本
> 适用：自动触发条件 = 高 stake (认证/支付/迁移/事故/安全/不可回滚) 或 高难度 (>1000 行/跨子系统/并发/算法核心)
> 顶级触发：川哥手动说"大活/不能错" 或 cc 风险预警确认后 → 跑 `review-4send.sh` 加 B3 付费档

## 三个标准动作

| 脚本 | 用途 | 触发 |
|------|------|------|
| `code-2send.sh` | A 双发写码实现 (A1 grok-build + A3 omp gpt-5.5) | 高 stake/高难度 写码 |
| `review-3send.sh` | B 三发评审对抗 (B4 grok + B5 gpt + B2 gemini-pro) | 高 stake/高难度 评审,顶级评审第一阶段 |
| `review-4send.sh` | B 四发评审顶级 (上面三家 + B3 VPS proxy 3.5-flash) | **顶级**评审,川哥手动触发或 cc 预警确认 |

## 使用流程

```bash
# 1. cc 写好任务 prompt
cat > /tmp/p.md <<EOF
# 任务
实现 OAuth refresh token 自动轮换

# AC
- 凭据 5min 内失效自动刷新
- refresh 失败 retry 3 次
- 集成测试 100% 通过
EOF

# 2. A 双发实现 (写码)
bash 4-Assets/Prompt/omp-team-templates/code-2send.sh /path/to/repo /tmp/p.md

# 3. cc 综合 /tmp/a-grok.md vs /tmp/a-gpt.md, 挑优, 跑测试

# 4. cc 选定版本后, B 三发评审
git diff main..HEAD > /tmp/review.md
echo "评审角度: 找 bug + 安全问题 + 性能问题" >> /tmp/review.md
bash 4-Assets/Prompt/omp-team-templates/review-3send.sh /tmp/review.md

# 5. cc 综合 /tmp/r-grok.md + /tmp/r-gpt.md + /tmp/r-gem.md, 取并集去重, 标各家独有发现
```

## cc 综合三家评审的标准流程

```
1. 三家共识 finding → 高置信度,必修
2. 两家共识 finding → 中置信度,核验后修
3. 一家独有 finding → 低置信度,标"待验证",cc 跑测试或人工 review 验证
4. 三家都没说但 cc 看到的 → 补充进 REVIEW.md
```

## 失败模式 + 降级

- omp 进程崩 → 切对应 CLI 直调 (grok / codex / gemini)
- 凭据 refresh 失败 → 重跑对应 `4-Assets/SOP/omp-*-bypass-import.sh`
- B3 VPS proxy 不可达 → 降级到 B2 gemini-3.1-pro (omp 路径)

## 关联

- v3 路由全文: `multi-agent/RULES.md`
- omp 接入手册: `~/.claude/projects/.../memory/project_omp_grok43.md`
- 引擎对照表: `~/.claude/rules/engine-routing.md`
