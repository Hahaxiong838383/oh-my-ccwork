# P003 单机埋点窗口运行手册

适用：使用现有 P003 服务器进行一台明确身份的联调，操作范围已经获得用户授权。本轮控制器已经在服务器受控目录运行；此文件用于恢复与复用，不是对任意设备开放采集的授权。

源码：[deploy/analytics-window-controller.mjs](../deploy/analytics-window-controller.mjs)。归档 SHA256：`ce318acbf81d64055d20346b5c204ebb47838d7e8d84d7604461d55a80bfa1e9`，与 2026-10-14 11:39:38.895 只读核验的当前窗口脚本一致。

## 依赖与固定边界

- 在 `/opt/p003/server` 运行，使用现有专用 Node 24.19.0 与 `node:sqlite`、`util.parseEnv`，不安装新依赖。
- 管理员凭据、设备签名密钥、内部健康密钥从服务器已有 `.env.local`、`.env.analytics` 加载，不能将值写入参数、stdout、状态文档或 Git。
- 数据库只读用于前置、后置验证；目标配置通过现有 admin API 写入，revision 单调，不直接写 config.db 或还原旧库。
- 独立 `.env.analytics` 的 `ANALYTICS_SN_ALLOW` 只支持空名单或本窗口目标；只重启 `p003-analytics`。不修改一般设备名单，不重启 `p003-voice` 或 `kidshub-voice`。
- 总闸文件始终为 mode 0600 的纯 `{"enabled":true}` / `{"enabled":false}`；截止时间存窗口 state/timer，不能塞进总闸 JSON。
- 开窗需全局上传 false、hour=0、所有注册设备有效上传 false、总闸 false、独立名单 0、目标 active、没有另一窗口 owner；其他状态应查明来源后处理。

## 新窗口准备

使用新的单次 ID，例如 `YYYYMMDDTHHMMSSZ-<MCU尾8位>`，在 `backups/analytics-windows/window-<ID>/` 建 mode 0700 目录。将已核验源码复制到该目录，控制器、state、原 env 备份、原配置与关闭日志均 mode 0600。

`state.json` 必须来自本轮实际核对的 MCU SN / JWT sub，不能填写 ADB serial。示例仅说明字段，不能直接执行：

```json
{
  "id": "<UTC时间戳>-<MCU尾8位>",
  "phase": "prepared",
  "sn": "<已确认的完整MCU SN/JWT sub>",
  "request_id_prefix": "<端侧本轮实际RID前缀>",
  "requested_expires_at": "<本轮获授权的UTC截止时间，格式YYYY-MM-DDTHH:mm:ss.000Z>"
}
```

省略 `requested_expires_at` 时默认 30 分钟；指定时必须为未来且距注册时刻不超过 24 小时。本次用户要求放长后的明确截止为 2026-10-14T10:00:00.000Z，即当日 18:00 CST。此上限是代码校验，不代表已授权任何未来窗口。

## 执行与核验

在服务器项目目录，用实际窗口目录替换占位符：

```bash
/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node \
  --experimental-sqlite --env-file=.env.local --env-file=.env.analytics \
  backups/analytics-windows/window-<ID>/window-controller.mjs \
  /opt/p003/server/backups/analytics-windows/window-<ID> open
```

控制器完成以下步骤后才输出 `ok=true, phase=open`：

1. 验证关闭基线，记录三表计数、关联进程与非目标配置哈希，保存本次私有原件。
2. 独占创建 `data/analytics-window-owner.json`，只增加此目标到独立 allowlist，普通重启 analytics 后验证名单 1、总闸仍关闭。
3. 先注册独立 systemd timer/service，核 active/enabled/下一截止时间，才打开总闸和目标 true/0 配置。
4. 公网读取完整设备配置；目标空批 400、其他 active 设备空批 403；核其他设备仍关闭、非目标配置哈希一致、公司与个人进程 PID/restart 未变。
5. 保存 `open-receipt.json`，输出末 8 位身份、绝对时间、配置版本、定时任务及脱敏验证结果。

PM2 子进程只继承受控基本环境，不能加 `--update-env` 把临时加载的密钥保存进 PM2 环境快照。公网探针用进程内短时凭据，不打印、不持久化，空批不写事件。

请另外独立读取保存的 receipt/state/owner，并用 `systemctl show <timer>` 核下一触发时间。仅看创建命令成功，不足以确认到期任务已启用。

## 自动与手动关闭

到期任务为绝对 UTC 日历时间、`Persistent=true`、精度 1 秒；oneshot 失败每 5 秒重试，日志只进本窗口私有 `close.log`。对话结束不影响执行。

需要提前收口或恢复失败开窗时，沿用当前 owner 对应的原目录执行：

```bash
/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node \
  --experimental-sqlite --env-file=.env.local --env-file=.env.analytics \
  backups/analytics-windows/window-<ID>/window-controller.mjs \
  /opt/p003/server/backups/analytics-windows/window-<ID> close
```

关闭先将 master=false，再写目标 upload=false/hour=0、清空独立名单并重启 analytics，核 ready/关闭态与其他进程。成功记录 `closed-receipt.json`，释放 owner；已关闭状态可重复调用。若 owner 属于另一窗口，不得借旧目录修改新窗口。

任何阶段都不删除事件、seen、WAL、HMAC，不清端侧 durable 队列，不覆盖数据库快照来回退上传。原 env/config 是本次变更取证和受控恢复材料，不能在有新写入时整体盲覆盖。

## 延长、失败与接手

- 用户要求延长时，先读当前 phase、总闸、timer 和 owner。若已经关闭，创建新 ID 和快照重新开窗，并报告关闭间隔。本控制器没有在线修改 active 窗口 timer 的 `extend` 模式，不应直接重跑 `open` 冒充延长。
- 取得 owner 后开窗失败，控制器尝试原路径收口；关闭失败时至少将总闸设为 false，并写 `open-failure-gate-closed.json`。继续查私有日志和 state，不称窗口已开，也不改无关服务来消除 guard 失败。
- 关闭 task 成功需要 state=closed、receipt、总闸 false、目标 false、独立名单 0 四项交叉确认。timer 的 active/enabled 是调度证明，不是未来实际关闭证明。
- 输出中的 requested RID 前缀只记录申请口径，不能替代数据库实际前缀。查询应结合目标键和接收时段，按完整三分区与端侧 pending 结算。
- 被拒绝事件原始正文不落库，计数只能证明拒绝类别；具体字段需端侧提供脱敏事件名与字段名。

2026-10-14 当前目录 ID 为 `20261014T032410Z-03800006`；原 30 分钟目录 ID 为 `20261014T024325Z-03800006`。私有状态包含完整设备身份和 env 原件，不进入 Git。当前快照见[检查点](analytics-joint-checkpoint-20261014.json)，原关闭已成功，新截止 18:00 的实际执行仍待复核。

署名：codex（OpenAI）| 2026-10-14
