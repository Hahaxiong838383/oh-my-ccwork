# omp Team 模式 prompt 模板（v3 高 stake/高难度专用）

> 用途：mycc team 模式 v3 的标准调用脚本,封装"A 双发实现"和"B 三发评审"两个核心动作
> 入参：cc 写好 `/tmp/p.md` (任务/AC) 和（可选）`/tmp/review.md` (评审内容),然后跑对应脚本
> 适用：自动触发条件 = 高 stake (认证/支付/迁移/事故/安全/不可回滚) 或 高难度 (>1000 行/跨子系统/并发/算法核心)
> 顶级触发：川哥手动说"大活/不能错" 或 cc 风险预警确认后 → 跑 `review-4send.sh`（真四发 B4+B5+B1+B3；B3 = 免费 antigravity gemini-3.5-flash，2026-06-17 复活）

## 四个标准动作

| 脚本 | 用途 | 触发 |
|------|------|------|
| `code-2send.sh` | A 双发写码实现 (A1 grok-build + A3 codex: 双网关 gpt-5.5 链→omp 订阅 gpt-5.4 兜底) | 高 stake/高难度 写码,要两个方案对比挑优 |
| `code-patch.sh` | **路 C 高质量写码** (codex 出 Search/Replace 块 → `apply-blocks.py` 确定性落盘 → cc 测试判官) | 已知目标、要高质量落地的高风险/跨≥3文件/核心路径写码 |
| `review-3send.sh` | B 三发评审对抗 (B4 grok + B5 codex: 双网关 gpt-5.5 链→omp 订阅 gpt-5.4 兜底 + B1 **antigravity** gemini-3-flash) | 高 stake/高难度 评审,顶级评审第一阶段 |
| `review-4send.sh` | B 四发评审 (B4 grok + B5 codex + B1 gemini-flash + **B3 antigravity gemini-3.5-flash 免费深度档**) | **顶级**评审,川哥手动触发或 cc 预警确认 |

> ⚠️ **评审脚本(review-3/4send)只读硬约束**(2026-06-17 事故后): 所有引擎 lane 跑 `--no-tools`(禁所有内置工具,纯文本评审) + `--cwd` 干净临时目录(避免加载 mycc/AGENTS.md 误把 grok/gemini 署名成 codex)。起因: 一次评审中 gemini lane 带 `--auto-approve` 擅改了用户生产配置。写码脚本(code-2send/code-patch)保留写权限。

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

## 路 C 高质量写码流程 (`code-patch.sh` + `apply-blocks.py`)

> 2026-06-17 team 三发评审收敛。解决"单个弱模型(grok-build)agentic 直写、质量无下限"问题。
> 核心: **强脑(codex)出块 + 无失真的手(脚本)落盘 + 独立判官(测试)**,三者解耦,写码者≠落盘者≠判官。

**为何不是 codex agentic 自己写(路 A)**: codex 订阅是只读沙箱不能写(栽 3 次);网关重 reasoning 非流式必 524。路 C 绕开这些基建坑。
**为何不是 unified diff**: AI 出的 diff 因行号/空格漂移,`git apply` 成功率评审实测 <40%。改用 **Search/Replace 块**(Aider 范式),按内容精确匹配,不依赖行号。

**四步流程**:
1. **验收单**(cc/川哥): 写极简 spec(目标/非目标/验收点) + 相关代码上下文。无测试框架的项目降级为"可执行验证命令/手测清单"(不强制 TDD)。
2. **块产出**(codex): `code-patch.sh` 调 codex(`CODEX_LANE_NO_TOOLS=1` 只出文本不碰文件)出 Search/Replace 块。
3. **确定性落盘**(脚本): `apply-blocks.py` 精确匹配替换 + **原子写**(任一块匹配失败则零写入)。cc 不手改落盘逻辑。
4. **判官**(cc): 跑测试/验收门; RED → 把失败回传 codex 重出块(**熔断≤2 次**); 超限降级"cc 接手+外部 diff 审"(标签改为非路 C)。高风险(认证/支付/迁移/不可逆)再加另一引擎审实际落盘 diff。

