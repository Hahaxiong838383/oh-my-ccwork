#!/usr/bin/env node
/**
 * EvoMap 资产更新飞书通知
 * 读取 ranked-top3.json，格式化后发送飞书卡片通知
 * 用法: node notify.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.dirname(__filename);
const TELL_ME_CONFIG = '/Users/rayman.chen/mycc/.claude/skills/tell-me/config.json';

// 读取飞书配置
let webhook, secret;
try {
  const config = JSON.parse(fs.readFileSync(TELL_ME_CONFIG, 'utf8'));
  webhook = config.webhook;
  secret = config.secret;
} catch (err) {
  console.error('❌ 无法读取飞书配置:', err.message);
  process.exit(1);
}

if (!webhook) {
  console.error('❌ 飞书 webhook 未配置');
  process.exit(1);
}

// 读取 ranked-top3.json
let ranked = [];
try {
  const data = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'ranked-top3.json'), 'utf8'));
  ranked = data.assets || [];
} catch (err) {
  console.error('❌ 无法读取 ranked-top3.json:', err.message);
  process.exit(1);
}

if (ranked.length === 0) {
  console.log('⚠️ 没有资产数据，跳过通知');
  process.exit(0);
}

// 格式化资产列表
const medals = ['🥇', '🥈', '🥉'];
const lines = ranked.map((asset, i) => {
  const p = asset.payload || {};
  const gdi = asset.gdi_score ? asset.gdi_score.toFixed(1) : '?';
  const implemented = asset.local_id ? '✅ 已实施' : '⏳ 未实施';
  // summary 截取前 60 字
  const summary = (p.summary || '').slice(0, 80);
  return `${medals[i] || `${i + 1}.`} **GDI ${gdi}** ${implemented}\n${summary}`;
});

const content = lines.join('\n\n') + '\n\n💬 有需要实施的资产，告诉 cc 即可';

// 生成签名
let sign = '';
let timestamp = '';
if (secret) {
  timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = timestamp + '\n' + secret;
  const hmac = crypto.createHmac('sha256', stringToSign);
  hmac.update('');
  sign = hmac.digest('base64');
}

const card = {
  msg_type: 'interactive',
  card: {
    header: {
      title: { content: '🧬 EvoMap 每日资产更新', tag: 'plain_text' },
      template: 'blue'
    },
    elements: [
      {
        tag: 'div',
        text: { content, tag: 'lark_md' }
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `⏰ ${new Date().toLocaleString('zh-CN')}` }]
      }
    ]
  }
};

const requestBody = secret ? { ...card, timestamp, sign } : { ...card };

fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(requestBody)
})
  .then(res => res.json())
  .then(data => {
    if (data.code === 0) {
      console.log('✅ EvoMap 资产通知发送成功');
    } else {
      console.error('❌ 发送失败:', data.msg);
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('❌ 请求失败:', err.message);
    process.exit(1);
  });
