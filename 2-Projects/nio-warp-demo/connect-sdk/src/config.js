const defaults = Object.freeze({
  serverURL: 'http://localhost:9981', protocol: 'legacy2', name: 'NIO Input Bridge',
  maxHz: 20, connectTimeoutMs: 5000, reconnectDelayMs: 1000,
  reconnectAttempts: 10, logDirectory: null
});

export function resolveConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_config');
  if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new Error('unknown_config_key');
  const config = { ...defaults, ...input };
  if (!['legacy2', 'modern4'].includes(config.protocol)) throw new Error('invalid_protocol');
  if (typeof config.serverURL !== 'string' || config.serverURL.length > 512)
    throw new Error('invalid_server_url');
  let url;
  try { url = new URL(config.serverURL); } catch { throw new Error('invalid_server_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || /[?#]/.test(config.serverURL))
    throw new Error('server_url_must_be_origin');
  if (config.protocol === 'legacy2' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('legacy2_loopback_only');
  config.serverURL = url.origin;
  if (typeof config.name !== 'string' || !/^[A-Za-z0-9 _.-]{1,64}$/.test(config.name))
    throw new Error('invalid_bridge_name');
  for (const [key, min, max] of [
    ['maxHz', 1, 200], ['connectTimeoutMs', 100, 30000],
    ['reconnectDelayMs', 100, 10000], ['reconnectAttempts', 0, 20]
  ]) if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max)
    throw new Error(`invalid_${key}`);
  if (config.logDirectory !== null && (typeof config.logDirectory !== 'string' ||
      config.logDirectory.length === 0 || config.logDirectory.length > 512 ||
      /[\x00-\x1f]/.test(config.logDirectory))) throw new Error('invalid_log_directory');
  return Object.freeze(config);
}
