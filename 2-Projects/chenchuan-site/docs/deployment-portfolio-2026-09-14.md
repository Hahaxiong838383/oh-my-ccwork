# 2026-09-14 个人站文案更新与验收

## 内容与范围

按用户批准的短稿，定位为「AI Native 产品经理」。首页精选顺序为 KidsHub AI、H 平台、MyJavis、公司战略洞察 AI 系统、EvoDesk、全车窗 AR HUD 5.0。全部 14 个旧项目链接保留，新增 H 独立页；旧视频与图片关联、4 篇文章及 15 条 arXiv 链接保留。

项目从需求、使用障碍、产品取舍讲起，技术方案与发布阶段直接显示。保留 Rust 实时双向全双工语音基座、Kotlin/Godot/Rust 分工、one-shot、H 的记忆管理/召回/Harness/运行时设计。one-shot 为专项验收、待合包发布，Warp 为未来 5.0 预研，不新增留存、人效或延迟成绩。

原首页、关于、历史项目、文章、决策示例、AI 讲解提示词和导航引导同步精简。经典内容明确为整理后的示例，去掉未经核实的耗时、效率倍数和虚构模型协作。AI 身份透明，岗位匹配时仍可依据公开项目明确建议进一步沟通。

ERP、GEO 不公开；第三方资讯原文不作批量改写。保留原 Next.js 架构和视觉风格，未迁移站点或改动香港实例。

## 版本

- 基线：`7b9f8e8b`，来自已部署的 8 月工作分支；生产源码与该基线 160 项 SHA 一致。
- 内容：`eb6a011659c4`。
- 构建目录隔离修正：`e92121fad248`。
- 联系入口及静态资源兼容修正：`4e1921037b3d`。
- 任务分支：`codex/chenchuan-site-copy-20260914`，仓库 `Hahaxiong838383/oh-my-ccwork`。
- 主工作区及 8 月 worktree 原有改动未覆盖；仅对本任务文件提交。

## 部署与回滚

域名 `my.chenchuan.cc` 的实时 A 记录匹配韩国 SWAS；所有云 API 限定 `ap-northeast-2` 及匹配实例。生产目录 `/var/www/chenchuan-site`，PM2 `chenchuan-site`。没有查询、登录或变更香港实例。

正式回滚点：

`/var/www/chenchuan-site-backups/portfolio-copy-20260914-e92121fad248`

包含原源码精确归档、缺失文件标记、原 `.next`、前后 SHA、固定回滚脚本、PM2 状态、构建日志，以及视频说明修改前后一致性快照。`contact-followup/` 另存联系入口修复前的源码与构建；最外层备份仍可回到本轮开始前。

回滚命令（仅在已确认的韩国实例执行）：

```bash
bash /var/www/chenchuan-site-backups/portfolio-copy-20260914-e92121fad248/deployment/deploy-portfolio-copy.sh rollback e92121fad248
```

回滚恢复本批目标文件与 `.next`，视频数据库仅通过 CAS 恢复 9 条 description。不会整库恢复或覆盖备份后新增的访问数据。若视频说明被管理员并发修改，会报告冲突，仍尝试恢复其他可安全恢复的部分；不把不完整回滚报告为成功。

构建在 `/var/tmp/chenchuan-site-build-e92121fad248` 完成，复用依赖和媒体，数据库使用一致性副本并显式指定 `ANALYTICS_DB_PATH`。独立端口 canary 通过后使用 Linux `renameat2(RENAME_EXCHANGE)` 交换构建目录，重启精确 PM2 服务。发布不承诺零停机；保留旧 hashed 静态资源，降低旧标签页加载失败的风险。

主上传包 SHA-256：`b0b0394d56cc37544a0606c61625ea961da655f09ee250f58fde9119719f60a6`。
联系入口修复包 SHA-256：`7a2fe3ce6ac4cc04611d709083a1373acabb7a1d2d78489e5fd03ecc755b907f`。

## 已完成的本地验证

- 最终源码 `npm run build` 通过，专利与访问统计测试通过。
- `node scripts/test-portfolio-copy.mjs`：9 组通过；检查旧 slug/媒体、精选顺序、关联、技术可见、阶段与 AI 身份、引用和禁用表述。
- `node scripts/update-video-copy-20260914.cjs self-test`：快照、只读演练、CAS 冲突、精确回滚、后增访问记录和元数据保留、脚本异地依赖解析均通过。
- 视频迁移在韩国节点的 SQLite 副本上执行 apply / verify / rollback 演练通过。
- 桌面与 390×844 本地真实点击项目卡、返回及手机菜单，技术字段可见、无横向溢出。

## 公网验收

