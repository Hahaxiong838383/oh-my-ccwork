import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { previewRouting } from '../src/tools/search-routing-config.js';

const cases = [
  ['我今天终于投进三分球了','chat'],
  ['你觉得哆啦A梦哪个道具最有用','chat'],
  ['我想在我的世界里建一个海底基地','chat'],
  ['朋友今天只跟别人组队我有点不开心','chat'],
  ['我们班要表演节目我不想又唱一样的歌','chat'],
  ['同学说我太抽象了是在夸我吗','chat'],
  ['帮我设计一个冰属性的小怪兽','chat'],
  ['如果机器人也上学它会喜欢什么课','chat'],
  ['帮我查一下库里最近一场比赛得了多少分','search'],
  ['帮我查一下羽毛球双打发球规则','search'],
  ['帮我查一下宝可梦地平线的两位主角是谁，别剧透','search'],
  ['帮我查一下我的世界基岩版最新正式更新有哪些新玩法','search'],
  ['帮我查一下我的世界基岩版红石中继器有什么用','search'],
  ['帮我查一下歌曲大鱼是谁唱的','search'],
  ['帮我查一下猫为什么会发出呼噜声','search'],
  ['帮我查一下最近中国航天有什么新进展','search'],
  ['不用查了，我们聊别的','cancel'],
  ['改查宝可梦地平线的主角','replace'],
  ['继续刚才的搜索结果','resume'],
  ['他说帮我查一下我的世界','chat'],
] as const;
const configPath=process.env.SEARCH_STUDENT_ROUTING_CONFIG;
const executable=process.env.SEARCH_ROUTING_PREVIEW_BIN;
if(!configPath||!executable)throw Error('routing_check_requires_actual_config_and_native_preview');
const result=await previewRouting(JSON.parse(readFileSync(configPath,'utf8')),cases.map(([text],i)=>({text,at_ms:i*20_000,reset:true})),executable);
const rows=cases.map(([text,expected],i)=>({text,expected,actual:result.decisions[i]?.action??'missing',decision:result.decisions[i]}));
if(process.env.SEARCH_STUDENT_ROUTING_OUTPUT)writeFileSync(process.env.SEARCH_STUDENT_ROUTING_OUTPUT,JSON.stringify(rows,null,2),{mode:0o600});
assert.deepEqual(rows.filter(r=>r.expected!==r.actual),[]);
console.log(JSON.stringify({passed:true,total:rows.length}));
