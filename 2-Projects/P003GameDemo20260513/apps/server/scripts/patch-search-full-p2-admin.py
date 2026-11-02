"""Apply only the search pane edits to a fresh production admin HTML snapshot."""
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
def one(old,new):
 global s
 assert s.count(old)==1,('unexpected live HTML',old[:70],s.count(old))
 s=s.replace(old,new,1)
one('P1 全量内测 · P2 双设备灰度 · 搜索在后台执行，普通聊天继续','全量内测 P1 / P2 · 独立候选窗口 · 搜索在后台执行，普通聊天继续')
one(">P1 全量内测</button>",">全量内测</button>")
one(">P2 双设备灰度</button>",">独立候选窗口</button>")
one("当前 P1 状态未知。","当前全量搜索状态未知。")
one("正在读取 P1 全量内测状态…","正在读取全量内测实时状态…")
one("p1.data.settings.enabled ? 'P1 服务端已开启 · 待设备体验核验' : 'P1 搜索未开启'","p1.data.settings.enabled ? (p1.data.settings.tools ? 'P2 全量内测已开启 · 实际体验持续观察' : 'P1 全量内测已开启') : '搜索总闸已关闭'")
one('<h3>P1 开放范围</h3>','<h3>全量开放范围</h3>')
one("p1.data.settings.enabled ? '关闭 P1 搜索' : '开启 P1 全量内测'","p1.data.settings.enabled ? '关闭搜索总闸' : '开启搜索总闸'")
one('持续内测，不继承 P2 的到期时间。总闸关闭后停止接收新搜索，普通聊天继续。','持续内测，不继承独立候选窗口的到期时间。总闸关闭后停止接收新搜索，普通聊天继续。')
one('<h3>P1 部署核验</h3>','<h3>全量部署核验</h3>')
one('P1 只做后台搜索。Tool Calls 与受控网页抓取仅在 P2 页面所示两台设备开放。','P1 支持后台搜索；P2 增加 Tool Calls 与受控网页读取。状态以全量开关及本轮发布核验为准。')
one("d.search_allowed ? 'P1 已允许'", "d.search_allowed ? (p1.data.settings.tools ? 'P2 已允许' : 'P1 已允许')")
one('<div class="kh-card"><h3>内测设备</h3>', '<div class="kh-card"><h3>P2 工具能力</h3><p>为全部符合准入的内测设备开启后台 Tool Calls 与受控网页读取，搜索等待期间仍可聊天。关闭此项退回 P1；已运行任务保留原执行模式，结束后新任务使用当前模式。</p><el-button :loading="p1.saving" :type="p1.data.settings.tools ? \'warning\' : \'primary\'" :disabled="p1.saving || !p1.data.settings.enabled" @click="setP1Tools(!p1.data.settings.tools)">{{ p1.data.settings.tools ? \'关闭 P2，退回 P1\' : \'开启 P2 全量内测\' }}</el-button></div><div class="kh-card"><h3>内测设备</h3>')
one("function setP1Enabled(enabled){", "function setP1Tools(enabled){return mutateP1('/tools',{enabled:enabled});}\n        function setP1Enabled(enabled){")
one('p1:p1,setP1Enabled:setP1Enabled,','p1:p1,setP1Tools:setP1Tools,setP1Enabled:setP1Enabled,')
one("searchLane==='p1' ? 'P1 全量任务路由' : 'P2 双设备任务路由'", "searchLane==='p1' ? '全量内测任务路由' : '独立候选任务路由'")
one('发布全量默认路由，存量及新增内测设备自动使用；不改变 P2。','发布全量默认路由，存量及新增内测设备自动使用；不改变独立候选配置。')
one('只影响所选灰度设备，不开窗、不延窗、不改变 P1。','只影响所选候选设备，不开窗、不延窗、不改变全量内测配置。')
one('仅本页实际名单中的两台设备测试 Tool Calls 与受控网页抓取；其他内测设备使用 P1。','本页只管理独立候选窗口。全部内测设备的 P1 / P2 状态请看“全量内测”页面。')
one('截止后退出重进回到 P1；P2 是否开放以本页实时状态为准。','截止后退出重进回到主链路；主链路 P1 / P2 状态以“全量内测”实时状态为准。')
p.write_text(s)
