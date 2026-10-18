# Netflix 电视源码发布快照

本目录将home-lan中两项Netflix源码按文件归档到oh-my-ccwork私有仓，便于版本控制与恢复；实现真源仍在home-lan。

- `netflix-remote-bridge/`：遥控转换辅助APK0.1.8/code13；构建/签名/真机证据见内部README和DEPLOYED。
- `netflix-cdn-watchdog/`：Reality/HY2视频出口故障切换守护；构建与离线测试见内部README和DEPLOYED。
- `SOURCE-MANIFEST.json`：本次归档文件的SHA256及真源路径，不含生成物。

发布时从`~/home-lan/4-Assets/Code/`同步两目录并重算清单；不要直接修改本快照后忘记回到真源。源码更新不等于电视已安装，设备验收始终单独记录。

签名密钥、token、Netflix原包/数据、运行日志、APK/Dex与build/out不入本目录。构建需要现有Android/JDK工具链，辅助APK更新必须恢复原签名；缺签名不另造。
