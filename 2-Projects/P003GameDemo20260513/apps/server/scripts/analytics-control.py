#!/usr/bin/env python3
"""Atomically update the analytics server gate; never change the device allowlist."""
import argparse,json,os,tempfile
from pathlib import Path

def set_enabled(path,enabled):
    path=Path(path)
    if not isinstance(enabled,bool):
        raise ValueError('enabled must be boolean')
    if path.is_symlink():
        raise ValueError('control file cannot be symlink')
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix='.'+path.name+'-',suffix='.tmp',dir=path.parent)
    temp=Path(name)
    try:
        with os.fdopen(fd,'w') as f:
            os.fchmod(f.fileno(),0o600)
            json.dump({'enabled':enabled},f,separators=(',',':'))
            f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(temp,path)
        fd=os.open(path.parent,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        temp.unlink(missing_ok=True)
    return {'ok':True,'enabled':enabled}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--control',type=Path,required=True)
    g=p.add_mutually_exclusive_group(required=True)
    g.add_argument('--disable',action='store_true'); g.add_argument('--enable',action='store_true')
    a=p.parse_args(); print(json.dumps(set_enabled(a.control,a.enable)))
