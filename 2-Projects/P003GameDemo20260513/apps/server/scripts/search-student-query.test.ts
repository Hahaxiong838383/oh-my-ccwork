import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateQuery } from '../src/tools/search-tasks.js';

test('public Minecraft title queries survive privacy validation without rewriting the question', () => {
  for (const query of [
    '查一下我的世界基岩版最新正式更新有哪些新玩法',
    '查一下《我的世界》红石中继器怎么用',
    '查一下我的世界游戏的生存模式怎么玩',
    '查一下我的世界Java版的更新公告',
    '查一下我的世界最近更新了什么',
    '查一下我的世界红石中继器怎么用',
    '查一下我的世界',
  ]) assert.equal(validateQuery(query), query);
});

test('a public game title cannot shield personal information or account credentials', () => {
  for (const query of [
    '查一下我的世界账号密码',
    '查一下我的世界游戏里同学的手机号',
    '查一下我的世界基岩版中我的账号信息',
    '查一下我的世界游戏和家庭住址',
    '查一下我的世界观和生活经历',
    '查一下我的学校和班级',
    '查一下《我的世界》Bearer abc',
  ]) assert.throws(() => validateQuery(query), /private_query/, query);
});
