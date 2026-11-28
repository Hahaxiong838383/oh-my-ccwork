"""Back up or verify the personal NAS databases. The encryption key stays in Vaultwarden."""
import argparse
import base64
import contextlib
import json
import os
import secrets
import shlex
import sys
import sqlite3
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b'XKDB1'
ITEM = '小可个人语音数据库备份密钥'
NAS_SSH = ['ssh', '-oBatchMode=yes', '-oConnectTimeout=8', 'hahaxiong83@192.168.1.115']
DIR = Path('/data/home-studio/archives/realtime-voice-agent')
FILES = {'admin/config.db','admin/devices.db','admin/profile.db','brain/conversations.sqlite','brain/profile.sqlite','brain/search.sqlite'}


def vault(*args, data=None):
    return subprocess.check_output(['vw', *args], input=data, stderr=subprocess.DEVNULL)


def backup_key(create):
    matches = [item for item in json.loads(vault('list','items','--search',ITEM)) if item['name'] == ITEM]
    if not matches and create:
        item = {'type':1,'name':ITEM,'login':{'password':secrets.token_hex(32)}}
        matches = [json.loads(vault('create','item',data=base64.b64encode(json.dumps(item).encode())))]
    if len(matches) != 1:
        raise RuntimeError('需要一个唯一的备份密钥条目')
    key = bytes.fromhex(vault('get','password',matches[0]['id']).decode().strip())
    if len(key) != 32:
        raise ValueError('备份密钥长度异常')
    return key


def verify(path, key):
    with path.open('rb') as src, tempfile.TemporaryFile(dir='/dev/shm') as archive:
        if src.read(len(MAGIC)) != MAGIC:
            raise ValueError('备份头错误')
        nonce = src.read(12)
        src.seek(-16,2)
        end = src.tell()
        decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce,src.read(16))).decryptor()
        decryptor.authenticate_additional_data(MAGIC)
        src.seek(len(MAGIC)+12)
        while src.tell() < end:
            archive.write(decryptor.update(src.read(min(65536,end-src.tell()))))
        archive.write(decryptor.finalize())
        archive.seek(0)
        with tarfile.open(fileobj=archive,mode='r:gz') as tar, tempfile.TemporaryDirectory(dir='/dev/shm') as restored:
            members = tar.getmembers()
            if len(members)!=len(FILES) or {m.name for m in members}!=FILES:
                raise ValueError('数据库清单不完整')
            for member in members:
                if not member.isfile():
                    raise ValueError('无效备份成员')
                dbfile = Path(restored)/member.name.replace('/','-')
                with dbfile.open('xb') as dbout, tar.extractfile(member) as stream:
                    import shutil
                    shutil.copyfileobj(stream,dbout)
                with contextlib.closing(sqlite3.connect(dbfile.as_uri()+'?mode=ro',uri=True)) as db:
                    if db.execute('PRAGMA integrity_check').fetchall()!=[('ok',)] or not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").fetchone():
                        raise ValueError('隔离恢复验证失败 '+member.name)


def take(key):
    if not os.path.ismount('/data'):
        raise RuntimeError('/data 未挂载')
    DIR.mkdir(mode=0o700,exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    final = DIR/(stamp+'.xkdb')
    nonce = secrets.token_bytes(12)
    cipher = Cipher(algorithms.AES(key),modes.GCM(nonce)).encryptor()
    cipher.authenticate_additional_data(MAGIC)
    with tempfile.NamedTemporaryFile(dir=DIR,delete=False) as stage:
        name=Path(stage.name)
        try:
            stage.write(MAGIC+nonce)
            with (Path(__file__).parent/'snapshot.py').open('rb') as script, subprocess.Popen(
                [*NAS_SSH, 'python3 -B -'],
                stdin=script,stdout=subprocess.PIPE) as proc:
                for chunk in iter(lambda:proc.stdout.read(65536),b''):
                    stage.write(cipher.update(chunk))
                if proc.wait()!=0:
                    raise RuntimeError('NAS 在线备份失败')
            stage.write(cipher.finalize()+cipher.tag); stage.flush(); os.fsync(stage.fileno())
            verify(name,key); name.rename(final)
        finally:
            name.unlink(missing_ok=True)
    return final


def publish_receipt(archive):
    captured = datetime.strptime(archive.stem, '%Y%m%dT%H%M%S%fZ').replace(tzinfo=timezone.utc)
    receipt = {'schema': 1, 'scope': 'personal-voice',
               'capturedAt': captured.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
               'verifiedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
               'databaseCount': len(FILES), 'archiveBytes': archive.stat().st_size}
    command = shlex.join(['python3', '-B', '-', json.dumps(receipt, separators=(',', ':'))])
    with Path(__file__).with_name('receipt.py').open('rb') as script:
        subprocess.run([*NAS_SSH, command], stdin=script, timeout=30, check=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--verify',type=Path)
    args=parser.parse_args()
    os.umask(0o077)
    key=backup_key(create=not args.verify)
    if args.verify:
        verify(args.verify,key);print('已解密恢复并核验 6 个数据库')
    else:
        archive = take(key)
        print(archive, flush=True)
        try:
            publish_receipt(archive)
        except (OSError, subprocess.SubprocessError) as error:
            print('备份已落盘并通过恢复核验，管理后台回执投递失败：' + type(error).__name__, file=sys.stderr)
            sys.exit(2)
