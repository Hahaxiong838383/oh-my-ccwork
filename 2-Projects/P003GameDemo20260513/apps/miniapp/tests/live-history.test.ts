import { describe, expect, it } from 'vitest';
import { HistoryController } from '../src/services/live-history';
const page=(id:string,cursor:string|null=null)=>({items:[{id}],nextCursor:cursor,hasMore:!!cursor,messageCount:2,historyComplete:false});
describe('真实历史分页生命周期',()=>{
 it('后页保持过滤和cursor，刷新重取首屏',async()=>{
  const calls:any[]=[];const c=new HistoryController(async(q:any)=>{calls.push(q);return page(q.cursor?'r2':'r1',q.cursor?null:'next');});
  await c.refresh({fromDay:'2026-11-01',toDay:'2026-11-16'});await c.loadMore();expect(c.state.items).toEqual([{id:'r1'},{id:'r2'}]);expect(calls[1]).toEqual({limit:20,fromDay:'2026-11-01',toDay:'2026-11-16',cursor:'next'});await c.refresh();expect(calls[2].cursor).toBeUndefined();expect(c.state.items).toEqual([{id:'r1'}]);
 });
 it('失败保留已展示历史，410只能刷新不能重复cursor',async()=>{
  let calls=0;const c=new HistoryController(async()=>{if(++calls===1)return page('r1','next');throw {status:410};});await c.refresh();await c.loadMore();expect(c.state.items).toEqual([{id:'r1'}]);expect(c.state.needsRefresh).toBe(true);expect(c.state.error).toContain('刷新');await c.loadMore();expect(calls).toBe(2);
 });
 it('400/410后首屏刷新503仍不得重发已失效cursor',async()=>{
  for(const status of [400,410]){
   const calls:any[]=[];
   const c=new HistoryController(async(q:any)=>{calls.push(q);if(calls.length===1)return page('r1','expired');if(calls.length===2)throw {status};throw {status:503};});
   await c.refresh();await c.loadMore();await c.refresh();
   expect(calls[2].cursor).toBeUndefined();expect(c.state.items).toEqual([{id:'r1'}]);expect(c.state.needsRefresh).toBe(true);
   await c.loadMore();expect(calls.length).toBe(3);
  }
 });
 it('退出后迟到响应不能恢复旧历史',async()=>{
  let done!:(value:any)=>void;const c=new HistoryController(()=>new Promise<any>(resolve=>{done=resolve;}));const request=c.refresh();c.dispose();done(page('old'));await request;expect(c.state.items).toEqual([]);
 });
 it('401/404清历史并通知父级，503保留旧记录并报错',async()=>{
  for(const code of [401,404,503]){let n=0;const lost:number[]=[];const c=new HistoryController(async()=>{if(++n===1)return page('r1','next');throw {status:code};},s=>lost.push(s));await c.refresh();await c.loadMore();expect(c.state.items.length).toBe(code===503?1:0);expect(lost).toEqual(code===503?[]:[code]);expect(c.state.error.length).toBeGreaterThan(0);}
 });
});
