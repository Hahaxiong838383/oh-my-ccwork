import {describe,expect,it,vi} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import RealDetails,{BusinessRow,ConversationRow,ObservationRow} from '../src/pages/index/real-details';
import {observation} from '../src/services/observations';
import type {BusinessItem} from '../src/services/history-api';
import {dashboardDetails} from '../src/services/real-details';
vi.mock('@tarojs/taro',()=>({default:{}}));
vi.mock('@tarojs/components',async()=>{const R=await import('react');const tag=(name:string)=>(p:any)=>R.createElement(name,{className:p.className},p.children);return {View:tag('div'),Text:tag('span'),Button:tag('button'),Picker:tag('div')};});
vi.mock('../src/pages/index/components',async()=>{const R=await import('react');return {Card:(p:any)=>R.createElement('section',{},p.children),Heading:(p:any)=>R.createElement('h2',{},p.title)};});
describe('真实面板可见内容',()=>{
 it('历史道具零库存、进度秒数、异常时钟及来源说明真实可见',()=>{
  const inventory=renderToStaticMarkup(<ObservationRow item={observation({eventId:'i',kind:'inventory',timeStatus:'clock_suspect',receivedAtMs:1794830000000,inventory:{itemId:'<道具>',before:1,after:0,delta:-1,status:null}})}/>);
  expect(inventory).toContain('&lt;道具&gt;：1 → 0');expect(inventory).toContain('设备时间待确认');expect(inventory).toContain('来源模式未确认');
  const progress=renderToStaticMarkup(<ObservationRow item={observation({eventId:'p',kind:'progress',progress:{elapsedSeconds:902,checkpointMinutes:15}})}/>);
  expect(progress).toContain('15 分 2 秒');expect(progress).toContain('15 分钟节点');
 });
 it('可呈现历史条数、已有时长和真实0，不要求设备此刻在线',()=>{
  const html=renderToStaticMarkup(<RealDetails publicId="dev_c" onAccessLost={()=>{}} details={dashboardDetails({usage:{today:{available:true,focusMinutes:2},daily:[{date:'2026-11-15',available:false,focusMinutes:null}]},ark:{available:true,sourceMode:'normal',wallets:{familyCoin:0,stardust:9},inventory:{'M-CARD-001':0}},conversations:{available:true,messageCount:184,lastMessageAtMs:1794830000000},records:{yesterdayIncome:{available:false,reason:'no_records'},latestItems:{available:false,reason:'no_records'}}})}/>);
  expect(html).toContain('今日 2 分钟');expect(html).toContain('已同步 184 条');expect(html).toContain('0 张');expect(html).toContain('2026-11-15');expect(html).toContain('暂无数据');expect(html).toContain('查看历史对话');expect(html).toContain('查看已同步业务流水');
 });
 it('真实对话内容作为文本可见，不转为HTML执行',()=>{
  const html=renderToStaticMarkup(<ConversationRow item={{id:'m1',role:'user',text:'上次说的 <历史问题>',ts:1794830000000}}/>);expect(html).toContain('孩子');expect(html).toContain('上次说的 &lt;历史问题&gt;');
 });
 it('历史基线显示已有资产与未知币种，不把余额或库存称为新增收益和获得',()=>{
  const item={recordId:'save:1',saveId:'save',sequence:1,sourceMode:'unknown',reason:'unknown',occurredAtMs:1794830000000,receivedAtMs:1794830000001,timeStatus:'reported',resourceChanges:[{resourceId:'family_coin',delta:99}],itemChanges:[{operation:'acquired',itemInstanceId:'bad',itemId:'不应重复显示',quantity:1,state:'active'}],format:'p003-ark-records-r1',recordKind:'baseline',authorizationSource:'legacy_explicit_scope',baseline:{wallets:{familyCoin:99,stardust:null,'M-CARD-001':0},items:[{itemId:'tank-part',quantity:2,state:'pending_activation',itemKind:'tank_component'}]}} as BusinessItem;
  const html=renderToStaticMarkup(<BusinessRow item={item}/>);
  expect(html).toContain('历史基线');expect(html).toContain('接入时已有状态');expect(html).toContain('不计入新增收益或新获得');expect(html).toContain('家族币：99');expect(html).toContain('星尘：未知');expect(html).toContain('补勤卡：0');expect(html).toContain('已有 · tank-part × 2');expect(html).toContain('待激活');expect(html).not.toContain('+99');expect(html).not.toContain('不应重复显示');
 });
 it('兼容业务保留真实领取分类，混合变更不全部降成原因未知',()=>{
  const common={recordId:'save:2',saveId:'save',sequence:2,sourceMode:'normal',occurredAtMs:null,receivedAtMs:1794830000001,timeStatus:'unknown',resourceChanges:[{resourceId:'family_coin',delta:5}],itemChanges:[],format:'p003-ark-records-r1',recordKind:'business_commit'};
  const reward=renderToStaticMarkup(<BusinessRow item={{...common,reason:'reward_claim'} as BusinessItem}/>);
  expect(reward).toContain('领取奖励');expect(reward).toContain('家族币：+5');expect(reward).not.toContain('来源未知');
  const mixed=renderToStaticMarkup(<BusinessRow item={{...common,reason:'unknown'} as BusinessItem}/>);
  expect(mixed).toContain('业务变更');expect(mixed).not.toContain('原因未知');expect(mixed).toContain('发生时间待确认');
 });
 it('历史物品状态变更可见，不被展示为再获得',()=>{
  const item={recordId:'save:3',saveId:'save',sequence:3,sourceMode:'gm',reason:'unknown',occurredAtMs:1794830000000,receivedAtMs:1794830000001,timeStatus:'reported',resourceChanges:[],itemChanges:[],format:'p003-ark-records-r1',recordKind:'business_commit',inventoryStateChanges:[{itemId:'tank-part',fromState:'pending_activation',toState:'active',quantity:2}]} as BusinessItem;
  const html=renderToStaticMarkup(<BusinessRow item={item}/>);
  expect(html).toContain('测试来源');expect(html).toContain('状态变化 · tank-part');expect(html).toContain('待激活 → 已启用');expect(html).not.toContain('获得');
 });
});
