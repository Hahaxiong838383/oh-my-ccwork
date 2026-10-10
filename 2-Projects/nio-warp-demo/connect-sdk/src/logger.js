import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const events = new Set(['starting', 'connected', 'disconnected', 'connect_error',
  'reconnect_attempt', 'reconnect_failed', 'stopped', 'input_closed', 'input_error']);
const reasons = new Set(['io server disconnect', 'io client disconnect', 'ping timeout',
  'transport close', 'transport error', 'other']);

function sanitize(entry) {
  const result = { timestamp: new Date().toISOString(),
    event: events.has(entry.event) ? entry.event : 'other' };
  if (/^[a-f0-9-]{36}$/.test(entry.session ?? '')) result.session = entry.session;
  if (/^[a-f0-9]{64}$/.test(entry.configHash ?? '')) result.configHash = entry.configHash;
  if (['legacy2', 'modern4'].includes(entry.protocol)) result.protocol = entry.protocol;
  if (entry.version === '2.0.0-rc.1') result.version = entry.version;
  if (/^v[0-9.]{1,24}$/.test(entry.node ?? '')) result.node = entry.node;
  if (reasons.has(entry.reason)) result.reason = entry.reason;
  if (entry.hint === 'check_service_protocol_and_license') result.hint = entry.hint;
  for (const key of ['attempt', 'connections', 'submitted'])
    if (Number.isSafeInteger(entry[key]) && entry[key] >= 0) result[key] = entry[key];
  if (typeof entry.stateSyncRequired === 'boolean') result.stateSyncRequired = entry.stateSyncRequired;
  if (entry.dropped && typeof entry.dropped === 'object') {
    result.dropped = {};
    for (const key of ['invalid', 'offline', 'transport_busy', 'rate_limited', 'duplicate', 'debounced'])
      if (Number.isSafeInteger(entry.dropped[key]) && entry.dropped[key] >= 0)
        result.dropped[key] = entry.dropped[key];
  }
  return result;
}

export function createStatusLogger({ directory = null, maxBytes = 1024 * 1024,
  stderr = process.stderr } = {}) {
  let enabled = directory !== null;
  const file = enabled ? join(directory, 'bridge.log') : null;
  return entry => {
    const line = JSON.stringify(sanitize(entry)) + '\n';
    stderr.write(line);
    if (!enabled) return;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const bytes = Buffer.byteLength(line);
      if (bytes > maxBytes) return;
      if (existsSync(file) && statSync(file).size + bytes > maxBytes) {
        rmSync(`${file}.2`, { force: true });
        if (existsSync(`${file}.1`)) renameSync(`${file}.1`, `${file}.2`);
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      enabled = false;
      // Never echo an OS error: it may include a customer path or host.
      stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), event: 'log_file_disabled' }) + '\n');
    }
  };
}
