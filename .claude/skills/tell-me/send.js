#!/usr/bin/env node
/**
 * 飞书通知脚本 - 跨平台版本（支持签名验证）
 * 用法: node send.js "标题" "内容" [颜色] [note]
 * 颜色: blue(默认), green, orange, red
 */


const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [,, title, rawContent, color = 'blue', noteContentArg] = process.argv;
const content = rawContent ? rawContent.replace(/\\n/g, '\n') : rawContent;
const noteContent = noteContentArg || `⏰ ${new Date().toLocaleString('zh-CN')}`;

if (!title || !content) {
  console.error('用法: node send.js "标题" "内容" [颜色]');
  process.exit(1);
}

// 读取配置文件
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

// 生成签名
let sign = '';
let timestamp = '';

if (secret) {
  timestamp = Math.floor(Date.now() / 1000).toString();
  // 飞书签名算法：timestamp + "\n" + secret 作为签名字符串
  // 使用 secret 作为密钥进行 HmacSHA256 加密
  // 飞书签名算法：以 timestamp+"\n"+secret 作为 key，消息为空字符串
  const stringToSign = timestamp + '\n' + secret;
  const hmac = crypto.createHmac('sha256', stringToSign);
  hmac.update('');
  sign = hmac.digest('base64');
}

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
        elements: [{ tag: 'plain_text', content: noteContent }]
      }
    ]
  }
};

// 构建请求体（无 secret 时不传 timestamp/sign，避免触发飞书签名验证）
const requestBody = secret ? { ...card, timestamp, sign } : { ...card };

fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(requestBody)
})
  .then(res => res.json())
  .then(data => {
    if (data.code === 0) {
      console.log('✅ 发送成功');
    } else {
      console.error('❌ 发送失败:', data.msg);
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('❌ 请求失败:', err.message);
    process.exit(1);
  });
