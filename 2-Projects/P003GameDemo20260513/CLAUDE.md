# P003（KidsHub AI · 小可）项目规则

> 项目级规则，cc 入口。codex/grok 入口 `AGENTS.md`（同目录，内容一致，由 cc 维护）。
> 运维/部署 SOP 在 `~/mycc/.claude/skills/p003-deploy-ops/SKILL.md` 与 `voice-agent-ops/SKILL.md`，发布记录在 `../P003-product-definition/docs/RELEASES.md`。

## 1. 对外命名：不露底层技术名（2026-09-17 川哥拍板）
- **所有用户可见文案不得出现「LiveKit」，统一写 `KidsHubAI-VoiceKit`。** 覆盖：admin 后台（含 SVG 图内文字、表头、提示、说明）、家长端、体验台、以及 server 返回给页面的 `error` / `message` / `label` 字符串。
- 不受限：代码标识符、env 键名（`LIVEKIT_URL` 等）、日志、内部文档、协议字段（`livekit_probe`）。
- 验收（改动这些面时必跑）：
  ```bash
  grep -c 'LiveKit' apps/web/public/admin/index.html          # 必须 0（含注释，免得被复制进文案）
  grep -rn 'LiveKit' apps/server/src --include='*.ts' | grep -E 'c\.json\(|message:|error:|label:'   # 必须空
  grep -rn 'LiveKit' apps/parent/src apps/web/src                # 必须空
  ```
- 同类先例：家长端「双语音链路切换」UI 全脱敏无技术名（2026-07-16）。`apps/web/admin-proto/index.source.html` 原型按既有约束不改，但凡从原型再生成现役页，必须重跑上面三条。
