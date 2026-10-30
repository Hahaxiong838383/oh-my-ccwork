// Reuse session39's existing harness. Prepares a bundle; does not run Cargo, deploy or change either service.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const [workerArg,outArg]=process.argv.slice(2);
if(!workerArg||!outArg||workerArg==='--help'){
 console.log('Usage: node scripts/listening-joint-prepare.mjs <Worker-worktree> <output.mjs>');
 console.log('Then, in the isolated Linux Worker copy: P003_LISTENING_JOINT_BUNDLE=<output.mjs> sh scripts/listening/run-joint.sh');
 process.exit(workerArg==='--help'?0:1);
}
const git=(tree,...args)=>execFileSync('git',['-C',tree,...args],{encoding:'utf8'}).trim();
const brain=git(dirname(fileURLToPath(import.meta.url)),'rev-parse','--show-toplevel'),worker=resolve(workerArg),out=resolve(outArg);
if(out===worker||out.startsWith(worker+'/'))throw Error('Output must stay outside the read-only Worker worktree');
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const names=['p003-listening-mode-v1.json','p003-listening-http-v1.json','p003-listening-http-v1.fixtures.json'];
const hashes={};
for(const name of names){const brainFile=resolve(brain,'4-Assets/contracts',name),workerFile=resolve(worker,'4-Assets/contracts',name);
 if(sha(brainFile)!==sha(workerFile))throw Error('Contract mismatch: '+name);hashes[name]=sha(brainFile);
}
const contract=JSON.parse(readFileSync(resolve(brain,'4-Assets/contracts/p003-listening-http-v1.json'),'utf8'));
if(contract.version!==1||contract.status!=='frozen_for_integration')throw Error('HTTP v1 is not frozen');
const rust=resolve(worker,'2-Projects/realtime-voice-agent/rust-worker');
mkdirSync(dirname(out),{recursive:true});
execFileSync(process.execPath,[resolve(rust,'scripts/listening/build-joint.mjs'),brain,out],{cwd:rust,stdio:'inherit'});
const file=out+'.manifest.json',manifest=JSON.parse(readFileSync(file,'utf8'));
Object.assign(manifest,{worker_commit:git(worker,'rev-parse','HEAD'),worker_worktree:worker,
 brain_dirty:git(brain,'status','--porcelain'),worker_dirty:git(worker,'status','--porcelain'),contracts:hashes,
 worker_harness:Object.fromEntries(['scripts/listening/build-joint.mjs','scripts/listening/joint-server.ts','scripts/listening/run-joint.sh','src/job.rs'].map(name=>[name,sha(resolve(rust,name))])),
 verification:'prepared_only; Rust/RTC/readiness not executed by this command'});
writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({manifest:file,brain_commit:manifest.brain_commit,worker_commit:manifest.worker_commit,contracts_match:true,verification:manifest.verification}));
