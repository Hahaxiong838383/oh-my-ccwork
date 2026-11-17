import {createHash} from 'node:crypto';
/** Keep synthetic session entropy without accidentally generating a phone-shaped ID. */
export function syntheticSessionId(seed:string){
 return createHash('sha256').update(seed).digest('hex').slice(0,32).replace(/[0-9]/g,d=>String.fromCharCode(103+Number(d)));
}
