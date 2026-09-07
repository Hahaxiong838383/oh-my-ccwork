import wave, array, json, os, math, glob, collections
def load(p):
    w=wave.open(p,'rb'); sr=w.getframerate(); a=array.array('h'); a.frombytes(w.readframes(w.getnframes())); return sr,a
def frames(a,sr,ms=10):
    n=sr*ms//1000; out=[]
    for i in range(0,len(a)-n+1,n):
        seg=a[i:i+n]; rms=math.sqrt(sum(x*x for x in seg)/n)
        zc=sum(1 for k in range(1,n) if (seg[k]>=0)!=(seg[k-1]>=0))
        out.append((rms,zc))
    return out
ev=collections.defaultdict(list)
for l in open('events-day.jsonl',encoding='utf-8',errors='replace'):
    l=l.strip()
    if l.startswith('{'):
        try: e=json.loads(l); ev[e['job']].append(e)
        except Exception: pass
rows=[]
for d in sorted(glob.glob('2026*/')):
    job=d.rstrip('/'); p=os.path.join(d,'t0000.wav')
    sr,a=load(p); fr=frames(a,sr)
    fnz=next((i for i,x in enumerate(a) if x!=0),None)
    if fnz is None: rows.append((job,'ALLZERO',None,None,None,'')); continue
    f0=fnz*100//sr
    onset=next((i for i in range(f0,len(fr)) if fr[i][0]>=150),None)
    lead=None if onset is None else (onset-f0)*10
    # fricative-ish frames (high zc, modest rms) between f0 and onset+2
    fric=sum(1 for i in range(f0,min((onset or f0)+2,len(fr))) if fr[i][1]>=40 and 30<=fr[i][0]<300) if onset is not None else 0
    first_voiced_rms=fr[onset][0] if onset is not None else 0
    kind='in-progress' if (lead is not None and lead<30) else ('lead-in' if lead is not None else 'no-speech')
    finals=[e for e in ev.get(job,[]) if e.get('ev')=='user_final']
    txt=finals[0]['text'] if finals else ''
    rows.append((job,kind,lead,fric,int(first_voiced_rms),txt))
print(f"{'job':<24} {'kind':<12} {'lead_ms':>7} {'fric':>4} {'v_rms':>5}  first_final")
for r in rows: print(f"{r[0]:<24} {r[1]:<12} {str(r[2]):>7} {str(r[3]):>4} {str(r[4]):>5}  {r[5]}")
def era(job):
    t=job[9:15]
    return 'v237/238(<00:20Z)' if t<'002000' else ('v239(00:20-00:56Z)' if t<'005700' else 'v240(>=00:57Z)')
agg=collections.defaultdict(lambda: collections.Counter())
for r in rows:
    if r[1] in ('in-progress','lead-in'): agg[era(r[0])][r[1]]+=1
print("\n=== summary (rooms with speech in first snapshot)")
for k,v in agg.items(): print(k, dict(v), "in-progress rate = %d/%d"%(v['in-progress'],v['in-progress']+v['lead-in']))
# known anchors
known={'20260907T002302-928701':'in-progress','20260907T002322-d8e29e':'in-progress','20260907T002342-176333':'in-progress','20260907T010112-3e1559':'lead-in','20260907T010128-b8d3d2':'in-progress','20260907T010145-456768':'in-progress'}
print("\n=== discriminator replay on known samples")
for r in rows:
    if r[0] in known: print(r[0], 'got', r[1], 'expected', known[r[0]], 'OK' if r[1]==known[r[0]] else 'MISMATCH')
