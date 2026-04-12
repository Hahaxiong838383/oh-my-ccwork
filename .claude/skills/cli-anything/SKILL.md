---
name: cli-anything
description: 为任意 GUI 软件自动生成 Agent 可用的 CLI 接口。7 阶段流水线：分析→设计→实现→测试→文档→SKILL.md→PyPI。触发词："/cli-anything"、"生成CLI"、"给软件做CLI"、"cli harness"、"agent-native CLI"
---

# CLI-Anything - 把任何软件变成 Agent 可控的 CLI

> 来源：[HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything)
> 已为 GIMP、Blender、Inkscape、Audacity、LibreOffice、OBS、Kdenlive、Shotcut 生成 1,245 个通过测试的 CLI。

## 触发词

- "/cli-anything"
- "生成CLI"
- "给软件做CLI"
- "cli harness"
- "agent-native CLI"

## 可用命令

### `/cli-anything <software-path-or-repo>`
构建完整的 CLI harness。接受本地路径或 GitHub URL。
执行 7 阶段流水线：源码获取 → 分析 → 设计 → 实现 → 测试规划 → 测试执行 → SKILL.md → PyPI 打包

### `/cli-anything:refine <path> [focus]`
扩展已有 CLI 的覆盖范围。可选 focus 参数聚焦特定功能域。

### `/cli-anything:test <path>`
运行 CLI harness 的测试并更新 TEST.md。

### `/cli-anything:validate <path>`
按 HARNESS.md 标准验证 CLI harness 的质量。

### `/cli-anything:list [--path dir] [--depth n] [--json]`
列出所有已安装和已生成的 CLI-Anything 工具。

## 执行步骤

收到指令后：

1. **读取 HARNESS.md**（必须）
   ```
   读取 .claude/skills/cli-anything/HARNESS.md
   ```
   这是方法论的唯一真相来源，所有阶段都必须遵循。

2. **读取对应的命令文档**
   ```
   读取 .claude/skills/cli-anything/commands/<command>.md
   ```
   命令文档定义了详细的执行步骤和成功标准。

3. **按命令文档的步骤执行**
   - 每个阶段完成后验证输出
   - 所有 CLI 使用 Click 框架 + `--json` 输出 + REPL 模式
   - 测试必须 100% 通过
   - 最终生成 SKILL.md 供 AI Agent 发现

## 输出结构

```
<software>/
└── agent-harness/
    ├── <SOFTWARE>.md              # 软件 SOP
    ├── setup.py                   # PyPI 配置
    └── cli_anything/              # 命名空间包（无 __init__.py）
        └── <software>/            # 子包
            ├── <software>_cli.py  # CLI 入口
            ├── core/              # 核心模块
            ├── skills/SKILL.md    # AI 可发现的技能定义
            ├── utils/             # 工具类
            └── tests/             # 测试套件
```

## 依赖

- Python 3.10+
- click（CLI 框架）
- pytest（测试框架）

## 支持文件

| 文件 | 用途 |
|------|------|
| `HARNESS.md` | 完整方法论标准 |
| `commands/*.md` | 各命令的详细执行指南 |
| `guides/*.md` | 专题指南（过滤翻译、MCP 后端、PyPI 发布等） |
| `templates/SKILL.md.template` | SKILL.md 生成模板 |
| `repl_skin.py` | 统一 REPL 界面皮肤 |
| `skill_generator.py` | SKILL.md 自动生成器 |
