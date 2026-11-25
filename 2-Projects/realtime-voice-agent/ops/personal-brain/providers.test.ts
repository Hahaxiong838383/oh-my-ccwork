import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  DEEPSEEK_CHAT_BASE, DEEPSEEK_CHAT_URL, extractionTarget, interpretProviders, planChat, planResponses,
  publicProviderStatus, resetProviderCache, resolvePersonalLlm,
} from './providers.ts';

const selected = 'unit-key-selected';
const other = 'unit-key-other';
const appId = 'unit-app-id';
const token = 'unit-access-token';
const asrKey = 'unit-asr-key';
const xfyunSecret = 'unit-xfyun-secret';
const dir = mkdtempSync(join(tmpdir(), 'pa-c-providers-'));
const file = join(dir, 'providers.json');
const saved = process.env.PERSONAL_PROVIDERS_FILE;

function document(active, profiles) {
  return { version: 1, revision: 7, profiles, active };
}
function write(value) {
  writeFileSync(file, JSON.stringify(value));
  resetProviderCache();
}
function deepseek(id, model, apiKey) {
  return {
    id, kind: 'llm', driver: 'deepseek', name: id,
    config: { DEEPSEEK_MODEL: model }, secrets: { DEEPSEEK_API_KEY: apiKey },
  };
}
const tools = [{ type: 'function', function: { name: 'search_web' } }];

before(() => { process.env.PERSONAL_PROVIDERS_FILE = file; });
after(() => {
  if (saved === undefined) delete process.env.PERSONAL_PROVIDERS_FILE;
  else process.env.PERSONAL_PROVIDERS_FILE = saved;
  resetProviderCache();
  rmSync(dir, { recursive: true, force: true });
});

test('missing file keeps CPA and the Feiniu speech fallback', () => {
  resetProviderCache();
  const status = publicProviderStatus();
  assert.equal(status.state, 'absent');
  assert.equal(status.mount, 'ready');
  assert.deepEqual(status.active, { llm: null, asr: null, tts: null });
  assert.equal(status.llm.provider, 'cpa');
  assert.equal(status.asr.provider, 'feiniu-zh');
  assert.equal(status.tts.provider, 'feiniu-voices');
  assert.equal(resolvePersonalLlm().provider, 'cpa');
});

test('null selections and a replaced deep model keep tools on the official chat endpoint', () => {
  write(document({ llm: null, asr: null, tts: null }, [deepseek('flash', 'deepseek-v4-flash', other)]));
  assert.equal(publicProviderStatus().state, 'ready');
  assert.equal(resolvePersonalLlm().provider, 'cpa');

  write(document({ llm: 'reasoner', asr: null, tts: null }, [
    deepseek('flash', 'deepseek-v4-flash', other),
    deepseek('reasoner', 'deepseek-reasoner', selected),
  ]));
  const llm = resolvePersonalLlm();
  assert.equal(llm.provider, 'deepseek');
  if (llm.provider !== 'deepseek') return;
  assert.equal(llm.model, 'deepseek-reasoner');
  assert.equal(llm.apiKey, selected);
  const planned = planChat({
    model: 'deepseek-flash', thinking: { type: 'disabled' }, tools, tool_choice: 'auto', stream: true,
  }, llm, { url: 'https://cpa.example/v1/chat/completions', apiKey: 'cpa-key', model: 'cpa-model' });
  assert.equal(planned.url, DEEPSEEK_CHAT_URL);
  assert.equal(new URL(planned.url).hostname, 'api.deepseek.com');
  assert.equal(planned.apiKey, selected);
  assert.equal(planned.body.model, 'deepseek-reasoner');
  assert.deepEqual(planned.body.tools, tools);
  assert.deepEqual(planned.body.thinking, { type: 'disabled' });
  assert.equal(planned.body.tool_choice, 'auto');
  const responses = planResponses({ tools: [{ type: 'web_search' }] }, {
    url: 'https://cpa.example/v1/responses', apiKey: 'cpa-key', model: 'cpa-model',
  });
  assert.equal(responses.url, 'https://cpa.example/v1/responses');
  assert.equal(responses.apiKey, 'cpa-key');
  assert.equal(responses.body.model, 'cpa-model');
  const extract = extractionTarget();
  assert.equal(extract.baseUrl, DEEPSEEK_CHAT_BASE);
  assert.equal(extract.model, 'deepseek-reasoner');
  assert.equal(extract.apiKey, selected);
  const published = JSON.stringify(publicProviderStatus());
  for (const secret of [selected, other]) assert.equal(published.includes(secret), false);
  assert.deepEqual(publicProviderStatus().llm, { provider: 'deepseek', profile: 'reasoner', model: 'deepseek-reasoner' });
});

