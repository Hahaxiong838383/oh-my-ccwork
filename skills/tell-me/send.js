#!/usr/bin/env node
/**
 * 飞书通知脚本 - 跨平台版本（支持签名校验）
 * 用法: node send.js "标题" "内容" [颜色]
 * 颜色: blue(默认), green, orange, red
 */

const [,, title, content, color = 'blue'] = process.argv;

if (!title || !content) {
  console.error('用法: node send.js "标题" "内容" [颜色]');
  process.exit(1);
}

// 读取配置文件
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const configPath = path.join(__dirname, 'config.json');

let webhook, secret;
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  webhook = config.webhook;
  secret = config.secret;
} catch (err) {
  console.error('❌ 无法读取配置文件:', err.message);
  process.exit(1);
}

if (!webhook || webhook === 'YOUR_FEISHU_WEBHOOK_HERE') {
  console.error('❌ 飞书 webhook 未配置');
  console.error('');
  console.error('请在 config.json 中配置 webhook 地址');
  console.error('详见：.claude/skills/tell-me/配置SOP.md');
  process.exit(1);
}

// 生成签名 - 飞书官方算法
function generateSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', stringToSign);
  // 飞书签名：用空字符串作为待签名字符串
  hmac.update('');
  return hmac.digest('base64');
}

// 构建请求体
const card = {
  msg_type: 'interactive',
  card: {
    header: {
      title: { content: `📌 ${title}`, tag: 'plain_text' },
      template: color
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

async function send() {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  let url = webhook;
  if (secret) {
    const sign = generateSign(secret, timestamp);
    // 判断 webhook 是否已包含 ?
    const separator = webhook.includes('?') ? '&' : '?';
    url = `${webhook}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
    console.log('Using signed URL');
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card)
    });
    const data = await res.json();
    if (data.code === 0) {
      console.log('✅ 发送成功');
    } else {
      console.error('❌ 发送失败:', data.msg);
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ 请求失败:', err.message);
    process.exit(1);
  }
}

send();
