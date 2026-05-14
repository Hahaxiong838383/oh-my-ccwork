#!/usr/bin/env node
/**
 * volc-ark-probe.mjs —— 火山方舟（ARK）endpoint 查询探针
 *
 * 检查川哥账号下是否已开通豆包 LLM、有哪些可用的 endpoint。
 */

import { createHash, createHmac } from 'node:crypto';

const AK = process.env.VOLC_ACCESS_KEY_ID;
const SK = process.env.VOLC_SECRET_ACCESS_KEY;
const REGION = process.env.VOLC_REGION ?? 'cn-beijing';

if (!AK || !SK) {
  console.error('[ERR] 凭据未配置');
  process.exit(1);
}

const HOST = 'open.volcengineapi.com';
const SERVICE = 'ark';
const ACTION = 'ListEndpoints';
const VERSION = '2024-01-01';

function sha256Hex(s) { return createHash('sha256').update(s).digest('hex'); }
function hmac(k, d) { return createHmac('sha256', k).update(d).digest(); }
function hmacHex(k, d) { return createHmac('sha256', k).update(d).digest('hex'); }

async function main() {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const q = new URLSearchParams({ Action: ACTION, Version: VERSION });
  const canonicalQS = [...q.entries()]
    .sort()
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const payloadHash = sha256Hex('');
  const canonicalHeaders =
    `host:${HOST}\nx-content-sha256:${payloadHash}\nx-date:${amzDate}\n`;
  const signedHeaders = 'host;x-content-sha256;x-date';

  const canonicalRequest =
    `GET\n/\n${canonicalQS}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/request`;
  const stringToSign =
    `HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;

  const kDate = hmac(SK, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = hmacHex(kSigning, stringToSign);

  const authHeader =
    `HMAC-SHA256 Credential=${AK}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${HOST}/?${canonicalQS}`;
  console.log('[volc-ark] →', url);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Host: HOST,
        'X-Date': amzDate,
        'X-Content-Sha256': payloadHash,
        Authorization: authHeader,
      },
    });
    const text = await res.text();
    console.log(`[volc-ark] HTTP ${res.status}`);
    console.log('[volc-ark] body:', text.slice(0, 1200));

    if (res.ok) {
      const json = JSON.parse(text);
      const endpoints = json?.Result?.Items ?? [];
      console.log(`\n✅ 火山方舟已开通，共 ${endpoints.length} 个 endpoint:`);
      for (const ep of endpoints) {
        console.log(`  - ${ep.Id} | ${ep.Name} | model=${ep.ForeignKey?.FoundationModel?.Name ?? '-'}`);
      }
    } else {
      try {
        const json = JSON.parse(text);
        console.log('\n⚠️ 错误码:', json?.ResponseMetadata?.Error?.Code);
        console.log('   错误信息:', json?.ResponseMetadata?.Error?.Message);
      } catch { /* */ }
    }
  } catch (err) {
    console.error('fetch failed:', err.message);
    if (err.cause) console.error('cause:', err.cause);
  }
}

main();
