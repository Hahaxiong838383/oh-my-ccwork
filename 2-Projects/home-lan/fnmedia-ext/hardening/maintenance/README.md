维护服务在 home-studio 用户 systemd 中运行。runner.py 每分钟消费飞牛1非敏感队列，每小时检查上游；update_prepare.py 只允许受审代码保持不变的文档/版本更新，代码变更显示 needs_review。local_upgrade.py 适配 trim-cli 0.1.1 本地包升级缺口：临时 loopback TLS CONNECT 代理只把该应用的 cloud download 来源改为固定 NAS FPK，之后仍走 CLI 正式 update 检查/任务；不读取、导出或保存 OAuth 凭据。详见上层 README。

运行方式是 home-studio 的 systemctl --user；不是 NAS root 服务。可信源码树必须已将所有新增加固文件纳入 Git（当前39577bd），离线wheelhouse与fnpack放runtime。先启用timer再检查真实heartbeat、request_id消费和up_to_date，不能只看unit已安装。真实失败用例见项目14号报告；App Center拒绝降级时不得称回滚成功。

验证：在本目录运行 `FNMEDIA_SOURCE_TREE=~/home-lan/runtime/fnmedia-ext-managed/source python3 -m unittest discover -s tests`。该变量仅供测试查找插件源码，不含凭据。
