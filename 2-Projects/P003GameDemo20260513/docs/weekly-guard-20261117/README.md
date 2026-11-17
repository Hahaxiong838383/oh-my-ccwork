# 周报护眼守护：实施与联调回执

状态：服务端周报与后台周报预览已于2026-11-17 21:24北京时间上线，公网接口、原始复算及浏览器同响应核对通过；Codex与Grok交叉测试完成，未复现P0/P1。现役LiveApp源码尚未找到，不能将参考页面构建写成手机实机完成。

## 给产品和联调同事的话

后台现在负责算好周报，页面拿结果显示。三个数字分别是：真实播放过的坐姿提醒次数、真实使用记录摊到7天的日均时长、每天连续真实使用满5分钟的已确认活跃天数。

姿态、在位和奖励进度仍可补充使用时长，单独列出。它们不冒充真实计时片段，也不用于证明连续5分钟。缺记录显示暂无数据；收到明确的零值才显示0。历史记录和补传会算回实际发生的日期。

每周按北京时间周一到周日统计。周日22点生成首版，页面注明本周未结束；周一补全自然周，随后补传继续修订，首次发布时间不变。后台保存日结果、周报及必要的去重依据，原始日志清理后不会把已验历史抹成0。短暂读取失败也不会让周报凭空增加版本。

后台入口：**Worker管理 → 小程序Dashboard → 选设备 → 周报预览**。可切周，查看三项指标、真实/补充/合计时长、逐日记录、最长连续时长、版本和时间。原坐姿提醒摘要、资产收益、短信身份、微信待企业认证提示、隐藏对话和解绑二次确认均保留。

## 兼容边界

- 上传URL、字段、幂等与ACK均未修改；不要求设备补focus_id。
- 家长仍用原`GET /v1/parent/devices/{public_id}/weekly-report`，新增`data.report`，旧字段和算法保留。
- 修复默认周起点落周二的问题；现在默认返回正确的北京时间周一。非法日历日期返回400。
- 旧调用显式传非周一时，旧字段仍从该日期算7天；新增report计算该日期所在自然周。新版页面始终传周一，并校验响应设备与周期。
- `guarded_minutes`仍为旧近似值，`eye_health_rate`仍为姿态轮比例。新版三张卡只读`data.report`，不能用旧字段兜底。
- 旧绑定账号缺失或设备停用时，原旧字段照旧，新增`report=null`、`report_unavailable_reason=current_binding_unavailable`；页面清空旧周报并提示条件不足。
- 现有明确历史授权可回填C机；其他绑定从服务端首次确认当前授权范围起记录，不自动继承旧主人历史。重新绑定形成新范围；不跨绑定代次推定同一孩子。

## 两端共用合同

家长：`GET /v1/parent/devices/{public_id}/weekly-report?timezone=Asia/Shanghai&week_start=2026-11-16`

后台：`GET /api/admin/devices/{sn}/miniapp/weekly-report?timezone=Asia/Shanghai&week_start=2026-11-16`

各自沿用现有登录权限，均`Cache-Control: no-store`；无登录401、其他家长404、非法日期或时区400、不可核验授权/依赖故障503。不返回Token、手机号、孩子对话或内部授权配置。

| report字段 | 含义与显示方式 |
|---|---|
| `scope.public_id / week_start / week_end / timezone` | 当前选中设备、周一至周日、Asia/Shanghai；响应不匹配必须丢弃 |
| `metrics.posture_reminders.value` | 唯一event_id且outcome精确played；冷却/未知/姿态轮不计 |
| `metrics.posture_reminders.reference_max / above_reference_max` | 参考672；超过保留真实数并提示待核，不截断 |
| `metrics.usage.total_seconds` | 本周真实focus区间并集，保留毫秒精度 |
| `metrics.usage.daily_average_seconds / denominator_days` | 真实总秒数÷7；显示“已同步折算日均”，不冒充完整采集 |
| `metrics.usage.supplemental_seconds / combined_seconds` | 有界姿态/在位窗口并集与奖励累计高水位计算的补充/合计，不重复相加 |
| `metrics.active_days.value / threshold_seconds` | 日内最长连续真实区间达到原始300000ms才计1天；门槛300秒 |
| 各指标`available / reason / updated_at_ms` | 独立判断；不可用显示暂无数据，合法0正常显示 |
| `daily[]` | 每日真实/补充/合计秒数、最长连续秒数、active、提醒次数、可用性和原因 |
| `coverage.complete / missing_dates / pending_dates` | 不声称完整采集；未收到真实片段的日期与未来日期分开 |
| `status / revision` | collecting统计中、published已发布、revised已修订；未到周末的首版注明本周未结束 |
| `scheduled_publish_at_ms / published_at_ms` | 计划周日22点、实际首次发布时间；漏跑补生成不伪造准点发布 |
| `data_cutoff_at_ms / period_end_ms` | 统计区间截止、下周一零点；不等于最后一次上传时间 |
| `updated_at_ms / source_updated_at_ms` | 报告事实修订时间、来源记录接收时间；补传可以晚于该周结束 |

