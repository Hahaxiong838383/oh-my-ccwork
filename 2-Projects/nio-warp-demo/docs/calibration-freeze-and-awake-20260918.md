# 2026-09-18：现场校正参数固化与显示器常亮

用户确认当前参数已调整完成。本次保存校正基线、关闭自动显示器休眠和屏保，随后确认ProtoPie预览状态。App保持v0.11.4(31)，没有重建或重启应用。

## 固化参数

- App内新增命名预设 **`0918-44.8-2-固化`**，保留原有3个预设。
- 完整可导入快照：[20260918-AUO-44.8-confirmed.json](../calibrations/20260918-AUO-44.8-confirmed.json)。由用户授权固化的几何配置入Git；全量系统偏好、ProtoPie链接及凭据不入Git。
- JSON SHA256：`1dfa5155d24227516106847e42fd56971d3d09d6ada231ffea6323aec37bb481`。
- 开发机独立备份：`/Users/futurus/mycc/2-Projects/nio-warp-demo/.rollback/calibration-freezes/20260918-024521Z`，含完整偏好、独立配置、预设记录、电源设置及屏保原键状态。目录0700，完整偏好0600。
- 新预设与当前活动配置逐字段相同；与操作前读取的用户确认配置相同。实际`ConfigurationStore.importData`在隔离suite中导入/导出往返完全一致，没有向活动配置试导入。
- 生产网格27939顶点验证有效，折叠、无效坐标、边界相交和异常缩放均0。11650/27939采样位于AA外，沿用现场的裁切行为，不改变曲面。

基础参数摘要（完整精度及局部/贝塞尔数据以JSON为准）：

| 参数 | 值 |
|---|---:|
| Warp强度 | 0.356381479 |
| 上下弧度 | 2.013299441 |
| 垂直压缩 / 拉伸倍率 | 1.458193771 |
| 旧基础垂直参数 | 0.6 |
| 左右不对称 | -0.008224219 |
| 整体倾斜 | 0.006174627 |
| 水平弯曲 | 0.001642189 |

快照面向AUO 7680×936和当前光学装置；恢复方法见[校正参数目录](../calibrations/README.md)。

## 常亮设置

原系统已设`sleep=0`、`SleepDisabled=1`，但显示器休眠仍是电池2分钟、接电10分钟。本次最小变更：

```sh
sudo pmset -a displaysleep 0
defaults write com.apple.screensaver idleTime -int 0
defaults -currentHost write com.apple.screensaver idleTime -int 0
```

读回验证：电池/接电的`displaysleep`均0（永不）；原系统禁休眠和其他电源键保持。用户及本机屏保`idleTime`均0；密码锁定键未改变。未增加后台保活服务。

CoreGraphics即时检查内屏和AUO外屏均online/active且`asleep=false`，会话未锁定，接电100%。独立只读复核通过；没有将即时检查称为长时间无人值守验收。

恢复原自动黑屏策略：

```sh
sudo pmset -b displaysleep 2
sudo pmset -c displaysleep 10
defaults delete com.apple.screensaver idleTime
defaults -currentHost delete com.apple.screensaver idleTime
```

原两处`idleTime`键均不存在，因此回滚删除新增键即可；不恢复整个偏好域。

## ProtoPie准备状态

用户确认时的快照已是`render.testPattern=off`，最终活动配置也保持关闭标定网格；完整配置全部字段与固化快照相同，命名预设未改变。验收中仅操作过显示开关，形成正常历史记录，未改校正数值；原历史已随完整偏好备份。界面停在「ProtoPie联动」，实际状态为「预览与 Warp 捕获已接通」。没有替换原型来源或改ProtoPie内容。

证据保存在`artifacts/calibration-freeze-20260918/`及开发机配对备份；完整偏好为本地私有备份，只有独立校正JSON/清单和本说明进入代码仓。

署名：codex（OpenAI）| 2026-09-18（Asia/Shanghai）
