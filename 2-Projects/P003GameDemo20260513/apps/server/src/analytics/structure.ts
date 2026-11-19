/** JSON input complexity limits checked without recursion, before stringify/hash/schema walks. */
export const EVENT_STRUCTURE_LIMITS={depth:8,nodes:4096} as const;
export function inspectEventStructure(raw:unknown):'invalid_event'|'event_too_large'|null {
  const stack:{value:unknown;depth:number}[]=[{value:raw,depth:0}],seen=new WeakSet<object>();
  let nodes=0;
  while(stack.length){
    const {value,depth}=stack.pop()!;
    if(++nodes>EVENT_STRUCTURE_LIMITS.nodes)return 'event_too_large';
    if(depth>EVENT_STRUCTURE_LIMITS.depth)return 'invalid_event';
    if(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))continue;
    if(typeof value!=='object')return 'invalid_event';
    if(seen.has(value))return 'invalid_event';seen.add(value);
    const children=Array.isArray(value)?value:Object.values(value);
    if(nodes+stack.length+children.length>EVENT_STRUCTURE_LIMITS.nodes)return 'event_too_large';
    for(const child of children)stack.push({value:child,depth:depth+1});
  }
  return null;
}
/** Preserve same-ID conflict semantics even for invalid deeply nested JSON, without hashing it. */
export function sameJsonContent(left:unknown,right:unknown):boolean {
  const pending:[unknown,unknown][]=[[left,right]];let checked=0;
  while(pending.length){
    if(++checked>2*1024*1024)return false; // Every HTTP body is already bounded to 2 MiB.
    const [a,b]=pending.pop()!;
    if(a===b)continue;
    if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
    if(Array.isArray(a)||Array.isArray(b)){
      if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return false;
      for(let i=0;i<a.length;i++)pending.push([a[i],b[i]]);
    }else{
      const av=a as Record<string,unknown>,bv=b as Record<string,unknown>,keys=Object.keys(av);
      if(keys.length!==Object.keys(bv).length)return false;
      for(const key of keys){if(!Object.hasOwn(bv,key))return false;pending.push([av[key],bv[key]]);}
    }
    if(pending.length+checked>2*1024*1024)return false;
  }
  return true;
}
