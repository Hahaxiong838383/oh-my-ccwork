import { deviceRegistryStore } from '../src/device-registry-store.js';
import { configStore } from '../src/config-store.js';
const subjects = Array.from({length:14},(_,i)=>'BJP003261013'+String(i+1).padStart(8,'0'));
for(const sn of subjects) deviceRegistryStore.add(sn,'analytics-synthetic-stage');
configStore.setGlobal('analytics.event_upload_enabled',true);
configStore.setGlobal('analytics.daily_upload_hour_cst',0);
console.log(JSON.stringify({ok:true,synthetic_devices:subjects.length}));
process.exit(0);
