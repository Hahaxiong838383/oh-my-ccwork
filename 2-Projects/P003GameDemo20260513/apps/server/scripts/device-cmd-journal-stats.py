#!/usr/bin/env python3
# device-cmd-journal-stats.py —— 语音设备命令链统计（只读，离线分析 worker journal）
# 用法 A（直连拉取，D1 W4 2026-09-22 起默认新机）:
#   python3 scripts/device-cmd-journal-stats.py --host root@64.90.13.177 --since '-24h'      # 日报
#   python3 scripts/device-cmd-journal-stats.py --host root@64.90.13.177 --since '-7d'       # 周观察
# 用法 B（离线文件，与旧法相同）:
#   ssh root@<host> "TZ=Asia/Shanghai journalctl -u voice-worker-rust --since '-14 days' --no-pager -o short-iso | sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -E '<下面 GREP>'" > /tmp/j.txt
#   python3 scripts/device-cmd-journal-stats.py /tmp/j.txt
# 输出: 提案/结果分布(含快路/慢路)、发布→result 延迟(按 match_type)、芯片候选决策、芯片↔ASR 一致性、LLM 标记、
#       **误触发嫌疑**(慢路提案而原话不含任何设备词根,方案 v1.1 §W4)、设备承接音次数。
# 背景: 2026-09-04 双源单核联调合同 v3 §8.0；D1 W4 日报(2026-09-22)。日志含 ASR 文本，分析文件勿入仓/勿外发。
import re, sys, collections, statistics, argparse, subprocess, tempfile, os
GREP = r"command_word 决策|device command proposed|asr 命中与 command_word 撞窗|device command result|llm device intent|l2 capability|Started|filler picked .*bucket=device"
DEVICE_ROOTS = ("灯","亮","暗","光","色温","模式","音量","声音","大声","小声","静音","吵","听不清","读写台","设备","画面","虚像","台子",
                "升高","降低","抬高","调高","调低","太高","太低","拉远","拉近","调远","调近","太远","太近","暖","冷")
ap=argparse.ArgumentParser(description="语音设备命令链 journal 统计")
ap.add_argument("file", nargs="?", help="离线 journal 文件(与 --host 二选一)")
ap.add_argument("--host", default=None, help="ssh 目标，如 root@64.90.13.177（直接拉 journal）")
ap.add_argument("--unit", default="voice-worker-rust")
ap.add_argument("--since", default="-24h", help="journalctl --since，相对时间(机器多为 UTC，别写本地钟点)")
ARGS=ap.parse_args()
if ARGS.host:
    cmd = (f"TZ=Asia/Shanghai journalctl -u {ARGS.unit} --since '{ARGS.since}' --no-pager -o short-iso "
           "| sed -E 's/\\x1b\\[[0-9;]*[A-Za-z]//g' | grep -E '" + GREP + "' || true")
    r = subprocess.run(["ssh","-o","BatchMode=yes","-o","ConnectTimeout=10",ARGS.host,cmd], capture_output=True, text=True, timeout=120)
    if r.returncode != 0 and not r.stdout:
        sys.exit(f"ssh 失败: {r.stderr.strip()[:200]}")
    tf = tempfile.NamedTemporaryFile("w", delete=False, suffix=".journal.txt", encoding="utf-8"); tf.write(r.stdout); tf.close()
    F = tf.name
    print(f"# source={ARGS.host} unit={ARGS.unit} since={ARGS.since} lines={r.stdout.count(chr(10))} (临时文件 {F}，用后删)")
elif ARGS.file:
    F = ARGS.file
else:
    ap.error("需要 file 或 --host")
kv=re.compile(r'(\w+)=("[^"]*"|\'[^\']*\'|\S+)')
def fields(s):
    d={}
    for k,v in kv.findall(s):
        d[k]=v.strip('"').strip("'")
    return d
