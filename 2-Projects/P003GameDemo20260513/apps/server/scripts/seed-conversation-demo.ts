// demo 对话 seed（hub 看板对话历史演示用）。真实对话由 web 体验台语音产生；此脚本仅灌演示数据。
import { conversationStore } from '../src/conversation-store.js';

const rows: Array<['user' | 'assistant', string]> = [
  ['user', '小可，海洋为什么是蓝色的？'],
  ['assistant', '因为海水会吸收阳光里的红光，把蓝光反射出来，所以大海看起来是蓝色的呀～'],
  ['user', '那鱼为什么不会淹死呢？'],
  ['assistant', '鱼有特别的鳃，能从水里直接拿到氧气，就像我们用鼻子呼吸空气一样！'],
  ['user', '我今天读完了一整本绘本！'],
  ['assistant', '哇，太棒了！你已经是小小阅读家啦，要不要把今天读到的故事讲给我听？'],
];

for (const [role, text] of rows) {
  conversationStore.add({ account_id: 'acct-01', session_id: 'demo-sess-1', role, text });
}
console.log('seeded conversation:', conversationStore.list({ accountId: 'acct-01' }).length, '条');
