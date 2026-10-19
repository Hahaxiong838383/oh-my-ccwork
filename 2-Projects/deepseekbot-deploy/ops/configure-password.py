#!/usr/bin/env python3
"""User-authorized Air RTF -> salted scrypt hash on Mini. No plaintext persisted/logged."""
import hashlib, json, os, shlex, subprocess
AIR=['ssh','-o','HostName=RaymanMacBook-Air.local','-o','HostKeyAlias=10.9.1.110','-o','User=Rayman.Chen','-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','ConnectTimeout=8','air']
path='/Users/rayman.chen/Documents/陈川个人站/DeepSeek Bot 密码.rtf'
r=subprocess.run(AIR+['textutil -convert txt -stdout '+shlex.quote(path)],capture_output=True)
if r.returncode: raise SystemExit('无法读取指定密码文件（未回显远端输出）。')
password=r.stdout.decode().strip()
if not password or len(password.splitlines())!=1: raise SystemExit('密码文件应包含一行密码。')
salt=os.urandom(16).hex()
hash_value=hashlib.scrypt(password.encode(),salt=salt.encode(),n=32768,r=8,p=1,dklen=64,maxmem=64*1024*1024).hex()
password=None;r=None
payload=json.dumps({'salt':salt,'hash':hash_value}).encode()
script='''import os,sys,json
from pathlib import Path
os.umask(0o077)
p=Path.home()/'local/deepseekbot/auth'
p.mkdir(parents=True,exist_ok=True,mode=0o700);p.chmod(0o700)
data=sys.stdin.buffer.read();json.loads(data)
f=p/'credential.json';tmp=p/'credential.json.tmp'
if f.exists():
 import shutil,time
 shutil.copy2(f,p/('credential.backup-'+str(int(time.time()))+'.json'))
with open(tmp,'wb') as w:w.write(data)
tmp.chmod(0o600);os.replace(tmp,f)
'''
r=subprocess.run(['ssh','-o','BatchMode=yes','mini-tb','python3 -c '+shlex.quote(script)],input=payload,capture_output=True)
if r.returncode: raise SystemExit('密码哈希写入失败（未回显远端输出）。')
print('密码已加盐哈希后写入 Mini 私有文件（0600），未落盘明文。')
