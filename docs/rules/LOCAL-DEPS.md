# LOCAL-DEPS: 依赖本地化

| 字段 | 值 |
|------|-----|
| 优先级 | P2 |
| 权重 | 0.60 |
| 是否常用 | 可选 |
| 是否必选 | 可选 |
| 触发条件 | 给项目装新依赖 / 引入外部命令行工具时 |

## 动作

所有外部依赖安装到项目根目录，**不依赖系统 PATH 或全局安装**。

## Why

- mycc 跨 4 台设备（Air / Mini / Studio / NAS）协作，全局安装无法保证版本一致
- `npm i -g` 类操作在跨设备场景下经常出现"我这能跑你那不能跑"
- 项目本地化依赖让 git clone + 装一次 → 立刻能跑

## How to apply

- Node 工具：`npm i` 进 `node_modules`，用 `npx` 或 `package.json#scripts` 调用
- Python 工具：venv 在项目根目录，路径写到 README
- CLI 二进制：放 `bin/` 子目录，`PATH=./bin:$PATH` 进 shell

## 例外

- `lark-cli` 已 symlink 到 `~/local/node/bin/`，全局可调（feedback_lark_cli_path）
- `gh` / `git` / `node` / `python3` 等基础工具不本地化
