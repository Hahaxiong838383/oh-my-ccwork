import {beforeEach,describe,expect,it,vi} from 'vitest';
import Taro from '@tarojs/taro';
import {liveApi} from '../src/services/live-api';
import {getConversationPage,getBusinessPage,getObservationPage} from '../src/services/history-api';
vi.mock('@tarojs/taro',()=>({default:{getStorageSync:()=> 'parent-test',request:vi.fn(),removeStorageSync:vi.fn()}}));
beforeEach(()=>{vi.mocked(Taro.request).mockReset();process.env.TARO_APP_API_BASE_URL='https://kidshub-ai.hahaxiong.cc';});
const response=(data:any)=>({statusCode:200,header:{},data:{ok:true,data}} as never);
describe('真实snake_case合同经微信传输层映射',()=>{
 it('色温和测试来源游戏快照可读，正常资产摘要保持隔离',async()=>{
  vi.mocked(Taro.request).mockResolvedValue(response({device:{online:true,updated_at_ms:1794898400000,color_mode:'warm',led_enabled:true,focus_active:false},ark:{available:false,reason:'non_normal',reported_state:{source:'device.ark.state',source_mode:'gm',snapshot_id:'s1',logical_day:'2026-11-08',captured_at_ms:1794898399000,received_at_ms:1794898400000,wallets:{family_coin:123,stardust:0},inventory:{'M-CARD-001':2},progress:{timer_state:'paused',claimable_count:1,next_reward:{status:'claimable',kind:'currency',item_id:'C-FAMILY-001',stage_id:'REGULAR-05',remaining_seconds:0}}}},records:{recent_activity:{available:true,items:[{record_id:'r1',save_id:'save',sequence:2,source_mode:'gm',reason:'gm_adjustment',logical_day:'2026-11-08',occurred_at_ms:1794898399000,received_at_ms:1794898400000,time_status:'reported',resource_changes:[],item_changes:[],grants:[{reward_instance_id:'reward1',source_kind:'progress_stage',source_id:'REGULAR-05',logical_day:'2026-11-08',resolved_rewards:[{item_id:'C-FAMILY-001',quantity:5,kind:'currency'}]}]}],has_more:false,next_cursor:null}}}));
  const d=await liveApi.getSnapshot('dev_c');
  expect(d).toMatchObject({colorMode:'warm',ledEnabled:true,focusActive:false});
  expect(d.details?.ark.available).toBe(false);
  expect(d.details?.reportedState).toMatchObject({sourceMode:'gm',logicalDay:'2026-11-08',familyCoin:123,stardust:0,cards:2,progress:{claimableCount:1,nextReward:{remainingSeconds:0}}});
  expect(d.details?.recentActivity.items[0]).toMatchObject({recordId:'r1',sourceMode:'gm',logicalDay:'2026-11-08',grants:[{logicalDay:'2026-11-08',resolvedRewards:[{quantity:5}]}]});
 });
 it('历史奖励/库存/使用时长snake合同可读，不把unknown旧奖励混入当前资产',async()=>{
  const item={event_id:'old-reward',event_name:'g1.reward_granted',kind:'rewards',occurred_at_ms:1793933632128,received_at_ms:1794830000000,time_status:'reported',source_mode:'unknown',rewards:[{item_id:'E01-DEC-001',quantity:1,kind:'decoration',tank_id:null}]};
  vi.mocked(Taro.request).mockResolvedValueOnce(response({device:{online:false,updated_at_ms:null},historical_usage:{available:true,total_seconds:902,observed_seconds:0,estimated_seconds:902,from_day:'2026-11-06',to_day:'2026-11-06',daily:[]},observations:{available:true,counts:{rewards:11,inventory:21,makeup_cards:5,progress:3,wallet:0},coverage:{complete:false,first_occurred_at_ms:1793933632128},latest:{rewards:item,makeup_cards:{...item,event_id:'card',kind:'makeup_cards',rewards:undefined,inventory:{item_id:'M-CARD-001',before:1,after:0,delta:-1}}}}}));
  const d=await liveApi.getSnapshot('dev_c');expect(d.details?.historicalUsage.totalSeconds).toBe(902);expect(d.details?.observations.latest.makeupCards?.inventory?.after).toBe(0);expect(d.details?.ark.available).toBe(false);
  vi.mocked(Taro.request).mockResolvedValueOnce(response({schema_version:1,items:[item],next_cursor:'opaque+/=',has_more:true,coverage:{complete:false}}));
  const p=await getObservationPage('dev_c',{limit:20,kind:'rewards',fromDay:'2026-11-06'});expect(p.items[0].rewards[0].itemId).toBe('E01-DEC-001');expect(p.nextCursor).toBe('opaque+/=');expect(vi.mocked(Taro.request).mock.calls[1][0].url).toContain('/observations?limit=20&from_day=2026-11-06&kind=rewards');
 });
 it('设备离线且快照时间未知仍能读取已有时长、资产、摘要和对话数量',async()=>{
  vi.mocked(Taro.request).mockResolvedValue(response({device:{online:false,updated_at_ms:null,brightness_level:0,present:false,image_distance_m:null,image_distance_state:null},usage:{today:{available:true,focus_minutes:2},daily:[{date:'2026-11-16',available:true,focus_minutes:2}]},ark:{available:true,source_mode:'normal',wallets:{family_coin:0,stardust:null},inventory:{'M-CARD-001':0}},records:{yesterday_income:{available:true,reason:'partial_history',source_mode:'normal',family_coin:99,stardust:null,date:'2026-11-15'},latest_items:{available:false,reason:'no_records',items:[]}},conversations:{available:true,message_count:184,user_message_count:92,assistant_message_count:92,history_complete:false}}));
  const d=await liveApi.getSnapshot('dev_c');expect(d.updatedAtMs).toBeNull();expect(d.details?.usage.today.focusMinutes).toBe(2);expect(d.details?.ark).toMatchObject({familyCoin:0,stardust:null,cards:0});expect(d.details?.income.familyCoin).toBe(99);expect(d.details?.conversations.messageCount).toBe(184);
 });
 it('对话分页保持签名cursor和日期，文本原样保留，不把助手条数称轮数',async()=>{
  vi.mocked(Taro.request).mockResolvedValue(response({schema_version:1,items:[{id:'message-1',role:'assistant',text:'<不是HTML>\n历史回答',ts:1794830000000}],next_cursor:'opaque+/=',has_more:true,message_count:184,user_message_count:92,assistant_message_count:92,history_complete:false}));
  const page=await getConversationPage('dev_c',{limit:20,cursor:'opaque+/=',fromDay:'2026-11-01',toDay:'2026-11-16'});expect(page.items[0].text).toBe('<不是HTML>\n历史回答');expect(page.messageCount).toBe(184);expect(vi.mocked(Taro.request).mock.calls[0][0].url).toBe('https://kidshub-ai.hahaxiong.cc/v1/parent/devices/dev_c/conversations?limit=20&cursor=opaque%2B%2F%3D&from_day=2026-11-01&to_day=2026-11-16');
 });
 it('业务流水保留多资源同笔、负支出和未知时间',async()=>{
  vi.mocked(Taro.request).mockResolvedValue(response({schema_version:1,items:[{record_id:'r1',save_id:'s1',sequence:2,source_mode:'normal',reason:'resource_spend',occurred_at_ms:null,time_status:'unknown',received_at_ms:1794830000000,resource_changes:[{resource_id:'family_coin',delta:-2}],item_changes:[]}],next_cursor:null,has_more:false}));
  const p=await getBusinessPage('dev_c',{limit:20});expect(p.items[0]).toMatchObject({recordId:'r1',occurredAtMs:null,resourceChanges:[{resourceId:'family_coin',delta:-2}]});
 });
 it('兼容基线与状态变更穿过snake_case映射，缺失资产保持未知',async()=>{
  const core={save_id:'save',source_mode:'unknown',reason:'unknown',occurred_at_ms:null,time_status:'unknown',received_at_ms:1794830000000,format:'p003-ark-records-r1',authorization_source:'legacy_explicit_scope',origin_verified:false,resource_changes:[],item_changes:[]};
  vi.mocked(Taro.request).mockResolvedValue(response({schema_version:1,items:[{...core,record_id:'save:1',sequence:1,record_kind:'baseline',baseline:{wallets:{family_coin:0,stardust:null,'M-CARD-001':1},items:[{item_id:'tank-part',quantity:2,state:'pending_activation',item_kind:'tank_component'}]}},{...core,record_id:'save:2',sequence:2,record_kind:'business_commit',inventory_state_changes:[{item_id:'tank-part',from_state:'pending_activation',to_state:'active',quantity:2}]}],next_cursor:null,has_more:false}));
  const p=await getBusinessPage('dev_c',{limit:20});
  expect(p.items[0]).toMatchObject({recordKind:'baseline',authorizationSource:'legacy_explicit_scope',originVerified:false,baseline:{wallets:{familyCoin:0,stardust:null,'M-CARD-001':1},items:[{itemId:'tank-part',quantity:2,state:'pending_activation'}]}});
  expect(p.items[1]).toMatchObject({recordKind:'business_commit',inventoryStateChanges:[{itemId:'tank-part',fromState:'pending_activation',toState:'active',quantity:2}]});
 });
 it('缺cursor或非法计数的200响应不能伪装为空历史',async()=>{
  vi.mocked(Taro.request).mockResolvedValue(response({schema_version:1,items:[],has_more:true,next_cursor:null,message_count:0,user_message_count:0,assistant_message_count:0}));await expect(getConversationPage('dev_c',{limit:20})).rejects.toMatchObject({status:502});
 });
});
