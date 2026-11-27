import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'private-recall-test-'));
after(() => rmSync(stage, { recursive: true, force: true }));
writeFileSync(join(stage, 'package.json'), '{"type":"module"}');
copyFileSync(join(here, 'memory-recall.ts'), join(stage, 'memory-recall.ts'));
execFileSync('python3', [join(here, 'stage.py'), join(here, '../../../P003GameDemo20260513/apps/server/src'), join(stage, 'p003')]);
process.env.PROFILE_DB_PATH = join(stage, 'staged-profile.sqlite');
process.env.CONVERSATION_DB_PATH = join(stage, 'staged-conversations.sqlite');
const moduleUnderTest = import(pathToFileURL(join(stage, 'memory-recall.ts')).href);

test('common public information stays on the conversation or tool path', async () => {
  const { asksForMemory } = await moduleUnderTest;
  for (const question of ['你还记得巴黎在哪个国家吗？', '我想知道北京明天气温是多少？', '如何称呼一位不熟悉的老师？', '你知道我该怎么坐地铁去故宫吗？', '你知道我该怎么在家做红烧肉吗？']) {
    assert.equal(asksForMemory(question), false, question);
  }
});

test('recall checks the owner, role, quote and polarity of the original source for each part of a question', async () => {
  const { PersonalRecall } = await moduleUnderTest;
  const data = join(stage, 'fixture');
  mkdirSync(data);
  const db = new DatabaseSync(join(data, 'profile.sqlite'));
  const conv = new DatabaseSync(join(data, 'conversations.sqlite'));
  db.exec(`CREATE TABLE family_member(account_id TEXT, nickname TEXT, interests TEXT);
    CREATE TABLE personal_memory_fact(account_id TEXT,kind TEXT,topic TEXT,value TEXT,source_quote TEXT,source_msg_id TEXT,updated_at INT);
    CREATE TABLE memory_item(id TEXT,account_id TEXT,type TEXT,content TEXT,subject TEXT,source_quote TEXT,source_msg_id TEXT,status TEXT,created_at INT);
    INSERT INTO family_member VALUES('owner','','[]'),('other','','[]');
    INSERT INTO personal_memory_fact VALUES('owner','fact','暗号','星灯','我的暗号是星灯','code',3),
      ('owner','name','称呼','青梧','叫我青梧','name',2),('owner','fact','鞋码','四十','鞋码四十','wrong-quote',1);
    INSERT INTO memory_item VALUES
      ('1','owner','preference','不喜欢香菜','owner','','diet','active',1),
      ('2','owner','preference','喜欢草莓','owner','','other-owner','active',2),
      ('3','owner','preference','喜欢山楂','owner','','other-speaker','active',3),
      ('4','owner','preference','喜欢芒果','owner','','incorrect-polarity','active',4),
      ('5','owner','preference','喜欢西瓜','owner','','question','active',5),
      ('6','owner','preference','喜欢杏仁','owner','','absent','active',6);`);
  conv.exec(`CREATE TABLE conversation(id TEXT,account_id TEXT,role TEXT,text TEXT,memory_excluded INT,ts INT);
    INSERT INTO conversation VALUES
      ('code','owner','user','请记住，我的暗号是星灯。',1,1),('name','owner','user','以后叫我青梧。',1,2),
      ('wrong-quote','owner','user','我的鞋子是蓝色的。',0,3),('diet','owner','user','我不喜欢香菜。',0,4),
      ('other-owner','other','user','我喜欢草莓。',0,5),('other-speaker','owner','assistant','我喜欢山楂。',0,6),
      ('incorrect-polarity','owner','user','我不喜欢芒果。',0,7),('question','owner','user','我喜欢西瓜吗？',0,8);`);
  const recall = new PersonalRecall(data);
  try {
    const answer = (text: string) => recall.answer('owner', text, true);
    assert.match(answer('我的暗号是什么？'), /星灯/);
    const both = answer('我让你以后怎么称呼我？我明确说过不喜欢哪种食材？');
    assert.match(both, /青梧/);
    assert.match(both, /不喜欢香菜/);
    for (const topic of ['草莓', '山楂', '芒果', '西瓜', '杏仁']) {
      const missing = answer('你记得我喜欢' + topic + '吗？');
      assert.match(missing, /不记得/, topic);
      assert.doesNotMatch(missing, /香菜|星灯|青梧/);
    }
    assert.match(answer('我的鞋码是多少？'), /不记得/);
    assert.doesNotMatch(recall.answer('owner', '我的暗号是什么？', false), /星灯/);
    assert.match(recall.answer('other', '我的暗号是什么？', true), /不记得/);
    const partial = answer('我的暗号是什么？我的幸运颜色是什么？');
    assert.match(partial, /星灯/);
    assert.match(partial, /不记得/);
  } finally {
    recall.close?.();
    conv.close();
    db.close();
  }
});
