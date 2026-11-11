# 容量夹具修正
首轮15案中的candidate-capacity失败，保留ISOLATED_RESULT与原hash。已独立读日志：倾听分支在第二房派单请求明确输出 at full capacity, declining job 且active=1；无第二job_assignment_received。旧夹具硬要求主池特有available=false广告日志，错误拒绝了直接decline的正确实现。
新断言接受有证据的两种机制（广告unavailable或同第二房direct decline），仍必须无超额assignment、持有者关闭后下一房ready+问答成功、全部房删除与进程回收。仅更改夹具，不修改生产/业务阈值。复验单独新目录。
