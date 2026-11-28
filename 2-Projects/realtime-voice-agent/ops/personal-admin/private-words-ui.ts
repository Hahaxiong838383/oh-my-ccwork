// Plain DOM, also works in the mobile WebView. No private values enter HTML markup.
function wordPanel() {
  const panel=document.getElementById('privateWordsPanel'), kind=document.querySelector<HTMLSelectElement>('#kind');
  if(!panel||!kind)return;
  let seq=0,writing=false;
  const element=(tag:string,text:string)=>{const e=document.createElement(tag);e.textContent=text;return e;};
  async function request(method:string,body?:object){
    const r=await fetch('/api/word-publications',{method,headers:{'Content-Type':'application/json','X-Voice-Admin':'1'},body:body&&JSON.stringify(body)});
    const v=await r.json();if(!r.ok)throw Error(v.error||'请重新登录');return v;
  }
  async function show() {
    const next=++seq;
    try {
      const r=await request('GET'); if(next!==seq)return;
      const k=kind!.value,live:string[]=r.current.words[k]||[],d=r.drafts[k],planned:string[]=d?.words||[];
      const changes=(a:string[],b:string[])=>a.filter(w=>!b.includes(w)).join('、')||'无';
      const last=r.last?'最近房间读取 '+(r.last.revision??'失败')+' · '+new Date(r.last.at).toLocaleString()+(r.last.cloudAsr?' · 在线识别':' · 本地识别'):'等待新通话回执';
      const title=element('h3','通话词表 · 版本 '+r.current.revision);
      const nodes:HTMLElement[]=[title,element('p',last),element('p','本类已发布的自定义词：'+(live.join('、')||'无'))];
      const publish=async(body:object)=>{
        if(writing)return;writing=true;
        panel!.querySelectorAll('button').forEach(b=>b.disabled=true);
        try{await request('POST',{...body,previous:r.current.revision});await show();}
        catch(e){await show();panel!.append(element('p',String((e as Error).message)));}
        finally{writing=false;}
      };
      if(d){
        nodes.push(element('p','草稿将新增：'+changes(planned,live)+'　移除：'+changes(live,planned)));
        const b=document.createElement('button');b.type='button';b.textContent='将此草稿用于下一通';
        b.disabled=JSON.stringify(planned)===JSON.stringify(r.current.words[k]);b.onclick=()=>void publish({kind:k,token:d.token});nodes.push(b);
      }
      if(r.history.length){
        const sel=document.createElement('select');sel.setAttribute('aria-label','恢复整套词表的历史版本');
        for(const h of r.history){const o=document.createElement('option');o.value=String(h.revision);o.textContent='版本 '+h.revision;sel.append(o);}
        const b=document.createElement('button');b.type='button';b.textContent='恢复整套历史词表';
        b.onclick=()=>{if(confirm('将整套词表恢复到版本 '+sel.value+' 的设置，并从下一通使用？'))void publish({restore:Number(sel.value)});};
        nodes.push(sel,b);
      }
      panel!.replaceChildren(...nodes);
    }catch(e){if(next===seq)panel!.replaceChildren(element('p',String((e as Error).message)));}
  }
  kind.addEventListener('change',show);
  Object.assign(window,{refreshPrivateWords:show});
}
export const privateWordsJs='('+wordPanel.toString()+')();';
