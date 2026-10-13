import type {DatabaseSync} from 'node:sqlite';
export const DEFAULT_ANALYTICS_NODE_PATH:string;
export const ANALYTICS_WAL_MAX_BYTES:number;
export function assertSafeSqliteVersion(version:string):void;
export function configureAnalyticsWriter(db:DatabaseSync):string;
export function validateWalMaxBytes(value:number):number;
