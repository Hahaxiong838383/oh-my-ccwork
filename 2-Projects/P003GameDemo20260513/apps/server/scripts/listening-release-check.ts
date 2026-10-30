/** Reconstruct only captured live DDL plus synthetic rows; never copy/read production user databases. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [stateArg,releaseArg]=process.argv.slice(2);if(!stateArg||!releaseArg)throw Error('STATE RELEASE required');
const state=resolve(stateArg),release=resolve(releaseArg),dir=resolve(release,'schema-check');mkdirSync(dir,{mode:0o700});
const snapshot=JSON.parse(readFileSync(resolve(state,'38-live-private.json'),'utf8'));
for(const name of ['config.db','devices.db']){
 const db=new DatabaseSync(resolve(dir,name)),schema=snapshot.dbs[name].schema as [string,string][];
 for(const prefix of ['CREATE TABLE','CREATE INDEX','CREATE UNIQUE INDEX','CREATE TRIGGER'])for(const [,sql] of schema)if(sql?.startsWith(prefix))db.exec(sql);
 db.close();
}
const configPath=resolve(dir,'config.db'),devicesPath=resolve(dir,'devices.db');
const configDb=new DatabaseSync(configPath),devicesDb=new DatabaseSync(devicesPath);
const {allowlist_count,allowlist_sha256,...config}=snapshot.dbs['config.db'].listening_config;
assert.equal(allowlist_count,0,'This rehearsal only seeds an empty live gate, never copies production identifiers');config.allowlist=[];
configDb.prepare('INSERT INTO listening_settings VALUES(1,?,?,?,?)').run(config.revision,JSON.stringify(config),Date.now(),'synthetic-schema-check');
configDb.prepare('INSERT INTO runtime_flag VALUES(?,?,?,?,?)').run('p003.search.canary.enabled','1',1,'synthetic','schema check');
const preserved=()=>JSON.stringify({flags:configDb.prepare('SELECT * FROM runtime_flag ORDER BY key').all(),settings:configDb.prepare('SELECT * FROM listening_settings').all(),registry:devicesDb.prepare('SELECT * FROM device_registry').all()});
const before=preserved();
const load=(tree:string,name:string)=>import(pathToFileURL(resolve(release,tree,'server/src',name+'.ts')).href);
const {ListeningSettingsStore}=await load('candidate','listening-settings-store');
const {ListeningAuthorityStore}=await load('candidate','listening-authority-store');
const settings=new ListeningSettingsStore(configPath),authority=new ListeningAuthorityStore(devicesPath);
const generation=settings.sourceGeneration();assert.equal(generation,0);assert.deepEqual(settings.read().config,config);
assert.equal(preserved(),before,'migration must not alter existing gate/search/registry rows');
const old=await load('live','listening-settings-store'),oldSettings=new old.ListeningSettingsStore(configPath);
assert.deepEqual(oldSettings.read().config,config,'actual captured old settings code reads additive schema/config unchanged');
configDb.prepare("UPDATE runtime_flag SET value=value WHERE key='p003.search.canary.enabled'").run();assert.equal(settings.sourceGeneration(),1);assert.equal(preserved(),before);
const tables=(db:DatabaseSync)=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'listening_%' ORDER BY name").all();
const result={status:'pass',scope:'actual captured DDL / synthetic rows; '+process.platform+' '+process.arch+' Node '+process.version,additive_only:true,shared_rows_unchanged:true,old_settings_code_reads_after_migration:true,source_generation_trigger:true,config_tables:tables(configDb),device_tables:tables(devicesDb),limitations:['not a production database backup/restore','schema-only command; full server startup requires separate evidence','no user rows or real device data']};
writeFileSync(resolve(release,'schema-check.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
oldSettings.close();settings.close();authority.close();configDb.close();devicesDb.close();console.log(JSON.stringify(result));
