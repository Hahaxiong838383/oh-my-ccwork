# 真实无障碍回归样本

- `cw-nodes.txt`：2026-10-18 真机 `My Netflix` 页 Service dump 的全部 63 个节点。来源 `/tmp/netflix-cw-quality-20261018/my-netflix-service-before.txt`，只复制 `node path=` 行，无账户、文本或 contentDescription。两个不可见包装节点各包含可见可点击的 Continue Watching 播放卡片与 Info/More 子按钮。
- `subtitle-choices.tsv`：同日已选中文字幕菜单 XML 提取的 19 个 checkable 节点，仅保留父路径、边界与 class；8 个音频选项和 11 个字幕选项分属两组。来源 `/tmp/netflix-tv-controls-20261018/subtitles-selected.xml`。

`CandidateTreeTest` 直接使用生产 `CandidateTree` 和 `NodePolicy` 回放样本，不以改写的备用遍历器代替生产路径。

- `player-range-nodes.txt`：2026-10-18 `player-range.txt` 的完整 54 个节点，仅保留无账户/无文本的 dump 行；真实 seekbar=0..1620000 ms、current=1503739 ms，brightnessSlider=0..1。`SeekPolicyTest` 共享生产 CandidateTree/NodePolicy/SeekPolicy 回放可选节点与方向路由。

- `feed-before.txt`、`feed-after-touch.txt`、`feed-top10.txt`：同日 New & Hot 列表滑动前后与 Top10 TV Shows 的结构样本；仅节点属性与结构，不含影片/账户文本。`FeedPolicyTest` 用三份真实树验证内容归属、底栏遮挡、方向路由、稳定回读与按键代次。
