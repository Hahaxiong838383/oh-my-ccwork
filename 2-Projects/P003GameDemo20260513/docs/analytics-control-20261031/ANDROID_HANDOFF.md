# 安卓接入回执：方舟数据 → 小可大脑（合同 v1）

状态：服务端已于2026-10-31 18:52 CST部署，主Brain与搜索P2均已接通；安卓权威快照及真实语音闭环待联调。正式地址 `https://kidshub-ai.hahaxiong.cc`。目标设备BJP00326081002000026已授予方舟读取/快照权限，授权水位1793443962091（2026-10-31 18:52:42.091 CST）；不得原样上传本文合成示例。

当前Analytics历史夜批仍仅03800006开启，23:00 CST；02000026未开夜批，原先受1台预算限制；本次清理及30天重算后总上限已为4台，但并未自动增开。快照与历史Analytics是独立接口，02000026可以先完成快照联调，不等待历史夜批放量。后端不得把无历史数据回答成0余额。

## 分工与数据口径

- 17:11调查时该SN历史埋点0条、上传未覆盖；这是无数据，不是0余额。
- 23点持久队列埋点用于历史事实，只能回答“截至上次同步”；不会驱动实时倒计时。历史读取从本功能明确授权水位开始，旧数据归属无法证明时仍unknown。
- 安卓从**当前正式内容版本的权威游戏projector**一致读取钱包、库存、奖励与计时状态，计算 `remaining_seconds`。不能从UI识别、旧版五段阈值、服务器墙钟或“设备已联网”推算有效专注。
- 首版 `family_coin` 对应 C-FAMILY-001；`stardust` 是星尘语义字段，现有埋点尚无已核实item_id映射，未知必须null，不能临时编一个资源ID。金币口语存在歧义，不能自动当成星尘。
- `source_mode=normal` 仅供普通游戏状态；GM/调试明确报gm，无法判断报unknown。客户端声明不是硬件防作弊证明；未标记的旧GM数据不能据此宣称真人成绩。

## 接口

已上线 `POST /v1/device/ark/state`，JSON ≤16384字节；`Authorization: Bearer <现有Device Bearer>`。只接受当前注册active、独立Brain账号role=device、在方舟scope且已授权的设备。

SN与账号只从已验证Bearer的sub取，**body不允许SN/account_id**；不使用Worker进程JWT、家长token或Analytics展示alias。凭据撤销会阻断上报；换绑/禁用再启用/撤销会使旧授权失效，总调度需核身份后重新授权。

完整示例见 [snapshot-v1.example.json](snapshot-v1.example.json)。示例时间和数值全为合成，不能原样发送。合同执行源是 `apps/server/src/ark/contracts.ts` 中的 `snapshotSchema`；所有字段均必填，未知用规定的null或unknown；多余字段拒绝。

| 字段 | 规则 |
|---|---|
| schema_version | 固定1 |
| snapshot_id | 当前采样唯一ID，1–64字符 `[A-Za-z0-9_.:-]` |
| captured_at_ms | 同一次权威状态采样的UTC毫秒；须不早于授权水位，不得晚于服务器收到时刻2秒以上；超过24小时拒收 |
| boot_id / boot_started_at_ms | 本次启动唯一ID/真实启动UTC毫秒；启动时间≤采样时间；新boot启动时间须严格大于旧boot |
| sequence | 同boot持久递增整数1..Number.MAX_SAFE_INTEGER；若独立上报进程重启，恢复原seq或更换boot，不得回到1冒充原boot |
| logical_day | YYYY-MM-DD；首版实时解释保守要求等于当前北京时间自然日；若游戏逻辑日不同，服务端不会自动按自然日改写，应联调确认跨日策略 |
| config_revision / content_version | 规则与内容实际版本ID；各1–64字符，同上述字符集，不上报任意文本规则 |
| source_mode | normal / gm / unknown |
| wallets | family_coin、stardust，各为非负整数≤10亿或null；0仅表示权威值确实为0 |
| inventory | 只接 M-CARD-001（补勤卡），非负整数≤10亿或null |
| progress.timer_state | running / paused / stopped / unknown |
| progress.claimable_count | 可领奖励项数量，非负整数≤10亿或null；不是金币数量 |
| next_reward.status | locked / claimable / claimed / day_complete / unknown |
| next_reward.kind | currency / chest / item / unknown；下一宝箱不能说成下一金币 |
| next_reward.item_id | currency只允许C-FAMILY-001；item只允许M-CARD-001；chest/unknown必须null |
| next_reward.stage_id | 有界ID或null，不发描述文本 |
| next_reward.remaining_seconds | 0..86400整数或null，端侧计算的**剩余有效专注秒数**；服务端不递减 |

