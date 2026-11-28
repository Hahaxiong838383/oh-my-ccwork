import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Stage the same P003 safety module the production build uses, without writing into its source tree.
const dir=dirname(fileURLToPath(import.meta.url));
const stage=mkdtempSync(join(tmpdir(),'xiaoke-memory-actions-'));
mkdirSync(join(stage,'p003'));
copyFileSync(join(dir,'memory-actions.ts'),join(stage,'memory-actions.ts'));
copyFileSync(join(dir,'../../../P003GameDemo20260513/apps/server/src/memory-safety-filter.ts'),join(stage,'p003/memory-safety-filter.ts'));
writeFileSync(join(stage,'p003/memory-safety-filter.js'),"export * from './memory-safety-filter.ts';");
after(()=>rmSync(stage,{recursive:true,force:true}));
const {parseMemoryCommand,PersonalMemoryActions}=await import(pathToFileURL(join(stage,'memory-actions.ts')).href);

test('accepts voice correction, retraction and multi-fact instruction; quoted and hypothetical speech cannot mutate',()=>{
  for (const q of [
    '以前我不喜欢香菜现在我喜欢吃香菜了请把我的口味改过来', '我以前不喜欢香菜，但现在已经喜欢上香菜了。','以前不喜欢香菜，现在喜欢了','我现在喜欢香菜了','请记住，我的暗号是星灯',
    '我的暗号改成月灯','请把我的暗号从星灯改成月灯','我的暗号不是星灯，是月灯','我的暗号是星灯',
  ]) assert.equal(parseMemoryCommand(q)?.op,'set',q);
  for (const q of ['忘掉我的暗号','请忘掉我关于山楂的那条口味记录，我希望以后不再保存它','把我不吃山楂这件事忘掉'])
    assert.equal(parseMemoryCommand(q)?.op,'forget',q);
  for (const q of ['请记住，以后叫我青岚桨手。我不喜欢香菜，以后不要推荐。',
    '请记住以后叫我青岚桨手，我不爱吃香菜','请记住以后叫我青岚桨手我不爱吃香菜以后不要推荐',
    '请记住以后叫我青岚桨手，我不爱吃香菜，以后不要给我推荐']) {
    const mult=parseMemoryCommand(q);
    assert.deepEqual(mult?.facts.map((f:{kind:string;value:string;topic:string})=>[f.kind,f.topic,f.value]),
      [['name','称呼','青岚桨手'],['preference','香菜','不喜欢']],q);
  }
  for (const q of ['我的口味变了。我以前不喜欢香菜，但现在已经喜欢上香菜了，以后可以推荐给我。',
    '我的口味变了我以前不喜欢香菜但现在已经喜欢上香菜了以后可以推荐给我']) {
    assert.deepEqual(parseMemoryCommand(q)?.facts.map((f:{topic:string;value:string})=>[f.topic,f.value]),[['香菜','喜欢']],q);
  }
  for (const q of ['我最不喜欢吃山楂，以后别推荐含山楂的零食','请记住我最不喜欢吃山楂以后别推荐含山楂的零食']) {
    assert.deepEqual(parseMemoryCommand(q)?.facts.map((f:{topic:string;value:string})=>[f.topic,f.value]),[['山楂','不喜欢']],q);
  }
  assert.notEqual(parseMemoryCommand('请记住我最不喜欢吃山楂，以后别推荐含香蕉的零食')?.op,'set');
  assert.equal(parseMemoryCommand('请忘掉我关于山楂的那条口味记录我希望以后不再保存它')?.target?.topic,'山楂');
  for (const q of ['不要忘记我不吃香菜','你记得我的暗号是什么吗？','如果我的暗号改成月灯','她说以后叫我夏天',
    '我没说过我的暗号改成月灯','你可以把“忘掉山楂”念一遍吗？','请问我的暗号是月灯？'])
    assert.equal(parseMemoryCommand(q),undefined,q);
  for (const q of ['忘掉所有记忆','忘了那个吧','请记住我的密码是123','请记住，如果我喜欢香菜','别记这句话，我不喜欢山楂']) {
    assert.ok(['clarify',undefined].includes(parseMemoryCommand(q)?.op));
  }
});

