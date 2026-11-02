import { inspectEventStructure } from './structure.js';
import { readFileSync } from 'node:fs';
import {TIER_REGISTRY,tierSemanticValid} from './tier-contracts.js';
const schema=JSON.parse(readFileSync(new URL('./event-property-schema-v1.json',import.meta.url),'utf8'));
export const RAW_EVENT_REGISTRY: {eventName:string;group:string;sample:Record<string,unknown>;jsonSchema:Schema}[]=schema.events;
export const EVENT_REGISTRY=[...RAW_EVENT_REGISTRY,...TIER_REGISTRY] as typeof RAW_EVENT_REGISTRY;
type Schema={type?:string|string[];const?:unknown;enum?:unknown[];oneOf?:Schema[];anyOf?:Schema[];not?:Schema;properties?:Record<string,Schema>;required?:string[];additionalProperties?:boolean;items?:Schema;maxItems?:number;maxLength?:number;pattern?:string;minimum?:number;maximum?:number;multipleOf?:number};
export function matchesSchema(value:unknown,s:Schema):boolean {
  if(s.oneOf && s.oneOf.filter(branch=>matchesSchema(value,branch)).length!==1)return false;
  if(s.anyOf && !s.anyOf.some(branch=>matchesSchema(value,branch)))return false;
  if(s.not && matchesSchema(value,s.not))return false;
  if('const' in s && value!==s.const)return false;
  if(s.enum && !s.enum.includes(value))return false;
  const object=typeof value==='object'&&value!==null&&!Array.isArray(value);
  if(s.type){const types=Array.isArray(s.type)?s.type:[s.type];if(!types.some(t=>t==='null'?value===null:t==='object'?object:t==='array'?Array.isArray(value):t==='integer'?typeof value==='number'&&Number.isSafeInteger(value):t==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===t))return false;}
  if(typeof value==='string' && ((s.maxLength!==undefined&&value.length>s.maxLength)||(s.pattern&&!new RegExp(s.pattern).test(value))))return false;
  if(typeof value==='number' && ((s.minimum!==undefined&&value<s.minimum)||(s.maximum!==undefined&&value>s.maximum)||(s.multipleOf!==undefined&&value%s.multipleOf!==0)))return false;
  if(Array.isArray(value)&&((s.maxItems!==undefined&&value.length>s.maxItems)||(s.items&&!value.every(v=>matchesSchema(v,s.items!)))))return false;
  if(object){const v=value as Record<string,unknown>;if(s.required?.some(k=>!Object.hasOwn(v,k)))return false;if(s.additionalProperties===false&&Object.keys(v).some(k=>!Object.hasOwn(s.properties??{},k)))return false;for(const [k,child] of Object.entries(s.properties??{}))if(Object.hasOwn(v,k)&&!matchesSchema(v[k],child))return false;}
  return true;
}
function containsSensitive(v:unknown):boolean {
  if(typeof v==='string')return /[\x00-\x1f\x7f]|BJP003\d{14}|eyJ[A-Za-z0-9_-]+\.|(?:^|\D)1[3-9]\d{9}(?:$|\D)/.test(v);
  if(Array.isArray(v))return v.some(containsSensitive);
  if(v&&typeof v==='object')return Object.values(v).some(containsSensitive);
  return false;
}
export function validateProperties(eventName:string,properties:unknown):'event_not_allowed'|'invalid_properties'|null{
  const entry=EVENT_REGISTRY.find(e=>e.eventName===eventName);
  if(!entry)return 'event_not_allowed';
  if(inspectEventStructure(properties)||containsSensitive(properties)||!matchesSchema(properties,entry.jsonSchema))return 'invalid_properties';
  if(!tierSemanticValid(eventName,properties as Record<string,unknown>))return 'invalid_properties';
  return null;
}
