/** Real SQLite/JWT policy tests; no production paths or credential output. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';
import { generateKeyPairSync, createECDH, randomBytes, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const temporary = mkdtempSync(join(tmpdir(), 'p003-ble-guards-'));
process.env.DEVICES_DB_PATH = join(temporary, 'devices.db');
const sourceRoot = process.env.GUARDS_TEST_SOURCE_ROOT || resolve(import.meta.dirname, '../src');
const isolatedImportDb = join(temporary, 'must-not-create-on-import.db');
const importCheck = spawnSync(process.execPath, ['--experimental-sqlite', '--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
  `import {existsSync} from 'node:fs'; await import(${JSON.stringify(pathToFileURL(join(sourceRoot, 'device-credential.ts')).href)}); if(existsSync(process.env.DEVICES_DB_PATH))process.exit(73);`],
  { env: { ...process.env, DEVICES_DB_PATH: isolatedImportDb }, encoding: 'utf8' });
assert.equal(importCheck.status, 0, 'importing shared JWT verifier must not open/create a writable devices database');
const { deviceRegistryStore: registry } = await import(pathToFileURL(join(sourceRoot, 'device-registry-store.ts')).href);
let passed = 0;
const check = async (name: string, run: () => void | Promise<void>) => {
  await run(); passed += 1; console.log(`ok ${name}`);
};
const SN = 'BJP00326070803800901';
const LEGACY = 'BJP00326070803800902';
const REMOVED = 'BJP00326070803800903';
await check('migration keeps existing device behavior legacy by default', () => {
  registry.add(SN, 'guard-test');
  assert.equal(registry.get(SN).binding_policy, 'legacy');
  assert.equal(registry.get(SN).binding_version, 0);
});
await check('null-to-owner increments version, same owner retry does not', () => {
  assert.equal(registry.setParentAccountId(SN, 'acct-A'), true);
  assert.equal(registry.get(SN).binding_version, 1);
  registry.setParentAccountId(SN, 'acct-A');
  assert.equal(registry.get(SN).binding_version, 1);
});
await check('transfer and unbind each invalidate the prior owner version', () => {
  registry.setParentAccountId(SN, 'acct-B');
  assert.equal(registry.get(SN).binding_version, 2);
  registry.setParentAccountId(SN, null);
  assert.equal(registry.get(SN).binding_version, 3);
  registry.setParentAccountId(SN, null);
  assert.equal(registry.get(SN).binding_version, 3);
  registry.setParentAccountId(SN, 'acct-A');
  assert.equal(registry.get(SN).binding_version, 4);
});

const db = new DatabaseSync(process.env.DEVICES_DB_PATH);
db.prepare("UPDATE device_registry SET binding_policy='ble-key-v1',binding_version=binding_version+1 WHERE sn=?").run(SN);
const { verifyDeviceCredential } = await import(pathToFileURL(join(sourceRoot, 'device-credential.ts')).href);
const { isDeviceCredentialBindingAllowed } = await import(pathToFileURL(join(sourceRoot, 'ble-binding-policy.ts')).href);
const secret = 'synthetic-local-guard-secret-never-production';
const key = new TextEncoder().encode(secret);
async function credential(sn: string, version?: unknown, timed = true) {
  let builder = new SignJWT({ kind: 'p003-device', ...(version === undefined ? {} : { binding_version: version }) })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(sn);
  if (timed) builder = builder.setIssuedAt().setExpirationTime('1h');
  return `Bearer ${await builder.sign(key)}`;
}
await check('server policy is derived from trusted registry rather than token selection', () => {
  assert.equal(registry.isBleBindingRequired(SN), true);
  assert.equal(registry.isBleBindingRequired(LEGACY), false);
  const state = registry.credentialBindingState(SN);
  assert.equal(isDeviceCredentialBindingAllowed(state, 5), true);
  assert.equal(isDeviceCredentialBindingAllowed(state, 4), false);
});
await check('BLE credential accepts exact version and returns only verified identity', async () => {
  assert.deepEqual(await verifyDeviceCredential(await credential(SN, 5), secret), { sn: SN, bindingVersion: 5 });
});
await check('missing, stale, malformed version cannot pass even permissive caller callback', async () => {
  for (const v of [undefined, 4, '5', -1, 0, 5.5, null]) {
    assert.equal(await verifyDeviceCredential(await credential(SN, v), secret, () => true), null);
  }
});
await check('BLE credentials require issued-at and expiry unlike legacy compatibility tokens', async () => {
  assert.equal(await verifyDeviceCredential(await credential(SN, 5, false), secret), null);
});
await check('disabled or unowned BLE device is rejected', async () => {
  const valid = await credential(SN, 5);
  registry.setStatus(SN, 'disabled');
  assert.equal(await verifyDeviceCredential(valid, secret), null);
  registry.setStatus(SN, 'active');
  registry.setParentAccountId(SN, null);
  assert.equal(await verifyDeviceCredential(await credential(SN, 6), secret), null);
  registry.setParentAccountId(SN, 'acct-A');
});
await check('old BLE credentials do not survive transfer even within the same second', async () => {
  const old = await credential(SN, 7);
  registry.setParentAccountId(SN, 'acct-B');
  assert.equal(await verifyDeviceCredential(old, secret), null);
  assert.deepEqual(await verifyDeviceCredential(await credential(SN, 8), secret), { sn: SN, bindingVersion: 8 });
});
await check('legacy records and unknown env-allowlist identities retain credential compatibility', async () => {
  registry.add(LEGACY, 'legacy-test');
  assert.deepEqual(await verifyDeviceCredential(await credential(LEGACY, undefined, false), secret), { sn: LEGACY });
  assert.deepEqual(await verifyDeviceCredential(await credential('BJP00326070803800999', undefined, false), secret), { sn: 'BJP00326070803800999' });
});
await check('revocation still rejects credentials when callers omit custom callback', async () => {
  const old = await credential(LEGACY);
  registry.revokeCredentials(LEGACY, 'guard-test', 'synthetic-local-test');
  assert.equal(await verifyDeviceCredential(old, secret), null);
});
await check('deleted BLE device cannot fall back to legacy env authorization or reset on re-add', async () => {
  registry.add(REMOVED, 'delete-test');
  db.prepare("UPDATE device_registry SET binding_policy='ble-key-v1',binding_version=10,parent_account_id='acct-A' WHERE sn=?").run(REMOVED);
  const old = await credential(REMOVED, 10);
  registry.remove(REMOVED);
  assert.equal(registry.isBleBindingRequired(REMOVED), true);
  assert.equal(await verifyDeviceCredential(old, secret), null);
  registry.add(REMOVED, 're-add-test');
  assert.equal(registry.get(REMOVED).binding_policy, 'ble-key-v1');
  assert.ok(registry.get(REMOVED).binding_version > 10);
  registry.setParentAccountId(REMOVED, 'acct-A');
  assert.equal(await verifyDeviceCredential(old, secret), null);
  assert.equal(await verifyDeviceCredential(await credential(REMOVED), secret), null);
});
await check('unknown server-side policy fails closed rather than silently downgrading', async () => {
  db.prepare("UPDATE device_registry SET binding_policy='future-unsupported' WHERE sn=?").run(SN);
  assert.equal(await verifyDeviceCredential(await credential(SN, 8), secret), null);
});
await check('signature failure and caller-level denial remain rejected', async () => {
  assert.equal(await verifyDeviceCredential(await credential(SN, 8), 'wrong-secret'), null);
  assert.equal(await verifyDeviceCredential(await credential('BJP00326070803800999'), secret, () => false), null);
});
await check('owner mutation during an asynchronous callback cannot pass the old credential', async () => {
  db.prepare("UPDATE device_registry SET binding_policy='ble-key-v1' WHERE sn=?").run(SN);
  const before = registry.get(SN).binding_version;
  const old = await credential(SN, before);
  assert.equal(await verifyDeviceCredential(old, secret, async () => {
    registry.setParentAccountId(SN, 'acct-C');
    return true;
  }), null);
});
await check('raw SQL owner changes advance version without double-incrementing an explicit CAS', () => {
  const before = registry.get(SN).binding_version;
  db.prepare("UPDATE device_registry SET parent_account_id='acct-D' WHERE sn=?").run(SN);
  assert.equal(registry.get(SN).binding_version, before + 1);
  db.prepare("UPDATE device_registry SET parent_account_id='acct-E',binding_version=binding_version+1 WHERE sn=?").run(SN);
  assert.equal(registry.get(SN).binding_version, before + 2);
});
await check('actual BLE core transactions and delete-key triggers share the registry generation correctly', async () => {
  const { BleBindingStore } = await import(pathToFileURL(join(sourceRoot, 'ble-binding-store.ts')).href);
  const core = new BleBindingStore(process.env.DEVICES_DB_PATH);
  const sn = 'BJP00326070803800904';
  registry.add(sn, 'core-interoperability');
  const identity = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  core.registerIdentityKey({ sn, keyId: 'test-device-key', publicKeyPem: identity.publicKey.export({ type: 'spki', format: 'pem' }).toString(), enablePolicy: true });
  assert.equal(registry.get(sn).binding_version, 1);
  const claimKey = createECDH('prime256v1'); claimKey.generateKeys();
  const input = { binding_protocol: 'ble-key-v1', sn, device_key_id: 'test-device-key', ble_session_id: 'a'.repeat(32), ble_transcript_hash: 'b'.repeat(64), pairing_nonce: randomBytes(32).toString('base64url'), credential_pk: claimKey.getPublicKey(null, 'compressed').toString('base64url') };
  const challenge = core.createChallenge('acct-A', input);
  const signature = sign('sha256', Buffer.from(challenge.signing_payload_b64url, 'base64url'), { key: identity.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const result = core.confirm('acct-A', challenge.challenge_id, signature);
  assert.equal(result.binding_version, 2);
  assert.equal(registry.get(sn).binding_version, 2);
  registry.remove(sn);
  assert.equal((db.prepare('SELECT status FROM device_identity_key WHERE sn=?').get(sn) as { status: string }).status, 'revoked');
  registry.add(sn, 're-added');
  assert.equal(registry.get(sn).binding_policy, 'ble-key-v1');
  assert.equal(registry.get(sn).binding_version, 3);
  assert.throws(() => core.createChallenge('acct-A', { ...input, pairing_nonce: randomBytes(32).toString('base64url') }));
});
await check('analytics-style read-only state reader enforces its own database instead of main-service fallback', async () => {
  const file = join(temporary, 'read-only-policy.db');
  const fixture = new DatabaseSync(file);
  fixture.exec("CREATE TABLE policy(sn TEXT PRIMARY KEY,binding_policy TEXT,binding_version INTEGER,status TEXT,parent_account_id TEXT); INSERT INTO policy VALUES('BJP00326070803800905','ble-key-v1',11,'active','acct-A')");
  fixture.close();
  const reader = (sn: string) => {
    const readonly = new DatabaseSync(file, { readOnly: true });
    try { return { binding: readonly.prepare('SELECT binding_policy,binding_version,status,parent_account_id FROM policy WHERE sn=?').get(sn) ?? null, revokedThroughSec: null }; }
    finally { readonly.close(); }
  };
  const sn = 'BJP00326070803800905';
  assert.equal(await verifyDeviceCredential(await credential(sn), secret, () => true, reader), null);
  assert.equal(await verifyDeviceCredential(await credential(sn, 10), secret, () => true, reader), null);
  assert.deepEqual(await verifyDeviceCredential(await credential(sn, 11), secret, () => true, reader), { sn, bindingVersion: 11 });
});
await check('database errors are propagated instead of bypassing binding checks', async () => {
  db.exec('DROP TABLE device_binding_state');
  await assert.rejects(() => verifyDeviceCredentialFromUnknown());
  async function verifyDeviceCredentialFromUnknown() {
    return verifyDeviceCredential(await credential('BJP00326070803800998'), secret, () => true);
  }
});
db.close();
console.log(`BLE binding guards ${passed}/${passed} passed; no credential output`);
