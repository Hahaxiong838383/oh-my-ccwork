import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {isArkStateQuestion} from '../src/xiaoke-kb.js';
import {answerArk} from '../src/ark/answer.js';
const d=JSON.parse(readFileSync(process.env.ASR_COMPARISON_FILE!,'utf8'));
const fixtures=d['asr-fixtures.json'];
const rows=d['asr-results.jsonl'].map((run:any)=>({label:run.label,nonstream:run.nonstream,rows:run.definites.map((x:any,i:number)=>({fixture_index:i,expected_text:fixtures[i].text,actual_text:x.text,state_query:isArkStateQuestion(x.text),finite_reply_without_facts:answerArk(x.text,undefined,[],1793701800000)}))}));
const a=rows.find((x:any)=>x.label==='candidate'&&!x.nonstream);
assert.equal(a.rows[2].actual_text,'忽悠几声，补勤卡。');
assert.equal(a.rows[2].state_query,false);assert.equal(a.rows[2].finite_reply_without_facts,null);
assert.equal(isArkStateQuestion(fixtures[2].text),true);
for(const mode of [false,true]){
 const r=rows.find((x:any)=>x.label==='candidate'&&x.nonstream===mode);
 for(const i of [7,8,9,10,11,12,13]){assert.equal(r.rows[i].state_query,false);assert.equal(r.rows[i].finite_reply_without_facts,null);}
}
writeFileSync(process.env.ASR_ROUTING_OUT!,JSON.stringify({source:'Fixed 856552b9 text functions; synthetic provider transcripts; no network/LLM',checks_passed:true,rows},null,2)+'\n');
console.log('PASS: surviving inventory-intent loss and negative-context boundaries reproduced from provider transcripts.');
