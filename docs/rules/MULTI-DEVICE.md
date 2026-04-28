# MULTI-DEVICE: 多设备协作

| 字段 | 值 |
|------|-----|
| 优先级 | P3 |
| 权重 | 0.35 |
| 是否常用 | 可选 |
| 是否必选 | 可选 |
| 触发条件 | 新机器初始化 / 跨设备同步 / 涉及 .env 凭据 |

## 动作

| 类型 | 处理 |
|------|------|
| 共享的（git） | CLAUDE.md、skills、文档 |
| 本地的（gitignore） | `.env`、`settings.local.json`、二进制、`current.json` |
| OS 差异 | 由 `platform.ts` 运行时处理 |

## Why

mycc 跨 4 台设备（Air / Mini / Studio / NAS）协作：
- 共享内容 git push/pull 同步，零冲突
- 本地凭据每台机器独立维护，git 不追踪
- OS 差异（macOS / Linux / Windows）在代码里处理，不在配置文件里

## 详细参考

[`docs/setup-guide.md`](../setup-guide.md) — 新机器初始化、提交规范

## 关联规则

- [`MOBILE-MYCC.md`](MOBILE-MYCC.md) — 移动端访问
