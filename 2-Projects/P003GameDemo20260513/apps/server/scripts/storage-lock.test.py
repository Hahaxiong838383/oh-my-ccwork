"""Real process tests: an orphan writer must keep its lock; dead jobs release it."""
import os, subprocess, sys, tempfile, time, unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('storage-lock.py')

class LockTests(unittest.TestCase):
    def test_budget_terminates_job_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as t:
            lock=Path(t).resolve()/'lock';start=time.monotonic()
            env={**os.environ,'ARCHIVE_JOB_TIMEOUT_SEC':'1'}
            p=subprocess.run([sys.executable,str(SCRIPT),str(lock),sys.executable,'-c','import time;time.sleep(30)'],env=env,capture_output=True,timeout=5)
            self.assertEqual(p.returncode,124,p.stderr);self.assertLess(time.monotonic()-start,4)
            p=subprocess.run([sys.executable,str(SCRIPT),str(lock),sys.executable,'-c','pass'],capture_output=True)
            self.assertEqual(p.returncode,0,p.stderr)
    def test_missing_or_wrong_volume_never_creates_lock(self):
        with tempfile.TemporaryDirectory() as t:
            r=Path(t).resolve();marker=r/'volume';lock=r/'lock'
            env={**os.environ,'ARCHIVE_VOLUME_MARKER':str(marker),'ARCHIVE_VOLUME_ID':'expected-volume'}
            for content in [None,'wrong-volume']:
                if content:marker.write_text(content)
                p=subprocess.run([sys.executable,str(SCRIPT),str(lock),sys.executable,'-c','pass'],env=env,capture_output=True)
                self.assertNotEqual(p.returncode,0);self.assertFalse(lock.exists())
            marker.write_text('expected-volume\n')
            p=subprocess.run([sys.executable,str(SCRIPT),str(lock),sys.executable,'-c','pass'],env=env,capture_output=True)
            self.assertEqual(p.returncode,0,p.stderr)
    def test_exclusion_sigkill_restart_and_orphan_child(self):
        self.assertTrue(SCRIPT.exists(), 'kernel lock launcher not implemented')
        with tempfile.TemporaryDirectory() as t:
            root = Path(t).resolve(); lock = root/'lock'; ready = root/'ready'
            code = 'import os,time; p=os.fork(); open(%r,"w").write(str(os.getpid())+","+str(p)) if p else None; time.sleep(30)' % str(ready)
            proc = subprocess.Popen([sys.executable,str(SCRIPT),str(lock),sys.executable,'-c',code])
            child = None;body=None
            try:
                deadline=time.time()+5
                while not ready.exists() and time.time()<deadline: time.sleep(.02)
                self.assertTrue(ready.exists()); body,child=map(int,ready.read_text().split(','))
                check=lambda:subprocess.run([sys.executable,str(SCRIPT),str(lock),sys.executable,'-c','pass'],capture_output=True)
                self.assertEqual(check().returncode,3)
                proc.kill(); proc.wait(); self.assertEqual(check().returncode,3, 'orphan still writes')
                os.kill(child,9);child=None
                if body!=proc.pid:os.kill(body,9)
                body=None
                deadline=time.time()+5
                while time.time()<deadline:
                    result=check()
                    if result.returncode==0:break
                    time.sleep(.02)
                self.assertEqual(result.returncode,0, result.stderr)
                self.assertTrue(lock.exists(), 'lock inode must never be deleted/recreated')
            finally:
                if proc.poll() is None:proc.kill();proc.wait()
                if child:
                    try:os.kill(child,9)
                    except ProcessLookupError:pass
                if body and body!=proc.pid:
                    try:os.kill(body,9)
                    except ProcessLookupError:pass

    def test_child_failure_cleans_descriptor_closing_grandchild_before_unlock(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve();ready=root/'ready';lock=root/'lock'
            code='import subprocess,os,time; p=subprocess.Popen(["sleep","30"],close_fds=True); open(%r,"w").write(str(os.getpid())+","+str(p.pid)); time.sleep(30)' % str(ready)
            proc=subprocess.Popen([sys.executable,str(SCRIPT),str(lock),sys.executable,'-c',code])
            body=child=None
            try:
                end=time.time()+5
                while not ready.exists() and time.time()<end:time.sleep(.02)
                body,child=map(int,ready.read_text().split(','));os.kill(body,9)
                proc.wait(timeout=5)
                # A non-zombie grandchild after the owner has exited is unsafe: SSH closes fds too.
                if sys.platform=='linux':
                    try:stat=Path('/proc/%s/stat'%child).read_text().rpartition(')')[2].split()[0]
                    except FileNotFoundError:stat=''
                else:stat=subprocess.run(['ps','-o','stat=','-p',str(child)],capture_output=True,text=True).stdout.strip()
                self.assertTrue(not stat or stat.startswith('Z'), 'orphan transfer remained alive after lock release')
            finally:
                for pid in [child,body,proc.pid]:
                    if pid:
                        try:os.kill(pid,9)
                        except ProcessLookupError:pass
                proc.wait()

    def test_symlink_refused(self):
        self.assertTrue(SCRIPT.exists(), 'kernel lock launcher not implemented')
        with tempfile.TemporaryDirectory() as t:
            r=Path(t);(r/'target').write_text('untouched');(r/'link').symlink_to(r/'target')
            p=subprocess.run([sys.executable,str(SCRIPT),str(r/'link'),sys.executable,'-c','pass'],capture_output=True)
            self.assertNotEqual(p.returncode,0);self.assertEqual((r/'target').read_text(),'untouched')

if __name__=='__main__':unittest.main()
