import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {activateProfile, createProfile, publicView, readDocument, updateProfile, withProviders} from './providers.ts';

const secret = 'sk-test-value-0123456789';
const token = 'token-value-0123456789';
const other = 'token-value-9876543210';
const xkey = 'key-value-0123456789';
const xsecret = 'secret-value-0123456789';

function echoed(value, samples) {
  const text = JSON.stringify(value);
  return samples.some(sample => text.includes(sample));
}

test('provider contract hides secrets and keeps the four seeds', async () => {
  const calls = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method];
    console[method] = (...args) => calls.push(args);
    console[method].restore = original;
  }
  const dir = mkdtempSync(join(tmpdir(), 'pa-c-providers-'));
  const file = join(dir, 'providers.json');
  const samples = [secret, token, other, xkey, xsecret];
  try {
    const missing = readDocument(file);
    assert.equal(missing.persisted, false);
    assert.equal(statSync(file, {throwIfNoEntry: false}), undefined);
    const untouched = await withProviders(file, doc => activateProfile(doc, 'llm', {revision: 0, id: null}, true));
    assert.equal(untouched.persisted, false);
    assert.equal(statSync(file, {throwIfNoEntry: false}), undefined);

    const seed = {
      version: 1, revision: 1,
      profiles: [
        {id: 'seed-deepseek', kind: 'llm', driver: 'deepseek', name: 'DeepSeek', config: {DEEPSEEK_MODEL: 'deepseek-v4-flash'}, secrets: {DEEPSEEK_API_KEY: secret}},
        {id: 'seed-asr', kind: 'asr', driver: 'doubao_asr', name: '豆包识别', config: {VOLC_ASR_RESOURCE_ID: 'volc.bigasr.sauc.duration', VOLC_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'}, secrets: {VOLC_APP_ID: '1000000001', VOLC_ACCESS_TOKEN: token}},
        {id: 'seed-doubao', kind: 'tts', driver: 'doubao_tts', name: '豆包音色', config: {VOLC_TTS_RESOURCE_ID: 'seed-tts-2.0', VOLC_TTS_SPEAKER: 'zh_female_vv_uranus_bigtts', VOLC_TTS_SPEED: '1.0'}, secrets: {VOLC_APP_ID: '1000000002', VOLC_ACCESS_TOKEN: other}},
        {id: 'seed-xfyun', kind: 'tts', driver: 'xfyun_tts', name: '讯飞音色', config: {XFYUN_TTS_VCN: 'x6_lingxiaoxuan_pro', CUSTOM_KEEP: 'keep-me'}, secrets: {XFYUN_TTS_APP_ID: '1000000003', XFYUN_TTS_API_KEY: xkey, XFYUN_TTS_API_SECRET: xsecret}},
      ],
      active: {llm: null, asr: null, tts: null},
    };
    const {writeFileSync} = await import('node:fs');
    writeFileSync(file, JSON.stringify(seed), {mode: 0o600});
    const loaded = readDocument(file);
    const view = publicView(loaded.doc, loaded.persisted);
    assert.equal(view.revision, 1);
    assert.deepEqual(view.profiles.map(item => item.id), ['seed-deepseek', 'seed-asr', 'seed-doubao', 'seed-xfyun']);
    assert.deepEqual(view.active, seed.active);
    assert.equal(view.profiles[0].secrets.DEEPSEEK_API_KEY, true);
    assert.equal(view.profiles[0].config.DEEPSEEK_MODEL, 'deepseek-v4-flash');
    assert.equal(Object.hasOwn(view.profiles[3].config, 'CUSTOM_KEEP'), false);
    assert.equal(echoed(view, samples), false);

    await assert.rejects(() => withProviders(file, doc => createProfile(doc, {
      revision: 1, kind: 'llm', driver: 'deepseek', name: '另一个', config: {DEEPSEEK_MODEL: 'deepseek-chat', DEEPSEEK_BASE_URL: 'https://proxy.example'}, secrets: {DEEPSEEK_API_KEY: secret},
    })), error => error.status === 400 && !echoed(error.message, samples));
    await assert.rejects(() => withProviders(file, doc => createProfile(doc, {
      revision: 1, kind: 'asr', driver: 'doubao_asr', name: '坏地址', config: {VOLC_ASR_RESOURCE_ID: 'volc.bigasr.sauc.duration', VOLC_ASR_URL: 'wss://evil.example/collect'}, secrets: {VOLC_ASR_API_KEY: xkey},
    })), error => error.status === 400);
    assert.equal(readDocument(file).doc.revision, 1);

    const edited = await withProviders(file, doc => updateProfile(doc, 'seed-deepseek', {
      revision: 1, kind: 'llm', driver: 'deepseek', name: 'DeepSeek', config: {DEEPSEEK_MODEL: 'deepseek-chat'}, secrets: {DEEPSEEK_API_KEY: ''},
    }, false));
    assert.equal(edited.revision, 2);
    assert.equal(edited.profiles[0].config.DEEPSEEK_MODEL, 'deepseek-chat');
    assert.equal(edited.profiles[0].secrets.DEEPSEEK_API_KEY, true);
    assert.equal(echoed(edited, samples), false);
    assert.equal(readFileSync(file, 'utf8').includes(secret), true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8').includes('keep-me'), true);

    await assert.rejects(() => withProviders(file, doc => updateProfile(doc, 'seed-deepseek', {
      revision: 1, kind: 'llm', driver: 'deepseek', name: 'DeepSeek', config: {DEEPSEEK_MODEL: 'deepseek-reasoner'}, secrets: {},
    }, true)), error => error.status === 409);
    const selected = await withProviders(file, doc => activateProfile(doc, 'tts', {revision: 2, id: 'seed-xfyun'}, true));
    assert.equal(selected.active.tts, 'seed-xfyun');
    assert.equal(selected.active.llm, null);
    const beforeBusy = readFileSync(file, 'utf8');
    await assert.rejects(() => withProviders(file, doc => updateProfile(doc, 'seed-xfyun', {
      revision: selected.revision, kind: 'tts', driver: 'xfyun_tts', name: '改名', config: {XFYUN_TTS_VCN: 'x6_lingxiaoxuan_pro'}, secrets: {},
    }, false)), error => error.status === 409);
    await assert.rejects(() => withProviders(file, doc => activateProfile(doc, 'tts', {revision: selected.revision, id: null}, false)), error => error.status === 409);
    assert.equal(readFileSync(file, 'utf8'), beforeBusy);
    const builtin = await withProviders(file, doc => activateProfile(doc, 'tts', {revision: selected.revision, id: null}, true));
    assert.equal(builtin.active.tts, null);
    assert.equal(echoed(builtin, samples), false);
    assert.equal(calls.length, 0);
  } finally {
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = console[method].restore;
    rmSync(dir, {recursive: true, force: true});
  }
});
