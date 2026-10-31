import {createArkRoutes} from '../ark/routes.js';
import {arkStore,arkService,arkCeiling} from '../ark/service.js';
import {deviceRegistryStore} from '../device-registry-store.js';
import {isValidToken,isAdminRole} from './auth.js';
export const arkRoute=createArkRoutes({store:arkStore,runtime:arkService,ceiling:arkCeiling,secret:()=>process.env.AUTH_JWT_SECRET??'',
 acceptsCredential:(sn,iat)=>{const n=deviceRegistryStore.credentialNotBeforeSec(sn);return iat>0&&(n===null||iat>n);},
 isAdmin:header=>{const token=/^Bearer\s+(.+)$/i.exec(header)?.[1]??'';return isValidToken(token)&&isAdminRole(token);}});
