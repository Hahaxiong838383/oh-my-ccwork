import { invalid } from './scope.js';
import { dayOf } from '../telemetry-store.js';
import { weekStartOf } from '../weekly-calculation.js';

export type Rule = {
  template: 'daily_reading'|'weekly_usage'; repeat: 'repeat'|'once';
  goal_minutes: number; required_days: number|null; reward_coins: number;
  sync_to_xiaoke: boolean; description: string|null;
};
export type State = 'active'|'ended_below_target'|'awaiting_confirmation'|'pending_payment'|'paid'|'needs_review';
export type Progress = { usage_seconds:number; received_usage:boolean; qualified_days:number|null; days?:{date:string;usage_seconds:number}[] };
export type TaskItem = Rule & {
  task_id:string; occurrence_id:string; definition_version:number; rule_version:number; state:State;
  period_start_ms:number; period_end_ms:number; progress:Progress; device_received_version:number|null;
  actions:string[]; settlement_id:string|null;
};

export function objectBody(input: unknown): Record<string,unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid('invalid_body');
  return input as Record<string,unknown>;
}
function integer(value: unknown, min: number, max: number, error: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid(error);
  return value;
}
export function ruleFrom(input: unknown, prior?: Rule): Rule {
  const body = objectBody(input);
  const allowed = ['repeat','goal_minutes','required_days','reward_coins','sync_to_xiaoke','description'];
  if (!prior) allowed.push('template');
  if (Object.keys(body).some(key => !allowed.includes(key)) || (prior && !Object.keys(body).length)) throw invalid('invalid_fields');
  const template = prior?.template ?? body.template;
  if (template !== 'daily_reading' && template !== 'weekly_usage') throw invalid('invalid_template');
  const merged = {...{repeat:'repeat',goal_minutes:30,required_days:template==='daily_reading'?null:5,
    reward_coins:template==='daily_reading'?30:150,sync_to_xiaoke:true,description:null},...prior,...body};
  if (merged.repeat !== 'repeat' && merged.repeat !== 'once') throw invalid('invalid_repeat');
  if (typeof merged.sync_to_xiaoke !== 'boolean') throw invalid('invalid_sync_to_xiaoke');
  if (merged.description !== null && (typeof merged.description !== 'string' || Array.from(merged.description).length>200)) throw invalid('invalid_description');
  if (template==='daily_reading' && merged.required_days!==null) throw invalid('invalid_required_days');
  return {template, repeat:merged.repeat, goal_minutes:integer(merged.goal_minutes,1,120,'goal_out_of_range'),
    required_days:template==='daily_reading'?null:integer(merged.required_days,1,7,'required_days_out_of_range'),
    reward_coins:integer(merged.reward_coins,1,500,'reward_out_of_range'),sync_to_xiaoke:merged.sync_to_xiaoke,
    description:merged.description || null};
}
export function periodStart(template: Rule['template'], now:number) {
  const date = template==='daily_reading' ? dayOf(now) : weekStartOf(now);
  return Date.parse(date+'T00:00:00+08:00');
}
export const periodLength = (template: Rule['template']) => 86_400_000*(template==='weekly_usage'?7:1);

export function calculation(rule: Rule, totals: Map<string,{ms:number}>) {
  const days = [...totals].sort(([a],[b])=>a.localeCompare(b));
  const milliseconds = days.reduce((n,[,d])=>n+d.ms,0);
  const target = rule.goal_minutes * 60_000;
  const qualified = days.filter(([,d])=>d.ms>=target).length;
  const weekly = rule.template==='weekly_usage';
  const progress:Progress = {usage_seconds:Math.floor(milliseconds/1000),received_usage:milliseconds>0,qualified_days:weekly?qualified:null};
  if (weekly) progress.days = days.map(([date,d])=>({date,usage_seconds:Math.floor(d.ms/1000)}));
  return {progress, eligible:weekly ? qualified>=rule.required_days! : milliseconds>=target};
}
