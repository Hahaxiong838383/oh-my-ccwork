# DEPLOY-LOG · companion-kg 语义层上机（公司侧 p003-voice）

> 2026-07-13 · 执行 cc · 川哥拍板：直接公司侧生产验证，回滚可达为硬约束。

## 改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/companion-kg.ts` | 新增 | L_companion 模块：语义 top3 + 触发词重排 + 阈值 0.47，interim 预热，三层降级 |
| `src/pipeline.ts` | 修改 +15/-3 | ① onPartial 挂 prewarm ② final 区算 companionGuardrail（K12/AI 启蒙命中时跳过）③ assembleSystemPrompt 第 8 参 ④ chat.trigger 传 companionSync=true |
| `src/prompt-orchestrator.ts` | 修改 +7/-1 | 第 8 参 companionGuardrail；互斥链 curriculum > aiLiteracy > companion；尾部人设锚点条件纳入 companion |
| `assets/companion-kg/slice-zh.json` | 新增 576K | 376 主题 + 594 边中文切片（grok 翻译 + codex 质检 97 修复 + 人工抽检通过） |
| `assets/companion-kg/topics-embeddings.json` | 新增 3.5M | bge-large-zh-v1.5 主题向量（1024 维归一化） |
| `assets/companion-kg/SOURCE.md` | 新增 | 来源 + ODbL/CC BY-SA 署名义务 + 消费方说明 |
| 服务器 `.env.local` | 已改（2026-07-13 15:4x） | 追加 `SILICONFLOW_API_KEY`（备份 `.env.local.bak-20260713`）；`COMPANION_KG` **不设=默认关** |

新增 npm 依赖：**无**（Node 22 内置 fetch）。内存增量：开关关 0；开关开 ~15MB（向量表+索引）。

## 部署前基线（2026-07-13 15:37 实测）

- pm2：p003-voice online（重启后 65.8MB）/ kidshub-voice online / chenchuan-site online
- 内存：total 1.6Gi / available 553Mi
- 公网：my.chenchuan.cc 200 / kidshub-ai 200
- ⚠️ 附带事件：服务器 07-12 重启致 pm2 全灭（无开机自启），15:36 已 `pm2 resurrect` 恢复三服务

## 三级回滚（照单执行）

```bash
# L1 秒级：关灰度（开关默认就是关；若已开）
ssh aliyun-hk 'sed -i "s/^COMPANION_KG=1/COMPANION_KG=0/" /opt/p003/server/.env.local; pm2 restart p003-voice'

# L2 分钟级：恢复部署前备份（备份路径见下方部署记录）
ssh aliyun-hk 'cp -r /opt/p003/_backup/<TS>/server-src/* /opt/p003/server/src/ && rm -rf /opt/p003/server/assets/companion-kg && pm2 restart p003-voice'

# L3 代码回滚：本仓 git revert 该次 commit 后按 SOP 重新 rsync src/ + pm2 restart
```

## 部署步骤（SOP Step 0/1 定制）

1. 备份：`ssh aliyun-hk 'ts=$(date +%Y%m%d-%H%M%S); bk=/opt/p003/_backup/$ts; mkdir -p $bk/server-src; cp -r /opt/p003/server/src $bk/server-src/; echo $bk'`
2. `rsync -az apps/server/src/ aliyun-hk:/opt/p003/server/src/`（增量不 --delete）
3. `rsync -az apps/server/assets/companion-kg aliyun-hk:/opt/p003/server/assets/`
4. `ssh aliyun-hk 'pm2 restart p003-voice'`（开关关，行为零变化）
5. 回归：chat.trigger K12 话语 → debug.prompt_assembled 含课程护栏、无 companion 痕迹；TTFT 无变化
6. 开灰度：`.env.local` 加 `COMPANION_KG=1` + restart → 三场景 E2E（陪伴域注入 / K12 优先 / 闲聊零注入）+ 内存观察
7. 翻车 → 按上面三级回滚

## 验证记录（2026-07-13 16:0x-16:2x 回填）

- [x] 步骤 5 回归通过：开关关时 K12 话语课程护栏照常 + companion 零痕迹 + 闲聊零注入（与部署前行为一致）
- [x] 步骤 6 通过（备份 `/opt/p003/_backup/20260713-160305`）：
  - 陪伴域 indirect（潮汐话语）→ companion 护栏正确注入：top1【潮汐波浪和洋流】+ 候选 2 个 + 先修 2 个 + 防说教规则 + 尾部人设锚点 ✅
  - 切片外话题（浮沉，376 切片无此主题）→ top1 0.356 < 0.47 被阈值门正确拦截，零注入 ✅
  - K12 话语 → curriculum 优先、companion 让位（互斥链按设计工作）✅
  - 生产 embed 实测：HTTP 200 / 253ms / key 长度 51 正常
- [x] 内存：companion 加载后 p003-voice 66MB（部署前基线 65.8MB，无可感知增量）；机器 available 522Mi
- [ ] 真实语音链路（interim 预热路径）：chat.trigger 验证走 allowSync 分支（与语音路径共享 embed/检索/组装，仅等待策略不同）；真机麦克风验收待川哥日常使用观察或后续真机专测

### 真机验收第一轮对账（2026-07-13 20:40-21:00）+ RTC 补挂

- **对账结论：该时段真机走火山 RTC CustomLLM 链路，companion 当时只挂 WS pipeline → 全程零调用（日志零 hit/skip），白测**。教训：**多入口系统的验收指南必须先确认被测端走哪条链路**（真机 App=RTC，体验台 WS 模式=pipeline）。
- **补挂（21:1x）**：custom-llm.ts 挂 companionGuardrail（互斥链对齐 pipeline；override/吐槽轮不注入）。RTC 无 interim → allowSync 同步 embed，**超时上限收紧 400ms**（典型 +250ms TTFT，超时降级不注入）。E2E 实锤：`hit【潮汐波浪和洋流】0.496` + SSE 流正常。火山 Prefill 真藏延迟方案记二期。
- 待川哥真机重测（同一批话语），关注：命中体感 + TTFT 是否可感知变慢（不满意关 `COMPANION_KG` 秒回滚）。

### 验证中发现的既有问题（非本次引入，不擅动，记录为后续建议）

1. **现网 curriculum-kg 子串误报会抢占 companion**："小狗小猫**小时候**好小"被 K12 数学概念「小时」子串命中（"小时候"⊃"小时"），注入了不相关的时间单位护栏，并按互斥链挡掉了 companion 本可正确命中的【动物的成长阶段】。建议后续：K12 概念名单加超短词（小时/分/秒/角/力）长度或词边界门槛，或 K12 也升级语义层。
2. 服务器 2026-07-12 重启后 pm2 无开机自启导致三服务全灭一天多（本次部署前已 resurrect 恢复）。建议：`pm2 startup systemd && pm2 save` 补自启（**未擅自执行**，等川哥点头）。