**用法**:
```bash
# cc 准备 spec(含目标文件现有片段,供 codex 出准 SEARCH 段)
bash 4-Assets/Prompt/omp-team-templates/code-patch.sh /path/to/repo /tmp/spec.md
# 失败块零写入,报告 failed 列表 → cc 拼回传包让 codex 重出; 成功则 git diff 核验 + 跑测试
```

**Search/Replace 块格式**(codex 输出 / `apply-blocks.py` 解析):
```
FILE: 相对仓库根的路径
<<<<<<< SEARCH
<目标文件中逐字符精确存在、且唯一的原文片段;新建文件则留空>
=======
<替换后的新内容>
>>>>>>> REPLACE
```

**诚实边界**: 保证功能正确性下限(测试覆盖内)+ 无落盘失真; **不**保证测试外逻辑、设计优雅度、块一定能匹配(匹配不上失败回传,绝不硬写)。

## codex lane 路由 (A3/B5,见 `_codex_lane.sh`)

四级降级链(三网关,2026-06-16 主次重排——网关1 曾 403 已修复,维持垫底):

- **① 网关2 主路**: `curl` `https://cc-sub2.whtaibang.top/v1` (黎夏) `gpt-5.5` + `reasoning_effort=high` + **`stream:true` 流式**,**直连**(强制 `--noproxy` + unset proxy)。⚠️ 其 WAF 拦 Python-urllib UA(curl/Bun/node/codex UA 放行);`/responses` 不认 `max_output_tokens`
  - ★ **为何流式**:网关在 Cloudflare 后,源站 ~100s 不响应回 **HTTP 524**。非流式重 reasoning 任务憋满 ~125s 必 524 卡死;流式持续吐 SSE 字节刷新 CF 空闲计时器绕过。`--connect-timeout 15` + `--max-time 900` 硬上限 + 截断抢救兜底
- **② 网关3 第一降级**: `curl` `https://api-direct.hahaxiong.top/v1` (川哥日本自建 CLIProxyAPI,聚合 team+gemini+grok) `gpt-5.5`。2026-06-16 实测最快最稳(轻请求 1.75s),自建可控
- **③ 网关1 垫底**: `curl` `https://10521052.xyz/v1` (cc-switch 同款) `gpt-5.5`。2026-06-16 曾突发 403「无权访问 20X专用通道分组」(账号被移出分组,非限流),同日川哥修复恢复 200;维持垫底兜底,需要时可升主。曾是主路(6 轮综合微胜)
- **④ 订阅兜底**: API 链全失败自动切 `omp -p --model openai-codex/gpt-5.4` (ChatGPT 订阅 OAuth,独立路径;订阅 5.5 常卡死故用 5.4)
- **key**: 存 `~/.gateway.env` 的 `CODEX_API_GATEWAY_KEY`(网关1) / `CODEX_API_GATEWAY2_KEY`(网关2) / `CODEX_API_GATEWAY3_KEY`(网关3) (chmod 600,home 目录不入 git)
- **自测旋钮**: `CODEX_FORCE_FALLBACK=1`(直达订阅) / `CODEX_SKIP_GW1=1`(跳过垫底网关1,省一次往返)
- 注: curl 主路是「prompt→文本」对话(非 agentic 改 repo),team 产出本就是文本交 cc 综合,无损

## 失败模式 + 降级

- omp 进程崩 → 切对应 CLI 直调 (grok / codex / gemini)
- 凭据 refresh 失败 → 重跑对应 `4-Assets/SOP/omp-*-bypass-import.sh`
- B3 antigravity (`google-antigravity/gemini-3.5-flash`) 失败 → ① 确认 xray 在跑 (`pgrep -fl 'xray run'`) ② `grep cloudcode ~/xray/access.log | tail` 确认走 `Gemini专用-US2` 节点(非美宅,否则 Google 判 400) ③ 缺 B3 不阻塞,按三发综合。详见 memory `project_antigravity_team_b3`
- 旧 B3 VPS proxy 付费档(Vertex AI `23.226.135.149:4000`)保留作备用,已被免费 antigravity 取代

## 关联

- v3 路由全文: `multi-agent/RULES.md`
- omp 接入手册: `~/.claude/projects/.../memory/project_omp_grok43.md`
- 引擎对照表: `~/.claude/docs/engine-ops.md`
