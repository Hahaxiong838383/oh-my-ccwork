// Usage: node build-joint.mjs <Brain-worktree> <output.mjs>. Never changes the Brain tree.
import {createRequire} from 'node:module';
import {realpathSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [brain,out]=process.argv.slice(2);if(!brain||!out)throw Error('Brain tree and output required');
const project=resolve(brain,'2-Projects/P003GameDemo20260513/apps/server');
const contract=JSON.parse(readFileSync(resolve(brain,'4-Assets/contracts/p003-listening-http-v1.json')));if(contract.status!=='frozen_for_integration')throw Error('contract not frozen');
const req=createRequire(realpathSync(resolve(project,'node_modules/tsx/dist/loader.mjs')));
const {build}=req('esbuild');
const result=await build({metafile:true,entryPoints:[resolve(dirname(fileURLToPath(import.meta.url)),'joint-server.ts')],bundle:true,platform:'node',format:'esm',outfile:out,plugins:[{name:'read-only-brain',setup(b){b.onResolve({filter:/^@p003-joint\//},args=>({path:resolve(project,args.path.endsWith('fixture')?'scripts/lib/listening-test.ts':'src/routes/listening.ts')}));}}]});

const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const inputs=Object.keys(result.metafile.inputs).filter(p=>!p.includes('node_modules')).map(p=>({path:resolve(p),sha256:digest(resolve(p))}));
writeFileSync(out+'.manifest.json',JSON.stringify({brain_commit:execFileSync('git',['-C',brain,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),bundle_sha256:digest(out),contract_sha256:digest(resolve(brain,'4-Assets/contracts/p003-listening-http-v1.json')),inputs},null,2)+'\n');