function fixture() {
  const dir=mkdtempSync(join(stage,'case-'));
  const db=new DatabaseSync(join(dir,'profile.sqlite')), conv=new DatabaseSync(join(dir,'conversations.sqlite'));
  db.exec(`CREATE TABLE family_member(account_id TEXT PRIMARY KEY,nickname TEXT DEFAULT '',preferred_address TEXT DEFAULT '',interests TEXT DEFAULT '[]',recent_emotion TEXT DEFAULT '',personality_notes TEXT DEFAULT '',birthday TEXT DEFAULT '',gender TEXT DEFAULT '',age_years INT,age_observed_at INT,updated_at INT);
    CREATE TABLE memory_item(id TEXT PRIMARY KEY,account_id TEXT,type TEXT,content TEXT,subject TEXT,source TEXT,session_id TEXT,source_role TEXT,source_quote TEXT,created_at INT,source_msg_id TEXT,valid_from INT, status TEXT DEFAULT 'active',UNIQUE(account_id,type,content));
    CREATE TABLE relation_state(account_id TEXT,self_narrative TEXT);
    CREATE TABLE style_pool(account_id TEXT,child_said TEXT,xiaoke_did TEXT);
    INSERT INTO family_member(account_id) VALUES ('owner'),('other');`);
  conv.exec('CREATE TABLE conversation(id TEXT PRIMARY KEY,account_id TEXT,session_id TEXT,role TEXT,text TEXT,ts INT,tokens INT,memory_excluded INT)');
  const a=new PersonalMemoryActions(dir,'owner');const apply=(s:string)=>a.apply(parseMemoryCommand(s),'room',s);
  return {dir,db,conv,a,apply,close:()=>{a.close();db.close();conv.close();}};
}

test('positive correction replaces old dislike and retains independently sourced facts; same-room stale history and pre-edit extraction windows cannot replay it',()=>{
  const {a,db,conv,close,apply}=fixture();
  try {
    apply('请记住，以后叫我青梧舵手。我不喜欢香菜，以后不要推荐。');
    db.exec("INSERT INTO memory_item(id,account_id,type,content,subject) VALUES ('unrelated','owner','event','今天在后院种了香菜','owner'),('other-row','other','preference','不喜欢香菜','owner')");
    const first=a.revision;
    apply('我以前不喜欢香菜，但现在已经喜欢上香菜了。');
    assert.ok(a.revision>first);
    assert.deepEqual(db.prepare("SELECT content FROM memory_item WHERE account_id='owner' ORDER BY content").all().map(r=>r.content),['今天在后院种了香菜','喜欢香菜']);
    assert.equal(db.prepare("SELECT value FROM personal_memory_fact WHERE kind='preference'").get()?.value,'喜欢');
    assert.equal(db.prepare("SELECT content FROM memory_item WHERE account_id='other'").get()?.content,'不喜欢香菜');
    const ev=db.prepare("SELECT source_quote,source_msg_id FROM personal_memory_fact WHERE kind='preference'").get()!;
    const turn=conv.prepare('SELECT role,text,memory_excluded FROM conversation WHERE id=?').get(ev.source_msg_id);
    assert.equal(turn?.role,'user');assert.equal(turn?.text,ev.source_quote);
    assert.deepEqual(a.replyHistory('room',[{role:'assistant', content:'不喜欢香菜'}]),[]);
    assert.deepEqual(a.filterSnapshot([{ts:first},{ts:a.revision+2}]),[{ts:a.revision+2}]);
  } finally { close(); }
});

test('general fact survives reopen, corrects and forgets without claiming an absent record or leaving prompt examples',()=>{
  const {dir,db,apply,close}=fixture();
  try {
    apply('请记住，我的暗号是星灯');
    apply('我的暗号改成月灯');
    assert.equal(db.prepare("SELECT value FROM personal_memory_fact WHERE topic='暗号'").get()?.value,'月灯');
    assert.equal(db.prepare("SELECT count(*) n FROM memory_item WHERE content LIKE '%星灯%'").get()?.n,0);
    db.exec("INSERT INTO style_pool VALUES ('owner','暗号是月灯','好的');INSERT INTO relation_state VALUES ('owner','谈过暗号是月灯')");
    const reopened=new PersonalMemoryActions(dir,'owner');
    try {
      assert.ok(reopened.revision>0);
      assert.match(reopened.apply(parseMemoryCommand('忘掉我的暗号'),'other-room','忘掉我的暗号'),/移除/);
      assert.equal(db.prepare("SELECT count(*) n FROM personal_memory_fact WHERE account_id='owner'").get()?.n,0);
      assert.equal(db.prepare("SELECT count(*) n FROM memory_item WHERE account_id='owner'").get()?.n,0);
      assert.equal(db.prepare('SELECT count(*) n FROM style_pool').get()?.n,0);
      assert.equal(db.prepare("SELECT self_narrative FROM relation_state WHERE account_id='owner'").get()?.self_narrative,'');
      assert.match(reopened.apply(parseMemoryCommand('忘掉我的暗号'),'another-room','忘掉我的暗号'),/没有找到/);
    } finally {reopened.close();}
  } finally {close();}
});

