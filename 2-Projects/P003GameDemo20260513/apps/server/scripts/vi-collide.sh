#!/usr/bin/env bash
# vi-collide.sh —— 虚像距离回读联调「三方对撞」（只读，不动设备、不用 force 接口）
#   ① 64.90 worker journal：该 SN 最近 N 条 device command proposed/result（CST）
#   ② aliyun-hk telemetry.db：该 SN 最近 N 条 image_distance_m / state（CST）
# 用法: scripts/vi-collide.sh [SN后四位=0003] [N=6] [journal起点=-2h]
# 背景: 2026-09-04 003 实机 2.5m / 遥测恒 12m / Android 对 label35 回 boundary_reached（联调单 CC_P003_VIRTUAL_IMAGE_READBACK_MISMATCH_20260904）
set -euo pipefail
SUF="${1:-0003}"; N="${2:-6}"; SINCE="${3:--2h}"
WORKER_HOST="root@64.90.13.177"; SERVER_HOST="aliyun-hk"  # 2026-09-23 阶段 3：生产池已迁 hk2
echo "=== ① worker(64.90) 最近 ${N} 条设备命令 proposed/result  sn=…${SUF}  since=${SINCE}"
out=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$WORKER_HOST" "TZ=Asia/Shanghai journalctl -u voice-worker-rust --since '${SINCE}' --no-pager -o short-iso 2>/dev/null" \
  | sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' \
  | grep -E "device command (proposed|result) .*room=sn-[A-Z0-9]*${SUF}-[0-9]+ " \
  | sed -E "s/^([^ ]+) [^ ]+ voice-rust-worker\[[0-9]+\]: [^ ]+ +INFO /\1 /; s/room=sn-[A-Z0-9]*([0-9]{4})-[0-9]+/sn=…\1/; s/ trace_id=[^ ]+//; s/ normalized_text_hash=[^ ]+//; s/ command_publish_ts_ms=[0-9]+//; s/ result_received_ts_ms=[0-9]+//; s/ asr_final_text_length=[0-9]+//; s/ llm_started=[a-z]+ filler_started=[a-z]+//; s/device command proposed: '[^']*'/device command proposed/" \
  | tail -n "$N" || true)
if [ -n "$out" ]; then printf '%s\n' "$out"; else echo "(窗口内无该 SN 的设备命令——先确认 SN 后四位/窗口，再下结论)"; fi
echo "=== ② telemetry(aliyun-hk) 最近 ${N} 条像距快照  sn=…${SUF}"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SERVER_HOST" "cd /opt/p003/server && node --experimental-sqlite -e '
const { DatabaseSync } = require(\"node:sqlite\");
const db = new DatabaseSync(\"data/telemetry.db\", { readOnly: true });
const fmt = ms => new Date(ms+8*3600e3).toISOString().replace(\"T\",\" \").slice(0,19)+\" CST\";
const rows = db.prepare(\"select captured_at_ms, server_received_ms, payload_json from device_telemetry_snapshot where sn like ? order by captured_at_ms desc limit ?\").all(\"%${SUF}\", ${N});
for (const r of rows.reverse()) { const p = JSON.parse(r.payload_json); console.log(fmt(r.captured_at_ms), \"image_distance_m=\"+p.image_distance_m, \"state=\"+p.image_distance_state, \"(server_received \"+fmt(r.server_received_ms).slice(11,19)+\")\"); }
if (!rows.length) console.log(\"(无快照)\");
' 2>/dev/null"
