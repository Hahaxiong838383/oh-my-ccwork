#!/usr/bin/env python3
"""Materialize only this package's signing pair; never print credential values."""
import base64, fcntl, os, pathlib, secrets, subprocess, sys

out=pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True); out.chmod(0o700)
store=pathlib.Path.home()/'.mycc-secrets.env'
keys=('TV_NETWORK_STATUS_KEYSTORE_B64','TV_NETWORK_STATUS_PASSWORD')
fd=os.open(store,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'r+') as f:
    fcntl.flock(f,fcntl.LOCK_EX)
    if os.fstat(f.fileno()).st_mode & 0o077: raise SystemExit('Credential store must be mode 600')
    original=f.read(); values={}
    for line in original.splitlines():
        name,sep,value=line.partition('=')
        if name in keys:
            if name in values: raise SystemExit('Duplicate signing entry; refusing')
            values[name]=value
    if not values and os.environ.get('CREATE_SIGNING')=='1':
        password=secrets.token_urlsafe(36)
        password_file=out/'password'; password_file.write_text(password+'\n'); password_file.chmod(0o600)
        key=out/'signing.p12'
        if key.exists(): raise SystemExit('Refusing to overwrite temporary signing key')
        subprocess.run(['keytool','-genkeypair','-keystore',str(key),'-storetype','PKCS12',
                        '-alias','tvnetstatus','-keyalg','RSA','-keysize','3072','-validity','3650',
                        '-dname','CN=TV Network Status Local','-storepass:file',str(password_file),
                        '-keypass:file',str(password_file)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        values={keys[0]:base64.b64encode(key.read_bytes()).decode(),keys[1]:password}
        f.seek(0,2)
        f.write(('\n' if original and not original.endswith('\n') else '') +
                '\n# TV network status APK signing; never rotate during ordinary rebuilds.\n' +
                ''.join(k+'='+values[k]+'\n' for k in keys))
        f.flush(); os.fsync(f.fileno())
    if set(values)!=set(keys): raise SystemExit('Signing absent/incomplete; first install requires CREATE_SIGNING=1')
    (out/'signing.p12').write_bytes(base64.b64decode(values[keys[0]],validate=True))
    (out/'password').write_text(values[keys[1]]+'\n')
    for name in ('signing.p12','password'): (out/name).chmod(0o600)
