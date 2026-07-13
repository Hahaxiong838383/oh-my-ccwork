#!/usr/bin/env node
// refine-triggers.mjs — REFINE 第一步：过泛触发词黑名单清洗（就地更新 slice-zh.json）
// 黑名单标准：纯句式无实质（真的吗/长什么样）或 高频弱实质词（老师/声音/睡觉），来自负样本真误报分析
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zh = JSON.parse(readFileSync(resolve(ROOT, 'slice-zh.json'), 'utf8'));

// 真误报触发词（2026-07-13 P1 首轮负样本分析）+ 同类纯句式词
const BLACKLIST = new Set([
  '死了', '真的吗', '长什么样', '不会做', '声音', '睡觉', '玩具', '老师',
  '能量', '大声', '朋友', // 单独"朋友"过泛；"好朋友""最好的朋友"保留
  '分类', '公平', '石头', '下雨', // 冲突榜高频且实质弱（"下雨"日常提及率过高）
  '为什么', '怎么办', '是什么', '什么样', // 纯疑问句式兜底
]);

let removed = 0, affected = 0, dropped = [];
for (const t of zh.topics) {
  const before = t.triggers.length;
  t.triggers = t.triggers.filter((x) => !BLACKLIST.has(x));
  if (t.triggers.length < before) {
    removed += before - t.triggers.length;
    affected++;
    if (t.triggers.length < 3) dropped.push(`${t.id}(${t.name}): 剩${t.triggers.length}个`);
  }
}

writeFileSync(resolve(ROOT, 'slice-zh.json'), JSON.stringify(zh, null, 2));
console.log(JSON.stringify({ 删除触发词: removed, 受影响主题: affected, 低于3个的主题: dropped }, null, 2));
