import wave, array, json, sys, os, math
def load(p):
    w=wave.open(p,'rb'); assert w.getnchannels()==1 and w.getsampwidth()==2, (w.getnchannels(),w.getsampwidth())
    sr=w.getframerate(); a=array.array('h'); a.frombytes(w.readframes(w.getnframes())); return sr,a
def frames(a,sr,ms=10):
    n=sr*ms//1000; out=[]
    for i in range(0,len(a)-n+1,n):
        seg=a[i:i+n]; e=sum(x*x for x in seg); rms=math.sqrt(e/n)
        zc=sum(1 for k in range(1,n) if (seg[k]>=0)!=(seg[k-1]>=0))
        d=sum((seg[k]-seg[k-1])**2 for k in range(1,n)); hp=math.sqrt(d/(n-1))
        out.append((rms,zc,hp/rms if rms>0 else 0.0,max(abs(x) for x in seg)))
    return out
events={}
for line in open('events240.jsonl',encoding='utf-8',errors='replace'):
    line=line.strip()
    if not line.startswith('{'): continue
    try: ev=json.loads(line)
    except Exception: continue
    events.setdefault(ev.get('job') or ev.get('job_id') or ev.get('room') or '?',[]).append(ev)
for k,v in events.items():
    print("EVENTS",k)
    for ev in v: print("  ",json.dumps(ev,ensure_ascii=False)[:200])
for d in sorted(os.listdir('.')):
    if not d.startswith('20260907T'): continue
    for f in sorted(os.listdir(d)):
        if not f.endswith('.wav'): continue
        sr,a=load(os.path.join(d,f)); n=len(a)
        first_nz=next((i for i,x in enumerate(a) if x!=0),None)
        fr=frames(a,sr)
        thr=150
        onset=next((i for i,(r,_,_,_) in enumerate(fr) if r>=thr),None)
        voiced=sum(1 for r,_,_,_ in fr if r>=thr)*10
        voiced300=sum(1 for r,_,_,_ in fr if r>=300)*10
        print(f"\n=== {d}/{f} sr={sr} n={n} dur_ms={n*1000//sr} first_nonzero_ms={None if first_nz is None else round(first_nz*1000/sr,1)} onset_ms(rms>={thr})={None if onset is None else onset*10} voiced_ms(>={thr})={voiced} voiced_ms(>=300)={voiced300}")
        if first_nz is not None:
            f0=first_nz*100//sr  # 10ms frame index at release
            print("  envelope from first_nonzero, per 10ms: rms/zc/hpratio")
            row=[]
            for i in range(f0,min(f0+60,len(fr))):
                r,zc,hp,pk=fr[i]; row.append(f"{int(r)}/{zc}/{hp:.2f}")
            print("   ",' '.join(row))
        if onset is not None:
            print(f"  onset relative to first_nonzero: {onset*10 - (first_nz*1000/sr if first_nz is not None else 0):.0f} ms; 30 frames from onset rms:", ' '.join(str(int(fr[i][0])) for i in range(onset,min(onset+30,len(fr)))))
            # low-energy run before onset (after first nonzero)
            if first_nz is not None:
                lo=[i for i in range(f0,onset) if fr[i][0]<1.0]
                print(f"  frames rms<1 between release and onset: {len(lo)} of {onset-f0}")
        # tail: last 100 frames rms summary (speech end vs eot)
        print("  last 80 frames rms:", ' '.join(str(int(r)) for r,_,_,_ in fr[-80:]))
