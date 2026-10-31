import {readFileSync} from 'node:fs';
import {readReplay} from './source.js';
try{const input=readFileSync(0,'utf8');if(Buffer.byteLength(input)>8192)throw new Error('source_options_too_large');process.stdout.write(JSON.stringify(readReplay(JSON.parse(input))));}
catch{process.stderr.write('shadow_source_read_failed\n');process.exitCode=1;}
