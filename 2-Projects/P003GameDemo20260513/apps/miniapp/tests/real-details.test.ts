import { describe, expect, it } from 'vitest';
import { dashboardDetails, detailsView } from '../src/services/real-details';

describe('真实数据面板映射', () => {
  it('缺测与真实零分开，已有时长资产不依赖设备在线', () => {
    const v = detailsView(dashboardDetails({usage:{today:{available:true,focusMinutes:0},daily:[{date:'2026-11-15',available:false,focusMinutes:null},{date:'2026-11-16',available:true,focusMinutes:0}]},ark:{available:true,sourceMode:'normal',wallets:{familyCoin:0,stardust:null},inventory:{'M-CARD-001':0}}}));
    expect(v.today).toBe('0 分钟'); expect(v.daily.map(x=>x.value)).toEqual(['暂无数据','0 分钟']);
    expect(v.familyCoin).toBe('0'); expect(v.stardust).toBe('暂无数据'); expect(v.cards).toBe('0 张');
  });
  it('gm资产不能靠有数字冒充正常余额，旧today默认0不能替代usage', () => {
    const v=detailsView(dashboardDetails({today:{focusMinutes:0},ark:{available:true,sourceMode:'gm',wallets:{familyCoin:99},inventory:{'M-CARD-001':3}}}));
    expect(v.today).toBe('暂无数据');expect(v.familyCoin).toBe('暂无数据');expect(v.cards).toBe('暂无数据');
  });
  it('摘要保留部分收入和待激活整组，已收0条不冒充完整历史',()=>{
    const v=detailsView(dashboardDetails({records:{yesterdayIncome:{available:true,sourceMode:'normal',reason:'partial_history',date:'2026-11-15',familyCoin:99,stardust:null},latestItems:{available:true,sourceMode:'normal',reason:'partial_history',recordId:'r1',items:[{itemInstanceId:'i1',itemId:'tank-part',itemKind:'tank_component',quantity:2,state:'pending_activation',activationRecordId:null}]}},conversations:{available:true,historyComplete:false,messageCount:0,userMessageCount:0,assistantMessageCount:0}}));
    expect(v.incomeFamilyCoin).toBe('99');expect(v.incomeStardust).toBe('暂无数据');expect(v.latestItems[0]).toMatchObject({itemId:'tank-part',quantity:2,state:'pending_activation'});expect(v.conversationCount).toBe('已同步 0 条');
  });
  it('不可用摘要即使携带旧数字也不显示',()=>{
    const v=detailsView(dashboardDetails({records:{yesterdayIncome:{available:false,reason:'dependency_unavailable',familyCoin:99},latestItems:{available:false,reason:'clock_unknown',items:[{itemId:'old'}]}},conversations:{available:false,reason:'not_enabled',messageCount:10}}));
    expect(v.incomeFamilyCoin).toBe('暂无数据');expect(v.latestItems).toEqual([]);expect(v.conversationCount).toBe('暂无数据');
  });
});
