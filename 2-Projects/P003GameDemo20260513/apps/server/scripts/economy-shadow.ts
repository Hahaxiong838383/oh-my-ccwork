import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateReplay} from '../src/economy-shadow/evaluate.js';
import {parseInput,type Basis} from '../src/economy-shadow/contracts.js';
import {ShadowStore,writeReport} from '../src/economy-shadow/store.js';
import {renderReport} from '../src/economy-shadow/report.js';
function json(path:string,max=32*1024*1024){const b=readFileSync(path);if(b.length>max)throw new Error('file_too_large');return JSON.parse(b.toString('utf8'));}
try{
 process.umask(0o077);const opts=new Map<string,string>(),allowed=new Set(['input','subject','day','cutoff-ms','output-dir','rule','basis']);
 const argv=process.argv.slice(2);for(let i=0;i<argv.length;i+=2){const key=argv[i].replace(/^--/,'');if(!argv[i].startsWith('--')||!allowed.has(key)||opts.has(key)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('invalid_arguments');opts.set(key,argv[i+1]);}
 if(!opts.has('output-dir'))throw new Error('output_dir_required');
 const sources:string[]=[];let input:unknown;
 if(opts.has('input')){if(['subject','day','cutoff-ms'].some(k=>opts.has(k)))throw new Error('mixed_input_modes');sources.push(realpathSync(opts.get('input')!));input=json(sources[0]);}
 else{
  const a=process.env.ANALYTICS_DB_PATH,t=process.env.TELEMETRY_DB_PATH,k=process.env.ANALYTICS_DEVICE_KEY_SECRET;
  if(!a||!t||!k||!opts.has('subject')||!opts.has('day')||!opts.has('cutoff-ms'))throw new Error('source_options_required');
  sources.push(realpathSync(a),realpathSync(t));
  const options={analyticsPath:sources[0],telemetryPath:sources[1],deviceKeySecret:k,subject:opts.get('subject'),day:opts.get('day'),cutoff_ms:Number(opts.get('cutoff-ms'))};
  const out=execFileSync(process.execPath,['--experimental-sqlite','--import','tsx',fileURLToPath(new URL('../src/economy-shadow/source-worker.ts',import.meta.url))],{input:JSON.stringify(options),encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']});input=JSON.parse(out);
 }
 const parsed=parseInput(input),basis=opts.get('basis') as Basis|undefined;
 if(basis&&!['telemetry_union','checkpoint_max'].includes(basis))throw new Error('invalid_basis');
 let rule:unknown=null;if(opts.has('rule')){sources.push(realpathSync(opts.get('rule')!));rule=json(sources.at(-1)!,65536);}else if(basis)throw new Error('basis_without_rule');
 const r=evaluateReplay(parsed,rule,basis??null),dir=resolve(opts.get('output-dir')!);
 if(existsSync(dir)&&lstatSync(dir).isSymbolicLink())throw new Error('output_symlink');
 mkdirSync(dir,{recursive:true,mode:0o700});const real=realpathSync(dir);
 for(const path of sources){const rel=relative(real,path);if(!rel||!isAbsolute(rel)&&!rel.startsWith('..'+(process.platform==='win32'?'\\':'/')))throw new Error('output_contains_source');}
 const store=new ShadowStore(join(real,'shadow.db'));let status;try{status=store.save(r);}finally{store.close();}
 const base=join(real,`${r.day}-${r.subject_alias}-${r.run_id}`);
 writeReport(base+'.json',JSON.stringify(r,null,2)+'\n');writeReport(base+'.md',renderReport(r));
 console.log(JSON.stringify({ok:true,status,mode:r.mode,ready_for_settlement:false,run_id:r.run_id,report:base+'.md'}));
}catch(error){
 // Child failures can contain original stdout/stderr. Never print them or credentials.
 const message=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'shadow_run_failed';
 console.error(JSON.stringify({ok:false,error:message}));process.exitCode=1;
}