def ts(line): return line[:25]
props=[];results=[];cw=[];clash=[];llm=[];starts=[];filler_dev=0
for line in open(F,encoding='utf-8',errors='replace'):
    line=line.rstrip('\n')
    if 'device command proposed' in line:
        m=re.search(r"device command proposed: '([^']*)'",line); d=fields(line.split('device command proposed')[1]); d['ts']=ts(line); d['text']=m.group(1) if m else ''
        props.append(d)
    elif 'device command result' in line:
        d=fields(line.split('device command result')[1]); d['ts']=ts(line); results.append(d)
    elif 'command_word 决策' in line:
        d=fields(line.split('command_word 决策')[1]); d['ts']=ts(line); cw.append(d)
    elif 'asr 命中与 command_word 撞窗' in line:
        d=fields(line.split('撞窗,吞句')[1]); d['ts']=ts(line); clash.append(d)
    elif 'llm device intent' in line:
        kind='observed' if 'observed' in line else ('suppressed' if 'suppressed' in line else 'hint')
        d=fields(line.split('llm device intent')[1]); d['ts']=ts(line); d['kind']=kind; llm.append(d)
    elif 'Started voice-worker-rust' in line:
        starts.append(ts(line))
    elif 'filler picked' in line and 'bucket=device' in line:
        filler_dev+=1
sn=lambda room: room.split('-')[1][-4:] if room and room.count('-')>=2 else room
print(f"proposals={len(props)} results={len(results)} command_word={len(cw)} clash={len(clash)} llm={len(llm)} restarts={len(starts)} filler_device_picks={filler_dev}")
print("\n== proposals by day / match_type / lane / sn ==")
c=collections.Counter((p['ts'][:10],str(p.get('match_type')),str(p.get('lane')),sn(p.get('room',''))) for p in props)
for k,v in sorted(c.items()): print(f"{k[0]} {k[1]:<14} {k[2]:<3} sn=…{k[3]} n={v}")
print("\n== results by status/reason/lane ==")
c=collections.Counter((str(r.get('status')),str(r.get('reason')),str(r.get('lane'))) for r in results)
for k,v in sorted(c.items(),key=lambda x:-x[1]): print(f"{k[0]:<16}{k[1]:<40}{k[2]:<3} n={v}")
# pair proposals -> results (same room, results after publish, until terminal)
def ms(x):
    try: return int(x)
    except: return None
lat_first=collections.defaultdict(list); lat_term=collections.defaultdict(list); terminal=collections.defaultdict(collections.Counter)
res_by_room=collections.defaultdict(list)
for r in results: res_by_room[r.get('room')].append(r)
for p in props:
    pub=ms(p.get('command_publish_ts_ms')); 
    if pub is None: continue
    cand=[r for r in res_by_room[p.get('room')] if ms(r.get('result_received_ts_ms')) and pub<=ms(r['result_received_ts_ms'])<=pub+30000 and r.get('semantic_label')==p.get('semantic_label')]
    if not cand: terminal[str(p.get('match_type'))]['(no result ≤30s)']+=1; continue
    first=cand[0]; lat_first[str(p.get('match_type'))].append(ms(first['result_received_ts_ms'])-pub)
    term=next((r for r in cand if r.get('status')!='accepted'),None)
    if term:
        lat_term[str(p.get('match_type'))].append(ms(term['result_received_ts_ms'])-pub); terminal[str(p.get('match_type'))][term.get('status')+'/'+term.get('reason','')]+=1
    else: terminal[str(p.get('match_type'))]['(accepted only, no terminal ≤30s)']+=1
def q(v):
    if not v: return "n=0"
    v=sorted(v); n=len(v)
    return f"n={n} min={v[0]} p50={v[n//2]} p90={v[min(n-1,int(n*0.9))]} max={v[-1]}"
print("\n== latency publish→first result (ms) by match_type =="); 
for k in sorted(lat_first): print(f"{k:<14} {q(lat_first[k])}")
print("== latency publish→terminal result (ms) by match_type ==")
for k in sorted(lat_term): print(f"{k:<14} {q(lat_term[k])}")
print("== terminal outcome by match_type ==")
for k in sorted(terminal):
    for kk,vv in terminal[k].most_common(): print(f"{k:<14} {kk:<48} n={vv}")
