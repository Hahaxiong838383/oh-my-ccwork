import {beforeEach,describe,expect,it,vi} from 'vitest';
import Taro from '@tarojs/taro';
import {liveApi} from '../src/services/live-api';
import {getConversationPage,getBusinessPage} from '../src/services/history-api';
vi.mock('@tarojs/taro',()=>({default:{getStorageSync:()=> 'parent-test',request:vi.fn(),removeStorageSync:vi.fn()}}));
beforeEach(()=>{vi.mocked(Taro.request).mockReset();process.env.TARO_APP_API_BASE_URL='https://kidshub-ai.hahaxiong.cc';});
const response=(data:any)=>({statusCode:200,header:{},data:{ok:true,data}} as never);
describe('真实snake_case合同经微信传输层映射',()=>{
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
 it('缺cursor或非法计数的200响应不能伪装为空历史',async()=>{
  vi.mocked(Taro.request).mockResolvedValue(response({schema_version:1,items:[],has_more:true,next_cursor:null,message_count:0,user_message_count:0,assistant_message_count:0}));await expect(getConversationPage('dev_c',{limit:20})).rejects.toMatchObject({status:502});
 });
});
