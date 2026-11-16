from pathlib import Path
import subprocess,json,hashlib,time
D=Path('/root/p003-records-summary-20261116');C=D/'candidate'
version=subprocess.check_output(['node','--version'],text=True).strip()
assert version.startswith('v22.'),version
result={'runtime':version,'at_ms':int(time.time()*1000),'manifest_sha256':hashlib.sha256((D/'MANIFEST.json').read_bytes()).hexdigest(),'pass':True,'tests':[]}
for name in ['ark-records-summaries','ark-records','mini008-dashboard','telemetry','schema']:
 cmd=['node','docs/records-r1/validate.mjs'] if name=='schema' else ['node','--experimental-sqlite','--import','tsx',f'scripts/{name}.test.ts']
 p=subprocess.run(cmd,cwd=C,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
 (D/f'node22-{name}.log').write_bytes(p.stdout)
 result['tests'].append({'name':name,'exit_code':p.returncode});result['pass'] &= p.returncode==0
 print(name,p.returncode,flush=True)
(D/'NODE22-TESTS.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
raise SystemExit(0 if result['pass'] else 1)
