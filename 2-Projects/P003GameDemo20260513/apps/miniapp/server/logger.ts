const sensitiveKeys = /authorization|token|jwt|secret|partner.?key|password/i;

export function maskPhone(value: string) {
  return value.replace(/(\d{3})\d+(\d{4})/, '$1****$2');
}

export function maskSn(value: string) {
  return value.length <= 8 ? '********' : `***${value.slice(-8)}`;
}

export function redact(value: unknown, key = ''): unknown {
  if (sensitiveKeys.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  if (typeof value === 'string') {
    if (/phone|mobile/i.test(key)) return maskPhone(value);
    if (/^sn$|serial/i.test(key)) return maskSn(value);
  }
  return value;
}

export function log(level: 'info' | 'error', event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...redact(data) as object });
  (level === 'error' ? console.error : console.log)(line);
}
