import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const stage = mkdtempSync(join(tmpdir(),'personal-style-test-'));
copyFileSync(join(here,'personal-style.ts'),join(stage,'personal-style.ts'));
writeFileSync(join(stage,'package.json'),'{"type":"module"}\n');
execFileSync('python3',[join(here,'stage.py'),join(here,'../../../P003GameDemo20260513/apps/server/src'),join(stage,'p003')]);
const dbPath = join(stage,'profile.sqlite');
process.env.PROFILE_DB_PATH = dbPath;
after(() => rmSync(stage,{recursive:true,force:true}));

test('private scoped style uses the existing owner store without a switch cooldown or daily limit', async () => {
  const {resolvePersonalStyle: resolve, styleHistory} = await import(pathToFileURL(join(stage,'personal-style.ts')).href);
  const db = new DatabaseSync(dbPath,{readOnly:true});
  try {
    const template = () => db.prepare("select template from trait_template where account_id='tester'").get()?.template ?? 'default';
    const dims = () => db.prepare("select * from trait_state where account_id='tester'").get();
    const run = (s:string, history: {role:string;content:string}[] = [], store=true) => resolve('tester',s,store,history);
    assert.equal(run('往后咱们聊天直奔主题，一两句话说完就可以。').key,'quiet');
    assert.equal(template(),'quiet');
    const previous = dims();
    const once = '只这一次，请你说话幽默一点，给我讲讲春天。';
    const t = run(once);
    assert.equal(t.key,'funny');assert.equal(t.request,'给我讲讲春天。');
    assert.equal(t.temporary,true);assert.equal(t.reply,undefined);
    assert.match(t.policyLine,/仅限本次/);
    assert.deepEqual(dims(),previous);assert.equal(template(),'quiet');
    assert.deepEqual(styleHistory([{role:'user',content:once},{role:'assistant',content:'春天来了。'}]),
      [{role:'user',content:'给我讲讲春天。'},{role:'assistant',content:'春天来了。'}]);
    const pure = '这次回答得幽默一点';
    const h = [{role:'user',content:pure},{role:'assistant',content:run(pure).reply}];
    assert.deepEqual(styleHistory(h),[]);
    assert.equal(run('以后都这样',h).key,'funny');assert.equal(template(),'funny');
    assert.match(run('以后都这样').reply,/想让我以后怎么说/);
    for (const [text,key] of [['以后多聊点','chatty'],['以后都简短点','quiet'],['以后都幽默些','funny'],
      ['以后恢复默认','default'],['以后健谈一点','chatty'],['以后直奔主题','quiet']]) {
      assert.equal(run(text).key,key);assert.equal(template(),key);
    }
    const count = () => db.prepare("select count(*) n from growth_event where account_id='tester'").get()?.n;
    const n = count();
    assert.equal(run('以后简短一点').key,'quiet');assert.equal(count(),n);
    assert.match(run('以后说话幽默一点',[],false).reply,/只对当前回答生效/);assert.equal(template(),'quiet');
    assert.equal(run('只这一次，用一句话告诉我今天几号').request,'今天几号');
    for(const text of ['我妈妈觉得他幽默一点比较好','解释“以后幽默一点”的意思','我想知道简短一点是什么意思','不要幽默一点','聊聊北京的天气']) {
      assert.equal(run(text),undefined,text);
    }
    assert.equal(template(),'quiet');
    assert.equal(run('恢复默认').temporary,false);assert.equal(template(),'default');
    const humorous = run('只这一次，请你用幽默的语气讲个小故事');
    assert.equal(humorous.temporary,true);assert.equal(humorous.request,'讲个小故事');
    const inRoom = (text:string,room='single-room') => resolve('tester',text,true,[],room);
    assert.match(inRoom('只这一次，回答得幽默一点').reply,/下一问/);
    assert.equal(inRoom('早上好','new-room'),undefined);
    const tool = inRoom('看看明天天气'); // Direct tool replies skip consume().
    assert.equal(tool.key,'funny');
    const first = inRoom('给我讲讲潮汐');
    assert.equal(first.key,'funny');first.consume();
    assert.equal(inRoom('说说山脉'),undefined);
    assert.equal(template(),'default');
    inRoom('只这一次，说话幽默点');
    const interrupted = inRoom('解释银河系');
    inRoom('只这一次，简短一点');
    interrupted.consume();
    assert.equal(inRoom('解释月食').key,'quiet');
    inRoom('以后都健谈一点');assert.equal(template(),'chatty');
    assert.equal(inRoom('聊聊极光'),undefined);
    inRoom('只这一次，请简短回答');
    inRoom('介绍一下满月').consume();
    assert.equal(inRoom('以后都这样').key,'quiet');assert.equal(template(),'quiet');
    assert.match(inRoom('以后说话稳重一点').reply,/哪一种/);assert.equal(template(),'quiet');
  } finally {db.close();}
});
