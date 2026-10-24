# R14 搜索续讲与阶段上下文协议

实现锚：Brain `ec578bd7`，Worker `e7cc475e`。本文件描述代码合同，不代表灰度已开启或实体设备已验收；运行状态见同目录R14验收记录。

## 授权与保留

- 仅独立候选内部认证接口；客户端不能直接读取其他房间的任务。原设备认证、首句合同和非目标设备派单不变。
- 恢复身份绑定完整SN、候选账号及现役只读设备台账的授权纪元；撤权、换绑、台账不可读时拒绝恢复。只读路径固定，普通聊天不增加台账查询。
- 退出取消未完成查询；已ready的结果可保留恢复资格。期限为`min(首次ready时间+300000ms, 测试窗口绝对截止)`，重连/领取/续讲不延期。
- 新房间静默不自动播报，必须显式要求继续；旧房间尚未关闭时返回409。一个活跃新房间，重复request_id幂等，总人工重播/恢复最多8次。
- 取消、成功接受新查询、撤权、到期、关闭能力或Brain重启使旧资格失效。恢复资格只在内存，重启不承诺找回。

## 内部端点

以下相对路径挂载在既有候选`/v1/internal/search-tasks`，继续使用既有room与Worker身份校验、body上限、候选范围与闸门。

| 方法与相对路径 | 请求与行为 |
|---|---|
| POST `/session/close` | 严格空对象；关闭旧session，保留合格ready结果的恢复引用 |
| POST `/session/cancel` | 原强取消语义保留 |
| POST `/resume/latest` | `{protocol:1, request_id}`；ID为1—80个字母/数字/下划线/短横线。返回绑定当前房间的resume授权 |
| POST `/resume/cancel` | 严格空对象；取消当前身份可恢复的旧查询 |
| GET `/resume/:grant/playback` | 复核当前房间、授权、范围、期限，返回剩余待播内容 |
| POST `/resume/:grant/receipt` | `{outcome, progress?}`；outcome为progress/completed/interrupted/dropped |
| POST `/:id/progress` | 旧任务原会话的`delivery`及`progress`；不是跨房间访问入口 |
| POST `/:id/receipt` | 保留原回执，新增可选progress |

恢复响应的`resume`包含`protocol、grant、task_id、revision、text、text_digest、complete_sentences、valid_for_ms`。grant仅供内部使用，不写入设备持有人回执。旧任务原路径的session隔离继续生效。

## 播放进度

```ts
type SearchProgress = {
  protocol: 1;
  text_digest: string;       // 完整结果UTF-8 SHA256，小写64位hex
  complete_sentences: number; // 已完成句数，非字符比例
  sequence: number;          // 每个delivery/grant内递增正整数
};
```

句界为`。！？!?；;`及换行，末尾不足4字符并入上一句；两端实现一致。先登记完整文本再合成，Worker用成功capture的累计样本减220ms保守尾量推进句游标，暂停墙钟不推进。未完成句从句首重播；全部完成后显式要求重听可从头播。

重复/乱序序号不前进；digest不符、句数越界或倒退拒绝。旧delivery/grant迟到不能复活新轮或已取消结果。进度异步有界发送，不阻塞音频主循环或让取消排在慢HTTP后面。关房显式清理有超时及Drop兜底，恢复开关关闭时保持旧abort路径。

capture、completed和合成接收端收到音频均不等于实体扬声器实听确认。

## 临时对话阶段

Worker附带独立`search_dialogue_context`枚举元数据，不向聊天history插入网页或任意system消息。Brain只在Worker认证、当前任务/恢复授权及版本校验通过时采用running/ready/playing/interrupted等固定阶段。

搜索正文已出首PCM且没有后续连续语音时，仅精确短附和可保持正文继续。STOP/EXIT、新查询和完整新话题优先。有效阶段下遇到“我想聊”等精确未完整表达，固定澄清；完整新话题仍正常调用模型。

缺谓语的明确搜索问句可在局部有界窗口内拼接邻近尾部；普通聊天不等待，不完整问句超时澄清。该规则不能修复任意ASR误识别或丢失音频。

署名：codex（OpenAI）| 2026-10-24 北京时间
