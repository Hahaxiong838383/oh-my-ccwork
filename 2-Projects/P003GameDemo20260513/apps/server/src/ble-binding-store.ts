import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BLE_BINDING_PROTOCOL, BLE_SIGNATURE_ALGORITHM, BleBindingError, buildSigningPayload,
  normalizeIdentityPublicKey, parseBleChallengeInput, validBleId, verifyDeviceProof,
} from './ble-binding-proof.js';
import { fromB64url } from './pairing-crypto.js';
import { validateDeviceSn } from './device-sn.js';
export { BleBindingError } from './ble-binding-proof.js';

const CHALLENGE_TTL_MS = 120_000;
const CLAIM_TTL_MS = 600_000;
const CLAIM_RECOVERY_MS = 900_000;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
type Device = { sn: string; status: string; parent_account_id: string | null; public_id: string | null; binding_policy: string; binding_version: number };
type IdentityKey = { sn: string; key_id: string; public_key_pem: string; fingerprint: string; status: string };
type Challenge = {
  challenge_id: string; account_id: string; sn: string; device_key_id: string; signing_payload_b64url: string;
  nonce_hash: string; credential_pk: string; expected_version: number; expected_owner: string | null;
  created_at_ms: number; expires_at_ms: number; consumed_at_ms: number | null; binding_id: string | null; revoked_at_ms: number | null;
};
export type BleBindingRecord = {
  binding_id: string; challenge_id: string; sn: string; account_id: string; device_key_id: string;
  binding_version: number; nonce_hash: string; credential_pk: string; public_id: string;
  bound_at_ms: number; claim_expires_at_ms: number; claimed_at_ms: number | null; activated_at_ms: number | null;
  brain_state: 'ready' | 'initializing'; revoked_at_ms: number | null;
};

