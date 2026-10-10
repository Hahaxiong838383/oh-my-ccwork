import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import legacyIO from 'socket.io-client-legacy';
import { io as modernIO } from 'socket.io-client-modern';
import { resolveConfig } from './config.js';
import { isCommand } from './protocol.js';

export function createBridge(input = {}, log = () => {}) {
  const config = resolveConfig(input);
  const bridge = new EventEmitter();
  const session = randomUUID();
  const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  let state = 'stopped', started = false, connections = 0, submitted = 0;
  let lastSubmitted = -Infinity;
  const states = new Map(), actions = new Map();
  const dropped = { invalid: 0, offline: 0, transport_busy: 0, rate_limited: 0, duplicate: 0, debounced: 0 };
  const socket = (config.protocol === 'legacy2' ? legacyIO : modernIO)(config.serverURL, {
    autoConnect: false, forceNew: true, reconnection: true,
    timeout: config.connectTimeoutMs, reconnectionAttempts: config.reconnectAttempts,
    reconnectionDelay: config.reconnectDelayMs,
    reconnectionDelayMax: Math.min(10000, config.reconnectDelayMs * 4),
    // Avoid a long-polling write queue for real-time inputs; no protocol auto-fallback.
    transports: ['websocket'], rejectUnauthorized: true
  });
  const record = (event, metadata = {}) => log({ event, session, protocol: config.protocol,
    configHash, ...metadata });
  const changeState = next => { state = next; bridge.emit('state', bridge.status()); };
  const clearPending = () => {
    // Both pinned client versions expose this offline queue. It is never a command store.
    socket.sendBuffer.length = 0;
    states.clear(); actions.clear(); lastSubmitted = -Infinity;
  };
  socket.on('connect', () => {
    if (!started) { socket.disconnect(); return; }
    clearPending(); connections++;
    socket.emit('ppBridgeApp', { name: config.name });
    changeState('connected');
    record('connected', { connections, stateSyncRequired: true });
  });
  socket.on('disconnect', reason => {
    clearPending();
    if (!started) return;
    changeState('disconnected');
    const allowed = ['io server disconnect', 'io client disconnect', 'ping timeout',
      'transport close', 'transport error'];
    record('disconnected', { reason: allowed.includes(reason) ? reason : 'other' });
    // Server-initiated disconnects do not retry automatically. Operator must restart.
  });
  socket.on('connect_error', () => {
    clearPending();
    if (!started) return;
    changeState('disconnected');
    record('connect_error', { hint: 'check_service_protocol_and_license' });
  });
  socket.io.on('reconnect_attempt', attempt => {
    clearPending(); record('reconnect_attempt', { attempt });
  });
  socket.io.on('reconnect_failed', () => {
    changeState('exhausted'); record('reconnect_failed');
  });
  bridge.start = () => {
    if (started) return;
    started = true; changeState('connecting');
    record('starting', { version: '2.0.0-rc.1', node: process.version });
    socket.connect();
  };
  bridge.stop = () => {
    started = false; clearPending(); socket.disconnect();
    changeState('stopped'); record('stopped', { submitted, dropped: { ...dropped } });
  };
  bridge.status = () => ({ state, protocol: config.protocol, session, configHash,
    connections, submitted, dropped: { ...dropped }, stateSyncRequired: state === 'connected' });
  bridge.send = command => {
    const drop = reason => { dropped[reason]++; return { result: reason }; };
    if (!isCommand(command)) return drop('invalid');
    if (!started || !socket.connected) return drop('offline');
    const now = performance.now();
    const previous = states.get(command.messageId);
    if (command.messageId !== 'demo.action' && previous?.value === command.value && now - previous.at < 1000)
      return drop('duplicate');
    if (command.messageId === 'demo.action' && now - (actions.get(command.value) ?? -Infinity) < 100)
      return drop('debounced');
    if (now - lastSubmitted < 1000 / config.maxHz) return drop('rate_limited');
    // The pinned Engine.IO implementations expose transport.writable. Check it before
    // any submission so legacy cannot enqueue and modern cannot silently discard a
    // fresh state behind the registration packet. A dependency update must re-test it.
    if (!socket.io.engine?.transport?.writable) return drop('transport_busy');
    const payload = { messageId: command.messageId, value: command.value, fromName: config.name };
    // Volatile modern packets have no offline replay; legacy packets are guarded above
    // and the offline queue is discarded on every transition. Neither mode uses ACK retries.
    if (config.protocol === 'modern4') socket.volatile.emit('ppMessage', payload);
    else socket.emit('ppMessage', payload);
    lastSubmitted = now; submitted++;
    if (command.messageId === 'demo.action') actions.set(command.value, now);
    else states.set(command.messageId, { value: command.value, at: now });
    return { result: 'submitted' }; // Local submission, never proof of prototype receipt.
  };
  return bridge;
}
