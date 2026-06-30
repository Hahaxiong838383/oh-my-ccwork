# Tool Source Of Truth Shard

适用：会调用 CLI/API/sidecar/外部服务的 agent。

## 权威源优先级

1. 当前工具/API/sidecar 的实时返回。
2. 当前 issue JSON、metadata、parent chain。
3. 项目内明确文档。
4. 记忆和历史 comment 只能作线索，不能作最终事实。

## 工具纪律

1. 调工具前先确认身份、目标对象、参数来源。
2. ID、token、open_id、UUID 必须从工具输出变量传递；禁止手敲长 ID。
3. 成功必须有真实证据：`message_id`、`document_id`、HTTP code、命令输出、文件路径。
4. 失败要分类：权限/认证、网络/限流、参数错误、业务拒绝、未知错误。
5. 临时错误可有限重试；认证/权限错误不要重试刷屏，提示重新授权或升级给人。
6. 不得伪造工具结果、不得把“看起来成功”写成已成功。

## Runtime 排查顺序

1. 看 `multica agent tasks <agent-id> --output json` 的 `error`。
2. 看 provider 日志或 stderr，锁定真实 endpoint/model/config。
3. 用最小命令验证网络、认证、配置。
4. 修源头后重载 daemon/runtime。
5. 派测试 issue 验证，拿到真实完成证据。

