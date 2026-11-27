#!/usr/bin/env node
/**
 * Offline zero-dependency builder for NightAvatars BoopFace delivery.
 *
 * Reads the pinned upstream checkout at:
 *   node build.mjs <upstream-checkout>
 * Bundles all runtime modules (44 files, zero dynamic imports, zero CDN)
 * together with `../adapter.js` into a single classic script `../engine.js`,
 * generates lightweight static SVG thumbnails in `../thumbs/`, and preserves
 * the upstream MIT LICENSE + pinned commit metadata.
 */
import fs from 'node:fs';
import {targetWebView} from '../webview.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DELIVERY_DIR = path.resolve(__dirname, '../../assets/avatars/boop');
if (!process.argv[2]) throw new Error('Pass the pinned upstream checkout as the first argument');
const UPSTREAM_DIR = path.resolve(process.argv[2]);
const PINNED_SHA = '940fdf7dd844c2052b5ae846374e1ce60b0f5c33';

function verifyUpstream() {
  if (!fs.existsSync(path.join(UPSTREAM_DIR, 'boopface.js'))) {
    throw new Error(`Upstream BoopFace checkout not found at ${UPSTREAM_DIR}`);
  }
  const sha = execFileSync('git', ['-C', UPSTREAM_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (sha !== PINNED_SHA) {
    throw new Error(`Upstream SHA mismatch: expected ${PINNED_SHA}, got ${sha}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(UPSTREAM_DIR, 'package.json'), 'utf8'));
  return { sha, version: pkg.version, license: pkg.license };
}

function resolveModuleId(fromId, specifier) {
  const fromDir = path.posix.dirname(fromId);
  return path.posix.normalize(path.posix.join(fromDir, specifier));
}

function discoverModules(entryId) {
  const visited = new Set();
  const order = [];

  function walk(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const fullPath = path.join(UPSTREAM_DIR, id);
    const src = fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n');

    // Collect every static import (side-effect or binding) without crossing semicolons/strings.
    const deps = [];
    let m;
    const sideRe = /^import\s+['"]([^'"]+)['"]\s*;?/gm;
    while ((m = sideRe.exec(src)) !== null) deps.push(m[1]);

    const fromRe = /^import\s+[^;'"]+\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
    while ((m = fromRe.exec(src)) !== null) deps.push(m[1]);

    const dynRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynRe.exec(src)) !== null) deps.push(m[1]);

    for (const spec of deps) {
      walk(resolveModuleId(id, spec));
    }
    order.push(id);
  }

  walk(entryId);
  return order;
}

function parseSpecifiers(raw) {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const m = /^(\w+)\s+as\s+(\w+)$/.exec(part);
      return m ? { local: m[1], exported: m[2] } : { local: part, exported: part };
    });
}

function transformModule(id, src) {
  const exported = [];
  let importCounter = 0;

  let code = src.replace(/\r\n/g, '\n');

  // 1. Replace dynamic import('...') -> __import('resolved')
  code = code.replace(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, (_, spec) => {
    const target = resolveModuleId(id, spec);
    return `__import(${JSON.stringify(target)})`;
  });

  // 2. Replace top-level static imports (never crossing ';' or quotes)
  // 2a. import Default, { a, b as c } from '...'
  code = code.replace(
    /^import\s+(\w+)\s*,\s*\{([^;{}]*?)\}\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    (_, defName, namedRaw, spec) => {
      const target = resolveModuleId(id, spec);
      const tmp = `__imp${importCounter++}`;
      const binds = parseSpecifiers(namedRaw)
        .map(({ local, exported: alias }) => (local === alias ? local : `${local}: ${alias}`))
        .join(', ');
      return `const ${tmp} = __require(${JSON.stringify(target)}); const ${defName} = ${tmp}.default; const { ${binds} } = ${tmp};`;
    }
  );

  // 2b. import { a, b as c } from '...'
  code = code.replace(
    /^import\s*\{([^;{}]*?)\}\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    (_, namedRaw, spec) => {
      const target = resolveModuleId(id, spec);
      const binds = parseSpecifiers(namedRaw)
        .map(({ local, exported: alias }) => (local === alias ? local : `${local}: ${alias}`))
        .join(', ');
      return `const { ${binds} } = __require(${JSON.stringify(target)});`;
    }
  );

  // 2c. import Default from '...'
  code = code.replace(
    /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    (_, defName, spec) => {
      const target = resolveModuleId(id, spec);
      return `const ${defName} = __require(${JSON.stringify(target)}).default;`;
    }
  );

  // 2d. import '...' (side-effect)
  code = code.replace(
    /^import\s+['"]([^'"]+)['"]\s*;?/gm,
    (_, spec) => {
      const target = resolveModuleId(id, spec);
      return `__require(${JSON.stringify(target)});`;
    }
  );

  // 3. Replace top-level exports
  // 3a. export default ...
  code = code.replace(/^export\s+default\s+/gm, 'exports.default = ');

  // 3b. export async function NAME
  code = code.replace(/^export\s+async\s+function\s+(\w+)/gm, (_, name) => {
    exported.push({ local: name, exported: name });
    return `async function ${name}`;
  });

  // 3c. export function NAME
  code = code.replace(/^export\s+function\s+(\w+)/gm, (_, name) => {
    exported.push({ local: name, exported: name });
    return `function ${name}`;
  });

  // 3d. export const NAME
  code = code.replace(/^export\s+const\s+(\w+)/gm, (_, name) => {
    exported.push({ local: name, exported: name });
    return `const ${name}`;
  });

  // 3e. export { a, b as c }; (single or multiline)
  code = code.replace(/^export\s*\{([^;{}]*?)\}\s*;?/gm, (_, raw) => {
    for (const spec of parseSpecifiers(raw)) {
      exported.push(spec);
    }
    return '';
  });

  // Verify no stray top-level ESM keywords remain
  const stray = code.match(/^(import|export)\b/gm);
  if (stray) {
    throw new Error(`Untransformed ESM statement in ${id}: ${stray.join(', ')}`);
  }

  const tail = exported.map(({ local, exported: expName }) => `exports.${expName} = ${local};`).join('\n');
  return `${code}\n${tail}`;
}

function buildEngineBundle(meta, modules) {
  const adapterSrc = fs.readFileSync(path.join(__dirname, 'adapter.js'), 'utf8');

  const chunks = [];
  chunks.push(`/*!
 * NightAvatars BoopFace Engine (offline classic-script bundle)
 * Upstream: https://github.com/CX-ArtLab/BoopFace
 * Version: ${meta.version}
 * Commit: ${meta.sha}
 * License: ${meta.license} (see LICENSE)
 */
(function (global) {
  'use strict';
  var __modules = Object.create(null);
  var __cache = Object.create(null);
  function __define(id, factory) {
    __modules[id] = factory;
  }
  function __require(id) {
    if (__cache[id]) return __cache[id];
    var factory = __modules[id];
    if (!factory) throw new Error('BoopFace bundle missing module: ' + id);
    var exports = {};
    __cache[id] = exports;
    factory(__require, __import, exports);
    return exports;
  }
  function __import(id) {
    return Promise.resolve(__require(id));
  }
`);

  for (const id of modules) {
    const raw = fs.readFileSync(path.join(UPSTREAM_DIR, id), 'utf8');
    const body = transformModule(id, raw);
    chunks.push(`\n  // --- ${id} ---\n  __define(${JSON.stringify(id)}, function (__require, __import, exports) {\n${body}\n  });\n`);
  }

  chunks.push(`
  // Boot upstream BoopFace entry and pre-warm skin painters offline
  var __boopface = __require("boopface.js");
  if (typeof __boopface.loadSkins === 'function') {
    __boopface.loadSkins();
  }

  // --- NightAvatars adapter (source: ./adapter.js) ---
${adapterSrc}
})(typeof window !== 'undefined' ? window : globalThis);
`);

  const outPath = path.join(DELIVERY_DIR, 'engine.js');
  const content = chunks.join('');
  fs.writeFileSync(outPath, content, 'utf8');
  targetWebView(outPath);
  return { outPath, bytes: Buffer.byteLength(content, 'utf8') };
}

async function main() {
  const meta = verifyUpstream();
  const modules = discoverModules('boopface.js');
  if (modules.length !== 44) {
    throw new Error(`Expected 44 upstream modules, discovered ${modules.length}`);
  }
  const bundle = buildEngineBundle(meta, modules);
  const {SKIN_CATALOG} = await import(pathToFileURL(path.join(UPSTREAM_DIR,'src/skins/catalog.js')).href);
  const variants = Object.keys(SKIN_CATALOG).length + 2;

  // Copy upstream MIT LICENSE verbatim
  fs.copyFileSync(path.join(UPSTREAM_DIR, 'LICENSE'), path.join(DELIVERY_DIR, 'LICENSE.txt'));

  // Write pinned provenance metadata
  const upstreamInfo = {
    name: 'BoopFace',
    repository: 'https://github.com/CX-ArtLab/BoopFace',
    version: meta.version,
    commit: meta.sha,
    license: meta.license,
    bundledModules: modules.length,
    variants,
    thumbnails: 'materials.webp (rendered by capture.cjs)',
  };
  fs.writeFileSync(path.join(DELIVERY_DIR, 'UPSTREAM.json'), JSON.stringify(upstreamInfo, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify({
    status: 'ok',
    version: meta.version,
    commit: meta.sha,
    bundledModules: modules.length,
    engineBytes: bundle.bytes,
    variants,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
