# CPA Menu 0.4.2 (14) — 当前路由与今日请求模型分层

## 原因与口径

用户在 Grok 4.7 升级后看到账号卡“主要模型 grok-4.5”。实机核查显示：当日 139 次请求中 grok-4.5 有 128 次、grok-4.6 有 5 次、grok-4.7 有 6 次；`top_model` 使用今日请求次数最多的 `record.Model`，不是当前默认路由、最后一次请求或上游真实响应型号。

同时，Smart Router 当前文本目标全为 grok-4.7；08:28 的 grok-4.6/grok-4.7-latest 请求都返回 200、实际模型 grok-4.7-build。两种数据并不矛盾，是原标签含义不明确。

## 修改

- Bridge `xai_usage.route_upstream_models` 返回当前 Router providers 中去重排序后的文本上游模型，不从历史 by_model 或请求别名推断。
- 多个目标如并存会完整显示，不擅自选一个当“主模型”；未知、缺字段或 Router 失败不会用历史值冒充。
- 上游模型字段只投影有界合法 Grok 模型 ID；媒体、Build、Composer 等专用模型不混入文本主路由展示。
- 账号卡显示“Smart API 文本路由 grok-4.7”；原“主要模型”改为“今日最多请求 grok-4.5”，保留历史真实统计。
- 明确该路由字段只适用于 Smart API，不宣称 CPA Direct 显式旧型号请求被统一升级。
- 未修改 OAuth、账号、Key、路由配置、用量计数或消费逻辑；App 保留 0.4.1 的窗口和取消授权修复。

## 验证与部署

- Bridge `go test -race ./...` / `go vet ./...` 通过；新增 4 项测试覆盖历史/路由分离、共享 provider 多目标、缺目标不推断、字段安全投影。
- Swift 19 项 XCTest + 25 项 Swift Testing，共 44 项通过，新增路由字段去重/错误状态测试，旧响应缺字段兼容。
- 隔离 Bridge 18330 验证 `route_upstream_models=["grok-4.7"]`；禁用管理 Key 后 `codex_usage_status=not_configured`，未产生第二个生产 usage-queue 消费者。
- Bridge 08:40:41 CST 独立部署验收通过；公网 summary/accounts 均 200，路由目标为 4.7，历史 top_model 仍为 4.5、请求总数仍为139，未清零或改写统计。
- App 安装版本 0.4.2(14)，发布前确认本机 1455 无活动授权监听。构建签名/哈希与安装版本检查通过；本轮不启动 Computer Use，不把 API/构建检查冒充用户界面验收。

## 回滚

Bridge root-only 目录：

```text
/root/cpa-upgrades/menu-model-label-20260922/
```

`bridge.previous` 为旧二进制，`bridge.next` 为新版，`accepted.json` 为验收回执；回滚只原子恢复 Bridge 二进制并重启 `cpa-desktop-bridge`，不覆盖 `/var/lib/cpa-desktop-bridge/usage.json` 或账号。新版 SHA-256：`2ea37498c5ec002ec2178b288845acf1b3decc1a06713fd264c4abd8472dde90`。

App 的 0.4.1(13) 备份及独立 rollback-app.sh：

```text
/Users/rayman.chen/Library/Application Support/CPAMenuBar/Backups/20260922-004133-21917/
```

回滚脚本 `--verify-only` 仅校验，不执行恢复；实际恢复前确认无活动授权。本版与 Grok 4.7 全入口适配共同收口，源代码提交以 Git 历史为准；代码与共享记忆的提交号、远端核对结果记录在本机备份目录的 `release-receipt.json`。本轮收口不再重启服务、请求模型、修改账号或消费重置卡。
