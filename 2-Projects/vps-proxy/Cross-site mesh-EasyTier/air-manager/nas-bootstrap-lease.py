import urllib.request,urllib.error,xml.etree.ElementTree as E,json,sys
ENDPOINT='http://192.168.1.1:5000/ctl/IPConn';SERVICE='urn:schemas-upnp-org:service:WANIPConnection:1'
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(action,args):
 xml='<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:'+action+' xmlns:u="'+SERVICE+'">'+''.join('<'+k+'>'+str(v)+'</'+k+'>' for k,v in args.items())+'</u:'+action+'></s:Body></s:Envelope>'
 req=urllib.request.Request(ENDPOINT,data=xml.encode(),headers={'Content-Type':'text/xml; charset="utf-8"','SOAPAction':'"'+SERVICE+'#'+action+'"'})
 try:
  with op.open(req,timeout=5) as r:body=r.read()
 except urllib.error.HTTPError as e:body=e.read()
 root=E.fromstring(body);result={el.tag.split('}')[-1]:el.text or '' for el in root.iter() if len(el)==0}
 return result

from pathlib import Path
import time,os,fcntl

def ensure():
    want={'NewRemoteHost':'','NewExternalPort':21110,'NewProtocol':'TCP'}
    old=call('GetSpecificPortMappingEntry',want)
    if 'errorCode' not in old:
        if old.get('NewInternalClient')!='192.168.1.115' or old.get('NewInternalPort')!='21110' or old.get('NewPortMappingDescription')!='EasyTier-Lucky-NAS2':
            return {'ok':False,'code':'conflict_no_overwrite'}
        lease=int(old.get('NewLeaseDuration','0'))
        if old.get('NewEnabled')=='1' and (lease==0 or lease>86400):
            return {'ok':True,'code':'mapping_valid','remaining_seconds':lease,'target':'192.168.1.115:21110'}
    elif old.get('errorCode')!='714':
        return {'ok':False,'code':'gateway_query_failed'}
    wanted=dict(want,NewInternalPort=21110,NewInternalClient='192.168.1.115',NewEnabled=1,NewPortMappingDescription='EasyTier-Lucky-NAS2',NewLeaseDuration=604800)
    result=call('AddPortMapping',wanted)
    if 'errorCode' in result:return {'ok':False,'code':'mapping_update_failed'}
    after=call('GetSpecificPortMappingEntry',want)
    ok=after.get('NewInternalClient')=='192.168.1.115' and after.get('NewInternalPort')=='21110' and after.get('NewEnabled')=='1'
    return {'ok':ok,'code':'mapping_renewed' if ok else 'readback_failed','remaining_seconds':int(after.get('NewLeaseDuration','0')),'target':'192.168.1.115:21110'}

def main():
    # Only user-owned state is written; no passwords or admin privileges.
    state=Path(__file__).resolve().parent
    os.umask(0o077)
    with open(state/'lease.lock','a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        try:result=ensure()
        except Exception:result={'ok':False,'code':'gateway_unavailable'}
        result['checked_at']=time.time()
        tmp=state/'lease-status.tmp'
        with tmp.open('w') as f:json.dump(result,f)
        os.replace(tmp,state/'lease-status.json')
        print(json.dumps(result))
        if not result['ok']:raise SystemExit(1)

if __name__=='__main__':main()
