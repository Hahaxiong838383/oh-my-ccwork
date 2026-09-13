#!/usr/bin/env bash
# B104 全量接入观测（worker 侧，只读；跑在 64.90）。用法：bash b104-adoption-worker.sh <SINCE_UTC_ISO>
set -u
SINCE="${1:?SINCE_UTC_ISO}"
for u in voice-worker-firstturn voice-worker-rust; do
  systemctl list-units --type=service --all --no-legend "$u.service" | grep -q "$u" || { echo "NO UNIT $u"; continue; }
  echo "== $u $(systemctl is-active "$u") MainPID=$(systemctl show -p MainPID --value "$u") NRestarts=$(systemctl show -p NRestarts --value "$u") MemoryPeak=$(systemctl show -p MemoryPeak --value "$u") =="
  J=$(journalctl -u "$u" --since "$SINCE" --no-pager -o short-iso 2>/dev/null)
  echo "-- 接房 per 设备 --"; echo "$J" | grep 'accepting job_id' | sed -E 's/.*room=sn-([A-Za-z0-9]+)-[0-9]+.*/\1/' | awk '{print substr($1,1,3) "…" substr($1,length($1)-7)}' | sort | uniq -c | sort -rn
  echo "-- 并发（accept-close 回放）--"; echo "$J" | grep -E 'accepting job_id|job closed' | awk 'BEGIN{c=0;p=0;t="-"}/accepting job_id/{c++; if(c>p){p=c;t=$1}}/job closed/{c=(c>0)?c-1:0}END{print "peak=" p " at=" t " now=" c}'
  if [ "$u" = voice-worker-firstturn ]; then
    echo "-- ordered_pcm result outcome/reason --"; echo "$J" | grep 'ordered_pcm result' | grep -oE '"outcome":"[a-z_]+"|"reason":"[a-z_]+"|"no_task_reason":"[a-z_]+"' | sort | uniq -c
    echo "-- end candidate published: $(echo "$J" | grep -c 'end candidate published') --"
    echo "-- 首句 held 文本长度分布 --"; echo "$J" | grep 'speculation on held final' | grep -oE 'chars=[0-9]+' | sort | uniq -c | sort -t= -k2 -n
  fi
  echo "-- playout underrun（有 underrun 的 turn / 总 turn）--"; echo "$J" | grep 'playout metrics' | awk '{u=0; for(i=1;i<=NF;i++) if($i ~ /^underrun_count=/){split($i,a,"="); u=a[2]} if(u+0>0) n++; t++} END {print (n+0) " / " (t+0)}'
  echo "-- WARN/ERROR: $(echo "$J" | grep -cE ' WARN | ERROR ') --"
done
