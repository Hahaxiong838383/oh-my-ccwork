import { deviceRegistryStore } from '../src/device-registry-store.js';
import { configStore } from '../src/config-store.js';
const subjects=(process.env.ANALYTICS_SN_ALLOW??'').split(',').filter(Boolean);
if(![14,20].includes(subjects.length))throw new Error('invalid_staging_subjects');
for(const sn of subjects) deviceRegistryStore.add(sn,'analytics-synthetic-stage');
configStore.setGlobal('analytics.event_upload_enabled',true);
configStore.setGlobal('analytics.daily_upload_hour_cst',0);
console.log(JSON.stringify({ok:true,synthetic_devices:subjects.length}));
process.exit(0);
