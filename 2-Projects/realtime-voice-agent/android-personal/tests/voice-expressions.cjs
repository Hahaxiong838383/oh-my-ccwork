// Verify accepted actions against the mounted renderers during a call.
const assert = require('node:assert/strict');

module.exports = async function voiceExpressions(page, family, ids) {
  const rpc = request => page.evaluate(req => NightView.avatarRequest(req), request);
  await page.evaluate(() => NightView.render({paired:true, active:true, phase:'listening'}));
  const {avatar} = await rpc({op:'inspect'});
  assert.equal(avatar.family, family);
  assert.deepEqual(avatar.expressions.map(e => e.id), ids);
  const express = {op:'express',family,variant:avatar.variant};
  assert.equal((await rpc({...express,variant:'retired',expression:ids[0]})).ok, false);
  assert.equal((await rpc({...express,expression:'missing'})).ok, false);
  for (const expression of ids) {
    const result = await rpc({...express, expression});
    assert.equal(result.ok, true, family + '/' + expression + ' rendered as ' + result.avatar.current);
  }
  assert.equal(avatar.expressions.find(e => e.id === 'cry').label, '哭泣');
  assert.ok(await page.locator('#avatar-tears').isVisible(), family + ' shows tears');
  const example = {classic:'shy',open:'shy',boop:'love',robot:'happy'}[family];
  assert.equal((await rpc({...express,expression:example})).avatar.current, example);
  assert.ok(await page.locator('#avatar-tears').isHidden(), 'new expression clears tears');
  await page.evaluate(() => NightView.render({paired:true,active:true,phase:'speaking'}));
  await page.waitForTimeout(240);
  assert.equal((await rpc({op:'inspect'})).avatar.current, example, family + ' survives first audio');
  await page.evaluate(() => NightView.render({paired:false,active:false,phase:'idle'}));
};
