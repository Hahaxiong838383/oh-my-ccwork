/** Real read-only devices.db reader + real analytics HTTP/JWT tests; no network or production writes. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';

const temp = mkdtempSync(join(tmpdir(), 'analytics-ble-policy-'));
const devicesPath = join(temp, 'readonly-devices.db'), configPath = join(temp, 'readonly-config.db');
const trap = join(temp, 'do-not-create-main-devices.db');
process.env.DEVICES_DB_PATH = trap;
const source = process.env.ANALYTICS_BLE_TEST_SOURCE_ROOT || resolve(import.meta.dirname, '../src');
const { AnalyticsDeviceReader } = await import(pathToFileURL(join(source, 'analytics/device-context.ts')).href);
const { createAnalyticsApp } = await import(pathToFileURL(join(source, 'analytics/index.ts')).href);
const { AnalyticsStore } = await import(pathToFileURL(join(source, 'analytics/store.ts')).href);
assert.equal(existsSync(trap), false, 'importing analytics must not initialize the main writable registry');

const sn = 'BJP00326070803800906', legacy = 'BJP00326070803800907';
const db = new DatabaseSync(devicesPath);
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE device_registry(sn TEXT PRIMARY KEY,status TEXT,parent_account_id TEXT,binding_policy TEXT,binding_version INTEGER);
  CREATE TABLE device_binding_state(sn TEXT PRIMARY KEY,binding_policy TEXT,binding_version INTEGER);
  CREATE TABLE device_credential_revocation(sn TEXT PRIMARY KEY,not_before_sec INTEGER);
  INSERT INTO device_registry VALUES('${sn}','active','acct-A','ble-key-v1',11),('${legacy}','active',NULL,'legacy',0);
  INSERT INTO device_binding_state SELECT sn,binding_policy,binding_version FROM device_registry;`);
const config = new DatabaseSync(configPath);
config.exec(`CREATE TABLE runtime_flag(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE device_config(scope TEXT,key TEXT,value_json TEXT);
  INSERT INTO device_config VALUES('(global)','analytics.event_upload_enabled','true');`);
config.close();
const reader = new AnalyticsDeviceReader({ devicesPath, configPath, deviceKeySecret: 'only-local-synthetic-key', envAllow: [sn, legacy] });
assert.equal(typeof reader.readCredentialState, 'function', 'analytics must supply its explicit read-only version-policy reader');
assert.equal(reader.readiness(), true);
assert.deepEqual(reader.readCredentialState(sn), {
  binding: { binding_policy: 'ble-key-v1', binding_version: 11, status: 'active', parent_account_id: 'acct-A' }, revokedThroughSec: null,
});
const controlPath = join(temp, 'control.json'); writeFileSync(controlPath, '{"enabled":true}', { mode: 0o600 });
const store = new AnalyticsStore(join(temp, 'analytics.db'));
const secret = 'synthetic-analytics-ble-test-key';
const app = createAnalyticsApp({ store, reader, authSecret: secret, internalSecret: 'synthetic-internal-key', controlPath,
  allowSubjects: [sn, legacy], diskFreeBytes: () => 20 * 1024 ** 3 });
const token = async (subject = sn, version?: number) => new SignJWT({ kind: 'p003-device', ...(version === undefined ? {} : { binding_version: version }) })
  .setSubject(subject).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
let id = 0;
const post = async (credential: string) => app.request('/v1/device/analytics/events:batch', {
  method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'X-Request-Id': `policy-${++id}` },
  body: JSON.stringify({ schema_version: 1, batch_id: `policy-${id}`, sent_at_ms: Date.now(), client: {}, events: [{
    schema_version: 1, client_event_id: `policy-event-${id}`, event_name: 'app.bridge_ready', occurred_at_ms: Date.now(),
    session_id: 'synthetic-session', sequence: id, priority: 'normal', context: {}, properties: {},
  }] }),
});
assert.equal((await post(await token())).status, 401, 'missing version cannot bypass analytics through the legacy callback');
assert.equal((await post(await token(sn, 10))).status, 401, 'stale version must fail');
assert.equal((await post(await token(sn, 11))).status, 200, 'current signed credential reaches actual ingest');
assert.equal((await post(await token(legacy))).status, 200, 'legacy device remains compatible');
assert.equal(existsSync(trap), false, 'requests must use only the supplied read-only dependency file');
const old = await token(sn, 11);
db.prepare("UPDATE device_registry SET parent_account_id='acct-B',binding_version=12 WHERE sn=?").run(sn);
db.prepare('UPDATE device_binding_state SET binding_version=12 WHERE sn=?').run(sn);
assert.equal((await post(old)).status, 401, 'live WAL ownership updates invalidate old credentials without a sidecar restart');
assert.equal((await post(await token(sn, 12))).status, 200);
db.prepare('DELETE FROM device_registry WHERE sn=?').run(sn);
assert.equal(reader.readCredentialState(sn).binding?.status, 'disabled', 'deleted BLE identity remains a policy tombstone');
assert.equal((await post(await token(sn, 12))).status, 401, 'deleted device cannot use env allowlist fallback');
db.exec('DROP TABLE device_binding_state');
assert.equal((await app.request('/ready')).status, 503, 'missing policy schema is an unavailable dependency');
assert.equal((await post(await token(legacy))).status, 503, 'schema error never silently downgrades policy');
assert.equal(existsSync(trap), false);
db.close(); store.close();
console.log('analytics BLE auth: PASS (read-only isolation, real ingestion, version/owner/revocation schema fail closed)');
