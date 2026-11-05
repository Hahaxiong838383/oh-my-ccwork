from pathlib import Path
import ast,json,base64,hashlib,subprocess
D=Path(__file__).resolve().parent.parent;out=D/'evidence-37'
repo='/Users/fu-121/.codex/worktrees/p003-auto-enrollment-20261104';pre='2-Projects/P003GameDemo20260513/apps/server/';sha='a92bd8f342144d6253cbb9a928925639ffa597cc';h=lambda b:hashlib.sha256(b).hexdigest()
objects={n:json.loads((out/n).read_text()) for n in ['CANDIDATE-13.json','DEPLOY_MANIFEST.json','main-result.json','main-legacy-retry.json','preflight.json','regression.json']}
t=ast.parse((D/'run-main.py').read_text());lits={}
for node in t.body:
 if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) and node.targets[0].id in ['expected','payload']:lits[node.targets[0].id]=ast.literal_eval(node.value)
assert lits['expected']==objects['preflight.json']['files']
main=objects['main-result.json'];assert main['runtime_unchanged'];expected={n:v for n,v in lits['expected'].items() if n.startswith('src/')};payload_checks=[]
for n,b64 in lits['payload'].items():
 b=base64.b64decode(b64);gb=subprocess.check_output(['git','show',sha+':'+pre+n],cwd=repo);assert b==gb,n
 payload_checks.append({'path':n,'sha256':h(b),'matches_candidate':True})
 if n.startswith('src/'):expected[n]=h(b)
assert expected==main['manifest']
for item in objects['CANDIDATE-13.json']['runtime_files']:
 assert expected[item['path']]==item['after']
 assert lits['expected'][item['path']]==item['before']
retry=ast.parse((D/'run-main-legacy-retry.py').read_text()); bs=[]
for node in ast.walk(retry):
 if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='b64decode':bs.append(base64.b64decode(ast.literal_eval(node.args[0])))
assert len(bs)==1
assert bs[0]==subprocess.check_output(['git','show',sha+':'+pre+'scripts/provision-device-identity.mjs'],cwd=repo)
for n in ['run-main.py','run-main-legacy-retry.py']:(out/n).write_bytes((D/n).read_bytes())
report={'candidate':sha,'verified_at':'2026-11-05','manifest_files':len(expected),'preflight_count':len(lits['expected']),'whole_src_manifest_matches_preflight_plus_seven_candidate_files':True,'payloads':payload_checks,'retry_only_missing_fixture':{'path':'scripts/provision-device-identity.mjs','sha256':h(bs[0]),'matches_candidate':True},'main_tests':[{'test':v['test'],'exit':v['exit'],'result':v.get('test_result',{})} for v in main['results']],'legacy_retry':objects['main-legacy-retry.json'],'scope':'37 verifies supplied 13 artifacts and exact inputs; not 37 SSH or independent rerun of main','artifacts':{n:h((out/n).read_bytes()) for n in ['CANDIDATE-13.json','DEPLOY_MANIFEST.json','main-result.json','main-legacy-retry.json','preflight.json','regression.json','run-main.py','run-main-legacy-retry.py']}}
(out/'main-input-verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'manifest_files':len(expected),'payload_count':len(payload_checks),'all_hashes_matched':True,'main':[(x['test'],x['exit']) for x in main['results']],'legacy_retry_exit':objects['main-legacy-retry.json']['exit']},ensure_ascii=False))
