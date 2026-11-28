import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {createConsoleActivity} from './console-activity.js';
import {applyVoiceCues,defaultVoiceCues,withVoiceProgress} from './voice-progress.js';

test('owner activity, seven local dates, versioned updates and actual spoken cue', async () => {
  const dir = mkdtempSync(join(tmpdir(),'personal-activity-'));
  try {
    const profile = new DatabaseSync(join(dir,'profile.sqlite'));
    profile.exec('CREATE TABLE extraction_log(account_id,ts,ok); CREATE TABLE growth_event(account_id,ts)');
    const now = Date.now();
    profile.prepare('INSERT INTO extraction_log VALUES(?,?,?)').run('me',now,0);
    profile.prepare('INSERT INTO growth_event VALUES(?,?)').run('me',now);
    profile.close();
    const chats = new DatabaseSync(join(dir,'conversations.sqlite'));
    chats.exec('CREATE TABLE conversation(id,role,text,ts,account_id,session_id)');
    const add = chats.prepare('INSERT INTO conversation VALUES(?,?,?,?,?,?)');
    add.run('1','user','测试用语',now,'me','room');
    add.run('2','assistant','测试回复',now,'me','room');
    add.run('3','user','其他账号',now,'another','room');
    chats.close();
    const app = createConsoleActivity(dir,'me',text=>text==='测试用语'?'已隐藏':text);
    const call = (path:string, value?:object) => app.request(path, value && {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
    const details = await (await call('/activity')).json();
    assert.equal(details.days.length,7);
    assert.equal(details.days.at(-1).turns,1);
    assert.equal(details.days.at(-1).extractions,1);
    assert.equal(details.days.at(-1).growth,1);
    assert.equal(details.extraction.lastStatus,'failed');
    assert.equal(details.total,1);
    assert.equal(details.items[0].messages,2);
    assert.equal((await (await call('/conversations/room')).json()).items[0].text,'已隐藏');
    assert.equal((await call('/activity?limit=-1')).status,400);
    assert.equal((await call('/conversations/missing')).status,404);
    const cfg = {...defaultVoiceCues, search:['我这就查一下。'], searchWaitMs:100};
    assert.equal((await call('/voice-cues',cfg)).status,200);
    assert.equal((await call('/voice-cues',cfg)).status,409);
    assert.equal((await call('/voice-cues',{...cfg,revision:1,chatWaitMs:0})).status,400);
    const spoken:string[]=[];
    await withVoiceProgress('test-room', async (write,start) => {
      start(); await delay(175); await write('这里是测试结果。');
    }, async text=>{spoken.push(text);},new AbortController().signal);
    assert.deepEqual(spoken,['我这就查一下。','这里是测试结果。']);
    const reopened = createConsoleActivity(dir,'me',text=>text);
    assert.deepEqual(await (await reopened.request('/voice-cues')).json(),{...cfg,revision:1});
  } finally {
    applyVoiceCues(defaultVoiceCues);rmSync(dir,{recursive:true,force:true});
  }
});
