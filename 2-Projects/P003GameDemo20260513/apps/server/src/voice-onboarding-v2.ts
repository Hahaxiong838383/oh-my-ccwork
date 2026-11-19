import {z} from 'zod';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** This is the worker-to-Brain contract, not a device-write endpoint. */
export const stepV2Schema=z.object({
 v:z.literal(2),session_id:id,trace_id:id,lesson_id:id,request_id:id,
 action:z.enum(['begin','question_started','audio_complete','answer','question_skipped','finish','cancel']),
 question_index:z.number().int().min(0).max(3),revision:z.number().int().min(0).max(1000000),
 text:z.string().min(1).max(120).optional(),
}).strict().superRefine((s,c)=>{
 if((s.action==='answer')!==Boolean(s.text))c.addIssue({code:'custom',message:'text only for worker answer'});
 if(['question_started','audio_complete','answer','question_skipped'].includes(s.action)&&s.question_index===0)c.addIssue({code:'custom',message:'question required'});
 if(s.action==='begin'&&(s.question_index!==0||s.revision!==0))c.addIssue({code:'custom',message:'initial revision required'});
});
export type StepV2=z.infer<typeof stepV2Schema>;
export type QuestionV2={index:number;phase:'idle'|'speaking'|'ready'|'answered'|'skipped'};
