import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSigningPayload, verifyDeviceProof } from '../src/ble-binding-proof.js';

const identity = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = identity.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const ec = createECDH('prime256v1'); ec.generateKeys();
const input = {
  binding_protocol: 'ble-key-v1', sn: 'BJP00326070803800006', device_key_id: 'test-key-1',
  ble_session_id: '0123456789abcdef0123456789abcdef', ble_transcript_hash: 'ab'.repeat(32),
  pairing_nonce: Buffer.alloc(32, 3).toString('base64url'), credential_pk: ec.getPublicKey(undefined, 'compressed').toString('base64url'),
};
function signPayload(payload: string, key = identity.privateKey) {
  return sign('sha256', Buffer.from(payload, 'base64url'), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}
let passed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  await fn(); passed++; console.log(`PASS ${name}`);
}

await test('P1363 proof authenticates the exact bytes and rejects altered transcript', () => {
  const payload = buildSigningPayload('acct-20', input, 'test_challenge_123456789', Buffer.alloc(32, 4).toString('base64url'), 1793610120000);
  const lines = Buffer.from(payload, 'base64url').toString('utf8').split('\n');
  assert.equal(lines.length, 12);
  assert.deepEqual(lines, ['P003-BLE-BIND-V1', 'kidshub-ai.hahaxiong.cc', 'test_challenge_123456789', Buffer.alloc(32, 4).toString('base64url'), 'acct-20', 'BJP00326070803800006', 'test-key-1', '0123456789abcdef0123456789abcdef', 'ab'.repeat(32), input.credential_pk, input.pairing_nonce, '1793610120000']);
  assert.equal(verifyDeviceProof(publicKeyPem, payload, signPayload(payload)), true);
  const altered = Buffer.from(Buffer.from(payload, 'base64url').toString().replace('ab'.repeat(32), 'cd'.repeat(32))).toString('base64url');
  assert.equal(verifyDeviceProof(publicKeyPem, altered, signPayload(payload)), false);
});
await test('proof format rejects DER/padding and accepts the equivalent legal ECDSA s value', () => {
  const payload = buildSigningPayload('acct-20', input, 'format_challenge_123456', Buffer.alloc(32, 4).toString('base64url'), 1793610120000);
  const p1363 = Buffer.from(signPayload(payload), 'base64url');
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const alternativeS = (n - BigInt(`0x${p1363.subarray(32).toString('hex')}`)).toString(16).padStart(64, '0');
  const equivalent = Buffer.concat([p1363.subarray(0, 32), Buffer.from(alternativeS, 'hex')]).toString('base64url');
  assert.equal(verifyDeviceProof(publicKeyPem, payload, equivalent), true);
  const der = sign('sha256', Buffer.from(payload, 'base64url'), identity.privateKey).toString('base64url');
  assert.equal(verifyDeviceProof(publicKeyPem, payload, der), false);
  assert.equal(verifyDeviceProof(publicKeyPem, payload, `${p1363.toString('base64url')}=`), false);
  assert.equal(verifyDeviceProof(publicKeyPem, payload, Buffer.alloc(64).toString('base64url')), false);
});

// Store tests use real isolated SQLite and a real EC key. Nothing is written to production.
const { BleBindingStore, BleBindingError } = await import('../src/ble-binding-store.js');
const dir = mkdtempSync(join(tmpdir(), 'p003-ble-core-'));
const dbPath = join(dir, 'devices.db');
const inspect = new DatabaseSync(dbPath);
inspect.exec(`CREATE TABLE device_registry (sn TEXT PRIMARY KEY, status TEXT NOT NULL, parent_account_id TEXT, account_id TEXT, public_id TEXT, binding_policy TEXT NOT NULL DEFAULT 'legacy', binding_version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);`);
let now = 1793610000000;
const store = new BleBindingStore(dbPath, () => now);
function addDevice(sn = input.sn) { inspect.prepare("INSERT INTO device_registry (sn,status) VALUES (?,'active')").run(sn); }
function register(sn = input.sn) { return store.registerIdentityKey({ sn, keyId: 'test-key-1', publicKeyPem, enablePolicy: true }); }
function challenge(account = 'acct-20', values = input) { return store.createChallenge(account, values); }
function confirm(c: { challenge_id: string; signing_payload_b64url: string }, account = 'acct-20') { return store.confirm(account, c.challenge_id, signPayload(c.signing_payload_b64url)); }
function rejects(code: string, fn: () => unknown) {
  assert.throws(fn, (e: unknown) => e instanceof BleBindingError && e.error === code);
}
function owner() { return inspect.prepare('SELECT parent_account_id,binding_version FROM device_registry WHERE sn=?').get(input.sn) as any; }
addDevice();