test('language-model-independent operation rolls back when its source cannot be persisted',()=>{
  const {a,db,conv,apply,close}=fixture();
  try {
    apply('请记住，我的暗号是星灯');
    const before=a.revision;
    conv.exec("CREATE TRIGGER fail_voice_write BEFORE INSERT ON conversation BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    assert.throws(()=>apply('我的暗号改成月灯'),/test failure/);
    assert.equal(a.revision,before);
    assert.equal(db.prepare("SELECT value FROM personal_memory_fact WHERE topic='暗号'").get()?.value,'星灯');
  } finally {close();}
});

test('short personal values never wipe unrelated facts, and a forgotten native birthday stays outside future recall windows',()=>{
  const {a,db,apply,close}=fixture();
  try {
    apply('请记住我的昵称是星');
    apply('请记住我的性别是男');
    db.exec("INSERT INTO memory_item(id,account_id,type,content) VALUES ('trip','owner','event','去过星海公园'),('runner','owner','event','去年看过男子马拉松'),('bday','owner','event','过生日是12月1日');UPDATE family_member SET birthday='2000-12-01',age_years=26,age_observed_at=1000; INSERT INTO style_pool VALUES ('owner','想了解星海','可以看男子马拉松')");
    const before=a.revision;
    apply('忘掉我的昵称');apply('忘掉我的性别');apply('忘掉我的生日');
    assert.deepEqual(db.prepare("SELECT id FROM memory_item WHERE account_id='owner' ORDER BY id").all().map(r=>r.id),['runner','trip']);
    assert.equal(db.prepare('SELECT count(*) n FROM style_pool').get()?.n,1);
    assert.deepEqual({...db.prepare("SELECT birthday,age_years FROM family_member WHERE account_id='owner'").get()},{birthday:'',age_years:null});
    assert.deepEqual(a.filterSnapshot([{ts:before}]),[]);
    assert.deepEqual(a.replyHistory('room',[{role:'user',content:'我生日是12月1日'}]),[]);
  } finally {close();}
});

test('forgetting removes the affected exchange and paraphrases from replay while retaining other turns; reopen keeps the masks',()=>{
  const {a,db,conv,dir,apply,close}=fixture();
  try {
    apply('请记住，我的暗号是星灯');
    const source=db.prepare('SELECT source_msg_id FROM personal_memory_fact').get()!;
    const add=conv.prepare('INSERT INTO conversation(id,account_id,session_id,role,text,ts,memory_excluded) VALUES(?,?,?,?,?,?,0)');
    let at=a.revision+1;
    for(const [id,role,text] of [['q1','user','聊聊森林'],['a1','assistant','叶子绿了'],
      ['q2','user','来个提示'],['a2','assistant','他说的是两种发光的东西。']]) add.run(id,'owner','room',role,text,at++);
    a.recordRecall('a2',{memoryIds:['v1'],sourceIds:[String(source.source_msg_id)]});
    apply('忘掉我的暗号');
    const reopened=new PersonalMemoryActions(dir,'owner');
    try {
      const stale=Array.from({length:8},()=>({role:'assistant',content:'星灯'}));
      assert.deepEqual(reopened.replyHistory('room',stale).map(x=>x.content),['聊聊森林','叶子绿了']);
      assert.deepEqual(reopened.filterSnapshot([{id:'q1',ts:at},{id:'q2',ts:at}]).map(x=>x.id),['q1']);
      assert.equal(db.prepare('SELECT count(*) n FROM personal_history_mask WHERE msg_id IN (?,?)').get('q2','a2')!.n,2);
    } finally {reopened.close();}
  } finally {close();}
});

test('migration preserves the old suppression boundary exactly once while new unrelated changes keep eligible history',()=>{
  const {db,conv,dir,close}=fixture();
  try {
    db.exec("DELETE FROM personal_legacy_boundary WHERE account_id='owner'; INSERT INTO personal_memory_boundary VALUES ('owner',100)");
    conv.exec("INSERT INTO conversation VALUES ('old','owner','room','user','旧窗口',99,0,0),('new','owner','room','user','公园散步',101,0,0)");
    const reopened=new PersonalMemoryActions(dir,'owner');
    try {
      reopened.apply(parseMemoryCommand('请记住，我的书签是蓝色'),'room','请记住，我的书签是蓝色');
      assert.deepEqual(reopened.filterSnapshot([{id:'old',ts:99},{id:'new',ts:101}]).map(x=>x.id),['new']);
      assert.deepEqual(reopened.replyHistory('room',[{role:'user',content:'旧窗口'}]).map(x=>x.content),['公园散步']);
      assert.equal(db.prepare("SELECT cut FROM personal_legacy_boundary WHERE account_id='owner'").get()?.cut,100);
    } finally {reopened.close();}
  } finally {close();}
});
