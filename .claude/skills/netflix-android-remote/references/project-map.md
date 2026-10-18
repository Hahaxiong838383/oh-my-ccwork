# 项目入口与已验基线

本页是2026-10-18的定位快照；后续版本与设备入口以源码 `DEPLOYED.md` 的最新段和运行态核对，不把本页作为实时配置。

| 内容 | 路径／指针 |
|---|---|
| 独立源码仓内目录 | `~/home-lan/4-Assets/Code/netflix-remote-bridge/` |
| 核心实现 | `BridgeService.java`、`CandidateTree.java`、`NodePolicy.java`、`PlayerPolicy.java`、`FeedPolicy.java`、`FeedNavigator.java`、`SeekPolicy.java`、`KeyState.java`、`LocalFeedInput.java` |
| 构建与测试 | 同目录 `build.sh`、`test/`、`test/fixtures/`；已有本机Android工具链，无需再装Gradle |
| 当前部署说明 | 同目录 `DEPLOYED.md` 末尾“预览滚动与进度条修复（当前部署）” |
| 最终报告 | `~/mycc/2-Projects/vps-proxy/2026-10-18-Netflix预览滚动与进度条修复.md` |
| 运行态证据 | `~/home-lan/runtime/netflix-20261018/scroll-seek/`，不入源码提交 |
| 签名路径 | `~/.local/share/netflix-remote-bridge/private-signing`，仅供构建引用 |
| 签名备份 | Vault条目“Netflix 遥控适配 APK 签名”；恢复凭据时使用现有 `secrets-vault-ops`，不把密钥／密码写进技能、报告或记忆 |

已验基线是 **0.1.8/code13**：154项自动检查；设备 APK 与交付 SHA 一致。code12 连续浏览20个实际可见影片到末尾，再反向回看；code13 修改长按计时，安装后另验3片 Feed 与 seek、取消、隐藏双OK、继续观看、字幕入口。不要把code12完整20片写成code13重新跑过20片。

code13证据应使用 `final13-feed-*`；`code13-feed-*` 是未成功进入 Feed 的探索样本。将证据名与有效断言对应，不能从文件存在推定通过。

本轮范围是向下滚动和 seek；列表 LEFT/RIGHT 仍走通用几何导航。用户已决定后续换设备并停止4K调查，此技能不继续DRM／4K改造。

停用：辅助 App 开关，或 `pm disable-user --user 0 cn.hahaxiong.netflixremote`。卸载前核当前辅助包 UID 并撤销其既有 Magisk 策略，再仅移除本服务。2026-10-18 UID为10080是历史值，后续安装不硬编码复用。

GitHub归档快照：`~/mycc/2-Projects/vps-proxy/netflix-tv/`，包含源码与逐文件SHA清单；修改真源仍是home-lan，发布时同步快照，不能分别改两份。
