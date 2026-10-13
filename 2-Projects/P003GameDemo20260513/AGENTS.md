# P003（KidsHub AI · 小可）项目规则（codex / grok 入口；与 CLAUDE.md 同内容，由 cc 维护）

## 1. 对外命名：不露底层技术名（2026-09-17 川哥拍板）
- 所有用户可见文案不得出现「LiveKit」，统一写 `KidsHubAI-VoiceKit`：admin 后台（含 SVG 图内文字、表头、提示）、家长端、体验台、server 返回给页面的 error / message / label 字符串。
- 不受限：代码标识符、env 键名、日志、内部文档、协议字段。
- 验收：`grep -c 'LiveKit' apps/web/public/admin/index.html` 必须 0；`grep -rn 'LiveKit' apps/server/src --include='*.ts' | grep -E 'c\.json\(|message:|error:|label:'` 必须空；`grep -rn 'LiveKit' apps/parent/src apps/web/src` 必须空。
