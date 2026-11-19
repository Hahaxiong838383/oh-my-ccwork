import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import legacyServer from 'socket.io-server-legacy';
import { Server } from 'socket.io-server-modern';
import { createBridge } from '../src/bridge.js';
import { resolveConfig } from '../src/config.js';

async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), 'expected observable state before timeout');
}

async function fixture(protocol, port = 0) {
  const http = createServer();
  const io = protocol === 'legacy2' ? legacyServer(http) : new Server(http);
  const registrations = [], messages = [], sockets = [];
  io.on('connection', socket => {
    sockets.push(socket);
    socket.on('ppBridgeApp', data => registrations.push(data));
    socket.on('ppMessage', data => messages.push(data));
  });
  await new Promise(resolve => http.listen(port, '127.0.0.1', resolve));
  return { io, http, port: http.address().port, registrations, messages, sockets,
    close: () => new Promise(resolve => io.close(resolve)) };
}

test('configuration rejects unsafe destinations and a legacy client cannot leave loopback', () => {
  assert.equal(resolveConfig().serverURL, 'http://localhost:9981');
  assert.equal(resolveConfig().protocol, 'legacy2');
  for (const serverURL of [
    'file:///tmp/x', 'http://user:password@localhost:9981',
    'http://localhost:9981/pie?pieid=private', 'http://localhost:9981/#secret',
    'http://localhost:9981/?token=secret', 'http://connect.example:9981'
  ]) assert.throws(() => resolveConfig({ serverURL }));
  assert.equal(resolveConfig({ protocol: 'modern4', serverURL: 'https://connect.example:8443' }).serverURL,
    'https://connect.example:8443');
  for (const config of [{ maxHz: 0 }, { maxHz: 201 }, { protocol: 'auto' }, { password: 'secret' }])
    assert.throws(() => resolveConfig(config));
});

