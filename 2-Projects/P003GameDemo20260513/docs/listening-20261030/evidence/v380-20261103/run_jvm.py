import pathlib,subprocess,json,hashlib,os,argparse
p=argparse.ArgumentParser();p.add_argument("--client-src",required=True);p.add_argument("--out",required=True);p.add_argument("--java",required=True);p.add_argument("--cache",default=str(pathlib.Path.home()/".gradle/caches/modules-2/files-2.1"));p.add_argument("--replay",action="append",default=[]);args=p.parse_args()
D=pathlib.Path(args.out).resolve();D.mkdir(parents=True,exist_ok=True)
HERE=pathlib.Path(__file__).resolve().parent
C=pathlib.Path(args.cache)
java=args.java
def jar(group,name,version):
 p=list((C/group/name/version).glob('**/*.jar'));assert len(p)==1,(name,p);return str(p[0])
compiler=[jar('org.jetbrains.kotlin',n,'2.0.21') for n in ['kotlin-compiler-embeddable','kotlin-stdlib','kotlin-script-runtime','kotlin-daemon-embeddable']]+[jar('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),jar('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),jar('org.jetbrains','annotations','13.0'),jar('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.6.4')]
cp=[jar('org.jetbrains.kotlin','kotlin-stdlib','2.0.21'),jar('org.jetbrains','annotations','13.0'),jar('com.google.code.gson','gson','2.10.1'),jar('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.6.4'),jar('org.jetbrains.kotlinx','kotlinx-coroutines-test-jvm','1.6.4'),jar('junit','junit','4.13.2'),jar('org.hamcrest','hamcrest-core','1.3')]
src=pathlib.Path(args.client_src);pkg='java/com/futurus/p003/launcher/voice/livekit';sources=[src/'main'/pkg/(n+'.kt') for n in ['ListeningVoiceControl','VoiceControlCodec']]+[src/'test'/pkg/'ListeningVoiceControlTest.kt',HERE/'V380ExitConsumerReviewTest.kt',HERE/'V380RtcReplay.kt']
expected=['8d53604cf4a3dc5227b53397c1bfe6201c7e6f463b1103ca5390a64e72be8f4e','b0f6418e7d03437d3626addf78a70efb9348323b25d1a5aaf952df5e02a4442f','f9715d167cd749a49ef487264736ee70721ec5f61a5f559d0a8cc60409563c1f']
assert all(hashlib.sha256(f.read_bytes()).hexdigest()==digest for f,digest in zip(sources,expected)), 'not the frozen v380 sources'
classes=D/'classes';classes.mkdir(exist_ok=True)
compile_cmd=[java,'-cp',os.pathsep.join(compiler),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',os.pathsep.join(cp),'-d',str(classes)]+list(map(str,sources))
run_cmd=[java,'-cp',os.pathsep.join([str(classes)]+cp),'org.junit.runner.JUnitCore','com.futurus.p003.launcher.voice.livekit.ListeningVoiceControlTest','com.futurus.p003.launcher.voice.livekit.V380ExitConsumerReviewTest']
results=[]
jobs=[('compile',compile_cmd),('tests',run_cmd)]+[(str(i)+'-replay',[java,'-cp',os.pathsep.join([str(classes)]+cp),'com.futurus.p003.launcher.voice.livekit.V380RtcReplayKt',str(pathlib.Path(f).resolve())]) for i,f in enumerate(args.replay)]
for name,cmd in jobs:
 r=subprocess.run(cmd,capture_output=True,text=True,timeout=90);log=r.stdout+r.stderr;(D/(name+'.log')).write_text(log);results.append({'name':name,'exit_code':r.returncode,'command':cmd,'log_sha256':hashlib.sha256(log.encode()).hexdigest()});print(name,r.returncode,log[-3000:]);
 if r.returncode:break
(D/'result.json').write_text(json.dumps({'source_commit':'6558e03ee9fda9f77d8a1f6209eae49124a55526','results':results,'sources':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}for p in sources]},indent=2)+'\n')

raise SystemExit(0 if len(results)==len(jobs) and all(r['exit_code']==0 for r in results) else 1)
