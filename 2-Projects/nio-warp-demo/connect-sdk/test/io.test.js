import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from 'socket.io-server-modern';
import { consumeJSONLines } from '../src/json-lines.js';
import { createStatusLogger } from '../src/logger.js';

async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), 'expected observable state before timeout');
}

test('JSON-lines input survives chunks, malformed and overlong lines, preserving subsequent commands', async () => {
  const values = [], errors = [];
  await consumeJSONLines(Readable.from([
    Buffer.from('{"messageId":"demo.'), Buffer.from('level","value":50}\r\nnot JSON\n'),
    Buffer.from('x'.repeat(10000)), Buffer.from('\n\n{"type":"status"}')
  ]), value => values.push(value), code => errors.push(code));
  assert.deepEqual(values, [{ messageId: 'demo.level', value: 50 }, { type: 'status' }]);
  assert.deepEqual(errors, ['invalid_json', 'line_too_long']);
});

test('status log rotates within its bound and excludes payload, URL, error text and private paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nio-sdk-logger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let stderr = '';
  const logger = createStatusLogger({ directory, maxBytes: 512,
    stderr: { write: value => { stderr += value; } } });
  for (let i = 0; i < 20; i++) logger({ event: 'connect_error', protocol: 'legacy2',
    hint: 'check_service_protocol_and_license', value: 'secret_input',
    serverURL: 'http://private.example/?password=secret',
    error: '/Users/private/secret_file', reason: 'secret_error' });
  const files = await readdir(directory);
  assert.deepEqual(files.sort(), ['bridge.log', 'bridge.log.1', 'bridge.log.2']);
  let saved = '';
  for (const file of files) {
    const bytes = await readFile(join(directory, file));
    assert.ok(bytes.length <= 512);
    saved += bytes;
  }
  assert.ok(saved.includes('connect_error'));
  assert.ok(!/(private|secret|password)/.test(saved + stderr));
});

test('actual CLI accepts JSON-lines while connected and exits cleanly at EOF', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nio-sdk-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const http = createServer();
  const server = new Server(http);
  const messages = [];
  server.on('connection', socket => socket.on('ppMessage', data => messages.push(data)));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ protocol: 'modern4',
    serverURL: `http://127.0.0.1:${http.address().port}` }));
  const child = spawn(process.execPath, ['src/cli.js', '--config', path],
    { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let stdout = '', stderr = '', exit;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('exit', code => { exit = code; });
  await until(() => stderr.includes('"event":"connected"'));
  await delay(30);
  child.stdin.write('not-json\n{"messageId":"demo.level","value":42}\n{"type":"status"}\n');
  await until(() => messages.length === 1);
  assert.deepEqual(messages, [{ messageId: 'demo.level', value: 42, fromName: 'NIO Input Bridge' }]);
  await until(() => stdout.split('\n').filter(Boolean).length === 3);
  const output = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(output[0], { result: 'invalid_json' });
  assert.deepEqual(output[1], { result: 'submitted' });
  assert.equal(output[2].state, 'connected');
  assert.ok(!stdout.includes('"value":42'));
  assert.ok(!stderr.includes('127.0.0.1'));
  child.stdin.end();
  await until(() => exit !== undefined);
  assert.equal(exit, 0);
});

test('CLI rejects a secret-bearing config without echoing its text or path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nio-sdk-secret-'));
  try {
    const path = join(directory, 'private-config.json');
    await writeFile(path, JSON.stringify({ serverURL: 'http://user:private-password@localhost:9981' }));
    const child = spawn(process.execPath, ['src/cli.js', '--config', path],
      { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exit = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(exit, 1);
    assert.ok(stderr.includes('invalid_configuration'));
    assert.ok(!stderr.includes('private'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
