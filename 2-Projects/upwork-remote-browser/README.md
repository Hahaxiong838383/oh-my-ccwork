# Upwork 独立远程浏览器

用途：在 home-studio 登录并操作用户本人 Upwork 账号。

- runtime/ 仅保存本机 Firefox 运行态，权限 700，禁止 Git 跟踪或复制到记忆。
- 浏览器独占 DISPLAY :44，不接触微信 :1 或招商 :43。
- 授权窗口仅绑定 127.0.0.1:18767，经 Air 的 SSH 隧道访问。
- 启动脚本临时位于 /tmp/upwork-home-studio-desktop.py；服务为 upwork-browser-session.service，不开机自启。
- 不存明文密码；Google 登录由用户在浏览器完成。
- 当前状态：2026-09-28 12:16 CST 已由用户完成 Google 登录；已在 home-studio 看到账号首页及本人可编辑档案，确认 Chuan C.、$75/hr 与原账号一致。

正式档案：https://www.upwork.com/freelancers/~01fee325b71f754dda

本次临时服务最多运行 4 小时，不开机自启；Firefox 独立 profile 保留，网站仍可能要求重新验证。后续操作使用本机 DISPLAY :44；不要重新调用 Air 上的浏览器 JS。

项目筛选记录：[2026-09-28-job-shortlist.md](2026-09-28-job-shortlist.md)。

2026-09-28 经用户授权，同一独立浏览器也用于 Fiverr、电鸭、Himalayas、Wellfound、We Work Remotely、Remote OK 注册。实际账号状态与待办见 [六平台注册记录](2026-09-28-platform-registration-status.md)；六个平台账号均已创建；连同既有 Upwork，以及本轮恢复登录的既有 X 账号，目前八条账号记录已存入密码库 remote accounts 并回读核对。LinkedIn 未注册成功；部分卖家／求职入驻尚未完成。

2026-09-28 依据履历与本人 AI 辅助开发项目补齐资料的保存状态、作品、材料及剩余缺项见 [平台资料补齐记录](2026-09-28-platform-profile-completion.md)。注册完成与完整入驻分别记录。

2026-09-28续办：用户已确认月薪人民币4万—5万元、每周20—40小时。Upwork、电鸭（人才库93%）、Himalayas、Wellfound资料已保存回读；Wellfound已补7段任职、3项目并纠正同名雇主误关联。WWR停Step3付费，Fiverr地区错误，Remote OK缺可用社交，X旧号永久冻结。以最新平台资料报告为准，不重复索要已确认事实。

浏览器本轮于2026-09-28 16:40:53 CST启动，4小时临时服务预计20:40停止，仍不常驻。X/Google临时PAC已停用，Firefox已恢复Use system proxy settings；未更改全机代理。

2026-09-28 19:07 CST：按用户要求新增小可AI、多模态交互、AI Ontology、H平台四项作品，Upwork由3项增至7项，全部实际发布并刷新逐项回读。第一页已排序为H平台、Ontology、小可AI。完整文案/封面在`4-Assets/career/chenchuan-upwork-expanded-portfolio-2026-09-28.*`及同日封面，链接和阶段见平台资料报告；不重复新增同名项目。
