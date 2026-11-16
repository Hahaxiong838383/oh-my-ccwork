// Only the explicitly authorized C switch; values/tokens for other domains are not printed.
import {readFileSync} from 'node:fs';
const scope=JSON.parse(readFileSync('/root/p003-records-compat-20261116/scope-private.json','utf8'));
const {configStore}=await import('/opt/p003/server/src/config-store.ts');
const {recordsStore}=await import('/opt/p003/server/src/ark/records-service.ts');
const enable=process.argv[2]==='enable';
if(!enable&&process.argv[2]!=='disable')throw Error('explicit operation required');
if(enable&&!recordsStore().legacyUploadEnabled(scope.sn))throw Error('current legacy scope not authorized');
const rev=configStore.setValue(scope.sn,'ark_records.enabled',enable);
if(rev===null)throw Error('configuration rejected');
const snapshot=configStore.effectiveSnapshot(scope.sn);
if(snapshot.ark_records?.enabled!==enable||snapshot.ark_records?.contract_id!=='p003-ark-records-r1')throw Error('configuration readback failed');
console.log(JSON.stringify({sn:scope.sn,revision:snapshot.revision,ark_records:snapshot.ark_records}));
