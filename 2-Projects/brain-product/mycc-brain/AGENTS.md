# AGENTS.md — mycc-brain 项目规则

## 强制规则

1. 只要交付了新功能、可见行为变更、重要 UI 文案调整，必须同步更新版本号和日期。
2. 未更新版本号和日期，视为该功能未完成交付。
3. 当前 Admin UI 的统一入口是 `src/admin/admin-ui.html`：
   - `ADMIN_UI_VERSION`
   - `ADMIN_UI_DATE`
4. 日期格式固定为 `YYYY-MM-DD`。
5. 如果本次只改了 Admin UI，也要把最新 HTML 同步到 Studio 的 `dist/admin/admin-ui.html`。

## 执行约定

1. 做完功能后，先更新版本号和日期，再汇报结果。
2. 如果变更影响后端或对外版本文案，再额外检查 `package.json`、`src/server.ts`、`src/services/mcp-client.ts` 里的版本字符串是否也需要同步。
