// Runs the real Swift-generated script against a synthetic Connect 2.13 Stage.
// Structure follows its public static host; no third-party source or prototype
// is included. This is not a live browser, input, hardware or optical test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const temporary = mkdtempSync(join(tmpdir(), 'nio-connect-layout-'));
let expressions;
try {
  const emitter = join(temporary, 'Emitter.swift');
  writeFileSync(emitter, `import Foundation
@main struct Emitter {
  static func main() throws {
    let url = URL(string: "http://localhost:9981/pie?pieid=7&name=synthetic")!
    let scripts = [
      "enabled": ProtoPieConnectLayout.expression(enabled: true, expectedURL: url),
      "disabled": ProtoPieConnectLayout.expression(enabled: false, expectedURL: url),
      "top": ProtoPieConnectLayout.expression(enabled: true, verticalPosition: 1, expectedURL: url),
      "bottom": ProtoPieConnectLayout.expression(enabled: true, verticalPosition: -1, expectedURL: url),
      "other": ProtoPieConnectLayout.expression(enabled: false, expectedURL: URL(string: "http://localhost:9981/pie?pieid=8")!),
      "encoded": ProtoPieConnectLayout.expression(enabled: false, expectedURL: URL(string: "http://localhost:9981/pie?pieid=7&name=%22%3BglobalThis.pwned%3Dtrue%3B%2F%2F")!),
      "invalid": ProtoPieConnectLayout.expression(enabled: false, expectedURL: URL(string: "file:///pie?pieid=7")!)
    ]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: scripts))
  }
}`);
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../Sources/NIOWarpApp/ProtoPieConnectLayout.swift');
  const executable = join(temporary, 'emitter');
  const build = spawnSync('/Library/Developer/CommandLineTools/usr/bin/swiftc',
    ['-module-cache-path', join(temporary, 'module-cache'), source, emitter, '-o', executable],
    { encoding: 'utf8', env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  expressions = JSON.parse(run.stdout);
} finally { rmSync(temporary, { recursive: true, force: true }); }

class Style {
  values = new Map(); priorities = new Map(); writes = [];
  constructor(values = {}) { for (const [key, value] of Object.entries(values)) this.values.set(key, value); }
  getPropertyValue(key) { return this.values.get(key) || ''; }
  getPropertyPriority(key) { return this.priorities.get(key) || ''; }
  setProperty(key, value, priority = '') { this.values.set(key, value); this.priorities.set(key, priority); this.writes.push(key); }
  removeProperty(key) { this.values.delete(key); this.priorities.delete(key); this.writes.push(key); }
}

function fixture({ empty = false, supported = true, width = 400, height = 800 } = {}) {
  const elements = [];
  const rect = (x, y, w, h) => ({ x, y, left: x, top: y, width: w, height: h });
  const element = (id, className, parent = null) => {
    const e = { id, className, tagName: 'DIV', parentElement: parent, children: [], style: new Style(), isConnected: true,
      classList: { contains(name) { return className.split(' ').includes(name); } },
      contains(other) { return this === other || this.children.some(child => child.contains(other)); },
      getBoundingClientRect() { return this.rect(); } };
    if (parent) parent.children.push(e);
    elements.push(e); return e;
  };
  const stage = element('', supported ? 'stage' : 'unknown-host');
  stage.style = new Style({ cursor: 'auto' });
  const zoomPane = element('', 'zoom-pane', stage);
  const viewport = element('', 'viewport', zoomPane);
  const layer = element('', 'layer react-draggable', viewport);
  const root = element('pie-screen', '', layer);
  root.offsetWidth = width; root.offsetHeight = height; root.nativeScale = 1;
  root.style = new Style({ transform: 'scale(1, 1)', cursor: 'inherit' });
  // Rnd's resize-handle sibling is valid; it must not be mistaken for another Pie.
  const handle = element('', 'resize-handle-wrapper', layer);
  handle.rect = () => rect(0, 0, 0, 0);
  if (!empty) { const scene = element('', 'synthetic-rendered-scene', root); scene.rect = () => root.rect(); }
  const context = vm.createContext({
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    location: { origin: 'http://localhost:9981', pathname: '/pie', search: '?pieid=7' },
    URLSearchParams,
    document: { readyState: 'interactive', documentElement: {}, body: {},
      getElementById(id) { return elements.find(e => e.isConnected && e.id === id) || null; },
      querySelectorAll(selector) { return elements.filter(e => e.isConnected && e.id === selector.slice(1)); } },
    getComputedStyle(e) { return { position: e === stage || e === zoomPane || e === viewport || e === layer ? 'absolute' : 'static',
      visibility: e.hidden ? 'hidden' : 'visible', display: e.hidden ? 'none' : 'block', opacity: e.transparent ? '0' : '1' }; }
  });
  context.window = context;
  stage.rect = zoomPane.rect = () => rect(0, 0, context.innerWidth, context.innerHeight);
  // This absolute viewport has only absolute children, so its own rect can be empty.
  viewport.rect = () => rect(0, 0, 0, 0);
  layer.rect = root.rect = () => {
    const z = zoomPane.__zoom || { x: 0, y: 0, k: 1 };
    return rect(z.x, z.y, width * z.k * root.nativeScale, height * z.k * root.nativeScale);
  };
  const nativeFit = () => {
    const k = Math.min(context.innerWidth / width, context.innerHeight / height);
    zoomPane.__zoom = { x: (context.innerWidth - width * k) / 2, y: (context.innerHeight - height * k) / 2, k };
    const z = zoomPane.__zoom;
    viewport.style.values.set('transform', `translate(${z.x}px,${z.y}px) scale(${z.k})`);
  };
  nativeFit();
  return { context, root, stage, zoomPane, viewport, layer, elements, nativeFit, element,
    run(name) { return vm.runInContext(expressions[name], context); },
    assertUnchanged() { for (const e of elements) assert.deepEqual(e.style.writes, [], e.id || e.className); } };
}

test('known Connect 2.13 native Stage is ready without a webplayer-root or style changes', () => {
  const f = fixture();
  const status = f.run('disabled');
  assert.equal(status.ready, true);
  assert.equal(status.width, 400); assert.equal(status.height, 800);
  assert.equal(status.layout, 'connect-stage-2.13');
  f.assertUnchanged();
});

test('a valid Rnd resize handle and zero-size absolute viewport are accepted', () => {
  const f = fixture();
  assert.equal(f.layer.children.length, 2);
  assert.equal(f.viewport.rect().height, 0);
  assert.equal(f.run('disabled').ready, true);
  f.assertUnchanged();
});

test('width fill and internal vertical positions explicitly require an unavailable native API', () => {
  for (const name of ['enabled', 'top', 'bottom']) {
    const f = fixture(); const result = f.run(name);
    assert.equal(result.ready, false);
    assert.equal(result.nativeReady, true);
    assert.equal(result.issue, 'width-fit-unavailable');
    assert.equal(f.root.style.getPropertyValue('transform'), 'scale(1, 1)');
    assert.equal(f.stage.style.getPropertyValue('cursor'), 'auto');
    f.assertUnchanged();
  }
});

test('unknown Stage ancestry fails closed without editing it', () => {
  const f = fixture({ supported: false });
  const result = f.run('disabled');
  assert.equal(result.ready, false); assert.equal(result.issue, 'unsupported-layout');
  f.assertUnchanged();
});

test('empty, hidden and transparent player mounts cannot claim rendering readiness', () => {
  for (const change of [f => { f.root.children = []; }, f => { f.root.hidden = true; }, f => { f.root.transparent = true; }]) {
    const f = fixture(); change(f);
    assert.equal(f.run('disabled').ready, false); f.assertUnchanged();
  }
});

test('uninitialized or inconsistent native D3 state cannot qualify', () => {
  for (const change of [f => { delete f.zoomPane.__zoom; }, f => { f.zoomPane.__zoom.k = 0; },
    f => { f.viewport.style.values.set('transform', 'translate(0px,0px) scale(2)'); }]) {
    const f = fixture(); change(f);
    assert.equal(f.run('disabled').ready, false); f.assertUnchanged();
  }
});

test('multiple Pie mounts or Stage layers are rejected rather than choosing arbitrary content', () => {
  for (const change of [f => { f.element('pie-screen', '', f.layer); }, f => { f.element('', 'layer', f.viewport); }]) {
    const f = fixture(); change(f);
    const result = f.run('disabled');
    assert.equal(result.ready, false); assert.equal(result.issue, 'unsupported-layout');
    f.assertUnchanged();
  }
});

test('native nonuniform scaling and unavailable viewport sizes are not ready', () => {
  for (const change of [f => { f.root.rect = () => ({ x: 0, y: 0, width: 400, height: 400 }); },
    f => { f.context.innerWidth = 0; }, f => { f.context.devicePixelRatio = NaN; }]) {
    const f = fixture(); change(f); assert.equal(f.run('disabled').ready, false); f.assertUnchanged();
  }
});

test('origin, pathname and unique pieid bind both the native and unsupported width branches', () => {
  for (const change of [f => { f.context.location.origin = 'http://localhost:9982'; },
    f => { f.context.location.pathname = '/multiview'; }, f => { f.context.location.search = '?pieid=7&pieid=7'; },
    f => { f.context.location.search = '?pieid=8'; }]) {
    const f = fixture(); change(f);
    assert.equal(f.run('disabled').issue, 'page-mismatch');
    assert.equal(f.run('enabled').issue, 'page-mismatch'); f.assertUnchanged();
  }
});

test('all entry branches dispose a previous adapter lease before returning', () => {
  for (const name of ['disabled', 'enabled', 'other']) {
    const f = fixture(); let disposed = 0;
    f.context.__nioWarpConnectWidthFitV1 = { dispose() { disposed++; } };
    f.run(name); assert.equal(disposed, 1);
    assert.equal(f.context.__nioWarpConnectWidthFitV1, undefined); f.assertUnchanged();
  }
});

test('native viewport resize remains native and needs no adapter observers or mutations', () => {
  const f = fixture({ width: 1600, height: 800 });
  assert.equal(f.run('disabled').ready, true);
  f.context.innerWidth = 1600; f.nativeFit();
  const result = f.run('disabled');
  assert.equal(result.ready, true); assert.equal(result.width, 1600); assert.equal(result.height, 800);
  f.assertUnchanged();
});

test('disconnecting the rendered mount removes its eligibility', () => {
  const f = fixture(); f.root.isConnected = false;
  assert.equal(f.run('disabled').ready, false); f.assertUnchanged();
});

test('encoded query text never executes and invalid protocols cannot become ready', () => {
  const f = fixture(); assert.equal(f.run('encoded').ready, true);
  assert.equal(f.context.pwned, undefined); assert.equal(f.run('invalid').ready, false); f.assertUnchanged();
});
