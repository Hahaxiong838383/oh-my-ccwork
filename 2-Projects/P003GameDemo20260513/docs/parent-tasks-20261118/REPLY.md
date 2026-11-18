# 家长任务反馈与 C 机周报读取回执

> 本页记录 2026-11-18 11:13 的周报读取与任务规划。17:16 家长 A 已读通 C 机任务列表。[生产开通回执](P003_PARENT_TASK_V1_1_SERVER_LIVE_RECEIPT_20261118.md)

2026-11-18。任务功能仍在规划，尚未实施、部署。最新明确规则：孩子完成任务后收到完成反馈；家族币必须由家长在小程序再次确认后才发放，孩子不需要领取。此规则取代上一版推荐孩子领取的内容。

## 本次周报读取

- 请求：GET `/v1/parent/devices/{C机public_id}/weekly-report?timezone=Asia/Shanghai&week_start=2026-11-16`
- 公网：`https://kidshub-ai.hahaxiong.cc`
- HTTP：200；读取完成：2026-11-18 11:13:40.675 北京时间（2026-11-18T03:13:40.675Z）。
- 家长A按11/16留存的既有身份与当前C机绑定逐字段核同；使用同一原账号/parent角色的90秒短时JWT读取，没有新建账号、扩大权限、修改绑定或触发短信/微信登录。请求前后绑定核同。
- 只调用1个业务GET，没有写接口调用；周报GET可能按原逻辑刷新派生缓存。无生产部署。
- 下方仅遮蔽public_id，metrics字段和值保持原响应；没有补齐或四舍五入。
- `report_unavailable_reason`：原响应data中没有该字段；不写成null或空字符串。

```json
{
  "report": {
    "scope": {
      "kind": "device",
      "public_id": "dev_************9045"
    },
    "metrics": {
      "posture_reminders": {
        "available": true,
        "reason": "partial_history",
        "value": 13,
        "reference_max": 672,
        "above_reference_max": false,
        "updated_at_ms": 1794971267002
      },
      "usage": {
        "available": true,
        "reason": "partial_history",
        "total_seconds": 16018.387,
        "daily_average_seconds": 2288.341,
        "denominator_days": 7,
        "source": "telemetry.focus_segment",
        "supplemental_seconds": 2175.6810000000023,
        "combined_seconds": 18194.068,
        "updated_at_ms": 1794971595465
      },
      "active_days": {
        "available": true,
        "reason": "partial_history",
        "value": 1,
        "threshold_seconds": 300,
        "updated_at_ms": 1794971595465
      }
    }
  }
}
```

三项指标均available=true、reason=partial_history：有可展示的真实观测，但不代表整周采集完整。usage.total_seconds及daily_average_seconds来自真实focus；supplemental_seconds是单列补充量，combined_seconds是合计，不能将合计标成全部真实上报时长。

[含HTTP状态、读取时间、原响应SHA256的脱敏JSON](P003_PARENT_A_C_WEEKLY_RAW_20261118.json)。账号、手机号、JWT未输出；哈希对应服务器原响应正文，JSON为选定字段的脱敏摘录，不是整份响应正文。

## 下一步实施规划

1. 服务端先补任务CRUD、绑定权限、真实focus核算和“已完成待家长确认”；只核定任务完成时不生成可执行奖励授权。
2. 补家长确认接口：复核周期和金额，事务登记唯一结算；重复确认、不同请求键或超时重试仍只发一笔。
3. 安卓接收任务、展示完成反馈；拉取家长已确认结算后自动加币并持久化去重记录/R1，再上报到账。离线显示待到账，完成与到账两次反馈分开。
4. Worker后台与现役小程序共用任务/资产DTO，显示进度、待确认、待到账、已到账与同步时间；核对parent_task奖励来源投影，避免ACK成功而收益遗漏。当前云端余额仍是设备已同步副本，不迁移整个游戏钱包。
5. C机验收：家长A建任务→真实使用达标→孩子收到完成反馈且余额不变→家长小程序确认→安卓自动到账→三端一致；覆盖并发重试、离线补传、取消、换绑/换档和B账号越权。

现役LiveApp源码入口仍待取得；参考小程序构建不能替代手机验收。[修订后的完整方案](../../../../docs/superpowers/specs/2026-11-18-parent-family-coin-tasks-design.md)。

署名：codex（OpenAI）| 2026-11-18 北京时间
