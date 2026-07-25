# lark-whiteboard-lite 安装说明（给平台管理员）

> 用途：让 grok 4.5 / kimi k3 / DeepSeek v4 等模型驱动的 CLI Agent 画出高水准的飞书画板图
> （流程图 / 思维导图 / 时序图 / 状态机 / 系统框图 / UI 原型图 / 对比表）。
> 设计原则：模板填空 + 机械校验，不依赖模型的空间推理和视觉能力。

## 包内容

```
lark-whiteboard-lite/
├── SKILL.md            # 唯一必读文件：铁律 + 4 步流水线 + 命令 + 字段/色板白名单
├── validate.py         # 机械校验器（Python3 标准库，渲染前必跑，替代"视觉自查"）
├── templates/          # 7 个开箱即渲染成功的模板（模型只改文字，不造结构）
│   ├── flowchart.mmd   ├── mindmap.mmd   ├── sequence.mmd   ├── state.mmd
│   ├── system-arch.json  ├── prototype.json  └── grid-cards.json
└── out/                # 模板渲染效果参考图（也是运行时的输出目录）
```

## 环境依赖（缺一不可）

| 依赖 | 验证命令 | 说明 |
|---|---|---|
| Node.js ≥ 18 | `node -v` | whiteboard-cli 运行时 |
| whiteboard-cli | `npx -y @larksuite/whiteboard-cli@^0.1.0 --version` | 建议 `npm install -g @larksuite/whiteboard-cli` 预装，避免 agent 每次 npx 联网拉包 |
| Python ≥ 3.8 | `python3 --version` | validate.py 只用标准库 |
| lark-cli 已登录 | `lark-cli auth status --verify` | 仅上传飞书时需要；只出本地 PNG 不需要。凭证由管理员预先配好（scope 需含 docx/drive/board） |

## 按 harness 类型安装

**A. Claude Code / Codex CLI 等支持 Agent Skills 的 harness**
把整个 `lark-whiteboard-lite/` 目录拷入其 skills 目录（如 `~/.claude/skills/`），SKILL.md frontmatter 会被自动识别。

**B. 其他 CLI Agent（grok / kimi / DeepSeek 自研 bridge 等）**
1. 把整个目录放到 agent 可读的固定路径，例如 `/opt/skills/lark-whiteboard-lite/`。
2. 把 `SKILL.md` **全文**注入 system prompt（或作为画图任务的前置消息），并在注入时替换/告知一句：
   `本 skill 包的绝对路径 <SKILL_DIR> = /opt/skills/lark-whiteboard-lite`。
3. 不要只注入摘要——SKILL.md 就是为一次性完整注入设计的（约 16KB，上下文占用可控）。

**C. 验收安装是否成功（一次性冒烟）**
让 agent 执行：「按 lark-whiteboard-lite 的流程画一张三层架构图的本地 PNG，不上传」。
通过标准：它 cp 了模板、只改了文字、`validate.py` 输出 `RESULT: PASS`、`out/*.png` 生成且 > 10KB。

## 已内置的经验坑（不需要再教）

- `+whiteboard-update` 管道喂入也必须 `--source -`（lark-cli 1.0.22 实测）
- 向已有画板写入前强制 `--overwrite --dry-run` 探测，非空必须先问用户
- 含 `<whiteboard token>` 的文档禁止 overwrite 写正文（画板引用会被静默丢弃）
- 含文字节点 height 必须 fit-content；connector 必须在顶层；flex 内 x/y 无效；
  cylinder 固定宽度；纯布局 frame 加 borderWidth:0 防编译优化——validate.py 全部机械拦截

署名：cc（Claude）| 2026-07-25
