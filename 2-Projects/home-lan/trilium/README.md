# TriliumNext 飞牛2维护

部署真源：本目录；远端审查快照：私有 oh-my-ccwork 的 `2-Projects/home-lan/trilium/`。源码单独拉取到 `~/home-lan/runtime/trilium-upstream/`，不将整个上游源码嵌入运维仓。

只保存脱敏部署配置、版本锁、检查脚本与验收记录。NAS 数据、备份、登录密码和 ETAPI token 不进入 Git。部署使用官方固定版本和摘要，每周检查只创建维护 PR，不更新生产。

运行态：NAS `/vol1/1000/docker/trilium/`；每周检查结果：home-studio `~/.local/state/trilium/update-status.json`。

## 运维约定

- 入口：`http://192.168.1.115:38081/`，绑定 NAS 局域网地址；没有新增公网映射或域名。
- 单用户登录密码及维护 ETAPI token：密码库条目「飞牛2 TriliumNext 登录与维护」，不要把值复制到本目录。
- `compose.yaml` 与 `desired.json` 是期望部署版本；`deployed.json` 是部署时实测版本，PR 合并不会自动改变它。
- 自动备份由 Trilium 原生机制执行：每4小时检查每日/每周/每月备份，启动5分钟后首次检查，目录独立挂载 `backups/`。它仍与数据在同一台 NAS，不能代替异机灾备。
- 首次验收已将生成的数据库备份放入独立容器，回读同一测试笔记和附件并核哈希；结束后删除恢复测试容器和恢复目录。备份及原始数据不进 Git。
- 数据库格式升级后不能只回退镜像。需停服务，备份当前状态，将升级前数据库和相应运行配置恢复，再用匹配镜像启动，验证正文附件后开放访问。

## 每周上游跟踪

`trilium-upstream-check.timer` 每周一09:20（Asia/Shanghai）执行，Persistent=true，home-studio 已启用 linger。断电期间错过的运行会在下次恢复后补执行。

检查脚本从密码库既有「GitHub token - 大权限」条目读取 GitHub 授权（按条目ID精确定位，避免同名前缀匹配到另一条目），仅在内存使用；GitHub 和 Docker 公共元数据经本机10808代理访问，失败不直连兜底。源码 fetch 更新 refs，不切换正在审查的稳定版工作区，不运行新源码。

无变化不创建 PR；有变化则向私有 `Hahaxiong838383/oh-my-ccwork` 创建一条草稿 PR；已有未关闭 PR 时继续记录检查结果，不改动正在审阅的分支。检查发布标签、镜像摘要、linux/amd64 清单，并附提交比较链接。没有执行候选镜像业务验收时，PR 会明确标明未验项目；不自动合并、不自动部署。

部署代码和凭据读取依赖 home-studio、其网络代理、密码库本地解锁状态及 GitHub 授权有效；任一失败时本次 service 失败并在 `~/.local/state/trilium/update-status.json` 留下失败状态，不伪报成功。查看：`systemctl --user status trilium-upstream-check.service`。

远端维护 PR 是待审候选。实际升级时先把已审变更回收到 home-lan 真源，在隔离实例验收并备份，再部署并更新 deployed.json 与验收报告，最后发布新快照。

## 当前范围

2026-10-23 已将 OK笔记405篇、2743个原附件与6个历史版本迁入独立目录，验收后卸载原应用；详见项目报告11与 `../oknote-to-trilium/README.md`。此前手动配置与原有笔记保持。未扫描或导入 mycc/MyAgent 文件，未启用自动文件写回或云端 AI。界面语言简体中文。

浏览器验收：桌面中文界面登录、Markdown实际编辑、服务端回读及刷新后内容持久化通过；手机尺寸浏览器登录和查看通过，未做真实手机验收。早期脚本在应用初始化未完成时导航曾触发前端异常，正常进入后复测未再出现；首次编辑定位误选快速搜索框已修正为正文编辑器，不能把那次结果算作保存成功。

后台凭据验收发现：Codeg credential helper 在本轮交互会话可用，但 systemd 环境不可用；定时任务改用密码库中已有的「GitHub token - 大权限」（另一条目缺少PR权限，真实接口返回403），未新建或轮换 GitHub 凭据。

真实后台验收：第一次 systemd 执行已创建 [PR #2](https://github.com/Hahaxiong838383/oh-my-ccwork/pull/2)，第二次执行返回 pr_pending_review，PR head 未变化。两次 service 均 exit 0；下次2026-10-26 09:20 CST。见 weekly-validation.json。

自动备份边界：新库初始化会把上次日/周/月备份时间设为初始化时刻，首次周期尚未到；启动5分钟只检查是否到期，不保证立即创建周期备份。本轮已主动创建并校验初始备份，恢复演练也已通过。
