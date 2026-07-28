#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const configPath = path.join(codexHome, 'config.toml');
const catalogPath = path.join(codexHome, 'cc-switch-model-catalog.json');
const officialCachePath = path.join(codexHome, 'models_cache.json');
const cpaOfficialCatalogUrl = process.env.CODEX_CATALOG_CPA_OFFICIAL_URL ||
  'https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/registry/models/codex_client_models.json';

const cfg = fs.readFileSync(configPath, 'utf8');
const baseUrl = readTomlString(cfg, 'base_url');
const token = readTomlString(cfg, 'experimental_bearer_token');
if (!baseUrl || !token) fail('missing base_url or experimental_bearer_token in ~/.codex/config.toml');

const endpointLevels = [
  { effort: 'none', description: 'No reasoning / disable thinking' },
  { effort: 'minimal', description: 'Minimal reasoning' },
  { effort: 'low', description: 'Low reasoning' },
  { effort: 'medium', description: 'Medium reasoning' },
  { effort: 'high', description: 'High reasoning' },
  { effort: 'xhigh', description: 'Extra high reasoning' },
  { effort: 'max', description: 'Maximum reasoning' },
];

const denyPattern = /(image|imagine|video|audio|asr|tts|realtime|embed|embedding|rerank|moderation)/i;
const allowPattern = envRegex('CODEX_CATALOG_MODEL_ALLOW_RE', /^(gpt-|grok-|codex-)/i);
const defaultModel = process.env.CODEX_CATALOG_DEFAULT_MODEL || readTomlString(cfg, 'model') || 'gpt-5.5';
const defaultReasoningLevel = process.env.CODEX_CATALOG_DEFAULT_REASONING || readTomlString(cfg, 'model_reasoning_effort') || 'high';

const officialModels = await readOfficialModels(officialCachePath, cpaOfficialCatalogUrl);
const modelsResponse = await fetchModels(`${baseUrl.replace(/\/$/, '')}/models?client_version=catalog-refresh`, token);
const endpointModels = modelsResponse
  .map((item) => normalizeEndpointModel(item))
  .filter(Boolean)
  .filter((model) => allowPattern.test(model.id) && !denyPattern.test(model.id));

if (endpointModels.length === 0) fail('endpoint returned no allowed text models');

const models = endpointModels.map(({ id, endpointItem }) => {
  const official = officialModels.get(id);
  const endpointReasoning = normalizeReasoningLevels(
    endpointItem.supported_reasoning_levels ??
      endpointItem.supportedReasoningEfforts ??
      endpointItem.supported_reasoning_efforts ??
      endpointItem.reasoning_levels ??
      endpointItem.reasoning
  );
  const officialReasoning = normalizeReasoningLevels(official?.supported_reasoning_levels);
  const supportedReasoningLevels = endpointReasoning ?? officialReasoning ?? endpointLevels;
  return buildCatalogModel({
    slug: id,
    displayName: official?.display_name ?? humanizeModelName(id),
    description: official?.description ?? id,
    contextWindow: official?.context_window ?? inferContextWindow(id),
    defaultReasoningLevel: supportedReasoningLevels.some((level) => level.effort === defaultReasoningLevel)
      ? defaultReasoningLevel
      : official?.default_reasoning_level ?? 'high',
    inputModalities: resolveInputModalities(id, endpointItem, official),
    supportedReasoningLevels,
    additionalSpeedTiers: resolveAdditionalSpeedTiers(endpointItem, official),
    serviceTiers: resolveServiceTiers(endpointItem, official),
    defaultServiceTier: resolveDefaultServiceTier(endpointItem, official),
    priority: priorityForModel(id),
  });
}).sort((a, b) => b.priority - a.priority || a.slug.localeCompare(b.slug));

const catalog = { models };
backupIfExists(catalogPath);
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`updated ${catalogPath}`);
console.log(`models=${models.length}`);
for (const model of models) {
  console.log(`${model.slug}: modalities=${model.input_modalities.join(',')} default=${model.default_reasoning_level} levels=${model.supported_reasoning_levels.map((x) => x.effort).join(',')}`);
}

