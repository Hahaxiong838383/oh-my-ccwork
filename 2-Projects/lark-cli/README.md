# lark-cli — 飞书 CLI 工具

> 基于 [larksuite/cli](https://github.com/larksuite/cli) 部署，供 Claude Code / Codex / Gemini CLI 调用。

## 路径

```
二进制: ./node_modules/.bin/lark-cli
配置:   ~/.lark-cli/config.json
凭据:   ~/.secrets/lark-cli.env (gitignored)
Skills: .agents/skills/lark-* (19 个，已 symlink 到各 agent)
```

## 使用

```bash
# 直接调用
./node_modules/.bin/lark-cli calendar +agenda

# 查看所有命令
./node_modules/.bin/lark-cli --help

# 查看认证状态
./node_modules/.bin/lark-cli auth status
```

## 已授权 Scopes

calendar, im, docs, sheets, base, drive, mail, task, wiki, vc, contact, board, minutes

## Agent Skills (19 个)

lark-shared, lark-calendar, lark-im, lark-doc, lark-drive, lark-sheets, lark-base,
lark-task, lark-mail, lark-contact, lark-wiki, lark-event, lark-vc, lark-whiteboard,
lark-minutes, lark-openapi-explorer, lark-skill-maker, lark-workflow-meeting-summary,
lark-workflow-standup-report

## 部署日期

2026-03-29
