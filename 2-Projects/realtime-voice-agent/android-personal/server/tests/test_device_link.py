"""Owner/device round trips against the HTTP and Unix listeners using two paired test devices."""
import http.client
import json
import os
import socket
import tempfile
import unittest
from test_service import CRED, CRED2, Server, ev, post_events


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self,path):
        super().__init__('localhost',timeout=3)
        self.path=path

    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX)
        self.sock.connect(self.path)


class DeviceRoundTrip(unittest.TestCase):
    def test_device_sync_and_owner_controls(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=os.path.join(tmp,'owner.sock')
            srv=Server(tmp,NIGHT_OWNER_SOCKET=path)
            self.addCleanup(srv.close)
            def admin(method,endpoint,data=None):
                c=UnixHTTP(path)
                c.request(method,endpoint,json.dumps(data) if data is not None else None)
                r=c.getresponse()
                reply=(r.status,json.loads(r.read()))
                c.close()
                return reply
            def sync(body,token=CRED):
                s,raw,_=srv.request('POST','/mobile/night/sync',json.dumps(body).encode(),{'Authorization':'Bearer '+token})
                return s,json.loads(raw)
            def devices():
                code,res=admin('GET','/devices')
                self.assertEqual(code,200)
                return {d['device']:d for d in res['devices']}
            body=dict(versionCode=1000006,phase='speaking',accent='#3485ef',muted=False,appliedRevision=0,ack='')
            self.assertEqual(srv.request('GET','/mobile/night/devices')[0],404)
            self.assertEqual(sync(body,'expired')[0],401)
            self.assertEqual(sync(dict(body,device='phone-02'))[0],400)
            self.assertEqual(sync(dict(body,phase=['idle']))[0],400)
            post_events(srv,[ev('old','call_end',vc=1000005)])
            self.assertEqual(devices()['phone-01']['lastSeen'],0)
            self.assertEqual(devices()['phone-01']['versionCode'],1000005)
            _,first=sync(body)
            self.assertEqual(first['accent'],'#3485EF')
            saved=devices()['phone-01']
            self.assertEqual(saved['phase'],'speaking')
            self.assertGreater(saved['lastSeen'],0)
            self.assertEqual(saved['events'][0]['kind'],'call_end')
            self.assertEqual(admin('POST','/devices/ghost/color',{'accent':'#00FF00'})[0],404)
            self.assertEqual(admin('POST','/devices/phone-01/color',{'accent':'#00FF00'})[0],200)
            _,stale=sync(dict(body,appliedRevision=first['revision']))
            self.assertEqual(stale['accent'],'#00FF00')
            self.assertGreater(stale['revision'],devices()['phone-01']['appliedRevision'])
            current=dict(body,appliedRevision=stale['revision'],accent='#00ff00')
            sync(current)
            self.assertEqual(devices()['phone-01']['appliedRevision'],stale['revision'])
            _,local=sync(dict(current,accent='#987654'))
            self.assertEqual(devices()['phone-01']['accent'],'#987654')
            self.assertGreater(local['revision'],stale['revision'])
            url='/devices/phone-01/command'
            self.assertEqual(admin('POST',url,{'action':'restart'})[0],400)
            self.assertEqual(admin('POST',url,{'action':'sync_logs'})[0],200)
            self.assertEqual(admin('POST',url,{'action':'check_update'})[0],409)
            _,pending=sync(current)
            command=pending['command']
            self.assertEqual(command['action'],'sync_logs')
            self.assertEqual(sync(current)[1]['command'],command)
            self.assertIsNone(sync(dict(current,ack=command['id']),CRED2)[1]['command'])
            self.assertEqual(devices()['phone-01']['command']['status'],'pending')
            self.assertIsNone(sync(dict(current,ack=command['id']))[1]['command'])
            self.assertEqual(devices()['phone-01']['command']['status'],'acked')
            self.assertEqual(admin('POST',url,{'action':'check_update'})[0],200)
            self.assertEqual(sync(dict(current,ack=command['id']))[1]['command']['action'],'check_update')
            srv.close()
            fresh=Server(tmp,NIGHT_OWNER_SOCKET=path)
            try:
                self.assertEqual(devices()['phone-01']['command']['status'],'pending')
                self.assertEqual(devices()['phone-01']['accent'],'#987654')
            finally:
                fresh.close()


if __name__ == '__main__':
    unittest.main()
