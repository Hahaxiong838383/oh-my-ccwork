#!/usr/bin/env python3
"""Android-shell replay of the real watcher with isolated inputs and no real am calls."""
import json,pathlib,shlex,sys,uuid
S=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(S.parent/'youtube-failover'))
from stage_rack_dualstack import Device,encoded

def main(serial,output):
    d=Device(serial); before=d.snapshot(); boot=before['boot']
    root='/data/adb/tv-network-status-fixture-'+uuid.uuid4().hex[:10]
    d.run('mkdir -m 700 '+root)
    try:
        source=(S/'watch.sh').read_text().replace('D=/data/adb/tv-network-status\n','D='+root+'\n')
        source=source.replace('/data/adb/video-proxy/',root+'/')
        for name in ('am','dumpsys','logcat'): source=source.replace('/system/bin/'+name,root+'/'+name)
        assert '/system/bin/am' not in source and '/data/adb/video-proxy/' not in source
        files={'watch.sh':source,'state.sh':(S/'state.sh').read_text(),
               'am':'#!/system/bin/sh\nprintf "%s\\n" "$*" >> '+root+'/calls\necho Starting service\n',
               'dumpsys':'#!/system/bin/sh\necho "mResumedActivity: ActivityRecord{x u0 com.dangbei.tvlauncher/.Main t1}"\n',
               'logcat':'#!/system/bin/sh\nsleep 0.8\necho "I/wm_set_resumed_activity(1262): [0,com.player.diyp2020/.Player,resume]"\nsleep 0.8\necho "I/wm_set_resumed_activity(1262): [0,com.dangbei.tvlauncher/.Main,resume]"\nexec sleep 30\n',
               'boot-start.log':f'now boot={boot} uptime=1 android_boot_complete\n',
               'boot-ready-boot-id':'old-boot\n',
               'controller.sh':f'''#!/system/bin/sh
sleep 1
echo 'now boot={boot} uptime=2 main_launched pid=1' >> {root}/boot-start.log
sleep 1
echo 'now boot={boot} uptime=3 dns_queries_verified' >> {root}/boot-start.log
sleep 1
echo '{boot}' > {root}/boot-ready-boot-id
'''}
        for name,value in files.items(): d.write(root+'/'+name,value.encode(),'700')
        d.run('/system/bin/sh '+root+'/controller.sh & /data/adb/magisk/busybox timeout 15 /system/bin/sh '+root+'/watch.sh',timeout=20)
        calls=d.read(root+'/calls').decode().splitlines(); log=d.read(root+'/status.log').decode()
        assert any('--ez home true --ez ready false' in c for c in calls),'waiting on home missing'
        assert any('--ez home false --ez ready false' in c for c in calls),'hide on playback missing'
        assert any('--es phase cache' in c for c in calls),'cache phase missing'
        assert any('--ez home true --ez ready true' in c for c in calls),'success on home missing'
        assert d.read(root+'/done-boot-id').decode().strip()==boot
        old_calls=d.read(root+'/calls'); d.run('/system/bin/sh '+root+'/watch.sh')
        assert d.read(root+'/calls')==old_calls,'same-boot replay must be silent'
        after=d.snapshot(); assert before['foreground']==after['foreground'] and before['processes']==after['processes']
        result={'actual_android_watcher':True,'mock_am_only':True,'same_boot_replay_silent':True,
                'calls':calls,'log':log,'before':before,'after':after}
        pathlib.Path(output).write_bytes(encoded(result))
        print(json.dumps({'watcher_replay':'passed','waiting_hide_return_ready':True,'same_boot_silent':True,'foreground_unchanged':True}))
    finally:
        # Only this randomized test directory; never production proxy/helper state.
        d.run('rm -rf '+shlex.quote(root))
if __name__=='__main__': main(sys.argv[1],sys.argv[2])
