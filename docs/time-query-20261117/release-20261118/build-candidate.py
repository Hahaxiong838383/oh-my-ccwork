"""Offline, exact-current-source overlays; never replay yesterday's payload."""
from pathlib import Path
import argparse,hashlib,json,importlib.util,shutil

def build(state,server):
 baseline=json.loads((state/'BASELINE.json').read_text());out=state/'candidate';manifest=[]
 spec=importlib.util.spec_from_file_location('old_builder',Path(__file__).parents[1]/'build-pool-overlays.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 for i,pool in enumerate(baseline['pools']):
  src=state/'snapshots'/str(i)
  for name,h in pool['sources'].items():
   assert hashlib.sha256((src/name).read_bytes()).hexdigest()==h,('snapshot drift',i,name)
  if i==0:
   names=['src/routes/custom-llm.ts','src/tools/search-runtime.ts','src/tools/search-tasks.ts']
   snapshot={pool['root']:{n:{'source':(src/n).read_text(),'sha256':pool['sources'][n]} for n in names}}
   (state/'main-source.json').write_text(json.dumps(snapshot))
   manifest.extend(module.build(state/'main-source.json',server,out))
  else:
   n='src/tools/clock-query.ts';dest=out/str(i)/n;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(server/n,dest)
   manifest.append(dict(pool=pool['root'],path=n,before_sha256=pool['sources'][n],after_sha256=hashlib.sha256(dest.read_bytes()).hexdigest()))
 (out/'MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
 return manifest
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--state',type=Path,required=True);p.add_argument('--server',type=Path,required=True);a=p.parse_args();print(json.dumps({'files':len(build(a.state,a.server))}))
