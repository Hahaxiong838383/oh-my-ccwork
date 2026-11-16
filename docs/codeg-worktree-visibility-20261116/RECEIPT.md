# 小程序R1工作树会话可见性修复

2026-11-16当前前端升级后又使用忽略parent_id的默认store。真实352存在folder57、parent13，正文可读；旧实际HTTP wrapper→store→侧栏投影显示57/65为空。
本次仅修当前两份store：请求includeChildren并允许跨文件夹、独立工作树的delegate进入顶层，保留同目录子任务嵌套、loop过滤、原parent/external ID和删除保护。两个实际模块各9断言通过；真实列表投影352/350及父13保留。
新内容版本URL发布，两新JS+八份HTML/Flight引用，保留旧JS；实际SW旧缓存反例、新URL取新内容、API/WS直通测试通过。线上10文件HTTP SHA一致。
入口：工作树folder57「P003 小程序真实数据R1｜开发与联调」，会话[352](codeg://session/352)「P003 小程序真实数据R1｜服务端开发与自检」。旧会话和正在开发的任务未搬迁或重启，未写Codeg数据库。
当前CUA无可用应用/浏览器，因此没有视觉验收。用户刷新Codeg加载新资源后验证画面；不能用接口列表结果冒充已经看见用户屏幕。
运行备份与可执行回滚脚本：/Users/fu-121/.local/state/codeg-worktree-visibility-20261116；回滚仅本次八份路由引用，先CAS核SHA，不回灌DB。脚本应从私有目录运行，那里包含原件及cache-publication-v2完整包；本仓为审计归档，不冒充可独立运行的备份包。
本次为当前安装包资源修复，未声称已合并Codeg上游源码；未来升级需复核该规则。

署名：codex（OpenAI）｜2026-11-16
