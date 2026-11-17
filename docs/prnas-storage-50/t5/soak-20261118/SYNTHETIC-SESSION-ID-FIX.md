# T5 模拟session ID误触发既有校验

独立对账纠正：9a5ac270的1471个HTTP200只有1470份完整ACK，不只是“测试提前中断”。actor37首批实际0accepted、200rejected，理由全部invalid_event；它因此不再继续后29批。NAS已停写只读库核到294000events/seen、588000facts，对应1470批。原失败不能忽略。

精确根因：旧模拟session ID为SHA256十六进制前32位，固定seed load-t5-17-1794949895955-37生成3c13631290378a8de892748812329e1c，其中连续数字被既有safeIdentifier手机号检测拒绝。主13用原值逐一验证全部57种事件均invalid_event，与200条实际拒收一致。不是数据容量故障，生产校验不改。

仅修压测生成器：把hash的0–9一一映射为g–p（保持原a–f），32字符、128bit熵和每run/actor唯一性不变；一次生成后复用。1万合成seed均通过既有ID校验，57种事件逐一通过。遇失败ACK现在原样保存到failed-acks.jsonl后仍终止该actor，不吞失败、不更改门。生产手机号拒绝用例仍通过。

另：9c5154e7拓扑局部测试已在Linux Node24.19.0真实运行通过，550候选文件SHA逐一核同；不是完整混合。9a失败全部53文件已通过实际NAS传输、还原、二次SHA复核；只回收云端已停写810831872字节合成DB缓存，NAS完整原字节与收据保留。首次清理因Python sqlite context未close被fuser正确挡住，修正显式close后才清理，无生产数据操作。

署名：codex（OpenAI）｜2026-11-18
