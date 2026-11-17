# 小程序管理读取 API（2026-11-17）

三个接口仅管理台 admin token 可用；401 未登录、403 非 admin。所有响应 `Cache-Control: no-store`。

- `GET /api/admin/devices/:sn/miniapp/dashboard?timezone=Asia/Shanghai`
- `GET /api/admin/devices/:sn/miniapp/records`：参数、分页 DTO 与家长 `ark/records` 相同。
- `GET /api/admin/devices/:sn/miniapp/conversations`：参数、分页 DTO 与家长 `conversations` 相同。

Dashboard 返回：

```ts
{
  ok: true,
  binding: {sn, public_id, parent_account_id, parent_phone, binding_version,
            brain_opened: boolean, status, note},
  observed_at_ms: number,
  data: ParentDashboard | null, // 原家长 dashboard 所有字段，含兼容 today/week
  reason: null | 'unbound' | 'parent_account_invalid',
  integration: {
    upload_config: {
      available: boolean, reason: null | 'dependency_unavailable',
      source: 'device_config', revision: string | null,
      ark_records: {configured_enabled: boolean, effective_enabled: boolean,
                    contract_id: string} | null
    },
    reported_version: {
      available: boolean, reason: null | 'no_report' | 'dependency_unavailable',
      source: 'ota_device_status', version_code: number | null,
      version_name: string | null, reported_at_ms: number | null
    },
    history_authorization: {
      ark: {enabled: boolean, authorized: boolean},
      records: {enabled: boolean},
      conversations: {available: boolean, reason: string | null}
    }
  }
}
```

未绑定不读取旧家长 Dashboard，`data=null, reason=unbound`；绑定账号不存在或不是 parent 则 `data=null, reason=parent_account_invalid`。记录/对话无可读当前家长时404。缺失设备404，读取过程中身份或授权变化404，查询异常503；分页保留400/410错误语义。disabled 设备仍可读身份，原数据域继续按各自授权门控返回不可用。

`parent_phone` 为当前绑定家长电话，前端默认脱敏，按需查看；不存 localStorage。`brain_opened` 仅表示 registry.account_id 存在。OpenID/UnionID 当前没有持久化，不提供伪造字段。

`upload_config` 仅返回真实配置中的流水上传开关和合同。`configured_enabled` 是有效配置值，`effective_enabled` 进一步核 legacy 历史授权。未返回的 telemetry 等域没有独立远程开关，不将缺字段解释为关闭。`reported_version` 来自 OTA check 最近自报，并非发布版本或服务端实测安装版本；不输出 last_result_json。

history_authorization 只公开布尔值/不可用原因，不输出 grant_id、授权 JSON 或凭据。`data.usage` 是用时真值，缺测null和有效0不同；telemetry仍按SN聚合。流水只显示本页已加载N条，不提供/推算总count。所有 latest_items.items 整组展示。baseline不算收益/新获得；非normal不显示当前资产。

兼容裁决：完整身份元组、Ark grant/启用状态、真实账户 role 的前后校验位于 admin 聚合 wrapper，覆盖共享数据查询及 metadata 查询，变化则整体404且不输出data。共享计算函数保留原家长 API 的 owner/SN 复核和各域降级合同：例如家长对话读取中 ABA 换绑仍返回200、conversations不可用；admin 同一竞态整体404。家长账户库故障仍只降级原先依赖它的域，admin解析真实家长身份失败则不返回家庭详情。此差异不改变正常状态下两端data的逐字段一致性。

`history_authorization.records.enabled` 仅表示流水服务端准入名单（含Ark ceiling），不表示当前历史已获授权；可读性仍看data.records各域的available/reason及分页接口结果。