状态组合：locked需已知kind且remaining_seconds>0；claimable需已知kind、remaining_seconds=0、claimable_count>0；claimed/day_complete/unknown需remaining_seconds=null。已可领不等于已领取/到账，首版小可只介绍设备奖励页面操作，不支持代领。没有可核实projector结果时上报unknown，不能填旧配置默认值。

## 时机、重试与新鲜度

建议：语音唤醒时、奖励/钱包/计时状态变化时采样；语音活跃且运行中约10–15秒采样一次并合并突发，离线不积压每秒快照。**30秒是服务端本轮建议的新鲜窗口，安卓尚未保证，需两端实测确认。**总限频每SN每分钟12请求，错误请求/重复也计数，触发429遵守Retry-After；不要因旧快照409一直重试。

只有当前 `(boot_id, sequence, snapshot_id)` 且payload完全相同的重试返回duplicate；不刷新采样/服务器收到时间。被新快照覆盖的旧seq统一stale；相同当前seq/ID异payload冲突。不是无限历史幂等收据库。网络断开后发新采样，勿补发过期倒计时覆盖最新值。

实时解释同时核captured/received≤30秒及来源normal、逻辑日匹配；过期钱包可带截至时间介绍，但剩余分钟/可领取结论降为未知。暂停可解释仍需的有效专注量，同时明确暂停；停止与计时未知不能承诺几分钟后自动到账。

| HTTP/响应 | 安卓动作 |
|---|---|
| 200 `{ok:true,status:"accepted",received_at_ms:...}` | 当前快照保存成功 |
| 200 status=duplicate | 当前快照幂等，不续新鲜度 |
| 400 invalid_snapshot / invalid_json / clock_invalid | 修字段或校钟，勿重试原错包 |
| 401 invalid_device_credential | 更新合法凭据，勿切换身份绕过 |
| 403 not_enabled_or_authorized / not_authorized | 等总调度核实名单、当前绑定与授权；不要打开Analytics代替此门控 |
| 408 read_timeout / 413 body_too_large | 完整小包重传/减小字段，不增加自由文本 |
| 409 stale / conflict / before_grant | 丢旧快照重新采样；确认boot/seq与授权水位，不造未来时钟 |
| 429 rate_limited | 遵守Retry-After=60秒，合并变化 |
| 503 ark_dependency_unavailable | 延时退避，主对话继续运行 |

## 最小真机验收（尚待安卓与总调度）

1. 发布后确认正式网关把新路径转发到对应Brain；总调度只为目标SN启用方舟门控，记录授权水位。不要同时更改搜索/倾听/夜批开关。
2. 同版本普通游戏采样→200→管理员同源preview可见截至时间和确切数值→问余额/下一奖励。保存请求ID、自带snapshot_id、boot/seq、状态与服务器回执；不用提供儿童原始正文或凭据。
3. 分别核下一家族币/宝箱、暂停、可领未领、已领取、当天完成、unknown、0余额；语音得到的数值与projector同源。超过30秒不更新必须回答进度未知，不继续扣秒。
4. 重试不续期、乱序409、换绑/撤销后旧授权失效；另一设备/家长不能读取目标状态。
5. 若需要历史余额再单独安排受控夜批与正常逻辑日标记验证；不能用合成埋点冒充本SN到账。

服务端发布已完成；本回执不代表安卓或真机闭环验收通过。署名：codex（OpenAI）| 2026-10-31

## 历史埋点上传要求补充

仍用原 `POST /v1/device/analytics/events:batch` 协议，Device Bearer、稳定event_id/batch_id/RID和旧去重语义不变。最多200条/2MiB，每台同时仅1批；批间至少约2秒并添加抖动，遵守503/429 Retry-After（常见5/10秒），网络失败指数退避加抖动。只有明确accepted/duplicate才结算本地队列，拒收记录原因，不可整批清空。语音、BLE、UI线程不能同步等待补传。首次启用可能立即排空积压，后续23点策略；默认关设备不应主动上传。

补充取证：真实连续13批以上积压，含至少一次可恢复重试；上传过程中唤醒/对话正常；保存RID、每批条数、accepted/duplicated/rejected、端侧剩余队列和服务器入库对账，不交付用户正文/凭据。此项需要端侧现有实现证据，服务端压测不能替代。