print("\n== command_word decisions (all) ==")
for d in cw: print(f"{d['ts']} sn=…{sn(d.get('room',''))} label={d.get('semantic_label')} before_ready={d.get('before_ready')} has_candidate={d.get('has_candidate')} decision={d.get('decision')} reason={d.get('reason')}")
print("\n== chip↔ASR agreement (chip-origin proposal text=[vad_label_N]) ==")
from datetime import datetime
def dt(s): return datetime.fromisoformat(s)
chip=[p for p in props if p.get('text','').startswith('[vad_label_')]
asr=[p for p in props if p.get('match_type') in ('exact_alias','volume_percent')]
for p in chip:
    t=dt(p['ts']); same=[c for c in clash if c.get('room')==p.get('room') and 0<=(dt(c['ts'])-t).total_seconds()<=5 and c.get('semantic_label')==p.get('semantic_label')]
    diff=[a for a in asr if a.get('room')==p.get('room') and -5<=(dt(a['ts'])-t).total_seconds()<=5 and a.get('semantic_label')!=p.get('semantic_label')]
    verdict='AGREE(asr撞窗同label)' if same else ('DISAGREE(asr另label)' if diff else 'CHIP_ONLY(asr无命中)')
    print(f"{p['ts']} sn=…{sn(p['room'])} chip_label={p.get('semantic_label')} -> {verdict} {'asr_label='+diff[0].get('semantic_label') if diff else ''}")
print("\n== ASR-origin proposals: chip candidate present within -5..+1s? ==")
cnt=collections.Counter()
for a in asr:
    t=dt(a['ts']); pre=[d for d in cw if d.get('room')==a.get('room') and -5<=(dt(d['ts'])-t).total_seconds()<=1]
    tag='ASR_WITH_CHIP' if pre else 'ASR_ONLY'; cnt[(tag,a['ts'][:10]>='2026-09-02')]+=1
    print(f"{a['ts']} sn=…{sn(a['room'])} label={a.get('semantic_label')} text_len={a.get('asr_final_text_length')} {tag}")
print("summary:",dict(cnt))
print("\n== llm device intent by kind/reason/known (since 2026-09-02) ==")
c=collections.Counter((d['kind'],d.get('reason',''),d.get('known','')) for d in llm if d['ts'][:10]>='2026-09-02')
for k,v in c.most_common(): print(k,v)
print("\n== worker restarts (last 8) =="); print("\n".join(starts[-8:]))

# ── 误触发嫌疑（D1 W4）：慢路(LLM)提案而原话不含任何设备词根 → 逐条人审，回填 prompt 反例/E2E ──
lane_of=lambda p: 'chip' if p.get('match_type')=='command_word' else ('L2' if (p.get('lane') or '').upper()=='L2' or p.get('match_type')=='llm' else 'L1')
res_by_room2=collections.defaultdict(list)
for r in results: res_by_room2[r.get('room')].append(r)
def term_status(p):
    pub=ms(p.get('command_publish_ts_ms'))
    cand=[r for r in res_by_room2[p.get('room')] if r.get('semantic_label')==p.get('semantic_label') and (pub is None or (ms(r.get('result_received_ts_ms')) and pub<=ms(r['result_received_ts_ms'])<=pub+30000))]
    t=next((r for r in cand if r.get('status')!='accepted'),None)
    return (t.get('status')+'/'+t.get('reason','')) if t else ('accepted' if cand else 'none')
lanes=collections.Counter(lane_of(p) for p in props)
print(f"\n== lanes: L1={lanes.get('L1',0)} L2={lanes.get('L2',0)} chip={lanes.get('chip',0)} ==")
sus=[p for p in props if lane_of(p)=='L2' and not any(r in p.get('text','') for r in DEVICE_ROOTS)]
print(f"\n== 误触发嫌疑 n={len(sus)}（慢路提案、原话无设备词根）==")
for p in sus: print(f"{p['ts']} sn=…{sn(p.get('room',''))} 「{p.get('text','')}」 label={p.get('semantic_label')} → {term_status(p)}")
print("\n== 慢路提案全表（人审用）==")
for p in [q for q in props if lane_of(q)=='L2']: print(f"{p['ts']} sn=…{sn(p.get('room',''))} 「{p.get('text','')}」 label={p.get('semantic_label')} → {term_status(p)}")
if ARGS.host:
    os.unlink(F)
