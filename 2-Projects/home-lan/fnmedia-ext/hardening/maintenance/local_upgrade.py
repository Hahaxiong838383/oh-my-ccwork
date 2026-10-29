#!/usr/bin/env python3
"""Let trim-cli run its normal update workflow for a local FPK.

trim-cli 0.1.1 always starts a cloud download before app update. This short-lived
loopback CONNECT proxy changes only that download source to the supplied NAS
FPK. OAuth storage, refresh, update guards and task polling remain in trim-cli.
No credentials or HTTP bodies are logged or persisted; the destination is fixed.
"""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading

HOST, PORT = '192.168.1.43', 5667
DOWNLOAD = '/ogh/ac/h/app-center/v1/download/task'


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--trim-cli', required=True)
    p.add_argument('--remote-fpk', required=True)
    p.add_argument('--version', required=True)
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args(argv)
    import re
    if not re.fullmatch(r'\d+(?:\.\d+){1,3}', args.version):
        p.error('invalid version')
    if not args.remote_fpk.startswith('/vol3/1000/软件安装/fnmedia-ext-managed-packages/') or not args.remote_fpk.endswith('.fpk') or '..' in Path(args.remote_fpk).parts:
        p.error('FPK must be in the fixed maintenance package directory')
    with tempfile.TemporaryDirectory(prefix='fnmedia-cli-') as temporary:
        certificate, key = Path(temporary)/'certificate.pem', Path(temporary)/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
                        '-subj','/CN=192.168.1.43','-keyout',str(key),'-out',str(certificate)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        key.chmod(0o600)
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, key)
        rewritten=[]
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*_): pass
            def do_CONNECT(self):
                if self.path != f'{HOST}:{PORT}':
                    return self.send_error(403)
                self.send_response(200); self.end_headers()
                self.connection=context.wrap_socket(self.connection,server_side=True)
                self.rfile=self.connection.makefile('rb')
                self.wfile=self.connection.makefile('wb')
                self.close_connection=False
            def relay(self):
                if not self.path.startswith('/ogh/') or self.headers.get('Host') != f'{HOST}:{PORT}':
                    return self.send_error(403)
                length=int(self.headers.get('Content-Length','0'))
                if length > 1024*1024: return self.send_error(413)
                body=self.rfile.read(length) if length else None
                if self.command=='POST' and self.path==DOWNLOAD:
                    data=json.loads(body)
                    # Capture no secrets: reject anything except the intended application.
                    if data.get('appName')!='fnmedia-ext' or str(data.get('version'))!=args.version:
                        return self.send_error(403)
                    data['packageSourceType']='file'
                    data['path']=args.remote_fpk
                    body=json.dumps(data).encode()
                    rewritten.append(True)
                headers={k:v for k,v in self.headers.items() if k.lower() not in
                         ('content-length','connection','proxy-connection','transfer-encoding')}
                headers['Connection']='close'
                upstream=http.client.HTTPSConnection(HOST,PORT,timeout=60,
                    context=ssl._create_unverified_context())
                try:
                    upstream.request(self.command,self.path,body=body,headers=headers)
                    r=upstream.getresponse(); content=r.read(4*1024*1024+1)
                    if len(content)>4*1024*1024: return self.send_error(502)
                    self.send_response(r.status)
                    for k,v in r.getheaders():
                        if k.lower() not in ('content-length','connection','transfer-encoding'):
                            self.send_header(k,v)
                    self.send_header('Content-Length',str(len(content)))
                    self.end_headers(); self.wfile.write(content)
                finally: upstream.close()
            do_GET=relay
            do_POST=relay
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        server.daemon_threads=True
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        env=os.environ.copy()
        proxy=f'http://127.0.0.1:{server.server_port}'
        for name in ('HTTPS_PROXY','HTTP_PROXY','https_proxy','http_proxy'): env[name]=proxy
        for name in ('NO_PROXY','no_proxy'): env[name]=''
        command=[args.trim_cli,'--profile','fnos1','app','update','fnmedia-ext',
                 '--version',args.version,'--package-type','local','--volume-id','3','--yes',
                 '--accept-license','--custom-parameters','[{"key":"wizard_agree_terms","value":["agree"]}]']
        if args.dry_run: command.append('--dry-run')
        try:
            result=subprocess.run(command,env=env,timeout=1800)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
        if not rewritten:
            raise SystemExit('CLI did not use the local-package adapter; no update claimed')
        return result.returncode


if __name__=='__main__': raise SystemExit(main())
