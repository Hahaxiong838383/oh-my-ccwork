# MOBILE-MYCC: 移动端访问

| 字段 | 值 |
|------|-----|
| 优先级 | P3 |
| 权重 | 0.35 |
| 是否常用 | 可选 |
| 是否必选 | 可选 |
| 触发条件 | 老板从手机访问 mycc 后端 |

## 动作

输入 `/mycc` 启动后端，即可在手机上远程使用。

- 网页版：[mycc.dev](https://mycc.dev)
- 后端启动：cc 调用 mycc skill
- tunnel URL 每次重启都变，从 `.claude/skills/mycc/current.json` 读

## Why

老板出门时常用手机访问 mycc，需要后端在跑。tunnel URL 不固定是因为 Cloudflare Tunnel 走免费档。

## 关联规则

- 启动 / 重启 / 排错见 [`docs/FAQ.md`](../FAQ.md)
- multi-device 共享/本地区分见 [`MULTI-DEVICE.md`](MULTI-DEVICE.md)
