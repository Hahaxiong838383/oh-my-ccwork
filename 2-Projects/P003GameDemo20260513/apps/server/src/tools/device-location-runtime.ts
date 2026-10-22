import type {Context} from 'hono';
import {getConnInfo} from '@hono/node-server/conninfo';
import {DeviceLocationStore,Ip9Location,trustedDeviceIp} from './device-location.js';
import {RoutingStore} from './search-routing-store.js';
let store:DeviceLocationStore|null=null,config:RoutingStore|null=null;
const provider=new Ip9Location();
export function getDeviceLocationStore(){const path=process.env.SEARCH_DEVICE_LOCATION_DB_PATH;return path?(store??=new DeviceLocationStore(path)):null;}
/** Called only after authentication, canary selection and token self-check. No network await. */
export function captureDeviceLocation(c:Context,sn:string,room:string,expires:number):void {
 try {
  if(!process.env.SEARCH_DEVICE_LOCATION_DB_PATH||!process.env.SEARCH_DEVICE_ROUTING_DB_PATH)return;
  config??=new RoutingStore(process.env.SEARCH_DEVICE_ROUTING_DB_PATH);
  const published=config.snapshot(sn)?.config;if(!published?.weather_enabled||!published.auto_location_enabled)return;
  const db=getDeviceLocationStore();if(!db)return;
  const request=db.begin(sn,room,expires);
  let ip:string|null=null;try{ip=trustedDeviceIp(getConnInfo(c).remote.address,c.req.header('host'),c.req.header('x-real-ip'));}catch{}
  if(!ip){db.fail(request,'location_untrusted_ingress');return;}
  void provider.lookup(ip).then(city=>db.finish(request,city),e=>db.fail(request,e instanceof Error?e.message:'location_unavailable')).catch(()=>console.warn('[device-location] storage_unavailable'));
 }catch{console.warn('[device-location] capture_unavailable');}
}
export function closeDeviceLocationRuntime(){store?.close();store=null;config?.close();config=null;}
