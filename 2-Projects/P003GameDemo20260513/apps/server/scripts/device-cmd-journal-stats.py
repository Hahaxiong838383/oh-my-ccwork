#!/usr/bin/env python3
# device-cmd-journal-stats.py —— 语音设备命令链 P0 统计（只读，离线分析 worker journal）
# 用法: ssh root@64.90.13.117 "TZ=Asia/Shanghai journalctl -u voice-worker-rust --since '-14 days' --no-pager -o short-iso \
#        | sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -E 'command_word 决策|device command proposed|asr 命中与 command_word 撞窗|device command result|llm device intent|l2 capability|Started'" > /tmp/j.txt
#      python3 scripts/device-cmd-journal-stats.py /tmp/j.txt
# 输出: 提案/结果分布、发布→result 延迟(按 match_type)、芯片候选决策、芯片↔ASR 一致性、ASR 起源是否伴随芯片候选、LLM 标记。
# 背景: 2026-09-04 双源单核联调合同 v3 §8.0（P003-product-definition/docs）。日志含 ASR 文本，分析文件勿入仓/勿外发。
import re, sys, collections, statistics
F=sys.argv[1]
kv=re.compile(r'(\w+)=("[^"]*"|\'[^\']*\'|\S+)')
def fields(s):
    d={}
    for k,v in kv.findall(s):
        d[k]=v.strip('"').strip("'")
    return d
def ts(line): return line[:25]
props=[];results=[];cw=[];clash=[];llm=[];starts=[]
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
sn=lambda room: room.split('-')[1][-4:] if room and room.count('-')>=2 else room
print(f"proposals={len(props)} results={len(results)} command_word={len(cw)} clash={len(clash)} llm={len(llm)} restarts={len(starts)}")
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