2026-09-14，最终修正版通过以下检查：

| 检查 | 结果 |
| --- | --- |
| 桌面 1440×1000、手机 390×844 | 各 27 页通过：首页、关于、项目列表与 15 项目、文章列表与 4 文章、视频、专利、联系、AI 问答页 |
| 页面与布局 | 全部 HTTP 200，无横向溢出、模板占位链接；15 项目的技术方案可见 |
| 媒体资源 | 13 个图片 URL 返回 200；22 个优化视频 URL 返回 Range 206；22 个原片返回 Range 206、video/mp4 且无 X-Media-Fallback |
| 桌面实际点击 | 导航、相关项目、浏览器返回；MyJavis → KidsHub 跳转正常 |
| 手机实际点击 | 展开菜单 → 作品（自动关闭菜单）→ 品牌回首页；KidsHub/H/MyJavis 三张精选卡、相关项目及返回列表通过 |
| MyJavis 实际播放 | 点击原生播放按钮，3.411 秒，readyState=4，960×540，paused=false，error=null；currentSrc 为优化版 |
| HUD 实际播放 | 点击原生播放按钮，3.471 秒，readyState=4，1280×720，paused=false，error=null；currentSrc 为优化版 |
| 浏览器控制台 | 最终版本的桌面、手机会话均 Errors=0 / Warnings=0 |
| 生产一致性 | 41 个部署文件与本地 SHA-256 一致，BUILD_ID=zWo2wwoKXeQpyglupPD36 |
| 服务状态 | PM2 chenchuan-site online，unstable_restarts=0；9 条视频说明 verify 通过；旧 JS 资源 HTTP 200 |

手机首页、KidsHub、H 和桌面视频截图已人工查看，排版与内容正常。另从导航进入 `/radar`，从首页进入 `/lab/ar-hud-demo` 并返回，页面和控制台正常。AI 问答页仅验证加载与入口，不提交对话，不访问管理后台，也不申请麦克风或摄像头权限。验收范围不是对所有浏览器或第三方服务的永久可用性保证。

测试脚本：`scripts/test-public-portfolio-browser.js`，通过 Playwright CLI `run-code --filename=...` 执行。原始日志与截图在任务 worktree 的 `output/playwright/portfolio-20260914/`（本地证据，不整目录提交）：`final-desktop-smoke.log`、`final-mobile-smoke.log`、`final-mobile-console.log`、`final-myjavis-playback.log`、`final-hud-playback.log`、`final-home-desktop.png`、`final-mobile-home.png`、`final-mobile-kidshub.png`、`final-mobile-h.png`。脚本返回结构化结果，避免 CLI 丢失内部 console.log。

回滚脚本由独立代理只读复核：数据库隔离、备份内固定脚本、幂等恢复、交换状态恢复、归档白名单、CAS 冲突处理均通过；`bash -n` 通过。生产正式回滚未执行，以免撤销已验收版本。

项目记忆与共享原子记忆已追加本轮状态，并明确旧香港部署命令和旧项目数量仅供历史参考。记忆文件位于工作区外或符号链接目录，不强制纳入本分支；可提交的事实和经验完整保留在本文。

## 本次排查记录

1. SWAS CLI 的 `--command-content` 接收明文脚本，返回 Output 才是 Base64。最初将输入也编码，导致只读预检失败，没有执行站点修改。
2. 多代理不能同时对同一 worktree 运行 `next build`。一次并发构建造成 `.next` 清理竞态，随后停止重叠构建，由主代理串行重建并通过。
3. 生产 `data` 是指向共享数据的符号链接。`--exclude='/data/'` 不匹配该链接，第一次预构建在创建隔离数据目录时停止，未切换或修改正式站点。改为根锚定 `--exclude='/data'`，同时检查链接缺失并用 `ln -sT` 防止意外嵌套链接。失败尝试保留在 `portfolio-copy-20260914-eb6a011659c4`，只作排查记录，不是正式回滚点。
4. 更新现有站点应保留旧 hashed 静态资源。第一次切换期间浏览器遇到旧 JS 失效；追加旧资源后需让服务重新扫描，确认旧资源返回 200。后续发布脚本在启动前合并资源。
5. 联系页原有 `/images/wechat-qr.png` 返回 404，GitHub/LinkedIn 有模板占位。未编造二维码或账号；移除失效二维码块、隐藏未配置的 LinkedIn，GitHub 改为已核实的本人主页。
6. 凭据检索是模糊匹配；`GitHub token` 同时命中标准与大权限条目。按精确条目 ID 取标准 token 即可，不需要扩大权限。任何凭据值均不入日志、文档或 Git。

署名：codex（OpenAI）| 2026-09-14
