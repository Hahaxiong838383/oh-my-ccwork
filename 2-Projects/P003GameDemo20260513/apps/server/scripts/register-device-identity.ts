import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { BleBindingError, normalizeIdentityPublicKey, validBleId } from '../src/ble-binding-proof.js';
import { validateDeviceSn } from '../src/device-sn.js';

/** Operator-only CLI. Accepts a trusted public key file; never generates or reads a private key. */
export async function registerDeviceIdentity(argv: string[]): Promise<Record<string, unknown>> {
  const options: Record<string, string | boolean> = {};
  const values = new Set(['--sn', '--key-id', '--public-key']);
  const switches = new Set(['--apply', '--enable-policy']);
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (Object.prototype.hasOwnProperty.call(options, option)) throw new BleBindingError(400, 'bad_arguments');
    if (switches.has(option)) options[option] = true;
    else if (values.has(option) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[option] = argv[++i];
    else throw new BleBindingError(400, 'bad_arguments');
  }
  const sn = options['--sn']; const keyId = options['--key-id']; const keyPath = options['--public-key'];
  if (typeof sn !== 'string' || !validateDeviceSn(sn).ok || !validBleId(keyId) || typeof keyPath !== 'string') throw new BleBindingError(400, 'bad_arguments');
  const normalized = normalizeIdentityPublicKey(readFileSync(keyPath, 'utf8'));
  const databasePath = resolve(process.env.DEVICES_DB_PATH?.trim() || './data/devices.db');
  if (!options['--apply']) {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = db.prepare('SELECT sn,status FROM device_registry WHERE sn=?').get(sn) as { status: string } | undefined;
      if (!row || row.status !== 'active') throw new BleBindingError(404, 'device_not_available');
      return { ok: true, dry_run: true, sn, device_key_id: keyId, public_key_fingerprint: normalized.fingerprint, enable_policy: Boolean(options['--enable-policy']), message: '未写入；确认公钥来自可信设备后加 --apply。启用策略会作废旧无版本凭据。' };
    } finally { db.close(); }
  }
  // Registry owns its existing migrations. Core adds identity/proof tables only after those are ready.
  await import('../src/device-registry-store.js');
  const { getBleBindingStore } = await import('../src/ble-binding-store.js');
  const result = getBleBindingStore().registerIdentityKey({ sn, keyId, publicKeyPem: normalized.pem, enablePolicy: Boolean(options['--enable-policy']) });
  return { ok: true, dry_run: false, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('用法：node --experimental-sqlite --import tsx scripts/register-device-identity.ts --sn FULL_SN --key-id KEY_ID --public-key /trusted/device-public.pem [--enable-policy] [--apply]');
    console.log('默认只读预检；--apply 登记可信公钥；--enable-policy 显式启用 BLE 身份策略并推进版本。不得提交私钥。');
  } else {
    registerDeviceIdentity(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => {
      console.error(JSON.stringify({ ok: false, error: error instanceof BleBindingError ? error.error : 'identity_registration_failed' }));
      process.exitCode = 1;
    });
  }
}