function readTomlString(text, key) {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"\\n]*)"`, 'm'));
  return match?.[1] ?? null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function envRegex(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return new RegExp(raw, 'i'); } catch { return fallback; }
}

async function readOfficialModels(file, remoteUrl) {
  const localModels = readModelMap(file);
  try {
    const res = await fetch(remoteUrl, { headers: { 'User-Agent': 'codex-catalog-refresh' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const remoteModels = modelMapFromPayload(await res.json());
    return new Map([...localModels, ...remoteModels]);
  } catch (error) {
    console.warn(`refresh-cc-switch-model-catalog: CPA official catalog unavailable, using local cache (${error.message})`);
    return localModels;
  }
}

function readModelMap(file) {
  try {
    return modelMapFromPayload(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return new Map();
  }
}

function modelMapFromPayload(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
  return new Map(models
    .filter((model) => model && typeof model === 'object')
    .map((model) => [model.slug ?? model.id, model])
    .filter(([slug]) => typeof slug === 'string' && slug.length > 0));
}

async function fetchModels(url, bearerToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearerToken}` } });
  if (!res.ok) fail(`GET /models failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const data = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  return data;
}

function normalizeEndpointModel(item) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id ?? item.slug ?? item.model ?? item.name;
  if (!id || typeof id !== 'string') return null;
  return { id, endpointItem: item };
}

function normalizeReasoningLevels(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const levels = value.map((item) => {
    if (typeof item === 'string') return { effort: item, description: `${item} reasoning` };
    const effort = item.effort ?? item.reasoningEffort ?? item.reasoning_effort ?? item.id ?? item.name;
    if (!effort || typeof effort !== 'string') return null;
    return { effort, description: item.description ?? `${effort} reasoning` };
  }).filter(Boolean);
  return levels.length ? levels : null;
}

function buildCatalogModel({ slug, displayName, description, contextWindow, defaultReasoningLevel, inputModalities, supportedReasoningLevels, additionalSpeedTiers, serviceTiers, defaultServiceTier, priority }) {
  return {
    additional_speed_tiers: additionalSpeedTiers,
    availability_nux: null,
    base_instructions: 'You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user\'s goals.',
    context_window: contextWindow,
    default_reasoning_level: defaultReasoningLevel,
    default_reasoning_summary: 'none',
    description,
    display_name: displayName,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: inputModalities,
    max_context_window: contextWindow,
    priority,
    service_tiers: serviceTiers,
    default_service_tier: defaultServiceTier,
    shell_type: 'shell_command',
    slug,
    support_verbosity: false,
    supported_in_api: true,
    supported_reasoning_levels: supportedReasoningLevels,
    supports_image_detail_original: false,
    supports_parallel_tool_calls: false,
    supports_reasoning_summaries: true,
    supports_search_tool: false,
    truncation_policy: { limit: 10000, mode: 'bytes' },
    upgrade: null,
    visibility: 'list',
  };
}

function resolveAdditionalSpeedTiers(endpointItem, official) {
  return normalizeStringArray(endpointItem?.additional_speed_tiers ?? official?.additional_speed_tiers) ?? [];
}

function resolveServiceTiers(endpointItem, official) {
  return normalizeServiceTiers(endpointItem?.service_tiers ?? official?.service_tiers) ?? [];
}

function resolveDefaultServiceTier(endpointItem, official) {
  const value = endpointItem?.default_service_tier ?? official?.default_service_tier;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeServiceTiers(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const tiers = value.map((item) => {
    if (typeof item === 'string') return { id: item, name: item, description: item };
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null;
    return {
      id: item.id,
      name: typeof item.name === 'string' ? item.name : item.id,
      description: typeof item.description === 'string' ? item.description : item.id,
    };
  }).filter(Boolean);
  return tiers.length > 0 ? tiers : null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const values = [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))];
  return values.length > 0 ? values : null;
}


function resolveInputModalities(slug, endpointItem, official) {
  const endpointModalities = normalizeInputModalities(endpointItem?.input_modalities ?? endpointItem?.inputModalities) ?? [];
  const officialModalities = normalizeInputModalities(official?.input_modalities) ?? [];
  return [...new Set(['text', ...endpointModalities, ...officialModalities, ...inferInputModalities(slug)])];
}

function normalizeInputModalities(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const modalities = [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.toLowerCase()))];
  if (modalities.length === 0) return null;
  return modalities.includes('text') ? modalities : ['text', ...modalities];
}

function inferInputModalities(slug) {
  if (/^gpt-5(?:\.|-|$)/i.test(slug)) return ['text', 'image'];
  return ['text'];
}

function humanizeModelName(slug) {
  return slug.replace(/-/g, ' ').replace(/\bgpt\b/i, 'GPT').replace(/\bgrok\b/i, 'grok');
}

function inferContextWindow(slug) {
  if (/grok/i.test(slug)) return 1000000;
  return 256000;
}

function priorityForModel(slug) {
  if (slug === defaultModel) return 2000;
  if (slug === 'grok-4.3') return 1990;
  if (/gpt-5\.5/i.test(slug)) return 1980;
  if (/gpt/i.test(slug)) return 1500;
  if (/grok/i.test(slug)) return 1400;
  if (/codex/i.test(slug)) return 1300;
  return 1000;
}

function backupIfExists(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  fs.copyFileSync(file, `${file}.bak-${stamp}`);
}

function fail(message) {
  console.error(`refresh-cc-switch-model-catalog: ${message}`);
  process.exit(1);
}
