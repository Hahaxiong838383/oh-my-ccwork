import {resolve} from 'node:path';
import {arkStore,arkCeiling} from './service.js';
import {accountStore} from '../account-store.js';
import {deviceRegistryStore} from '../device-registry-store.js';
import {RecordsStore} from './records-store.js';
import {createRecordsDeviceRoutes,createRecordsParentRoutes} from './records-routes.js';
import {dashboardRecords,emptyCoverage} from './records-contract.js';
let store:RecordsStore|undefined;
export const recordsAllowed=(sn:string)=>(process.env.ARK_RECORDS_SN_ALLOW??'').split(',').map(x=>x.trim()).filter(Boolean).includes(sn)&&arkCeiling().includes(sn);
export function recordsStore(){
 if(!store){arkStore();store=new RecordsStore({arkPath:resolve(process.env.ARK_DB_PATH??'./data/ark.db'),devicesPath:resolve(process.env.DEVICES_DB_PATH??'./data/devices.db'),allowed:recordsAllowed,validAccount:id=>accountStore.findAccount(id)?.role==='device',validParentAccount:id=>accountStore.findAccount(id)?.role==='parent',secret:()=>process.env.AUTH_JWT_SECRET??''});}
 return store;
}
const options={store:recordsStore,secret:()=>process.env.AUTH_JWT_SECRET??''};
export const recordsDeviceRoute=createRecordsDeviceRoutes(options);
export const recordsParentRoute=createRecordsParentRoutes(options);
export function legacyUploadConfigAllowed(sn:string){try{return recordsStore().legacyUploadEnabled(sn);}catch{return false;}}
export function recordsDashboard(publicId:string,owner:string){
 const dev=deviceRegistryStore.getByPublicId(publicId);
 if(!dev||dev.parent_account_id!==owner||!recordsAllowed(dev.sn))return dashboardRecords(emptyCoverage(),'not_enabled');
 try { return recordsStore().dashboard(publicId,owner); }
 catch { return dashboardRecords(emptyCoverage(),'dependency_unavailable'); }
}