临时故障只影响本次读取提示：`retained_dependency_unavailable`显示已保存周报；`partial_history_retained_supplement`保留已存补充记录；`partial_history_supplement_unavailable`提示补充来源不可用，真实计时照常显示。没有新事实时，故障与恢复不增加修订号。

## 公式和已修边界

真实片段按event_id去重，重叠与首尾相接的区间求并集；有1毫秒间隙就断开。先按北京时间午夜拆日，再判断连续门槛。299999ms不算活跃，300000ms才算；跨午夜23:57至00:03是两天各3分钟，都不能凭这条算活跃。

补充量由历史最小事件重新求区间并集。原始清理后补来的新focus不会挤掉旧的不重叠估算；晚到离位记录能纠正之前过长的在位估算。只有没有具体位置的奖励累计保留每日高水位，301→600→902取902，不累计相加。周报使用精确秒数；首页原有取整行为不变。

已发布报告按受影响周修订。其他周的异常记录不会污染本周质量统计或虚增版本；只调整授权JSON排版、或改另一台设备授权，不会丢失本设备缓存。读取过程中若发生换绑、A→B→A、epoch变化或授权角色改变，整份迟到结果丢弃。

## 验收记录

- 服务端纯计算24项、真实SQLite持久化14项、HTTP/服务16项通过。
- Node22生产同版本隔离回归7组通过，含原遥测37项、原后台及历史数据回归。
- 后台真实Vue浏览器回归通过：30次周报GET，页面错误0，保留原功能；变更周报未写业务数据。
- 参考小程序133项、类型检查、H5/weapp live构建通过。
- 3005 C机真实数据副本：本周真实11743.13秒、提醒8次、已确认活跃1天；原始独立复算、家长report、后台report一致。此项是上线前副本验证，不替代生产验收。
- Grok已对提交972f27d2重跑24+14+16项，另写3条独立反例，全部通过；审查无P0/P1。[Grok原始报告](./GROK-IMPLEMENTATION-REVIEW.md)。

生产于21:24:38读取：家长/后台/默认周/无数据周均HTTP200，非法日期/时区400，无登录401，其他家长404。C机本周真实11743.13秒，补充约2146.61秒，合计13889.74秒；日均1677.59秒即27.96分钟，提醒8次，活跃1天，状态统计中、第1版。部分数据不等于完整周。

公网浏览器21:25通过6次只读业务GET（4次周报），指标/逐日数据与同响应匹配；历史无数据周不显示0，切周再回来、刷新均正确；原顶部今日/历史提醒8次保持，页面错误0，无业务写入、无解绑。

仅覆盖本次8个源文件，保留生产已有voice-onboarding入口；环境配置不变、上传合同不变、绑定不变。新增派生weekly-reports.db，p003-voice仅重启一次，p003-analytics及其他服务未动。生产空闲通话/无配对时发布，有源文件备份与仅源码回滚记录，不恢复业务库。

代码提交并已push：`972f27d2650170bda0021577e3b639738dd4bc33`，分支`codex/p003-mini008-realdata-20261111`。当前生产发布清单SHA256：`1156f7bd8bc4f13660108ed0cf09ce5f09dfce5c14f438a6df688e1c63c48be1`。

[公网API与原始复算](./POST-RELEASE-PROBE.json) · [公网浏览器](./PUBLIC-WEEKLY-BROWSER.json) · [页面截图](./PUBLIC-WEEKLY-REGION.png) · [部署回执](./RELEASE.json) · [Node22回归](./NODE22-TESTS.json)

周日22点与周一零点发布边界由隔离时钟/SQLite测试验证；本次生产真实日期是周二，未声称已等到本周日实际定时发布。

## 已知边界

Grok保留一项P2运维边界：历史授权配置JSON损坏时，周报会暂时返回503（包括无关设备），恢复合法配置后原报告、数值和版本保留。本次生产配置有效，实测HTTP200；本轮维持校验失败即拒绝历史读取，未为规避报错放宽授权。配置损坏不等于历史数据丢失。

Grok报告中的“错误角色404”需按实际兼容测试细化：不属于该设备的账号404；同一旧owner若不具备新report读取条件，旧字段可200，report=null。本回执以HTTP/服务测试及上述兼容说明为准。

## 当前尚缺的验收

现役小程序使用另一套`LiveApp/liveHomeView/src/services/live-home.ts`。本机相关工作树/上传包、Air主项目/两个P003工作树/Downloads和60个相关ZIP均未找到其源码。本仓只完成同源`RealDataHome`的周报接入及构建，尚未上传微信，也未宣称手机界面已验证。

小程序同事只需按[接线说明](../../apps/miniapp/docs/weekly-report-20261117.md)将现役页面接到原GET的`data.report`，保留空态、设备/周校验、切换与退出后丢弃迟到响应。拿到现役仓路径后可继续直接接入并做手机验收，无需再改设备上传协议。

署名：codex（OpenAI）| 2026-11-17 21:28 北京时间
