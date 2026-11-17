export type HistoryFilter={fromDay?:string;toDay?:string;kind?:string};
export type HistoryQuery=HistoryFilter&{limit:number;cursor?:string};
export type HistoryPage<T>={items:T[];nextCursor:string|null;hasMore:boolean;messageCount?:number;userMessageCount?:number;assistantMessageCount?:number;historyComplete?:boolean};
export type HistoryState<T>={items:T[];page:HistoryPage<T>|null;busy:boolean;loaded:boolean;error:string;needsRefresh:boolean;filters:HistoryFilter};
/** One controller belongs to one signed-in device view. Disposal invalidates pending requests. */
export class HistoryController<T>{
 state:HistoryState<T>={items:[],page:null,busy:false,loaded:false,error:'',needsRefresh:false,filters:{}};
 private version=0;private disposed=false;private listeners=new Set<(state:HistoryState<T>)=>void>();
 constructor(private fetchPage:(query:HistoryQuery)=>Promise<HistoryPage<T>>,private accessLost?:(status:number)=>void){}
 subscribe(fn:(state:HistoryState<T>)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private update(patch:Partial<HistoryState<T>>){if(this.disposed)return;this.state={...this.state,...patch};this.listeners.forEach(fn=>fn(this.state));}
 dispose(){this.version++;this.disposed=true;this.listeners.clear();this.state={...this.state,items:[],page:null};}
 async refresh(filters:HistoryFilter=this.state.filters){const changed=JSON.stringify(filters)!==JSON.stringify(this.state.filters);const version=++this.version;this.update({filters:{...filters},busy:true,error:'',...(changed?{items:[],page:null,loaded:false}:{})});await this.load({limit:20,...filters},version,false);}
 async loadMore(){if(this.disposed||this.state.busy||this.state.needsRefresh||!this.state.page?.hasMore||!this.state.page.nextCursor)return;const version=this.version;this.update({busy:true,error:''});await this.load({limit:20,...this.state.filters,cursor:this.state.page.nextCursor},version,true);}
 private async load(query:HistoryQuery,version:number,append:boolean){
  try{const page=await this.fetchPage(query);if(this.disposed||version!==this.version)return;this.update({items:append?[...this.state.items,...page.items]:page.items,page,busy:false,loaded:true,needsRefresh:false});}
  catch(error){if(this.disposed||version!==this.version)return;const status=(error as {status?:number})?.status;const reset=status===401||status===404;const invalidCursor=status===400||status===410;const needsRefresh=this.state.needsRefresh||invalidCursor;this.update({busy:false,error:status===401?'登录已过期，请重新登录':status===404?'设备当前不可访问，请刷新设备列表':needsRefresh?'分页已失效，请刷新记录后继续':status===429?'请求较频繁，请稍后重试':'记录读取失败，请重试；已显示内容保留',needsRefresh,...(invalidCursor&&this.state.page?{page:{...this.state.page,nextCursor:null,hasMore:false}}:{}),...(reset?{items:[],page:null,loaded:false}:{})});if(reset)this.accessLost?.(status!);}
 }
}