test('CPA chat keeps search tools while dropping only the DeepSeek thinking field', () => {
  const planned = planChat({ thinking: { type: 'disabled' }, tools, stream: false }, { provider: 'cpa' }, {
    url: 'https://cpa.example/v1/chat/completions', apiKey: 'cpa-key', model: 'gpt-test',
  });
  assert.equal('thinking' in planned.body, false);
  assert.deepEqual(planned.body.tools, tools);
  assert.equal(planned.body.model, 'gpt-test');
});

test('speech profiles validate and never publish APP_ID or keys', () => {
  write(document({ llm: null, asr: 'asr-key', tts: 'tts-xf' }, [
    {
      id: 'asr-key', kind: 'asr', driver: 'doubao_asr', name: '豆包识别',
      config: { VOLC_ASR_RESOURCE_ID: 'volc.bigasr.sauc.duration', VOLC_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', VOLC_ASR_END_WINDOW_MS: '800', VOLC_ASR_ENABLE_DDC: '1' },
      secrets: { VOLC_ASR_API_KEY: asrKey },
    },
    {
      id: 'asr-pair', kind: 'asr', driver: 'doubao_asr', name: '豆包配对',
      config: { VOLC_ASR_RESOURCE_ID: 'volc.bigasr.sauc.duration' },
      secrets: { VOLC_APP_ID: appId, VOLC_ACCESS_TOKEN: token },
    },
    {
      id: 'tts-volc', kind: 'tts', driver: 'doubao_tts', name: '豆包音色',
      config: { VOLC_TTS_RESOURCE_ID: 'seed-tts-2.0', VOLC_TTS_SPEAKER: 'zh_female_vv_uranus_bigtts', VOLC_TTS_SPEED: '1.25' },
      secrets: { VOLC_APP_ID: appId, VOLC_ACCESS_TOKEN: token },
    },
    {
      id: 'tts-xf', kind: 'tts', driver: 'xfyun_tts', name: '讯飞音色',
      config: { XFYUN_TTS_VCN: 'x6_lingxiaoxuan_pro', XFYUN_TTS_SPEED: '50', XFYUN_TTS_ORAL_LEVEL: 'mid', XFYUN_TTS_PRECONNECT: '1' },
      secrets: { XFYUN_TTS_APP_ID: appId, XFYUN_TTS_API_KEY: token, XFYUN_TTS_API_SECRET: xfyunSecret },
    },
  ]));
  const status = publicProviderStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.llm.provider, 'cpa');
  assert.deepEqual(status.asr, { provider: 'doubao_asr', profile: 'asr-key' });
  assert.deepEqual(status.tts, { provider: 'xfyun_tts', profile: 'tts-xf' });
  const published = JSON.stringify(status);
  for (const secret of [appId, token, asrKey, xfyunSecret]) assert.equal(published.includes(secret), false);
  assert.equal(resolvePersonalLlm().provider, 'cpa');
});

test('rejects forwarding URLs, config-side APP_ID, and a mismatched active profile', () => {
  const base = document({ llm: 'flash', asr: null, tts: null }, [deepseek('flash', 'deepseek-v4-flash', selected)]);
  base.profiles[0].config.DEEPSEEK_BASE_URL = 'https://evil.example/v1';
  assert.equal(interpretProviders(base), undefined);
  write(base);
  assert.equal(publicProviderStatus().state, 'invalid');
  assert.equal(publicProviderStatus().reason, 'schema');
  assert.equal(resolvePersonalLlm().provider, 'cpa');
  assert.equal(JSON.stringify(publicProviderStatus()).includes(selected), false);

  const appInConfig = document({ llm: null, asr: 'asr', tts: null }, [{
    id: 'asr', kind: 'asr', driver: 'doubao_asr', name: '识别',
    config: { VOLC_ASR_RESOURCE_ID: 'volc.bigasr.sauc.duration', VOLC_APP_ID: appId },
    secrets: { VOLC_ACCESS_TOKEN: token },
  }]);
  assert.equal(interpretProviders(appInConfig), undefined);
  const evilUrl = document({ llm: null, asr: 'asr', tts: null }, [{
    id: 'asr', kind: 'asr', driver: 'doubao_asr', name: '识别',
    config: { VOLC_ASR_RESOURCE_ID: 'volc.asr', VOLC_ASR_URL: 'wss://evil.example/asr' },
    secrets: { VOLC_ASR_API_KEY: asrKey },
  }]);
  assert.equal(interpretProviders(evilUrl), undefined);
  const wrongKind = document({ llm: null, asr: 'flash', tts: null }, [deepseek('flash', 'deepseek-v4-flash', selected)]);
  assert.equal(interpretProviders(wrongKind), undefined);
  writeFileSync(file, '{');
  resetProviderCache();
  assert.equal(publicProviderStatus().reason, 'json');
  assert.equal(extractionTarget().provider, 'personal');
  if (extractionTarget().baseUrl !== process.env.BRAIN_UPSTREAM_BASE_URL) throw new Error('invalid file switched extraction upstream');
});
