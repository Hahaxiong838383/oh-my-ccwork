无阻断问题。候选 `97f13f08` 相对基线 `6afe561` 的这 6 个文件可以按显示改动部署。线上备份、替换、重启和发布后哈希仍由主13做。这次审查没有写文件、没有切分支、没有连生产。

## 范围

`git diff` 只有这 6 个文件，共 +224/−6。运行时只有：

- `apps/server/src/admin-device-credential-status.ts`（新文件）
- `apps/server/src/routes/admin-data.ts`（加 import，`GET /devices` 增加 `ble_status`）
- `apps/web/public/admin/index.html`（设备表两列文案）

`credentialView` 函数两边字节一致。`adminDataRoute.` 注册数仍是 76。写路由、发证、绑定、鉴权代码不在 diff 里。三份运行时文件的 sha256 与证据里的 preflight「before」、deploy-manifest「after」一致：`admin-data.ts` 基线 `64e39b14…`，候选 `056e9d3c…`；页面基线 `88c93913…`，候选 `240bea05…`；新模块 `bf9e13f7…`。

## 行为

新读取器用 `DatabaseSync(..., { readOnly: true })`，再执行 `PRAGMA query_only=ON` 和只读事务，结束关连接。它只处理 `binding_policy === 'ble-key-v1'`。先用当前库里的 `parent_account_id`、`binding_version`、`binding_policy` 对上台账快照，对不上就返回 `unavailable`，不读上一任家长的记录。

历史领证是同一 SN、家长、代际上 `MAX(claimed_at_ms)` 和 `MAX(activated_at_ms)`，不看这行是否已撤销。本轮进度另取一行：未撤销优先，其次 `bound_at_ms`、`rowid`。没有未撤销行时，状态是 `revoked`。状态优先级是撤销、已认证、已领证待认证，最后才用领证窗口。窗口过期只进配对列。

库缺失、表缺失或查询失败时，选中的 BLE 行都是 `unavailable`，页面写「领证状态暂不可查」和「配对状态暂不可查」。查询结果不带 `credential_pk`、nonce 或 token。非 BLE 仍走原来的 `credential_expires_at`。

页面把「本轮已撤销」放在「本轮配对」列。凭据列写「已有自动领证记录」「到期时间未记录」，标题写明不代表凭据当前有效。领证截止的提示写明不是凭据有效期。

## 证据

我看过日志和脚本，没有重跑会写临时文件的测试。

- `status-test.log` 为 15/15，用例覆盖空记录、历史领证与本轮未领证分离、窗口边界、已领证未认证、只认真实认证、撤销不显示为进行中、换绑隔离、错家长/错代际、20 次只读不改行、缺库不创建、缺表不报未签发、legacy 不开库、管理 GET 不写库且不回密钥、旧字段原值、guest 403、BLE 手工发证仍 `device_proof_required`。
- 提交后 staging（Node v22.22.2）再次记录该 15 项 exit 0，以及 BLE HTTP、simple-binding exit 0。`runtime_files_untouched: true`。
- 本地重跑日志：registry `28 passed / 0 failed`，pairing `pass=148 fail=0`。第一次四套都是临时目录缺 `tsx`，不是断言失败。
- `ui-test.log` 在提交之后，内容与脚本末行一致：`PASS 18 UI checks`。截图文件在，审查环境没能把 png 当图片打开。
- `rollback-rehearsal.json` 写明 `production_touched: false`。发布前 API 样本里该 BLE 设备还没有 `ble_status` 对象。

本地 registry/pairing 日志时间是 08:48，提交是 08:51:47。这两套没有出现在提交后的 staging 记录里。改动面不碰它们的写路径。

## 非阻断

读连接没有 `busy_timeout`。短锁时这次 GET 上的 BLE 行会一起变成「暂不可查」，接口仍返回 200，也不会显示成「未签发」。

凭据列的认证时间是该家长、该代际全部回执里最晚的 `activated_at_ms`。本轮若是「已领证 · 待设备认证」，旁边仍可能出现上一轮的认证时间。待领证和窗口过期有「分别记录」一句，待认证没有同样一句。撤销文案在配对列，凭据列没有改成 JWT 失效。

发布脚本不在这 6 个文件里。它在 `pm2` 重启之后如果断言失败，脚本正文不会调用 `restore`。这交给主13在发布时处理。
