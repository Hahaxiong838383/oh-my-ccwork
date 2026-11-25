import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateProfile, createProfile, publicView, updateProfile,
} from '../personal-admin/providers.ts';
import { interpretProviders } from '../personal-brain/providers.ts';

const empty = () => ({
  version: 1, revision: 0, profiles: [], active: { llm: null, asr: null, tts: null },
});
const create = (doc, kind, driver, config, secrets) => createProfile(doc, {
  kind, driver, name: driver, config, secrets, revision: doc.revision,
});
const select = (doc, kind, id) => activateProfile(doc, kind, {id, revision: doc.revision}, true);
const dig = () => create(empty(), 'llm', 'deepseek',
  {DEEPSEEK_MODEL: 'deepseek-v4-flash'}, {DEEPSEEK_API_KEY: 'fixture-only-llm'});

test('个人后台的每种选择都能被个人大脑读取，编辑空密钥保留原值', () => {
  let doc = dig();
  const llm = doc.profiles[0];
  doc = create(doc, 'asr', 'doubao_asr', {
    VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration',
    VOLC_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
    VOLC_ASR_END_WINDOW_MS: '150', VOLC_ASR_ENABLE_DDC: '1',
  }, {VOLC_ASR_API_KEY: 'fixture-only-asr'});
  doc = create(doc, 'tts', 'doubao_tts', {
    VOLC_TTS_RESOURCE_ID: 'volc.service_type.10029', VOLC_TTS_SPEAKER: 'example_voice', VOLC_TTS_SPEED: '1.05',
  }, {VOLC_APP_ID: 'fixture-app-id', VOLC_ACCESS_TOKEN: 'fixture-only-tts'});
  doc = create(doc, 'tts', 'xfyun_tts', {
    XFYUN_TTS_VCN: 'x6_lingxiaoxuan_pro', XFYUN_TTS_SPEED: '50', XFYUN_TTS_ORAL_LEVEL: 'mid',
  }, {XFYUN_TTS_APP_ID: 'fixture-only-app', XFYUN_TTS_API_KEY: 'fixture-only-key', XFYUN_TTS_API_SECRET: 'fixture-only-secret'});
  let next = select(doc, 'llm', llm.id);
  for (const p of doc.profiles.slice(1)) {
    next = select(next, p.kind, p.id);
    const brain = interpretProviders(next);
    assert.ok(brain, p.driver);
    assert.deepEqual(brain.active, next.active);
    assert.equal(brain.llm.provider, 'deepseek');
    assert.equal(brain[p.kind].provider, p.driver);
  }
  next = updateProfile(next, llm.id, {
    ...llm, revision: next.revision, name: '备用模型', secrets: {DEEPSEEK_API_KEY: ''},
  }, true);
  assert.equal(next.profiles[0].secrets.DEEPSEEK_API_KEY, llm.secrets.DEEPSEEK_API_KEY);
  const view = JSON.stringify(publicView(next, true));
  for (const profile of next.profiles)
    for (const value of Object.values(profile.secrets)) assert.ok(!view.includes(value));
  for (const kind of ['llm','asr','tts']) next = select(next,kind,null);
  assert.deepEqual(interpretProviders(next)?.active, empty().active);
});

test('后台允许保存的配置数量能被运行时读取', () => {
  let doc = dig();
  while (doc.profiles.length < 32)
    doc = create(doc,'llm','deepseek',{DEEPSEEK_MODEL:'test-model'},{DEEPSEEK_API_KEY:'fixture-only-key'});
  doc = select(doc,'llm',doc.profiles.at(-1).id);
  assert.equal(interpretProviders(doc)?.llm.profile,doc.active.llm);
});
