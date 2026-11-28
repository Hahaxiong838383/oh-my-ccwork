import {randomUUID} from 'node:crypto';

type Turn = {role:'user'|'assistant';content:string};
type Room = {id:string;expires:number;history:Turn[];pending?:AbortController};
type Reply = {text:string;tool:string|null;sources:{title:string;url:string}[]};
const idleMs = 30*60_000;

export class DiagnosticError extends Error {
  readonly status:400|429|502|503;
  constructor(status:400|429|502|503,message:string) {super(message);this.status=status;}
}

export class DiagnosticSessions {
  private rooms = new Map<string,Room>();
  private readonly connect:()=>{url:URL;key:string};
  private readonly now:()=>number;
  private readonly request:typeof fetch;
  constructor(connect:()=>{url:URL;key:string},now=Date.now,request=fetch) {
    this.connect=connect;this.now=now;this.request=request;
  }

  reset(login:string) {
    this.rooms.get(login)?.pending?.abort();
    this.rooms.delete(login);
  }
  expire() {
    const now=this.now();
    for (const [login,room] of this.rooms) if (room.expires<=now) this.reset(login);
  }
  async ask(login:string,input:unknown,signal?:AbortSignal):Promise<Reply> {
    if (typeof input!=='string'||!input.trim()||input.length>600) throw new DiagnosticError(400,'请输入 1 至 600 字的试问');
    this.expire();
    const room:Room=this.rooms.get(login)??{id:'admin-diagnostic-'+randomUUID(),expires:0,history:[]};
    if (room.pending) throw new DiagnosticError(429,'当前试问正在回答');
    const {url,key}=this.connect();
    const controller=new AbortController();
    room.pending=controller;
    room.expires=this.now()+idleMs;
    this.rooms.set(login,room);
    const question:Turn={role:'user',content:input.trim()};
    try {
      const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(45_000),...(signal?[signal]:[])]);
      const response=await this.request(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key,
        'X-Personal-Session':room.id},body:JSON.stringify({model:'personal-brain',stream:false,store:false,messages:[...room.history,question]}),signal:combined});
      if (!response.ok) throw new DiagnosticError(502,'大脑暂时无法完成试问');
      const data=await response.json();
      combined.throwIfAborted();
      const text=data.choices?.[0]?.message?.content;
      if (typeof text!=='string'||!text.trim()) throw new DiagnosticError(502,'大脑没有返回正文');
      const sources=(Array.isArray(data.sources)?data.sources:[]).slice(0,10)
        .filter((s:{url?:string}|null)=>typeof s?.url==='string' && /^https?:\/\//.test(s.url))
        .map((s:{title?:string;url:string})=>({title:s.title||s.url,url:s.url}));
      room.history.push(question,{role:'assistant',content:text.slice(0,1200)});
      room.history=room.history.slice(-12);
      room.expires=this.now()+idleMs;
      return {text,tool:typeof data.tool==='string'?data.tool:null,sources};
    } catch (error) {
      if (error instanceof DiagnosticError) throw error;
      throw new DiagnosticError(502,'大脑连接失败或试问已结束');
    } finally { room.pending=undefined; }
  }
}
