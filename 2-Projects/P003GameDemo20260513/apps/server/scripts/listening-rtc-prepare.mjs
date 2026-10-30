// Same esbuild/metafile approach as the existing joint harness; no Worker writes/builds.
import {createRequire} from 'node:module';
import {realpathSync,readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=execFileSync('git',['-C',project,'rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
const [outArg]=process.argv.slice(2);if(!outArg)throw Error('Usage: node scripts/listening-rtc-prepare.mjs OUT.mjs');
const out=resolve(outArg);mkdirSync(dirname(out),{recursive:true});
const req=createRequire(realpathSync(resolve(project,'node_modules/tsx/dist/loader.mjs'))),{build}=req('esbuild');
const result=await build({absWorkingDir:project,metafile:true,entryPoints:[resolve(project,'scripts/listening-rtc-brain.ts')],bundle:true,platform:'node',format:'esm',outfile:out,
 banner:{js:"import { createRequire as __p003Require } from 'node:module'; const require = __p003Require(import.meta.url);"}});
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const inputs=Object.keys(result.metafile.inputs).filter(p=>!p.includes('node_modules')).map(p=>({path:resolve(project,p),sha256:sha(resolve(project,p))}));
const assets=['weather-places.json','search-routing-defaults.json'].map(name=>{const source=resolve(project,'src/tools',name),target=resolve(dirname(out),name);copyFileSync(source,target);return {name,source,sha256:sha(target)};});
const contracts=Object.fromEntries(['p003-listening-mode-v1.json','p003-listening-http-v1.json','p003-listening-http-v1.fixtures.json'].map(n=>[n,sha(resolve(root,'4-Assets/contracts',n))]));
const manifest={brain_commit:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),bundle_sha256:sha(out),entry:'scripts/listening-rtc-brain.ts',
 kind:'isolated_rtc_real_authority_synthetic_provider_not_production_artifact',clock:'Date.now',readiness:'external_worker_registration_and_config_ack_only',inputs,assets,contracts};
writeFileSync(out+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({bundle:out,sha256:manifest.bundle_sha256,source_inputs:inputs.length,verification:'prepared_only'}));
