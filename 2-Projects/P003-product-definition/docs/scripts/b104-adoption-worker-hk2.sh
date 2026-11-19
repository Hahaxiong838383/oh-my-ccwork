#!/usr/bin/env bash
# B104 全量接入观测（worker 侧，只读；跑在 hk2 64.90.13.177，单池 voice-worker-rust）。用法：bash b104-adoption-worker.sh <SINCE_UTC_ISO>
# 2026-09-23 阶段 3：由老机版（两池 firstturn/rust）改为单池；One-shot 房与普通房同池，One-shot 相关行（ordered_pcm/end candidate/held）只在 One-shot 房出现，天然分流。
set -u
SINCE="${1:?SINCE_UTC_ISO}"
u=voice-worker-rust
systemctl list-units --type=service --all --no-legend "$u.service" | grep -q "$u" || { echo "NO UNIT $u"; exit 1; }
echo "== $u $(systemctl is-active "$u") MainPID=$(systemctl show -p MainPID --value "$u") NRestarts=$(systemctl show -p NRestarts --value "$u") MemoryPeak=$(systemctl show -p MemoryPeak --value "$u")"
J=$(journalctl -u "$u" --since "$SINCE" --no-pager -o short-iso 2>/dev/null)
echo "-- 接房 per 设备（末 8 位）--"; echo "$J" | grep 'accepting job_id' | sed -E 's/.*room=sn-([A-Za-z0-9]+)-[0-9]+.*/\1/' | awk '{print "…" substr($1,length($1)-7)}' | sort | uniq -c | sort -rn
echo "-- 房数 $(echo "$J" | grep -c 'accepting job_id')；其中 One-shot 房（有 ordered_pcm result）$(echo "$J" | grep 'ordered_pcm result' | grep -oE 'room=sn-[A-Za-z0-9]+-[0-9]+' | sort -u | wc -l) --"
echo "-- 并发（accept-close 回放）--"; echo "$J" | grep -E 'accepting job_id|job closed' | awk 'BEGIN{c=0;p=0;t="-"}/accepting job_id/{c++; if(c>p){p=c;t=$1}}/job closed/{c=(c>0)?c-1:0}END{print "peak=" p " at " t}'
echo "-- ordered_pcm result outcome/reason --"; echo "$J" | grep 'ordered_pcm result' | grep -oE '"outcome":"[a-z_]+"|"reason":"[a-z_]+"|"no_task_reason":"[a-z_]+"' | sort | uniq -c
echo "-- end candidate published: $(echo "$J" | grep -c 'end candidate published') --"
echo "-- 首句 held 文本长度分布 --"; echo "$J" | grep 'speculation on held final' | grep -oE 'chars=[0-9]+' | sort | uniq -c | sort -t= -k2 -n
echo "-- playout underrun（有 underrun 的 turn / 总 turn）--"; echo "$J" | grep 'playout metrics' | awk '{u=0; for(i=1;i<=NF;i++) if($i ~ /^underrun_count=/){split($i,a,"="); u=a[2]} if(u+0>0) n++; t++} END{print n+0 "/" t+0}'
echo "-- 语音控设备：提案 $(echo "$J" | grep -c 'device command proposed') / 语法命中 $(echo "$J" | grep -c 'device grammar hit') / 慢路压制 $(echo "$J" | grep -c 'llm device intent suppressed') --"
echo "-- WARN/ERROR: $(echo "$J" | grep -cE ' WARN | ERROR ') --"
