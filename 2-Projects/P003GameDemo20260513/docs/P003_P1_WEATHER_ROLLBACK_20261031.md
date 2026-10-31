# P003 P1 天气修复回滚记录

发布：2026-10-31，北京时间；Brain 14:52:21 健康，普通 Worker 14:53:49 注册正常。

## 恢复点

| 对象 | 原 SHA-256 | 本批新 SHA-256 |
|---|---|---|
| 普通 Worker 二进制 | `a00744bfb55478e9d549d19f8712e643e2d9234901aa81e3cb93855c4b5ceb2d` | `cbe8c79124a718c913a3e1dc9e7cb7119809ef9f19b32895f206e83bdbe066f6` |
| 主 Brain 天气文件 | `7063e076eea7713139305f2ee567424c5b2e9217c79e14cb44ccee552ebe216f` | `64527be87f0fdf9ff0630013b4ce35b27587cc054bab9e032582780090b3231d` |
| 主 Brain 路由预览 | `0a442a39a9b349eb4a62f9e8ad44a40ce3f59a28ed474358e04fc54260f1db04` | `17a2cc22538c0fbc3af8fba4d72ec25112242d434b4e5a7ca2db523ca0eabb09` |

Worker 原件：`/root/rust-worker/backups/p1-weather-20261031T064800Z/voice-rust-worker`。

Brain 原件：`/opt/p003/backups/p1-weather-20261031T064800Z/src/tools/fixed-weather.ts`、`bin/search-route-preview`。

两端目录内 `manifest.json` 保存旧文件、环境指纹、进程及配置快照；`deployed.json` 保存本批实际发布时间及核验结果。原件已逐项核 SHA。

## 正常恢复顺序

1. 先读当前服务版本、完整房间数和在途任务。等待通话结束，不直接中断用户。
2. 比较当前目标文件仍是上表本批版本；若已有更新，先做新的恢复点并按差异撤回，不能直接覆盖。
3. 停普通 `voice-worker-rust`，用原件通过同目录临时文件、核 SHA、原子替换恢复 `/root/rust-worker/voice-rust-worker`，保留执行权限，再启动。确认重新注册及 `/proc/<PID>/exe` 的 SHA。
4. 恢复主 Brain 的 `src/tools/fixed-weather.ts` 与 `bin/search-route-preview`，只对 `p003-voice` 做一次受控重启。确认本地 `http://127.0.0.1:3001/health` 正常；公网 `/v1/internal/search-tasks` 无认证应返回 401。
5. 核 P1/P2 范围、期限、倾听总闸、Analytics、个人语音、P2 与倾听 Worker 均保持，复核管理后台预览与 Worker 属于同一解析版本。

本批安装脚本具有启动/健康失败自动恢复该服务原件的处理；本次实际部署成功，没有执行运行回滚。只备份与检查，不等于已经做过新→旧→新运行演练。

## 边界

- 不恢复整份旧 env，不回灌用户数据库、人格、埋点、任务账本、天气额度。
- 代码分支只管理本次天气补丁。Worker 基于普通线上 `8a343694`；Brain 基于与线上天气文件同字节的 `6fb9287a`，部署仅一个 TS 文件，**不能整分支覆盖当前 Brain 的倾听或其他新代码**。
- 真实地区未覆盖时的市级参考会随 Brain 文件回退而撤销；全量撤回必须同时恢复 Worker 和预览。
- 此前 RTC 重复身份退房缺陷不在本批改动内，回滚也不能解决它。
- 私有原始取证与发布脚本在调查机 `/Users/fu-121/.local/state/p003-p1-weather-02000038-20261031/`；不把私有凭据、对话日志或录音提交 Git。

署名：codex（OpenAI）| 2026-10-31 14:56 CST
