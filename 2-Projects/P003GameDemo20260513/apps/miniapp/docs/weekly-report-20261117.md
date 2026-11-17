# 单设备自然周周报接入（2026-11-17）

本工作树 `RealDataHome` 已接入服务端同源周报。现役手机小程序的 `LiveApp / liveHomeView` 源码未在本机指定范围找到，本交付不等于现役手机已接入或微信平台已发布。

## 接口与页面

使用原 `GET /v1/parent/devices/{public_id}/weekly-report?week_start=YYYY-MM-DD`，仍带当前家长会话。旧字段保持兼容，页面只读取新增 `data.report`，不使用旧 `guarded_minutes / eye_health_rate` 替代新指标。`apiRequest` 统一递归 snake_case → camelCase；下面为服务端字段。

| 页面 | `data.report` 字段 | 展示规则 |
|---|---|---|
| 周期和所选设备 | `week_start / week_end / scope.public_id` | 北京时间周一到周日；返回设备/周起点不匹配请求即拒收 |
| 坐姿守护 | `metrics.posture_reminders.{available,value,reason}` | available 且 value 非 null 才显示次数；真实0可显示 |
| 提醒次数参考提示 | `metrics.posture_reminders.{reference_max,above_reference_max}` | 可选增量字段；超参考672时保留真实值，显示待核对提示，不截断 |
| 已同步折算日均 | `metrics.usage.{available,daily_average_seconds,denominator_days}` | 只做秒→分钟展示，不重算时长；分母7，覆盖不足显著说明 |
| 活跃天数 | `metrics.active_days.{available,value,threshold_seconds}` | 服务端已确认天数；客户端不从补充量推断连续5分钟 |
| 真实/补充/合计 | `metrics.usage.{total_seconds,supplemental_seconds,combined_seconds}` | total 是真实片段；补充与合计另列，未收到真实片段时不以补充替代主值 |
| 状态和版本 | `status / revision / published_at_ms / updated_at_ms / data_cutoff_at_ms` | 统计中/已发布/已修订；首次发布和更新时间分别显示 |
| 每日证据 | `daily[]` | observed/supplemental/combined 秒、最长连续、active、posture_count、可用性与原因 |
| 覆盖情况 | `coverage` | observed_days、missing_dates、pending_dates、异常事件数；未来日期显示待统计 |

`status=collecting` 显示“统计中 · 累计预览”和计划发布时间，不声称已经发布。发布后的缺测/覆盖不足继续保留提示。三个指标独立可用，单项失败不会清空其他项；未知/缺失/非法负数不转0。

`status=published` 且 `data_cutoff_at_ms < period_end_ms` 时显示“已发布（本周未结束）”，明确周日22点首版尚未包含自然周最后两小时。`data_cutoff_at_ms` 是**统计区间截止**，最多到该自然周结束；它不是“最后一次收到上传”的时间。`updated_at_ms` 是报告后续更新时刻，`source_updated_at_ms` 是来源记录更新时间，补传可能发生在周结束后；页面分别列示，晚到记录仍归原发生周。

接口兼容空报告：HTTP200、`ok=true` 仍可能返回 `data.report=null` 与 `data.report_unavailable_reason=current_binding_unavailable`。这表示当前绑定尚不具备新周报读取条件；立即清空此前显示的报告，提示刷新设备列表，不登出账号，也不把仍存在的旧字段补作新周报。缺失 `report` 字段则按未满足新合同处理。

服务依赖故障时可返回此前保存的报告，`coverage.reason=retained_dependency_unavailable` 明确显示“当前显示上次保存的周报”，保留原数据截至时间；`partial_history_retained_supplement` 表示已保留此前保存的补充计算；`partial_history_supplement_unavailable` 表示补充数据暂不可用，真实计时/提醒仍按各自状态显示。这些理由均在页面可见，不把旧结果冒充刚完成计算。

## 同源文件与现役接线

- `src/services/weekly-report.ts`：类型、严格读取适配、北京时间周导航、请求控制器。
- `src/pages/index/weekly-report.tsx`：`WeeklyReportPanel` 和可独立渲染的 `WeeklyReportContent`。
- `src/pages/index/real-data.tsx`：参考入口按选中设备挂载；周报不依赖 dashboard 快照有无或设备在线状态。

现役 `LiveApp` 可在真实周报 Tab 中复用：

```tsx
{signedIn && selectedDevice && <WeeklyReportPanel
  key={`weekly:${selectedDevice.publicId}`}
  publicId={selectedDevice.publicId}
  deviceLabel={selectedDevice.note || '读写台'}
  onAccessLost={status => status === 401 ? logout() : refreshDevices()}
/>}
```

挂载必须跟随已登录状态和所选设备，保留 `key`。卸载销毁控制器，切周递增请求版本；迟到成功/失败均失效。401、403、404清空已显示周报并通知父级重新校验身份或设备授权；同周临时服务故障保留旧结果并明确标为上次读取；换周失败不残留上一周数据。客户端不持久化设备周报。

## 本机现役源码定位证据

只读查找范围：`/Users/fu-121/mycc`（main，918c9ac6）、`p003-miniapp-joint-20261029`（6c2cc932）、`p003-sms-login-20261103`（7ccd1f7c），再对全部 `.codex/worktrees` 按 `live-home.ts / LiveApp.tsx / liveHomeView*` 文件名搜索。排除 `.git / node_modules / .env / dist / build`，未找到现役标记源码。

Downloads 与实际 Codeg uploads 位于 `/Users/fu-121/Library/Application Support/Codeg-company-studio/uploads`。相关源码/文本搜索与小程序ZIP内部只读检查，也未发现现役实现。找到的权威历史记录：

- `uploads/conv-12-codex-13/内测真实数据依赖清单-2026-11-10.md` 第9节，明确现役有 `src/services/live-home.ts`、`LiveApp` 五 Tab 和7项 `liveHomeView` 测试，但未写仓路径。
- `uploads/new-1794806644203-u9z1sp/P003_mini010_小程序请求服务端排查回执_20261117.md` 仍明确引用现役 `liveHomeView`。
- `uploads/conv-27-codex-37/xiaoke-miniapp-source-2026-10-29.zip` 无上述标记；10月29日快照早于11月10日现役改造。

没有读取凭据、SSH、修改外部仓源码或向微信平台上传。

## 验证

新增合同/日期/生命周期9项、渲染6项，均先验证失败后实现。首次全套128项、TypeScript、live H5/weapp构建已通过；补空报告/依赖保留语义后同源周报12项、类型检查与H5/weapp双构建也均通过（API为生产HTTPS，只构建，没有上传）。参考值提示及22点首版文案增量后，最新周报15项和类型检查通过，最终构建待整体冻结后统一执行。weapp保留既有空vendors chunk提示；BLE测试保留预期“写入测试中断”诊断，无失败。传输测试使用隔离 fixture，浏览器/实机或生产业务数据验证另行记录，不把 fixture 数字当作C机真实统计。

署名：codex（OpenAI）| 2026-11-17