await test('missing trusted key cannot create a challenge or change owner', () => {
  rejects('device_not_available', () => challenge()); assert.equal(owner().parent_account_id, null);
});
await test('explicit trusted key enrollment enables policy once and is idempotent', () => {
  register(); assert.equal(owner().binding_version, 1); register(); assert.equal(owner().binding_version, 1);
});
await test('reusing a public identity key for another SN is refused', () => {
  const sn = 'BJP00326070804800006'; addDevice(sn);
  rejects('identity_key_conflict', () => register(sn));
});
await test('malformed and untrusted challenge fields fail before writing', () => {
  for (const bad of [{ ...input, pairing_nonce: `${input.pairing_nonce}=` }, { ...input, credential_pk: 'not-a-point' }, { ...input, device_key_id: 'key\ninject' }, { ...input, sn: input.sn.toLowerCase() }, { ...input, account_id: 'acct-27' }, { ...input, binding_protocol: 'trial' }]) {
    rejects('bad_request', () => challenge('acct-20', bad as any));
  }
  assert.equal(owner().parent_account_id, null);
});
const first = challenge();
await test('cross-account proof and wrong key proof are rejected without ownership', () => {
  rejects('binding_not_found', () => confirm(first, 'acct-27'));
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  rejects('device_proof_invalid', () => store.confirm('acct-20', first.challenge_id, signPayload(first.signing_payload_b64url, other.privateKey)));
  assert.equal(owner().parent_account_id, null);
});
let receipt: any;
await test('valid proof binds before any Wi-Fi or claim and reserves stable public id', () => {
  receipt = confirm(first); assert.equal(receipt.already_bound, false); assert.equal(owner().parent_account_id, 'acct-20');
  assert.equal(receipt.binding_version, 2); assert.match(receipt.public_id, /^dev_[0-9a-f]{16}$/); assert.equal(receipt.claimed_at_ms, null);
});
await test('Brain failure retains bound ownership and can be retried under the owner lock', () => {
  assert.throws(() => store.ensureBrain('acct-20', receipt.binding_id, () => { throw new Error('profile temporarily unavailable'); }), /profile temporarily unavailable/);
  assert.equal(owner().parent_account_id, 'acct-20');
  assert.equal(store.getBinding('acct-20', receipt.binding_id).brain_state, 'initializing');
  const ready = store.ensureBrain('acct-20', receipt.binding_id, r => {
    assert.equal(r.brain_account_id, null); return `device-${r.sn}`;
  });
  assert.equal(ready.brain_state, 'ready');
  assert.equal((inspect.prepare('SELECT account_id FROM device_registry WHERE sn=?').get(input.sn) as any).account_id, `device-${input.sn}`);
});
await test('confirm replay returns same receipt and still verifies its signature', () => {
  const repeat = confirm(first); assert.equal(repeat.binding_id, receipt.binding_id); assert.equal(repeat.already_bound, true);
  assert.equal(owner().binding_version, 2);
  rejects('device_proof_invalid', () => store.confirm('acct-20', first.challenge_id, Buffer.alloc(64).toString('base64url')));
});
await test('B cannot steal or read A binding, even with valid device identity', () => {
  rejects('device_already_bound', () => challenge('acct-27'));
  rejects('binding_not_found', () => store.getBinding('acct-27', receipt.binding_id));
});
await test('Wi-Fi/claim timeout retains owner while preventing stale issuance', () => {
  now += 600001;
  rejects('claim_expired', () => store.claim(input.sn, input.pairing_nonce, () => 'credential'));
  assert.equal(store.getBinding('acct-20', receipt.binding_id).account_id, 'acct-20');
  assert.equal(owner().parent_account_id, 'acct-20');
  assert.equal(confirm(first).binding_id, receipt.binding_id);
});
const secondInput = { ...input, pairing_nonce: randomBytes(32).toString('base64url') };
const second = challenge('acct-20', secondInput);
let recovered: any;
await test('same owner new proof revokes old claim receipt, retains owner/version/public id', () => {
  recovered = confirm(second); assert.equal(recovered.binding_version, 2); assert.equal(recovered.public_id, receipt.public_id); assert.equal(recovered.already_bound, true);
  rejects('binding_changed', () => store.claim(input.sn, input.pairing_nonce, () => 'credential'));
  rejects('binding_changed', () => confirm(first));
});
await test('issuance failure rolls back claimed timestamp and has no ownership effect', () => {
  assert.throws(() => store.claim(input.sn, secondInput.pairing_nonce, () => { throw new Error('signer unavailable'); }), /signer unavailable/);
  assert.equal(store.getBinding('acct-20', recovered.binding_id).claimed_at_ms, null);
});
let issuedAt: number;
await test('first claim and response-loss recovery do not extend idempotence window', () => {
  issuedAt = now;
  const firstClaim = store.claim(input.sn, secondInput.pairing_nonce, r => ({ version: r.binding_version, retry: r.idempotent }));
  assert.deepEqual(firstClaim, { version: 2, retry: false });
  now += 600000;
  const next = store.claim(input.sn, secondInput.pairing_nonce, r => r.idempotent); assert.equal(next, true);
  assert.equal(store.getBinding('acct-20', recovered.binding_id).claimed_at_ms, issuedAt);
  now += 300001;
  rejects('claim_expired', () => store.claim(input.sn, secondInput.pairing_nonce, () => 'credential'));
});
await test('activation only marks matching active owner version after claim', () => {
  store.markActivated(input.sn, 1); assert.equal(store.getBinding('acct-20', recovered.binding_id).activated_at_ms, null);
  store.markActivated(input.sn, 2); assert.equal(store.getBinding('acct-20', recovered.binding_id).activated_at_ms, now);
});
await test('an expired unused challenge cannot bind', () => {
  const c = challenge('acct-20', { ...input, pairing_nonce: randomBytes(32).toString('base64url') });
  now += 120001; rejects('challenge_expired', () => confirm(c));
});
await test('owner changes block old claim before its recovery branch and block Brain mutation', () => {
  inspect.prepare('UPDATE device_registry SET parent_account_id=?,binding_version=binding_version+1 WHERE sn=?').run('acct-27', input.sn);
  rejects('binding_changed', () => store.claim(input.sn, secondInput.pairing_nonce, () => 'credential'));
  rejects('binding_changed', () => store.setBrainState(recovered.binding_id, 'ready'));
  rejects('binding_not_found', () => store.getBinding('acct-20', recovered.binding_id));
  let ran = false;
  rejects('binding_not_found', () => store.ensureBrain('acct-20', recovered.binding_id, () => { ran = true; return `device-${input.sn}`; }));
  assert.equal(ran, false);
});
await test('identity revocation advances version and invalidates all proofs', () => {
  const oldVersion = owner().binding_version;
  store.revokeIdentityKey(input.sn, 'test-key-1'); assert.equal(owner().binding_version, oldVersion + 1);
  rejects('device_not_available', () => challenge('acct-27'));
});
await test('two pre-issued challenges cannot double-consume the same nonce', () => {
  const sn = 'BJP00326070804800006';
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  store.registerIdentityKey({ sn, keyId: 'other-key', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), enablePolicy: true });
  // Same owner before either challenge, so no owner version change masks nonce reuse.
  inspect.prepare('UPDATE device_registry SET parent_account_id=? WHERE sn=?').run('acct-20', sn);
  const value = { ...input, sn, device_key_id: 'other-key', pairing_nonce: randomBytes(32).toString('base64url') };
  const c1 = challenge('acct-20', value); const c2 = challenge('acct-20', value);
  store.confirm('acct-20', c1.challenge_id, signPayload(c1.signing_payload_b64url, pair.privateKey));
  rejects('binding_changed', () => store.confirm('acct-20', c2.challenge_id, signPayload(c2.signing_payload_b64url, pair.privateKey)));
});
await test('deleting a device revokes the trusted identity and receipts before reenrollment', () => {
  const sn = 'BJP00326070804800006';
  inspect.prepare('DELETE FROM device_registry WHERE sn=?').run(sn);
  assert.equal((inspect.prepare('SELECT status FROM device_identity_key WHERE sn=?').get(sn) as any).status, 'revoked');
  assert.ok((inspect.prepare('SELECT revoked_at_ms FROM ble_binding_receipt WHERE sn=?').get(sn) as any).revoked_at_ms);
  addDevice(sn);
  rejects('device_not_available', () => challenge('acct-20', { ...input, sn, device_key_id: 'other-key', pairing_nonce: randomBytes(32).toString('base64url') }));
});
await test('A/B challenges issued while unowned still allow only one winner', () => {
  const sn = 'BJP00326070805800006'; addDevice(sn);
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  store.registerIdentityKey({ sn, keyId: 'race-key', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), enablePolicy: true });
  const a = challenge('acct-20', { ...input, sn, device_key_id: 'race-key', pairing_nonce: randomBytes(32).toString('base64url') });
  const b = challenge('acct-27', { ...input, sn, device_key_id: 'race-key', pairing_nonce: randomBytes(32).toString('base64url') });
  const secondHandle = new BleBindingStore(dbPath, () => now);
  store.confirm('acct-20', a.challenge_id, signPayload(a.signing_payload_b64url, pair.privateKey));
  rejects('device_already_bound', () => secondHandle.confirm('acct-27', b.challenge_id, signPayload(b.signing_payload_b64url, pair.privateKey)));
  assert.equal((inspect.prepare('SELECT parent_account_id FROM device_registry WHERE sn=?').get(sn) as any).parent_account_id, 'acct-20');
});
await test('operator CLI default is read-only and refuses private keys/ambiguous arguments', async () => {
  const { registerDeviceIdentity } = await import('./register-device-identity.js');
  const previous = process.env.DEVICES_DB_PATH; process.env.DEVICES_DB_PATH = dbPath;
  try {
    const file = join(dir, 'public.pem'); writeFileSync(file, publicKeyPem);
    const before = JSON.stringify(inspect.prepare('SELECT * FROM device_registry ORDER BY sn').all());
    const result = await registerDeviceIdentity(['--sn', input.sn, '--key-id', 'new-test-key', '--public-key', file, '--enable-policy']);
    assert.equal(result.dry_run, true); assert.equal(result.enable_policy, true);
    assert.equal(JSON.stringify(inspect.prepare('SELECT * FROM device_registry ORDER BY sn').all()), before);
    await assert.rejects(() => registerDeviceIdentity(['--sn', input.sn, '--sn', input.sn]), (e: any) => e.error === 'bad_arguments');
    const privateFile = join(dir, 'test-only-private.pem');
    writeFileSync(privateFile, identity.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await assert.rejects(() => registerDeviceIdentity(['--sn', input.sn, '--key-id', 'new-key', '--public-key', privateFile]), (e: any) => e.error === 'invalid_identity_public_key');
  } finally {
    if (previous === undefined) delete process.env.DEVICES_DB_PATH; else process.env.DEVICES_DB_PATH = previous;
  }
});
await test('profile sync filters active current owner and locks each canonical Brain mapping', () => {
  const entries = [
    ['BJP00326070806800006', 'acct-20', 'active', 'device-BJP00326070806800006'],
    ['BJP00326070807800006', 'acct-20', 'active', 'device-BJP00326070807800006'],
    ['BJP00326070808800006', 'acct-27', 'active', 'device-BJP00326070808800006'],
    ['BJP00326070809800006', 'acct-20', 'disabled', 'device-BJP00326070809800006'],
  ];
  for (const [sn, ownerId, status, brain] of entries) {
    addDevice(sn); inspect.prepare('UPDATE device_registry SET parent_account_id=?,status=?,account_id=? WHERE sn=?').run(ownerId, status, brain, sn);
  }
  const profileDb = new DatabaseSync(join(dir, 'profile-sync.db'));
  profileDb.exec('CREATE TABLE profile(account_id TEXT PRIMARY KEY, nickname TEXT NOT NULL)');
  inspect.exec('PRAGMA busy_timeout=0');
  const count = store.syncOwnedProfiles('acct-20', brainId => {
    assert.throws(() => inspect.prepare('UPDATE device_registry SET parent_account_id=? WHERE sn=?').run('acct-27', entries[0][0]), /locked/);
    profileDb.prepare('INSERT INTO profile(account_id,nickname) VALUES (?,?)').run(brainId, '新昵称');
  });
  assert.equal(count, 2);
  assert.deepEqual(profileDb.prepare('SELECT account_id,nickname FROM profile ORDER BY account_id').all().map(r => ({ ...r })), [
    { account_id: 'device-BJP00326070806800006', nickname: '新昵称' },
    { account_id: 'device-BJP00326070807800006', nickname: '新昵称' },
  ]);
  profileDb.close();
});
await test('profile sync validates every Brain mapping before any cross-database write', () => {
  const brokenSn = 'BJP00326070807800006';
  for (const badBrain of ['acct-27', 'device-BJP00326070806800006']) {
    inspect.prepare('UPDATE device_registry SET account_id=? WHERE sn=?').run(badBrain, brokenSn);
    let writes = 0;
    assert.throws(() => store.syncOwnedProfiles('acct-20', () => { writes++; }), /invalid device Brain mapping/);
    assert.equal(writes, 0);
  }
  inspect.prepare('UPDATE device_registry SET account_id=? WHERE sn=?').run(`device-${brokenSn}`, brokenSn);
});
await test('profile sync rejects async callbacks and releases the lock on callback failure', () => {
  let asyncRan = false;
  assert.throws(() => store.syncOwnedProfiles('acct-20', async () => { asyncRan = true; }), /synchronous/);
  assert.equal(asyncRan, false);
  assert.throws(() => store.syncOwnedProfiles('acct-20', () => Promise.resolve()), /synchronous/);
  assert.throws(() => store.syncOwnedProfiles('acct-20', () => { throw new Error('profile write failed'); }), /profile write failed/);
  let count = 0; assert.equal(store.syncOwnedProfiles('acct-20', () => { count++; }), 2); assert.equal(count, 2);
  rejects('unauthorized', () => store.syncOwnedProfiles('', () => {}));
});
console.log(`BLE core: ${passed} passed`);