for (const protocol of ['legacy2', 'modern4']) {
  test(`${protocol}: a state callback cannot queue input behind registration while transport is busy`, async t => {
    const server = await fixture(protocol);
    t.after(() => server.close());
    const bridge = createBridge({ protocol, serverURL: `http://127.0.0.1:${server.port}` });
    t.after(() => bridge.stop());
    let result;
    bridge.on('state', status => {
      if (status.state === 'connected') result = bridge.send({ messageId: 'demo.level', value: 90 });
    });
    bridge.start();
    await until(() => server.registrations.length === 1);
    assert.equal(result.result, 'transport_busy');
    assert.equal(server.messages.length, 0);
    await delay(30);
    assert.equal(bridge.send({ messageId: 'demo.level', value: 90 }).result, 'submitted');
    await until(() => server.messages.length === 1);
    assert.equal(server.messages[0].value, 90);
  });

  test(`${protocol}: registers, sends exact official payload, rejects wrong values, limits bursts and duplicates`, async t => {
    const server = await fixture(protocol);
    t.after(() => server.close());
    const events = [];
    const bridge = createBridge({ protocol, serverURL: `http://127.0.0.1:${server.port}`, maxHz: 20 },
      entry => events.push(entry));
    t.after(() => bridge.stop());
    assert.equal(bridge.send({ messageId: 'demo.level', value: 9 }).result, 'offline');
    bridge.start();
    await until(() => server.registrations.length === 1);
    assert.deepEqual(server.registrations, [{ name: 'NIO Input Bridge' }]);
    for (const command of [
      { messageId: 'demo.level', value: -1 }, { messageId: 'demo.level', value: '50' },
      { messageId: 'demo.toggle', value: 2 }, { messageId: 'demo.action', value: 'delete' },
      { messageId: 'warp.config', value: 1 }, { messageId: 'demo.level', value: 50, secret: 'x' }
    ]) assert.equal(bridge.send(command).result, 'invalid');
    assert.equal(bridge.send({ messageId: 'demo.level', value: 50 }).result, 'submitted');
    assert.equal(bridge.send({ messageId: 'demo.level', value: 51 }).result, 'rate_limited');
    await until(() => server.messages.length === 1);
    assert.deepEqual(server.messages, [{ messageId: 'demo.level', value: 50, fromName: 'NIO Input Bridge' }]);
    await delay(60);
    assert.equal(bridge.send({ messageId: 'demo.level', value: 50 }).result, 'duplicate');
    assert.equal(bridge.send({ messageId: 'demo.action', value: 'next' }).result, 'submitted');
    await until(() => server.messages.length === 2);
    await delay(60);
    assert.equal(bridge.send({ messageId: 'demo.action', value: 'next' }).result, 'debounced');
    await delay(50);
    assert.equal(bridge.send({ messageId: 'demo.toggle', value: 1 }).result, 'submitted');
    await until(() => server.messages.length === 3);
    const status = bridge.status();
    assert.equal(status.state, 'connected');
    assert.equal(status.submitted, 3);
    assert.equal(status.dropped.offline, 1);
    assert.equal(status.dropped.invalid, 6);
    assert.ok(events.every(entry => !JSON.stringify(entry).includes('127.0.0.1')));
    bridge.stop();
    assert.equal(bridge.send({ messageId: 'demo.action', value: 'reset' }).result, 'offline');
    assert.equal(bridge.status().state, 'stopped');
  });

  test(`${protocol}: real server outage reconnects without replaying old or offline commands`, async t => {
    let server = await fixture(protocol);
    t.after(() => server.close());
    const port = server.port;
    const bridge = createBridge({ protocol, serverURL: `http://127.0.0.1:${port}`,
      reconnectDelayMs: 100, connectTimeoutMs: 500, reconnectAttempts: 20 });
    t.after(() => bridge.stop());
    bridge.start();
    await until(() => server.registrations.length === 1);
    assert.equal(bridge.send({ messageId: 'demo.action', value: 'next' }).result, 'submitted');
    await until(() => server.messages.length === 1);
    await server.close();
    await until(() => bridge.status().state === 'disconnected');
    for (let i = 0; i < 4; i++)
      assert.equal(bridge.send({ messageId: 'demo.action', value: 'reset' }).result, 'offline');
    server = await fixture(protocol, port);
    await until(() => server.registrations.length === 1);
    await delay(200);
    assert.equal(server.messages.length, 0, 'old actions must never arrive after reconnect');
    assert.equal(bridge.status().connections, 2);
    assert.equal(bridge.send({ messageId: 'demo.level', value: 75 }).result, 'submitted');
    await until(() => server.messages.length === 1);
    assert.deepEqual(server.messages, [{ messageId: 'demo.level', value: 75, fromName: 'NIO Input Bridge' }]);
  });
}

test('unchanged current state can refresh after the duplicate interval without replaying an action', async t => {
  const server = await fixture('modern4');
  t.after(() => server.close());
  const bridge = createBridge({ protocol: 'modern4', serverURL: `http://127.0.0.1:${server.port}` });
  t.after(() => bridge.stop());
  bridge.start();
  await until(() => server.registrations.length === 1);
  assert.equal(bridge.send({ messageId: 'demo.level', value: 10 }).result, 'submitted');
  await until(() => server.messages.length === 1);
  await delay(1100);
  assert.equal(bridge.send({ messageId: 'demo.level', value: 10 }).result, 'submitted');
  await until(() => server.messages.length === 2);
  assert.deepEqual(server.messages, [
    { messageId: 'demo.level', value: 10, fromName: 'NIO Input Bridge' },
    { messageId: 'demo.level', value: 10, fromName: 'NIO Input Bridge' }
  ]);
});

test('protocol mismatch reports a connection error without switching protocol or sending commands', async t => {
  const server = await fixture('legacy2');
  t.after(() => server.close());
  const logs = [];
  const bridge = createBridge({ protocol: 'modern4', serverURL: `http://127.0.0.1:${server.port}`,
    reconnectAttempts: 0, connectTimeoutMs: 500 }, entry => logs.push(entry));
  t.after(() => bridge.stop());
  bridge.start();
  await until(() => logs.some(entry => entry.event === 'connect_error'));
  assert.equal(bridge.send({ messageId: 'demo.action', value: 'next' }).result, 'offline');
  assert.equal(server.messages.length, 0);
  assert.equal(bridge.status().protocol, 'modern4');
  assert.equal(bridge.status().connections, 0);
});
