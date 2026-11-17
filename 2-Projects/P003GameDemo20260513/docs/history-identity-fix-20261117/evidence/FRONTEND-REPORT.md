# 前端实施与验证

已完成前端三块接线，等待根代理最终 review、上线及生产验证；未自行 commit 或部署。

## 行为

- 小程序与 admin 接同一 observations / historical_usage 合同。旧奖励、道具、补勤卡、进度独立分页；保留来源不明、设备时间可疑和覆盖不完整说明。历史记录数不是获得总量，钱包无上报不补 0。
- 小程序及 admin 优先 total_seconds，今日 24 秒不会显示为 0 分钟；历史 5003 秒显示 83 分 23 秒。服务端合并后总量直接展示，不在前端重复累计。区分有效使用片段与补充用时。
- 微信 weapp 使用手机号授权 code + Taro.login code + getAccountInfoSync AppID，发送服务端核验；保留短信和 H5。已登录提供同账号身份补齐。公开 config 未就绪禁用微信按钮，已有身份可读。
- 授权 code 过期不清短信会话，真实 JWT 401 仍清空；退出后迟到授权/数据不能恢复旧账号。
- admin 新历史 tab 与原流水/对话独立筛选游标；真实身份替代静态“未接入”提示，AppSecret 待配置与尚未关联、微信未返回 UnionID 分开显示。

## 新鲜验证

- 测试先行：4 项初始失败（历史映射2、微信API2）后修复通过。真实 snake 合同补测发现仅历史字段时 details 识别遗漏，已修复。
- miniapp typecheck 通过；完整 Vitest 14 文件、111/111 通过。
- admin 实际 Vue/ElementPlus 浏览器通过：52 次 miniapp GET、3 次隔离夹具解绑、0 停用设备写入、0 pageerror；含历史分页、400/410 游标、503 恢复、迟到响应、权限撤销、退出、390px。
- 最终 live H5 build 47.63s、weapp build 16.34s，均成功。API基址 https://kidshub-ai.hahaxiong.cc。
- 最终 H5 构建产物浏览器：6 次隔离业务请求、2 页历史、0 pageerror。验证短信登录、5003 秒与今日24秒显示、真实身份 DTO/UnionID未返回、历史翻页、退出清空、H5无微信专属按钮。
- git diff --check 通过。

## 证据与冻结

- frontend-manifest.json：源文件和两平台全部构建产物 SHA256。
- admin HTML SHA256：aa72315824d1f19926c693eda543e8de2e6de26436255f36b78b71ac73b2e826。
- admin-browser-result.json、h5-browser-result.json、build-h5.log、build-weapp.log。
- history-usage-desktop.png、history-rewards-desktop.png、task-3-390.png、miniapp-h5-history-390.png 均为合成夹具；不能当作生产事实。
- 产物位于 apps/miniapp/dist/h5（9文件）与 dist/weapp（17文件）。
- 源码、测试脚本和产物已冻结。根代理需纳入新增 api-error.ts / observations.ts / wechat-identity.ts，以及 miniapp/scripts/test-history-identity-h5.cjs。

尚未通过真实微信用户完成授权兑换；需有效AppSecret及小程序端用户操作。此项不能由本地构建或mock验收冒称成功。

署名：codex（OpenAI）| 2026-11-17
