import os,sys,pathlib,subprocess
# Executed only inside a fresh private mount namespace. The normal host stub
# and all production workers retain their existing resolver files.
folder,binary=sys.argv[1:]
assert os.readlink('/proc/self/ns/mnt')!=os.environ['P003_HOST_MOUNT_NS']
subprocess.run(['mount','--bind',str(pathlib.Path(folder)/'stub.conf'),'/run/systemd/resolve/stub-resolv.conf'],check=True)
assert pathlib.Path('/etc/resolv.conf').resolve()==pathlib.Path('/run/systemd/resolve/stub-resolv.conf')
assert pathlib.Path('/etc/resolv.conf').read_text()==(pathlib.Path(folder)/'stub.conf').read_text()
os.execve(binary,[binary],dict(os.environ))
