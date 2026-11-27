#!/usr/bin/env node
/**
 * Offline zero-dependency bundler for open-bot-avatar -> NightAvatars classic script.
 *
 * Reads upstream TypeScript core + gallery JSON from UPSTREAM_DIR and our local
 * maintainable ../adapter.js, then emits:
 *   ../engine.js       Single classic-script IIFE for <script src="avatars/open/engine.js">
 *   ../thumbs/*.svg    Lightweight static SVG thumbnails via upstream renderAvatarSvg
 *   ../LICENSE         Upstream MIT license
 *   ../UPSTREAM.json   Pinned upstream SHA, version, license & manifest
 */

import fs from 'node:fs';
import {targetWebView} from '../webview.mjs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../assets/avatars/open');
if (!process.argv[2]) throw new Error('Pass the pinned upstream checkout as the first argument');
const UPSTREAM_DIR = path.resolve(process.argv[2]);
const CORE_SRC = path.join(UPSTREAM_DIR, 'packages/core/src');
const GALLERY_DIR = path.join(UPSTREAM_DIR, 'gallery');


function readUpstreamMeta() {
  const pkg = JSON.parse(fs.readFileSync(path.join(UPSTREAM_DIR, 'packages/core/package.json'), 'utf8'));
  const sha = execFileSync('git', ['-C', UPSTREAM_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (sha !== 'e10afe49d46da8ffcc6545f5d6e8ba1de4ea8c5d') throw new Error('Unexpected upstream revision: '+sha);
  const remote = execFileSync('git', ['-C', UPSTREAM_DIR, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  return {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    author: pkg.author,
    repository: remote,
    commit: sha,
  };
}

/**
 * Convert a single upstream TypeScript file (after stripTypeScriptTypes) from ESM
 * into a CommonJS-style module body using __req(id) and exports.
 */
function transformModule(relId, absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  const stripped = stripTypeScriptTypes(raw, { mode: 'transform' });

  const deps = [];
  const exportedNames = [];
  const reexports = [];

  const resolveRel = (spec) => {
    const targetAbs = path.resolve(path.dirname(absPath), spec);
    const targetRel = path.relative(CORE_SRC, targetAbs).split(path.sep).join('/');
    if (!fs.existsSync(targetAbs)) {
      throw new Error(`Missing upstream import ${spec} from ${relId} (resolved ${targetAbs})`);
    }
    deps.push({ relId: targetRel, absPath: targetAbs });
    return targetRel;
  };

  const parseSpecifiers = (specBlock) =>
    specBlock
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((item) => {
        const parts = item.split(/\s+as\s+/);
        return parts.length === 2
          ? { imported: parts[0].trim(), local: parts[1].trim() }
          : { imported: parts[0].trim(), local: parts[0].trim() };
      });

  const outLines = [];
  for (const line of stripped.split('\n')) {
    // 1. import { a, b as c } from './x.ts';
    const impMatch = /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/.exec(line);
    if (impMatch) {
      const targetRel = resolveRel(impMatch[2]);
      const bindings = parseSpecifiers(impMatch[1])
        .map(({ imported, local }) => (imported === local ? imported : `${imported}: ${local}`))
        .join(', ');
      outLines.push(`const { ${bindings} } = __req(${JSON.stringify(targetRel)});`);
      continue;
    }

    // 2. export { a, b as c } from './x.ts';
    const reexpMatch = /^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/.exec(line);
    if (reexpMatch) {
      const targetRel = resolveRel(reexpMatch[2]);
      const specs = parseSpecifiers(reexpMatch[1]);
      reexports.push({ targetRel, specs });
      continue;
    }

    // 3. export const|function|class Name ...
    const declMatch = /^export\s+(const|function|class)\s+([A-Za-z_$][\w$]*)(.*)$/.exec(line);
    if (declMatch) {
      const [, kind, name, rest] = declMatch;
      exportedNames.push(name);
      outLines.push(`${kind} ${name}${rest}`);
      continue;
    }

    // Guard against any unhandled top-level import/export syntax
    if (/^\s*(?:import|export)\b/.test(line)) {
      throw new Error(`Unhandled ESM syntax in ${relId}: ${line}`);
    }

    outLines.push(line);
  }

  reexports.forEach(({ targetRel, specs }, idx) => {
    const tmp = `__re_${idx}`;
    outLines.push(`const ${tmp} = __req(${JSON.stringify(targetRel)});`);
    for (const { imported, local } of specs) {
      outLines.push(`exports.${local} = ${tmp}.${imported};`);
    }
  });
  for (const name of exportedNames) {
    outLines.push(`exports.${name} = ${name};`);
  }

  return {
    relId,
    code: outLines.join('\n').trim(),
    deps,
  };
}

function collectModuleGraph(entryRelPaths) {
  const visited = new Map();
  const queue = entryRelPaths.map((rel) => ({
    relId: rel.split(path.sep).join('/'),
    absPath: path.join(CORE_SRC, rel),
  }));

  while (queue.length > 0) {
    const item = queue.shift();
    if (visited.has(item.relId)) continue;
    const mod = transformModule(item.relId, item.absPath);
    visited.set(item.relId, mod);
    for (const dep of mod.deps) {
      if (!visited.has(dep.relId)) queue.push(dep);
    }
  }

  // Deterministic sorted order
  return [...visited.values()].sort((a, b) => (a.relId < b.relId ? -1 : 1));
}

function loadGallery() {
  const colors = JSON.parse(fs.readFileSync(path.join(GALLERY_DIR, 'colors.json'), 'utf8'));
  const files = fs
    .readdirSync(GALLERY_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'colors.json')
    .sort();
  const gallery = files.map((f) => JSON.parse(fs.readFileSync(path.join(GALLERY_DIR, f), 'utf8')));
  return { gallery, colors };
}

function buildGlassThumbSvg(baseSvg, id) {
  // Wrap upstream renderAvatarSvg output with subtle translucent glass specular sheen
  // so Glass variants are visually distinct in static SVG thumbnail pickers.
  const gradId = `oba-glass-sheen-${id}`;
  const overlay =
    `<defs><linearGradient id="${gradId}" x1="15%" y1="10%" x2="85%" y2="90%">` +
    `<stop offset="0%" stop-color="#ffffff" stop-opacity="0.62"/>` +
    `<stop offset="42%" stop-color="#ffffff" stop-opacity="0.12"/>` +
    `<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    `<g opacity="0.88" pointer-events="none">` +
    `<ellipse cx="38" cy="27" rx="18" ry="8" transform="rotate(-24 38 27)" fill="url(#${gradId})"/>` +
    `<circle cx="77" cy="23" r="5" fill="#ffffff" fill-opacity="0.72"/>` +
    `<circle cx="77" cy="23" r="2.2" fill="#e0f2fe" fill-opacity="0.9"/>` +
    `</g>`;
  return baseSvg.replace('</svg>', `${overlay}</svg>`);
}

async function generateThumbnails(gallery, colors) {
  const core = await import(path.join(CORE_SRC, 'index.ts'));
  const thumbsDir = path.join(OUT_DIR, 'thumbs');
  fs.mkdirSync(thumbsDir, { recursive: true });

  // Clean stale svgs
  for (const f of fs.readdirSync(thumbsDir)) {
    if (f.endsWith('.svg')) fs.unlinkSync(path.join(thumbsDir, f));
  }

  const allDefs = [...core.examples, ...gallery];
  const byId = new Map(allDefs.map((d) => [d.id, d]));
  const written = [];

  for (const def of allDefs) {
    const color = colors[def.id] || core.DEFAULT_COLOR;
    const svg = core.renderAvatarSvg(def, {
      color,
      size: 96,
      depth: 3,
      reducedMotion: true,
    });
    const outFile = path.join(thumbsDir, `${def.id}.svg`);
    fs.writeFileSync(outFile, svg, 'utf8');
    written.push({ file: `thumbs/${def.id}.svg`, bytes: Buffer.byteLength(svg) });
  }

  for (const id of byId.keys()) {
    const def = byId.get(id);
    if (!def) continue;
    const color = colors[def.id] || core.DEFAULT_COLOR;
    const baseSvg = core.renderAvatarSvg(def, {
      color,
      size: 96,
      depth: 3,
      reducedMotion: true,
    });
    const glassSvg = buildGlassThumbSvg(baseSvg, id);
    const outFile = path.join(thumbsDir, `${id}-glass.svg`);
    fs.writeFileSync(outFile, glassSvg, 'utf8');
    written.push({ file: `thumbs/${id}-glass.svg`, bytes: Buffer.byteLength(glassSvg) });
  }

  return written;
}

function buildEngineBundle(meta, modules, gallery, colors) {
  const adapterSrc = fs
    .readFileSync(path.join(__dirname, 'adapter.js'), 'utf8')
    .replace(/\nif \(typeof module !== 'undefined' && module\.exports\)[\s\S]*$/m, '')
    .trim();

  const header = `/*!
 * NightAvatars Engine: open-bot-avatar (offline classic script bundle)
 * Upstream: ${meta.name}@${meta.version} (${meta.repository})
 * Commit:   ${meta.commit}
 * License:  ${meta.license} — Copyright (c) 2026 ${meta.author}
 */
`;

  const moduleEntries = modules
    .map(
      (m) =>
        `  ${JSON.stringify(m.relId)}: function (__req, exports) {\n${m.code
          .split('\n')
          .map((l) => (l ? '    ' + l : ''))
          .join('\n')}\n  }`
    )
    .join(',\n');

  const bundle = `${header}(function (global) {
  'use strict';

  var __modules = {
${moduleEntries}
  };
  var __cache = Object.create(null);
  function __req(id) {
    if (__cache[id]) return __cache[id].exports;
    var factory = __modules[id];
    if (!factory) throw new Error('open-bot-avatar: missing bundled module ' + id);
    var mod = (__cache[id] = { exports: {} });
    factory(__req, mod.exports);
    return mod.exports;
  }

  var __gallery = ${JSON.stringify(gallery)};
  var __colors = ${JSON.stringify(colors)};
  var __upstream = ${JSON.stringify(meta)};

${adapterSrc
  .split('\n')
  .map((l) => (l ? '  ' + l : ''))
  .join('\n')}

  var core = __req('index.ts');
  var colorMod = __req('color.ts');
  var dom = __req('dom/index.ts');
  var fluffy = __req('dom/materials/fluffy.ts').fluffy;
  var glass = __req('dom/materials/glass.ts').glass;

  var engine = createOpenBotAvatarEngine({
    core: core,
    colorMod: colorMod,
    dom: dom,
    fluffy: fluffy,
    glass: glass,
    atlasKeys: ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(UPSTREAM_DIR,'apps/site/src/studio/fluffy-thumbnails.json'),'utf8')))},
    gallery: __gallery,
    colors: __colors,
    upstream: __upstream,
    thumbBase: 'avatars/open/thumbs',
  });

  if (global && global.NightAvatars && typeof global.NightAvatars.register === 'function') {
    global.NightAvatars.register(engine);
  }
})(typeof window !== 'undefined' ? window : globalThis);
`;

  // Verify classic-script JS syntax strictly before writing
  new vm.Script(bundle, { filename: 'engine.js' });
  fs.writeFileSync(path.join(OUT_DIR, 'engine.js'), bundle, 'utf8');
  return Buffer.byteLength(bundle);
}

async function main() {
  const meta = readUpstreamMeta();
  const modules = collectModuleGraph([
    'index.ts',
    'color.ts',
    'dom/index.ts',
    'dom/materials/fluffy.ts',
    'dom/materials/glass.ts',
  ]);
  const { gallery, colors } = loadGallery();

  const bundleBytes = buildEngineBundle(meta, modules, gallery, colors);
  targetWebView(path.join(OUT_DIR, 'engine.js'));
  const thumbs = await generateThumbnails(gallery, colors);
  fs.copyFileSync(path.join(UPSTREAM_DIR, 'apps/site/src/studio/fluffy-thumbnails.webp'), path.join(OUT_DIR, 'fluffy.webp'));

  // Copy upstream MIT license verbatim
  fs.copyFileSync(path.join(UPSTREAM_DIR, 'LICENSE'), path.join(OUT_DIR, 'LICENSE.txt'));

  // Emit UPSTREAM.json provenance record
  const manifest = {
    ...meta,
    bundledModules: modules.map((m) => `packages/core/src/${m.relId}`),
    starterAvatars: 7,
    galleryAvatars: gallery.length,
    totalAvatars: 7 + gallery.length,
    materials: ['fluffy', 'glass', 'flat'],
    thumbnails: thumbs.map((t) => t.file),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'UPSTREAM.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const totalThumbBytes = thumbs.reduce((s, t) => s + t.bytes, 0);
  console.log(`Built engine.js: ${(bundleBytes / 1024).toFixed(1)} KB (${modules.length} upstream modules)`);
  console.log(`Generated ${thumbs.length} SVG thumbs: ${(totalThumbBytes / 1024).toFixed(1)} KB total`);
  console.log(`Pinned upstream: ${meta.name}@${meta.version} @ ${meta.commit}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
