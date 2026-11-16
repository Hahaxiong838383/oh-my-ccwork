import {describe,expect,it,vi} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import RealDetails,{ConversationRow} from '../src/pages/index/real-details';
import {dashboardDetails} from '../src/services/real-details';
vi.mock('@tarojs/taro',()=>({default:{}}));
vi.mock('@tarojs/components',async()=>{const R=await import('react');const tag=(name:string)=>(p:any)=>R.createElement(name,{className:p.className},p.children);return {View:tag('div'),Text:tag('span'),Button:tag('button'),Picker:tag('div')};});
vi.mock('../src/pages/index/components',async()=>{const R=await import('react');return {Card:(p:any)=>R.createElement('section',{},p.children),Heading:(p:any)=>R.createElement('h2',{},p.title)};});
describe('真实面板可见内容',()=>{
 it('可呈现历史条数、已有时长和真实0，不要求设备此刻在线',()=>{
  const html=renderToStaticMarkup(<RealDetails publicId="dev_c" onAccessLost={()=>{}} details={dashboardDetails({usage:{today:{available:true,focusMinutes:2},daily:[{date:'2026-11-15',available:false,focusMinutes:null}]},ark:{available:true,sourceMode:'normal',wallets:{familyCoin:0,stardust:9},inventory:{'M-CARD-001':0}},conversations:{available:true,messageCount:184,lastMessageAtMs:1794830000000},records:{yesterdayIncome:{available:false,reason:'no_records'},latestItems:{available:false,reason:'no_records'}}})}/>);
  expect(html).toContain('今日 2 分钟');expect(html).toContain('已同步 184 条');expect(html).toContain('0 张');expect(html).toContain('2026-11-15');expect(html).toContain('暂无数据');expect(html).toContain('查看历史对话');expect(html).toContain('查看已同步业务流水');
 });
 it('真实对话内容作为文本可见，不转为HTML执行',()=>{
  const html=renderToStaticMarkup(<ConversationRow item={{id:'m1',role:'user',text:'上次说的 <历史问题>',ts:1794830000000}}/>);expect(html).toContain('孩子');expect(html).toContain('上次说的 &lt;历史问题&gt;');
 });
});
