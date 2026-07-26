# HANDOFF · F6a 进化管线接快照回滚（2026-07-27 凌晨交接）

> 上下文：penguin-harness 调研报告 §22（自我提升循环）落地第一步。
> 报告在 `1-Inbox/2026-07-26-penguin-harness调研报告.md`（该目录被 gitignore，本地文件）。
> 前置已完成：F1 轨迹层 / F2 skills / F3 定时任务 / F4 配置快照，均已上生产并经川哥真机验收。

## 目标（川哥拍板，半天量级，纯接线不引入新概念）

给 H 现有的自进化管线补上「安全网 + 版本化」这两件，顺手修掉盘出来的两个现患：

1. **apply 前打快照、eval 不过自动回滚** —— 现在 `apply.mjs` 只做单文件
   `lineage/<basename>.<ts>.bak`，eval 失败仅 `console.error` 提示「consider
   lineage rollback」，**fail-soft 继续**，没有自动回滚。
2. **提案按内容 hash 去重** —— 现在按 `status:applied` 去重，**同一条提案已实证
   被 apply 了两次**（`workspace/evolve/applied/` 有 6 个文件 = 3 角色 × 2 轮，
   2026-07-21 与 07-22 各一次），PROMPT 里叠了两遍同款补丁、单调膨胀稀释注意力
   （advisor 自己的 cons 里都承认这点）。

## 第一个设计决策（动手前先定，别直接写代码）

**F4 的 `lib/config-snapshot.mjs` 不能直接复用**——它的白名单是**用户树配置面**
（`/srv/h-platform/users/<uid>/` 下的 SOUL.md、两个引擎的 AGENTS.md、skills），
而 evolve 改的是 **owner 侧的三个 PROMPT.md**（已核实真实路径）：

| 角色 | 主文件 | 种子镜像 |
|---|---|---|
| leader | `workspace/leader/PROMPT.md` | `prompts/leader/PROMPT.md` |
| pm | `workspace/PROMPT.md` | `prompts/pm/PROMPT.md` |
| ai | `prompts/ai/PROMPT.md` | `prompts/ai/PROMPT.md` |

（相对 `~/feishu-grok-bridge/`，见 `scripts/evolve/apply.mjs:28-31,93-96`）

**建议方案：把 config-snapshot.mjs 参数化**，抽成
`createSnapshotStore({ root, files, dirs, snapDir })` 返回
`{ maybeSnapshot, restoreSnapshot, listSnapshots, janitorResidue }`，两套白名单
共用同一套原子/安全逻辑。**这么做的核心理由**：F4 那三个 critical 的修复
（目录根 lstat + realpath 双检、per-root 互斥、排除项搬回、janitor、回滚失败
上抛）都在这套逻辑里，另起一套等于把三个坑重踩一遍。

风险可控：19 项单测 + 真机 E2E 脚本可复跑（脚本在 scratchpad，需要时重写一份，
内容见项目记忆 F4 节）。重构后必须两套白名单都跑一遍再上线。

若判断参数化代价过高，退路是 evolve 侧只用「tar + tmp/rename + meta」的最小
子集，但**必须显式记录放弃了哪几道防线**，别默认没事。

## 待完成清单

- [ ] 决策并实施快照模块参数化（或退路方案）
- [ ] `scripts/evolve/apply.mjs`：改动前打快照 → append 补丁 → 跑 eval-skills →
      **不过则自动 restore 回快照**（现在是 fail-soft 只打印）；保留 lineage/.bak
      不动（两层保护不冲突）
- [ ] 提案去重：按**正文内容 hash**判定是否已应用，而非只看 frontmatter 的
      `status:applied`；`bridge.mjs` 的「应用提案」批量路径（最多 3 份）同样要过
      这道去重
- [ ] 回归：`applied/` 里已叠加两遍的补丁要不要清理？（**先问川哥**，涉及改
      owner 的 PROMPT 正文，属不可逆内容变更，不自行决定）
- [ ] 测试：apply 失败自动回滚、同内容提案第二次被拒、快照模块两套白名单各跑一遍
- [ ] 全链 `npm test` + 重启 + healthz；owner 侧真机发一句「评估进化」验证链路没坏

## 关键文件（全在 dev198 `~/feishu-grok-bridge/`）

- `scripts/evolve/apply.mjs` —— 改动主战场（backup:41-54 / appendFile:56-68 /
  补丁提取与镜像:78-99 / eval fail-soft:118-132）
- `scripts/evolve/eval-skills.mjs` —— 现状是纯静态 lint（8 项存在性检查，
  头注释自认 no network）。**F6a 不动它**，换真跑评估器是 F6b。
- `bridge.mjs` —— `handleEvolveDecision`（775-870，批量 apply ≤3 份、按 status 去重）
- `lib/config-snapshot.mjs` —— F4 模块，参数化改造对象
- `workspace/evolve/` —— 产物目录（applied/ lineage/ proposals/ friction.jsonl）

## 纪律提醒（这一夜踩过的）

- **owner 零影响**：evolve 是 owner 专属链路，但凡新增命令词/触发词，未命中分支
  必须 **fall-through 不消费**，不能「回一句拒绝」——回拒绝也是吞掉消息。
- **改白名单按「引擎 × 配置载体」矩阵过一遍**，别凭印象列（F4 就漏了
  `workspace/AGENTS.md` 这个 omp 托管块，是审查抓出来的）。
- **自动回滚的口径不能撒谎**：回滚本身失败时必须改口径告警，不能一边残留
  半新半旧一边说「配置未动」（吞错红线变体）。
- 高风险面（数据不可逆/并发/安全）值得跑一次对抗 review，配方见
  `[[feedback_adversarial_review_for_highrisk_code]]`。

---

## 可粘贴提示词（下个 session 直接用）

```
开工 F6a。交接文档在 ~/mycc/tasks/h-platform-f6a.md，先读它。

目标：H 自进化管线接上安全网——apply 前打快照、eval 不过自动回滚、提案按内容
hash 去重（同一条提案已实证被 apply 两次）。

第一个决策点在文档里写了：F4 的 config-snapshot.mjs 白名单是用户树配置面，而
evolve 改的是 owner 侧三个 PROMPT.md，需要先定「参数化复用」还是「另起一套」。
先给判断再动手。

已有代码：dev198 ~/feishu-grok-bridge/scripts/evolve/（六件套）+ lib/config-snapshot.mjs。
清理 applied/ 里已叠加两遍的补丁属不可逆内容变更，先问我别自己动。
```
