import {parentPort} from 'node:worker_threads';
import {tsImport} from 'tsx/esm/api';

try{
  // Explicit loader registration works even though the worker does not inherit main execArgv.
  await tsImport('./writer-thread.ts',import.meta.url);
}catch{
  parentPort?.postMessage({type:'fatal'});
  parentPort?.close();
  process.exitCode=1;
}
