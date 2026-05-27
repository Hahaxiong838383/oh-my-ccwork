# multica × 飞书 OAuth 集成 (P1 完成 2026-05-27)

## 集成机制

零侵入 multica daemon — 纯 LLM-driven 通过 skill + issue metadata 联动:

```
multica web (后端)             multica daemon → agent (Claude/Codex)              sidecar (:18090)
  ↓ create issue                                ↓                                       ↑
  metadata.feishu_user_id ─────────────────→ agent skill 教 LLM:                       │
                                              1. multica issue get → 拿 metadata  ─────┤
                                              2. curl sidecar /status?id → 拿 token    │
                                              3. bash 05_agent_spawn.sh → 真发飞书 ────┘
```

## 关键设计

| 决策 | 理由 |
|------|-----|
| 用 skill 教 LLM 而非改 daemon | multica daemon 闭源 binary，且 agent 是 LLM-driven，skill 是天然集成点 |
| issue.metadata 注入 feishu_user_id | multica 原生支持 KV metadata，无需新表/新 API |
| skill 铁律 5 条 (不伪造/不绕 wrapper/不用 owner 身份) | 多用户安全审计基线 |
| agent 自己调 sidecar status 检查 token | token 长任务期间可能失效，每次操作前验证 |

## 验收结果 (FUT-14 + FUT-15)

**FUT-14 (test-user-001)**:
- ❌ 第一次 gemini runtime: gemini 未认证 (验证 daemon 选 runtime 机制)
- ✅ rerun claude runtime: agent 严格按 skill 3 步走，token 刚过期时 fail-safe (返回根因, 不伪造)

**FUT-15 (test-user-002)**:
- ⚠️ agent 跑时 lark-cli 临时错误，misdiagnose 为 token_invalid
- ✅ 手动 `05_agent_spawn.sh test-user-002 im +messages-send` 成功发出 `om_x100b6e5a8adb00b0b2c59a5864b0d9b`
- 结论: 集成机制 work, agent prompt 在 lark-cli 报错归因上需优化 skill markdown

## 资产

| 资产 | 位置 | ID |
|------|------|-----|
| skill "飞书代理操作-zh" | `skill-feishu-as-user.md` | multica skill `54d94775-5dda-4024-afd7-9c950ebb2f91` |
| agent "飞书代理操作员" | multica web | agent `ccaa5609-feea-47b2-a76f-01f10becba5f` |
| runtime (claude on mini) | mini daemon | `1e99998f-eada-44b6-8a1c-e94101fc3280` |
| sidecar | mini :18090 | launchd `com.multica.feishu-oauth` |
| user HOMEs | mini `~/multica-user-homes/` | mc-user-test-user-001, mc-user-test-user-002 |

## multica runtime ID → provider 映射

| runtime_id | provider |
|------------|----------|
| `1e99998f-eada-44b6-8a1c-e94101fc3280` | claude (2.1.152 via LXJ MiniMax-M2.7) |
| `6e723acd-3693-4d23-8103-9b4dc13cc74d` | codex (0.134.0 via LXJ gpt-5.5) |
| `4e1e8d95-a017-4d6b-b526-1ea82183b27b` | gemini (未认证 — 川哥挂起) |

## multica web 集成下一步

为了 production 化, multica web 后端需要:

1. **用户飞书绑定页面** (类似 OAuth 应用绑定): 调 sidecar 3 endpoint, UI 显示 QR + 长轮询完成状态
2. **创建 issue 时自动注入**: 任何 issue (无论 assignee) 都给 metadata 加 `feishu_user_id = creator_lookup(creator_id)`
3. **token 过期监控**: 定时跑 sidecar /status?id=* 提前 24h 通知用户重新扫码
4. **issue UI 显示 sidecar 状态**: assignee 是 "飞书代理操作员" 时显示 "✅ 已授权 (陈川Rayman)" / "❌ 需重新授权"

## skill markdown 优化 (V2 待做)

agent 在 lark-cli 偶发错误时易归因到 token。优化方向:
- 加入"先试发,看是 OAuth 错误码 (401/403) 还是其他错误"判断分支
- token_invalid 必须由 sidecar 明确返回,不能从 lark-cli stderr 推断
- 提供 retry 机制 (临时网络问题 max 2 次)
