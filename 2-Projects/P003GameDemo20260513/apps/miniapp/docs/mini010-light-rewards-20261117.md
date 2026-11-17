# mini010 色温、游戏与实时奖励接入

日期：2026-11-17。此文件描述本仓 `RealDataHome` 的补齐；附件所称现役 `liveHomeView` 不在本工作树，不能以本次构建冒称现役小程序已发布。

设备上传 URL、合同、ACK 和字段均不变。以下是家长 dashboard 的读取映射，使用现有家长权限；后台收到 ACK 不等于旧页面已经消费新增查询字段。

| dashboard 路径（原始 JSON） | 读取与展示 |
|---|---|
| `data.device.color_mode` | `cool=冷光`、`normal=常规`、`warm=暖光`；`null` 或未知枚举为暂无数据。按原上报值展示，不反向补偿端侧映射错误。 |
| `data.device.led_enabled` | `true=已开灯`、`false=已关灯`，缺失/null 为暂无数据。 |
| `data.device.focus_active` | `true=计时中`、`false=未计时`，缺失/null 为暂无数据。 |
| `data.ark.reported_state` | null 表示没有当前授权下可展示的已上报快照；有值时按原样展示资产、游戏日、采样时间、接收时间和来源。 |
| `reported_state.wallets` / `inventory` | 家族币 `family_coin`、星尘 `stardust`、补勤卡 `M-CARD-001`；0 显示0，null 保持暂无数据。 |
| `reported_state.progress` | `timer_state`、`claimable_count`，以及 `next_reward.status/stage_id/remaining_seconds`。剩余秒数是采样值，页面不自行倒计时推算。 |
| `data.records.recent_activity.items` | 最近最多20条已入库业务流水，字段与现有 `/ark/records` 分页一致；每笔保留 `source_mode`、物理发生/接收时间、`logical_day`。 |
| 业务项 `grants` / `inventory_changes` | 逐领取记录展示 `resolved_rewards`，按 before/after 展示库存；领取逻辑日来自每条 grant，不用物理11月17日替换历史游戏日。 |
| `data.observations` | 继续表示夜间同步的历史观测，与实时业务记录分栏，不混加两条链路的记录数或金额。 |

`reported_state.source_mode=gm` 显示“测试来源（GM）”，unknown 显示“来源未核实”。这两类保留设备实际上传值，但不计入正常收益。既有 `ark.available/wallets`、`yesterday_income`、`latest_items` 仍为正常来源摘要；不能把它们的 `non_normal/null` 误报为未收到上传。

实时领取、奖励、钱包变化可立即出现在“历史奖励与道具 → 实时业务记录”。夜批埋点尚未上传时，下方历史观测条数可以保持不变。两者不需要互相等待。baseline 仍表示已有资产，不计新增收益。

本仓传输层统一执行 `snakeToCamel`：组件读取 `colorMode`、`reportedState`、`sourceMode`、`recentActivity`、`resolvedRewards` 等 camelCase 字段。现场前端若直接消费原始 JSON 则使用表中的 snake_case，不要混用两种层级。现有“刷新”重新查询 dashboard；切账号、切设备和退出继续丢弃迟到响应。

构建入口：

```sh
TARO_APP_DATA_MODE=live TARO_APP_API_BASE_URL=https://kidshub-ai.hahaxiong.cc npm run build:h5
TARO_APP_DATA_MODE=live TARO_APP_API_BASE_URL=https://kidshub-ai.hahaxiong.cc npm run build:weapp
```

输出为 `dist/h5` 和 `dist/weapp`。本次交付是源码和构建产物；微信开发者工具上传、审核/体验版发布和手机真实页面验证单独记账。端侧 MCU 冷光/常规名称对调仍须其原代码修复，本仓不悄悄交换接收到的枚举。

## 本仓验证（2026-11-17）

| 验证 | 结果 |
|---|---|
| Node v24.19.0，`vitest run --threads false` | 14 套、115 项全部通过；先复现新增字段被丢弃，再完成修复。 |
| `tsc --noEmit` | 通过。 |
| live H5 / weapp 构建 | 通过，分别9 / 17个文件。 |
| 已构建 H5 浏览器回归 | 合成身份、全部业务请求在本地拦截：9请求、2次 dashboard、2页历史观测，页面错误0；暖光、GM资产、奖励阶段、实时库存和刷新后数值更新均可见。 |

浏览器回归只证明本仓页面正确消费合同，不是 iPhone 真实家长登录、当前 C 机响应或微信发布证明。生产接口与实机对账由服务端本轮回执分别记录。

署名：codex（OpenAI）| 2026-11-17
