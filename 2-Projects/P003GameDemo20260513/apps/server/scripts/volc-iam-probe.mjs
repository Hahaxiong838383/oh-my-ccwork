#!/usr/bin/env node
/**
 * volc-iam-probe.mjs —— 火山引擎 AK/SK 有效性探针
 *
 * 用 IAM:GetUser API 验证 .env.local 中的 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY
 * 是否有效。SignV4 签名算法参考火山官方文档：
 *   https://www.volcengine.com/docs/6369/67269
 *
 * 运行：node --env-file=.env.local scripts/volc-iam-probe.mjs
 */

import { createHash, createHmac } from 'node:crypto';

const AK = process.env.VOLC_ACCESS_KEY_ID;
const SK = process.env.VOLC_SECRET_ACCESS_KEY;
const REGION = process.env.VOLC_REGION ?? 'cn-north-1';

if (!AK || !SK) {
  console.error('[ERR] VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY 未配置');
  process.exit(1);
}

const HOST = 'iam.volcengineapi.com';
const SERVICE = 'iam';
const ACTION = 'ListUsers';
const VERSION = '2018-01-01';

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function hmacHex(key, data) {
  return createHmac('sha256', key).update(data).digest('hex');
}

function formatTime(d) {
  // ISO8601 basic: YYYYMMDDTHHMMSSZ
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function shortDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function main() {
  const now = new Date();
  const amzDate = formatTime(now);
  const dateStamp = shortDate(now);

  const queryParams = new URLSearchParams({
    Action: ACTION,
    Version: VERSION,
  });
  const canonicalQueryString = [...queryParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const payloadHash = sha256Hex('');
  const canonicalHeaders =
    `host:${HOST}\n` +
    `x-content-sha256:${payloadHash}\n` +
    `x-date:${amzDate}\n`;
  const signedHeaders = 'host;x-content-sha256;x-date';

  const canonicalRequest =
    'GET\n' +
    '/\n' +
    canonicalQueryString + '\n' +
    canonicalHeaders + '\n' +
    signedHeaders + '\n' +
    payloadHash;

  const algorithm = 'HMAC-SHA256';
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/request`;
  const stringToSign =
    algorithm + '\n' +
    amzDate + '\n' +
    credentialScope + '\n' +
    sha256Hex(canonicalRequest);

  const kDate = hmac(SK, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = hmacHex(kSigning, stringToSign);

  const authorizationHeader =
    `${algorithm} Credential=${AK}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${HOST}/?${canonicalQueryString}`;
  console.log('[volc-iam] →', url);
  console.log('[volc-iam] AK:', AK.slice(0, 12) + '...');

  try {
    const startedAt = Date.now();
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Host: HOST,
        'X-Date': amzDate,
        'X-Content-Sha256': payloadHash,
        Authorization: authorizationHeader,
      },
    });
    const elapsedMs = Date.now() - startedAt;
    const text = await res.text();
    console.log(`[volc-iam] HTTP ${res.status} (${elapsedMs}ms)`);
    console.log('[volc-iam] body:', text.slice(0, 800));

    if (res.ok) {
      console.log('\n✅ AK/SK 验证通过');
    } else {
      console.log('\n⚠️ 鉴权失败或服务未开通');
      try {
        const json = JSON.parse(text);
        console.log('  错误码:', json?.ResponseMetadata?.Error?.Code);
        console.log('  错误信息:', json?.ResponseMetadata?.Error?.Message);
      } catch {
        /* 非 json */
      }
    }
  } catch (err) {
    console.error('[volc-iam] fetch failed:', err.message);
    if (err.cause) console.error('  cause:', err.cause);
    process.exit(2);
  }
}

main();
