import test from 'node:test';
import assert from 'node:assert/strict';
import { BriefSpeech, briefToolSpeech } from './brief-speech.js';
import { withVoiceProgress } from './voice-progress.js';

function spoken(chunks: string[], limit: 1|2 = 2): string {
  const brief = new BriefSpeech(limit);
  return chunks.map(chunk => brief.feed(chunk)).join('') + brief.finish();
}
test('sentence caps are independent of SSE fragmentation, including decimals, versions and unmatched final punctuation', () => {
  for (const [input, expected] of [
    ['北京是3.5摄氏度。明早0.8摄氏度！第三句不会出现。','北京是3.5摄氏度。明早0.8摄氏度！'],
    ['可用v1.2.3。第二句没有标点','可用v1.2.3。第二句没有标点。'],
    ['真的吗？！当然！多了一句','真的吗？当然！'],
    ['你好呀～很高兴见你！还有第三句。','你好呀～很高兴见你！'],
    ['今天3～5度。明天4~7度。多余一句。','今天3～5度。明天4~7度。'],
    ['明天见~后天见；第三天再见。','明天见~后天见；'],
    ['Ready; Next! Third', 'Ready; Next!'],
    ['他说：“明天放晴。”晚风会停。别忘了出门。','他说：“明天放晴。”晚风会停。'],
    ['Data 3.5 is ready. Next one! Extra', 'Data 3.5 is ready. Next one!'],
  ]) {
    assert.equal(spoken([input]),expected);
    assert.equal(spoken([...input]),expected);
  }
  assert.equal(spoken(['地球绕太阳公转。还有一句。'],1),'地球绕太阳公转。');
  assert.equal(spoken(['到站了。', '有'.repeat(250)]),'到站了。');
  assert.equal(spoken(['如果先看到彩虹，'+'其'.repeat(150)]),'我暂时没能把重点说清楚。');
  const intact = '地球在围绕太阳持续公转的过程中始终保持地轴相对于轨道平面的倾斜角度使北半球和南半球在一年中的不同时间分别获得较长或较短的白昼以及较为直接或较为倾斜的太阳光照从而出现春夏秋冬交替的现象。';
  assert.ok(intact.length > 88);
  assert.equal(spoken([...intact]),intact);
  assert.equal(spoken(['语'.repeat(240),'。公转和地轴倾斜带来四季。']),'公转和地轴倾斜带来四季。');
  assert.equal(spoken(['地轴倾斜使日照变化，'+'许'.repeat(180)]),'地轴倾斜使日照变化。');
});

test('short tool speech keeps city, decimal temperature and warning including when one sentence was requested', () => {
  const weather = '北京今天有小雨。最高温度12.5摄氏度。大风黄色预警生效。';
  assert.equal(briefToolSpeech(weather,'weather',2),'北京今天有小雨。最高温度12.5摄氏度，大风黄色预警生效。');
  assert.equal(briefToolSpeech(weather,'weather',1),'北京今天有小雨，最高温度12.5摄氏度，大风黄色预警生效。');
  assert.equal(briefToolSpeech('你想查哪个城市的天气？','weather',2),'你想查哪个城市的天气？');
});

test('brief voice turns suppress slow chat and search cues across the entire utterance',async () => {
  const chunks: string[] = [];
  await withVoiceProgress('brief-test', async (say,search,suppressCue) => {
    suppressCue();search();
    await new Promise(resolve => setTimeout(resolve,18));
    await say('北京今天有小雨。');await say('最高12.5摄氏度。');
  }, async text=>{chunks.push(text);},new AbortController().signal,{chatWaitMs:2,searchWaitMs:2});
  assert.deepEqual(chunks,['北京今天有小雨。','最高12.5摄氏度。']);
});
