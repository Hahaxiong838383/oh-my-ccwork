import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Script} from 'node:vm';
import {
  getNightDevices,
  isSameOriginRequest,
  NIGHT_BRIDGE_SOCKET,
  NightBridgeError,
  sendDeviceCommand,
  setDeviceColor,
} from './night-devices.ts';

function startMockBridge(socketPath, handler) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        let body = null;
        if (bodyText) {
          try { body = JSON.parse(bodyText); } catch { body = bodyText; }
        }
        handler(req, res, body);
      });
    });
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

test('night devices bridge proxies fixed operations over Unix socket and normalizes legacy records', async () => {
  assert.equal(NIGHT_BRIDGE_SOCKET, '/run/night-bridge/admin.sock');
  const dir = mkdtempSync(join(tmpdir(), 'pa-night-bridge-'));
  const socketPath = join(dir, 'admin.sock');
  const seen = [];
  let state = {
    devices: [
      {
        device: 's24-ultra',
        versionCode: 42,
        phase: 'listening',
        muted: false,
        accent: '#3b82f6',
        revision: 3,
        appliedRevision: 2,
        lastSeen: 1795650000,
        events: [
          {kind: 'call_started', ts: 1795649950},
          {kind: 'accent_applied', ts: 1795649990},
        ],
        command: {
          id: 'cmd-101',
          action: 'sync_logs',
          status: 'pending',
          createdAt: 1795649980,
          ackedAt: null,
        },
      },
      {
        device: 's24-legacy',
        versionCode: null,
        phase: '',
        muted: null,
        accent: null,
        revision: 0,
        appliedRevision: 0,
        lastSeen: 0,
        events: [{kind: 'legacy_diag', ts: 1795600000}],
        command: null,
      },
    ],
  };

  const server = await startMockBridge(socketPath, (req, res, body) => {
    seen.push({method: req.method, url: req.url, body});
    if (req.method === 'GET' && req.url === '/devices') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === 'POST' && req.url === '/devices/s24-ultra/color') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true}));
      return;
    }
    if (req.method === 'POST' && req.url === '/devices/s24-ultra/command') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true}));
      return;
    }
    if (req.method === 'POST' && req.url === '/devices/missing-phone/color') {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'device_not_found'}));
      return;
    }
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'not_found'}));
  });

  try {
    const listed = await getNightDevices(socketPath);
    assert.equal(listed.devices.length, 2);
    assert.equal(listed.devices[0].device, 's24-ultra');
    assert.equal(listed.devices[0].accent, '#3B82F6');
    assert.equal(listed.devices[0].muted, false);
    assert.equal(listed.devices[0].revision, 3);
    assert.equal(listed.devices[0].appliedRevision, 2);
    assert.equal(listed.devices[0].command.status, 'pending');
    assert.equal(listed.devices[0].command.ackedAt, null);

    assert.equal(listed.devices[1].device, 's24-legacy');
    assert.equal(listed.devices[1].lastSeen, 0);
    assert.equal(listed.devices[1].phase, null);
    assert.equal(listed.devices[1].muted, null);
    assert.equal(listed.devices[1].accent, null);
    assert.equal(listed.devices[1].command, null);

    const colorRes = await setDeviceColor(socketPath, 's24-ultra', '#10b981');
    assert.deepEqual(colorRes, {ok: true});
    assert.deepEqual(seen.at(-1), {
      method: 'POST',
      url: '/devices/s24-ultra/color',
      body: {accent: '#10B981'},
    });

    const logCmd = await sendDeviceCommand(socketPath, 's24-ultra', 'sync_logs');
    assert.deepEqual(logCmd, {ok: true});
    assert.deepEqual(seen.at(-1), {
      method: 'POST',
      url: '/devices/s24-ultra/command',
      body: {action: 'sync_logs'},
    });

    const updCmd = await sendDeviceCommand(socketPath, 's24-ultra', 'check_update');
    assert.deepEqual(updCmd, {ok: true});

    await assert.rejects(
      () => setDeviceColor(socketPath, 'missing-phone', '#112233'),
      err => err instanceof NightBridgeError && err.status === 404 && err.message === 'device_not_found',
    );

    const callsBeforeValidation = seen.length;
    await assert.rejects(
      () => setDeviceColor(socketPath, '../etc', '#112233'),
      err => err instanceof NightBridgeError && err.status === 400,
    );
    await assert.rejects(
      () => setDeviceColor(socketPath, 's24-ultra', 'not-a-color'),
      err => err instanceof NightBridgeError && err.status === 400,
    );
    await assert.rejects(
      () => sendDeviceCommand(socketPath, 's24-ultra', 'reboot'),
      err => err instanceof NightBridgeError && err.status === 400,
    );
    assert.equal(seen.length, callsBeforeValidation, 'invalid inputs must be rejected before touching socket');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
});

test('night devices bridge handles missing socket and timeout cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-night-timeout-'));
  const missingSocket = join(dir, 'absent.sock');
  const slowSocket = join(dir, 'slow.sock');
  const pendingResponses = [];
  const server = await startMockBridge(slowSocket, (_req, res) => {
    pendingResponses.push(res);
  });

  try {
    await assert.rejects(
      () => getNightDevices(missingSocket, 500),
      err => err instanceof NightBridgeError && err.status === 503,
    );
    await assert.rejects(
      () => getNightDevices(slowSocket, 120),
      err => err instanceof NightBridgeError && err.status === 504,
    );
  } finally {
    for (const res of pendingResponses) res.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
});

test('same-origin guard enforces Origin and Sec-Fetch-Site while allowing LAN and Lucky origins', () => {
  const lucky = 'https://pa.hahaxiong.cc:8666';
  assert.equal(isSameOriginRequest('https://192.168.1.115:18783/api/devices', 'https://192.168.1.115:18783', 'same-origin', lucky), true);
  assert.equal(isSameOriginRequest('https://192.168.1.115:18783/api/devices', lucky, 'same-origin', lucky), true);
  assert.equal(isSameOriginRequest('https://192.168.1.115:18783/api/devices', undefined, undefined, lucky), true);
  assert.equal(isSameOriginRequest('https://192.168.1.115:18783/api/devices', 'https://evil.example', 'same-origin', lucky), false);
  assert.equal(isSameOriginRequest('https://192.168.1.115:18783/api/devices', lucky, 'cross-site', lucky), false);
});

test('index.html inline script parses cleanly and exposes the mobile devices tab', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /data-view="devices"[^>]*>手机设备<\/button>/);
  assert.match(html, /下一通通话生效/);
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert(match, 'missing inline script');
  new Script(match[1], {filename: 'index.html'});
});
