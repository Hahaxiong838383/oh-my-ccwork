# EasyTier 组网速查 Tab — 2026-09-22

## 交付

localhost:8888 新增独立「EasyTier 组网速查」Tab。原「EasyTier 组网」的操作、拓扑保留，原香港静态速查页也保留链接，不覆盖远端站点。

- 从 `scripts/common.sh` 的 ET_NODES 读取登记节点（只解析文本，绝不source执行或导出第五列凭据）。
- 与实时peer/route合并，展示组网IP、P2P/中继、通道、延迟、导出子网、最近观测及SSH服务响应。
- 未观测的登记节点保留，不把“本轮没看见”直接等同关机。新peer自动加入；已发现peer消失后保留最近观测记录；组网IP变化取消旧SSH快捷命令并提示。
- 本机物理IP实时显示；不伪造其他节点的实时物理LAN地址。子网服务的“实际局域网地址”是已登记映射目标，不是远程DHCP探测结果。
- SSH快捷命令先核对本机实际alias→VIP匹配；无alias时仅使用已登记用户名。香港旧hostkey有提醒，不自动改known_hosts。
- 周期性探测只读banner，不登录、不执行远程指令；共用原三个关键目标结果，不重复探测它们。
- PRNAS HTTP5000/HTTPS5001、公司网关、家庭路由器有独立服务检测。GET只取响应状态、不读业务内容、不跟随跨站跳转、不忽略TLS证书，明确区分超时、HTTP响应和证书问题。
- 独立监控后台约30秒采样，页面每5秒取状态；“立即检测”复用受保护的既有接口。超过90秒或监控失败不沿用旧绿灯。后台不靠网页保持打开。

## 实测

- 初始登记9节点，当前peer可见7（含Air），6个远端SSH服务响应；linux-lan与maxtkf-server当前未观测。
- PRNAS5000 HTTP200；5001 TLS到达但自签证书待处理；公司网关HTTP301；家庭路由器HTTP200。
- 从Air的一次完整新增采样约398ms。并行数上限4，固定探测目标，无任意IP输入接口。
- 67/67测试通过（旧50＋新增17），JavaScript语法/DOM引用检查通过。
- 浏览器实际加载新Tab、查看节点/子网结果、勾选筛选、点击立即检测并刷新采样；旧组网Tab保留。
- 仅重载Air的 `cn.easytier.air-monitor` 与 `com.xray.manager`；未重启EasyTier/Xray或远端机器，1052-OS保持上次维护后的停止状态。

## 文件与回滚

新增：`easytier_reference.py`、`easytier-reference.html`、`test_reference.py`。
修改：`easytier_monitor.py`（采集与持久化速查状态）、`easytier_manager.py`（插入Tab与页面）。运行文件均在 `~/xray/`。

旧runtime备份：`~/Library/Application Support/EasyTierManager/runtime-before-reference-20260922-230959/`。
回滚前校对并发变更，恢复备份中的两个Python文件，再重载monitor/manager；新文件可保留但不再被引用。不要恢复整份Xray配置或重启其引擎。

## 根治边界

Mini重启清除了当前TCP时钟/端口耗尽状态，没有修复macOS26.2内核代码。继续用同版本长期运行仍有复发风险；此次没有升级系统、启用定时重启或切换公司子网主网关。真正代码级根治需核实修复版本后升级；也可另行评估让Linux dev198主承接公司子网，不能把新监控页面当作内核修复。

2026-09-22 用户接受本次速查界面与维护结果，明确授权更新共享记忆并commit/push；通过独立工作区、文件白名单收口到代码仓main，记忆独立提交。提交回执记录于共享事件流。
