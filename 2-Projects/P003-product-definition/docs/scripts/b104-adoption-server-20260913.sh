#!/usr/bin/env bash
# B104 全量接入观测（server 侧，只读；跑在 aliyun-hk）。用法：bash b104-adoption-server.sh <SINCE_UTC_ISO>
# 输出全部脱敏：SN 只留 头3…末8（末 4 位会把不同批次码撞成一台）。
set -u
SINCE="${1:?SINCE_UTC_ISO e.g. 2026-09-14T00:00:00Z}"; S=$(date -u -d "$SINCE" +%s)
L=$HOME/.pm2/logs/p003-voice-out.log
echo "-- 策略 --"
grep -E '^ONESHOT_FIRST_TURN_(POLICY|AGENT_NAME)=' /opt/p003/server/.env.local
grep -h '\[admin-oneshot\]' "$L" | tail -n 1 | sed -E 's/by=[^ ]*/by=<admin>/'
echo "-- 签发明细（房 epoch ≥ $S）：次数 设备 contract policy src supports --"
grep -h '\[device-session\] ok' "$L" | awk -v since="$S" '{ sp="supports=?"; c="contract=?"; p="policy=?"; ps="policy_src=?"; for(i=1;i<=NF;i++){ if($i ~ /^room=/){ split($i,a,"-"); ep=a[length(a)] } if($i ~ /^sn=/){ s=substr($i,4) } if($i ~ /^contract=/){ c=$i } if($i ~ /^policy=/){ p=$i } if($i ~ /^policy_src=/){ ps=$i } if($i ~ /^supports=/){ sp=$i } } if(ep+0 >= since) print substr(s,1,3) "…" substr(s,length(s)-7), c, p, ps, sp }' | sort | uniq -c | sort -k2
echo "-- 判定：设备 → One-shot 状态（last=最近签发房 epoch）--"
grep -h '\[device-session\] ok' "$L" | awk -v since="$S" '{ sp="supports=-"; c="contract=-"; for(i=1;i<=NF;i++){ if($i ~ /^room=/){ split($i,a,"-"); ep=a[length(a)] } if($i ~ /^sn=/){ s=substr($i,4) } if($i ~ /^contract=/){ c=$i } if($i ~ /^supports=/){ sp=$i } } if(ep+0 >= since){ k=substr(s,1,3) "…" substr(s,length(s)-7); tot[k]++; if(c=="contract=first_turn_v1") ft[k]++; if(sp!="supports=-") su[k]++; if(ep+0>last[k]) last[k]=ep+0 } } END { for(k in tot){ st=(ft[k]>0)?"ONESHOT":((su[k]>0)?"声明了能力但未签合同(查策略/agent)":"仍旧端或未升级"); printf "%s 签发=%d first_turn_v1=%d supports=%d last=%d → %s\n", k, tot[k], ft[k]+0, su[k]+0, last[k], st } }' | sort
echo "-- OTA 最近状态 per 设备 + 最近 3 个发布 --"
cd /opt/p003/server && NODE_OPTIONS=--experimental-sqlite node -e '
const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("data/ota.db",{readOnly:true});
const rows=db.prepare("select sn,version_code,version_name,last_check_at,last_result_json from ota_device_status order by sn, updated_at desc").all(); const seen=new Set();
for(const r of rows){ if(seen.has(r.sn)) continue; seen.add(r.sn); let st=""; try{ const j=JSON.parse(r.last_result_json||"{}"); st=(j.status||"")+(j.error?"("+j.error+")":"")+(j.to_version_code?" →"+j.to_version_code:""); }catch{}
console.log(r.sn.slice(0,3)+"…"+r.sn.slice(-8), "vc="+r.version_code, r.version_name, "check="+new Date(Number(r.last_check_at)).toISOString().slice(0,16)+"Z", st) }
for(const x of db.prepare("select version_code,version_name,enabled,rollout_sns,force_install,install_hint from ota_release order by version_code desc limit 3").all()) console.log("release vc="+x.version_code, x.version_name, "enabled="+x.enabled, "rollout="+(x.rollout_sns?"灰度("+x.rollout_sns.split(",").length+"台)":"全量"), "force="+x.force_install, x.install_hint);' 2>/dev/null
