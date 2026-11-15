"""Build reviewable per-pool overlays from a hash-verified read-only source snapshot.
No SSH, environment reads, database writes or production mutation.
"""
import argparse, hashlib, json, pathlib, shutil

ap=argparse.ArgumentParser()
ap.add_argument('--snapshot',required=True)
ap.add_argument('--baseline',required=True)
ap.add_argument('--out',required=True)
a=ap.parse_args()
src=pathlib.Path(__file__).resolve().parents[1]
snapshot=pathlib.Path(a.snapshot);out=pathlib.Path(a.out)
assert not out.exists(), 'output already exists'
baseline=json.loads(pathlib.Path(a.baseline).read_text())['pools']
shared=['src/ark/answer.ts','src/ark/contracts.ts','src/ark/memory-policy.ts','src/ark/language.ts','src/xiaoke-kb.ts']
main_only=['src/ark/history.ts','src/ark/context.ts','src/routes/custom-llm.ts']
sha=lambda b:hashlib.sha256(b).hexdigest()
manifest={}
def replace(s,old,new):
    assert s.count(old)==1, 'patch anchor count: '+old[:50]
    return s.replace(old,new)
for pool in ['main','search','listening']:
    before=snapshot/pool;target=out/pool
    # Verify every original file against the current online read-only baseline.
    for p in (before/'src').rglob('*'):
        if p.is_file():
            rel=str(p.relative_to(before))
            assert baseline[pool]['hashes'].get(rel)==sha(p.read_bytes()), 'stale snapshot '+pool+'/'+rel
    shutil.copytree(before/'src',target/'src')
    shutil.copyfile(before/'package.json',target/'package.json')
    (target/'node_modules').symlink_to(src/'node_modules',target_is_directory=True)
    for rel in shared+(main_only if pool=='main' else []):
        (target/rel).write_bytes((src/rel).read_bytes())
    if pool!='main':
        p=target/'src/routes/custom-llm.ts';s=p.read_text()
        s="import {arkConversationPolicy,createArkControlFilter} from '../ark/language.js';\n"+s
        s=replace(s,'import {isArkStateQuestion}', 'import {isArkStateQuestion,deferArkDirectReply}')
        reference=(src/'src/routes/custom-llm.ts').read_text()
        policy=reference[reference.index('  const arkPolicy='):reference.index('  if (voiceStylePolicy)')]
        s=replace(s,"  if(ark.prompt) systemPrompt += '\\n\\n'+ark.prompt;", "  if(ark.prompt) systemPrompt += '\\n\\n'+ark.prompt;\n"+policy.rstrip())
        s=replace(s,"(!overridePrompt && authContext?.role === 'device') ? deviceIntentProtocol()", "(!overridePrompt && !protectArkControl && authContext?.role === 'device') ? deviceIntentProtocol()")
        s=replace(s,'    const exitStripper = createExitMarkerStripper();','    const exitStripper = createExitMarkerStripper();\n    const arkControlFilter=createArkControlFilter(protectArkControl);')
        s=replace(s,'exitStripper.feed(delta).text','exitStripper.feed(arkControlFilter.feed(delta)).text')
        s=replace(s,'parenFilter.feed(exitStripper.flush().text)','parenFilter.feed(exitStripper.feed(arkControlFilter.flush()).text+exitStripper.flush().text)')
        if pool=='search':
            s="import {answerArk,arkDirectReplyAllowed} from '../ark/answer.js';\n"+s
            s=replace(s,"import {arkContext} from '../ark/service.js';", "import {arkContext} from '../ark/canary-context.js';")
            line=next(x for x in reference.splitlines() if 'const directArkQuestion =' in x)
            anchor=next(x for x in s.splitlines() if 'const staticArkAnswer =' in x)
            s=replace(s,anchor,anchor+'\n'+line)
            s=s.replace('!staticArkAnswer && !searchPolicy','!directArkQuestion && !searchPolicy')
            s=s.replace('(staticArkAnswer || overridePrompt','(directArkQuestion || overridePrompt')
            s=replace(s,'    if(staticArkAnswer){','    if(directArkQuestion){')
            s=replace(s,'      assistantText=staticArkAnswer;', "      assistantText=staticArkAnswer??answerArk(userText,ark.facts_v1,rawHistory)??'这部分方舟数据我暂时查不到。';")
            (target/'src/ark/proxy.ts').write_bytes((src/'src/ark/proxy.ts').read_bytes())
            (target/'src/ark/canary-context.ts').write_bytes((snapshot/'listening/src/ark/canary-context.ts').read_bytes())
        p.write_text(s)
    for p in (target/'src').rglob('*'):
        if not p.is_file():continue
        rel=str(p.relative_to(target));old=before/rel
        oldsha=sha(old.read_bytes()) if old.exists() else None
        newsha=sha(p.read_bytes())
        if oldsha!=newsha:manifest[pool+'/'+rel]={'pool':pool,'file':rel,'before':oldsha,'after':newsha}
out.mkdir(exist_ok=True)
(out/'MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'files':len(manifest),'per_pool':{p:sum(v['pool']==p for v in manifest.values()) for p in baseline}}))