/** Same devices.db connection owns the compare-and-set and challenge consumption transaction. */
export class BleBindingStore {
  private readonly db: DatabaseSync;
  constructor(path = process.env.DEVICES_DB_PATH?.trim() || './data/devices.db', private readonly now: () => number = Date.now) {
    const dbPath = resolve(path); mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    // Registry migrations run first in the application; do not silently create a competing registry schema.
    const fields = this.db.prepare('PRAGMA table_info(device_registry)').all() as { name: string }[];
    if (!fields.some(f => f.name === 'binding_policy') || !fields.some(f => f.name === 'binding_version')) {
      throw new Error('BLE binding requires device registry migrations');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_identity_key (
        sn TEXT NOT NULL, key_id TEXT NOT NULL, public_key_pem TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('active','revoked')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(sn,key_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ble_active_identity ON device_identity_key(sn) WHERE status='active';
      CREATE TABLE IF NOT EXISTS ble_binding_challenge (
        challenge_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, sn TEXT NOT NULL, device_key_id TEXT NOT NULL,
        signing_payload_b64url TEXT NOT NULL, nonce_hash TEXT NOT NULL, credential_pk TEXT NOT NULL,
        expected_version INTEGER NOT NULL, expected_owner TEXT,
        created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, consumed_at_ms INTEGER,
        binding_id TEXT, revoked_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ble_challenge_expiry ON ble_binding_challenge(expires_at_ms);
      CREATE TABLE IF NOT EXISTS ble_binding_receipt (
        binding_id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL UNIQUE,
        sn TEXT NOT NULL, account_id TEXT NOT NULL, device_key_id TEXT NOT NULL,
        binding_version INTEGER NOT NULL, nonce_hash TEXT NOT NULL UNIQUE, credential_pk TEXT NOT NULL,
        public_id TEXT NOT NULL, bound_at_ms INTEGER NOT NULL, claim_expires_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER, activated_at_ms INTEGER,
        brain_state TEXT NOT NULL DEFAULT 'initializing', revoked_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ble_receipt_sn ON ble_binding_receipt(sn);
      CREATE TRIGGER IF NOT EXISTS ble_identity_revoke_on_device_delete AFTER DELETE ON device_registry
      BEGIN
        UPDATE device_identity_key SET status='revoked',updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE sn=OLD.sn;
        UPDATE ble_binding_receipt SET revoked_at_ms=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE sn=OLD.sn AND revoked_at_ms IS NULL;
        UPDATE ble_binding_challenge SET revoked_at_ms=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE sn=OLD.sn AND revoked_at_ms IS NULL;
      END;
    `);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private device(sn: string): Device | null {
    return this.db.prepare('SELECT sn,status,parent_account_id,public_id,binding_policy,binding_version FROM device_registry WHERE sn=?').get(sn) as Device | undefined ?? null;
  }
  private key(sn: string, id: string): IdentityKey | null {
    return this.db.prepare('SELECT * FROM device_identity_key WHERE sn=? AND key_id=?').get(sn, id) as IdentityKey | undefined ?? null;
  }
  private receipt(id: string): BleBindingRecord | null {
    return this.db.prepare('SELECT * FROM ble_binding_receipt WHERE binding_id=?').get(id) as BleBindingRecord | undefined ?? null;
  }
  private assertCurrent(row: BleBindingRecord): void {
    const device = this.device(row.sn); const key = this.key(row.sn, row.device_key_id);
    if (row.revoked_at_ms !== null || !device || device.status !== 'active' || device.binding_policy !== BLE_BINDING_PROTOCOL ||
        device.parent_account_id !== row.account_id || device.binding_version !== row.binding_version || key?.status !== 'active') {
      throw new BleBindingError(409, 'binding_changed');
    }
  }
  registerIdentityKey(input: { sn: string; keyId: string; publicKeyPem: string; enablePolicy: boolean }) {
    if (!validateDeviceSn(input.sn).ok || !validBleId(input.keyId)) throw new BleBindingError(400, 'bad_request');
    const publicKey = normalizeIdentityPublicKey(input.publicKeyPem);
    return this.transaction(() => {
      const device = this.device(input.sn);
      if (!device || device.status !== 'active') throw new BleBindingError(404, 'device_not_available');
      const current = this.key(input.sn, input.keyId);
      const sameFingerprint = this.db.prepare('SELECT sn,key_id FROM device_identity_key WHERE fingerprint=?').get(publicKey.fingerprint) as { sn: string; key_id: string } | undefined;
      const active = this.db.prepare("SELECT key_id FROM device_identity_key WHERE sn=? AND status='active'").get(input.sn) as { key_id: string } | undefined;
      if ((current && (current.fingerprint !== publicKey.fingerprint || current.status !== 'active')) ||
          (sameFingerprint && (sameFingerprint.sn !== input.sn || sameFingerprint.key_id !== input.keyId)) ||
          (active && active.key_id !== input.keyId)) throw new BleBindingError(409, 'identity_key_conflict');
      if (!current) this.db.prepare('INSERT INTO device_identity_key(sn,key_id,public_key_pem,fingerprint,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.sn, input.keyId, publicKey.pem, publicKey.fingerprint, 'active', this.now(), this.now());
      if (input.enablePolicy && device.binding_policy !== BLE_BINDING_PROTOCOL) {
        this.db.prepare('UPDATE device_registry SET binding_policy=?,binding_version=binding_version+1,updated_at=? WHERE sn=?')
          .run(BLE_BINDING_PROTOCOL, this.now(), input.sn);
        this.invalidateSn(input.sn);
      }
      const updated = this.device(input.sn)!;
      return { sn: input.sn, device_key_id: input.keyId, fingerprint: publicKey.fingerprint, binding_policy: updated.binding_policy, binding_version: updated.binding_version };
    });
  }
  revokeIdentityKey(sn: string, keyId: string): void {
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE device_identity_key SET status='revoked',updated_at=? WHERE sn=? AND key_id=? AND status='active'").run(this.now(), sn, keyId).changes;
      if (changed) {
        this.db.prepare('UPDATE device_registry SET binding_version=binding_version+1,updated_at=? WHERE sn=?').run(this.now(), sn);
        this.invalidateSn(sn);
      }
    });
  }
  private invalidateSn(sn: string): void {
    this.db.prepare('UPDATE ble_binding_receipt SET revoked_at_ms=? WHERE sn=? AND revoked_at_ms IS NULL').run(this.now(), sn);
    this.db.prepare('UPDATE ble_binding_challenge SET revoked_at_ms=? WHERE sn=? AND revoked_at_ms IS NULL').run(this.now(), sn);
  }
  createChallenge(accountId: string, value: unknown) {
    if (!validBleId(accountId)) throw new BleBindingError(401, 'unauthorized');
    const input = parseBleChallengeInput(value);
    return this.transaction(() => {
      const device = this.device(input.sn); const key = this.key(input.sn, input.device_key_id);
      if (!device || device.status !== 'active' || device.binding_policy !== BLE_BINDING_PROTOCOL || key?.status !== 'active') throw new BleBindingError(404, 'device_not_available');
      if (device.parent_account_id && device.parent_account_id !== accountId) throw new BleBindingError(409, 'device_already_bound');
      // A nonce must not be reused after a completed proof, even with a different signing key/session.
      if (this.db.prepare('SELECT binding_id FROM ble_binding_receipt WHERE nonce_hash=?').get(hash(input.pairing_nonce))) throw new BleBindingError(409, 'binding_changed');
      const id = randomBytes(18).toString('base64url'); const expiresAt = this.now() + CHALLENGE_TTL_MS;
      const payload = buildSigningPayload(accountId, input, id, randomBytes(32).toString('base64url'), expiresAt);
      this.db.prepare('DELETE FROM ble_binding_challenge WHERE consumed_at_ms IS NULL AND expires_at_ms<?').run(this.now() - 86400000);
      this.db.prepare(`INSERT INTO ble_binding_challenge (challenge_id,account_id,sn,device_key_id,signing_payload_b64url,nonce_hash,credential_pk,expected_version,expected_owner,created_at_ms,expires_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, accountId, input.sn, input.device_key_id, payload, hash(input.pairing_nonce), input.credential_pk, device.binding_version, device.parent_account_id, this.now(), expiresAt);
      return { challenge_id: id, expires_in_s: CHALLENGE_TTL_MS / 1000, signing_payload_b64url: payload, signature_alg: BLE_SIGNATURE_ALGORITHM };
    });
  }
  confirm(accountId: string, challengeId: string, signature: string): BleBindingRecord & { already_bound: boolean } {
    if (!validBleId(accountId)) throw new BleBindingError(401, 'unauthorized');
    if (!validBleId(challengeId) || typeof signature !== 'string' || signature.length > 100) throw new BleBindingError(400, 'bad_request');
    return this.transaction(() => {
      const challenge = this.db.prepare('SELECT * FROM ble_binding_challenge WHERE challenge_id=? AND account_id=?').get(challengeId, accountId) as Challenge | undefined;
      if (!challenge) throw new BleBindingError(404, 'binding_not_found');
      const key = this.key(challenge.sn, challenge.device_key_id);
      if (key?.status !== 'active' || !verifyDeviceProof(key.public_key_pem, challenge.signing_payload_b64url, signature)) throw new BleBindingError(403, 'device_proof_invalid');
      if (challenge.revoked_at_ms !== null) throw new BleBindingError(409, 'binding_changed');
      if (challenge.binding_id) {
        const row = this.receipt(challenge.binding_id);
        if (!row) throw new BleBindingError(409, 'binding_changed');
        this.assertCurrent(row); return { ...row, already_bound: true };
      }
      if (this.now() >= challenge.expires_at_ms) throw new BleBindingError(410, 'challenge_expired');
      const device = this.device(challenge.sn);
      if (!device || device.status !== 'active' || device.binding_policy !== BLE_BINDING_PROTOCOL) throw new BleBindingError(404, 'device_not_available');
      if (device.parent_account_id && device.parent_account_id !== accountId) throw new BleBindingError(409, 'device_already_bound');
      if (device.binding_version !== challenge.expected_version || device.parent_account_id !== challenge.expected_owner) throw new BleBindingError(409, 'binding_changed');
      if (this.db.prepare('SELECT binding_id FROM ble_binding_receipt WHERE nonce_hash=?').get(challenge.nonce_hash)) throw new BleBindingError(409, 'binding_changed');
      const alreadyBound = device.parent_account_id === accountId;
      const publicId = device.public_id || `dev_${randomBytes(8).toString('hex')}`;
      const version = alreadyBound ? device.binding_version : device.binding_version + 1;
      const changed = this.db.prepare(`UPDATE device_registry SET parent_account_id=?,binding_version=?,public_id=?,updated_at=?
        WHERE sn=? AND binding_version=? AND parent_account_id IS ? AND status='active' AND binding_policy=?`)
        .run(accountId, version, publicId, this.now(), device.sn, challenge.expected_version, challenge.expected_owner, BLE_BINDING_PROTOCOL).changes;
      if (changed !== 1) throw new BleBindingError(409, 'binding_changed');
      const bindingId = randomBytes(18).toString('base64url'); const timestamp = this.now();
      this.db.prepare('UPDATE ble_binding_receipt SET revoked_at_ms=? WHERE sn=? AND revoked_at_ms IS NULL').run(timestamp, device.sn);
      this.db.prepare(`INSERT INTO ble_binding_receipt(binding_id,challenge_id,sn,account_id,device_key_id,binding_version,nonce_hash,credential_pk,public_id,bound_at_ms,claim_expires_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(bindingId, challengeId, device.sn, accountId, challenge.device_key_id, version, challenge.nonce_hash, challenge.credential_pk, publicId, timestamp, timestamp + CLAIM_TTL_MS);
      this.db.prepare('UPDATE ble_binding_challenge SET binding_id=?,consumed_at_ms=? WHERE challenge_id=?').run(bindingId, timestamp, challengeId);
      return { ...this.receipt(bindingId)!, already_bound: alreadyBound };
    });
  }
  getBinding(accountId: string, bindingId: string): BleBindingRecord {
    const row = this.receipt(bindingId);
    const device = row ? this.device(row.sn) : null;
    if (!row || row.account_id !== accountId || device?.parent_account_id !== accountId) throw new BleBindingError(404, 'binding_not_found');
    this.assertCurrent(row); return row;
  }
  /** Callback may only synchronously write accounts/profile DBs; this connection owns registry writes. */
  ensureBrain(accountId: string, bindingId: string, initialize: (record: BleBindingRecord & { brain_account_id: string | null }) => string): BleBindingRecord {
    return this.transaction(() => {
      const row = this.getBinding(accountId, bindingId);
      const device = this.db.prepare('SELECT account_id FROM device_registry WHERE sn=?').get(row.sn) as { account_id: string | null };
      const brainAccountId = initialize({ ...row, brain_account_id: device.account_id });
      if (brainAccountId !== `device-${row.sn}`) throw new Error('BLE Brain initializer must return matching device account synchronously');
      this.db.prepare('UPDATE device_registry SET account_id=?,updated_at=? WHERE sn=?').run(brainAccountId, this.now(), row.sn);
      this.db.prepare("UPDATE ble_binding_receipt SET brain_state='ready' WHERE binding_id=?").run(bindingId);
      return this.receipt(bindingId)!;
    });
  }
  setBrainState(bindingId: string, state: 'ready' | 'initializing'): void {
    this.transaction(() => {
      const row = this.receipt(bindingId); if (!row) throw new BleBindingError(404, 'binding_not_found');
      this.assertCurrent(row);
      this.db.prepare('UPDATE ble_binding_receipt SET brain_state=? WHERE binding_id=?').run(state, bindingId);
    });
  }
  /**
   * Hold ownership stable while the caller synchronously updates basic fields in profile.db.
   * This protects recipient selection, not cross-database atomicity: a callback's earlier
   * profile writes can persist if a later callback fails, so callers must write idempotently.
   */
  syncOwnedProfiles(accountId: string, write: (brainAccountId: string) => void): number {
    if (!validBleId(accountId)) throw new BleBindingError(401, 'unauthorized');
    if (Object.prototype.toString.call(write) === '[object AsyncFunction]') throw new Error('BLE profile sync callback must be synchronous');
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT sn,account_id FROM device_registry
        WHERE status='active' AND parent_account_id=? AND account_id IS NOT NULL AND account_id<>'' ORDER BY sn`)
        .all(accountId) as { sn: string; account_id: string }[];
      // Validate the whole recipient set before any profile write: a bad legacy pointer
      // must not copy child data into another parent's/device's account, even transiently.
      for (const row of rows) {
        if (row.account_id !== `device-${row.sn}`) throw new Error('invalid device Brain mapping');
      }
      const recipients = [...new Set(rows.map(row => row.account_id))];
      for (const brainAccountId of recipients) {
        const result: unknown = write(brainAccountId);
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('BLE profile sync callback must be synchronous');
      }
      return recipients.length;
    });
  }
  /** Issuer must be synchronous: validation, credential creation and claimed timestamp share one lock. */
  claim<T>(sn: string, nonce: string, issue: (record: BleBindingRecord & { idempotent: boolean }) => T): T {
    if (!validateDeviceSn(sn).ok || typeof nonce !== 'string' || fromB64url(nonce)?.length !== 32) throw new BleBindingError(400, 'bad_request');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM ble_binding_receipt WHERE nonce_hash=? AND sn=?').get(hash(nonce), sn) as BleBindingRecord | undefined;
      if (!row) throw new BleBindingError(404, 'pairing_pending');
      this.assertCurrent(row);
      const idempotent = row.claimed_at_ms !== null;
      if (this.now() >= (idempotent ? row.claimed_at_ms! + CLAIM_RECOVERY_MS : row.claim_expires_at_ms)) throw new BleBindingError(410, 'claim_expired');
      const result = issue({ ...row, idempotent });
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('BLE claim issuer must be synchronous');
      if (!idempotent) this.db.prepare('UPDATE ble_binding_receipt SET claimed_at_ms=? WHERE binding_id=?').run(this.now(), row.binding_id);
      return result;
    });
  }
  markActivated(sn: string, version: number, bindingId?: string): void {
    // Historic credentials remain usable, but do not prove authentication for a new receipt.
    if (!validBleId(bindingId)) return;
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM ble_binding_receipt WHERE binding_id=? AND sn=? AND binding_version=? AND revoked_at_ms IS NULL').get(bindingId, sn, version) as BleBindingRecord | undefined;
      if (!row || row.claimed_at_ms === null) return;
      try { this.assertCurrent(row); } catch (error) { if (error instanceof BleBindingError) return; throw error; }
      this.db.prepare('UPDATE ble_binding_receipt SET activated_at_ms=COALESCE(activated_at_ms,?) WHERE binding_id=?').run(this.now(), row.binding_id);
    });
  }
}

let singleton: BleBindingStore | undefined;
export function getBleBindingStore(): BleBindingStore { return singleton ??= new BleBindingStore(); }
