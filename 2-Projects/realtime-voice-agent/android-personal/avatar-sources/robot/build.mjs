#!/usr/bin/env node
/**
 * Zero-dependency offline builder for NightAvatars robot-heads engine.
 *
 * Uses Node 22's built-in `module.stripTypeScriptTypes` to compile the verbatim
 * upstream TypeScript core (`fayazara/robot-heads`) together with local `adapter.js`
 * into a single classic IIFE script `engine.js`, and generates lightweight static
 * SVG thumbnails in `thumbs/`.
 */

import fs from 'node:fs';
import {targetWebView} from '../webview.mjs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DELIVERY_DIR = path.resolve(__dirname, '../../assets/avatars/robot');
if (!process.argv[2]) throw new Error('Pass the pinned upstream checkout as the first argument');
const UPSTREAM_DIR = path.resolve(process.argv[2]);
const PINNED_SHA = '58ebf6439a8125a769f63b22ffd35bc18834b1b5';

function verifyUpstreamPin() {
  const actualSha = execFileSync('git', ['-C', UPSTREAM_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actualSha !== PINNED_SHA) {
    throw new Error(`Upstream SHA mismatch: expected ${PINNED_SHA}, got ${actualSha}`);
  }
  return actualSha;
}

/**
 * Strip TS types from a verbatim upstream module and wrap it into an isolated IIFE
 * returning its named exports.
 */
function compileUpstreamModule(relPath, moduleName, importsMap = {}) {
  const fullPath = path.join(UPSTREAM_DIR, 'src', relPath);
  const rawTs = fs.readFileSync(fullPath, 'utf8');
  let js = stripTypeScriptTypes(rawTs, { mode: 'strip' });

  // Collect and strip `export` keywords
  const exportedNames = [];
  js = js.replace(/^export\s+(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm, (_m, kw, name) => {
    exportedNames.push(name);
    return `${kw} ${name}`;
  });

  // Rewrite relative imports into destructuring from previously built module objects
  js = js.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm, (_m, spec, source) => {
    const depVar = importsMap[source];
    if (!depVar) {
      throw new Error(`Unmapped import "${source}" in ${relPath}`);
    }
    const names = spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return '';
    return `const { ${names.join(', ')} } = ${depVar};`;
  });

  // Safety check: no leftover top-level import/export statements
  if (/^\s*(import|export)\b/m.test(js)) {
    const offending = js.split('\n').filter((l) => /^\s*(import|export)\b/.test(l));
    throw new Error(`Leftover ESM syntax in ${relPath}:\n${offending.join('\n')}`);
  }

  // Trim excessive blank lines left by stripped interfaces while keeping readability
  js = js.replace(/\n{3,}/g, '\n\n').trim();

  return [
    `  /* ── upstream: src/${relPath} ── */`,
    `  const ${moduleName} = (function () {`,
    indent(js, 4),
    `    return { ${exportedNames.join(', ')} };`,
    `  })();`,
  ].join('\n');
}

function indent(str, spaces) {
  const pad = ' '.repeat(spaces);
  return str
    .split('\n')
    .map((line) => (line.length ? pad + line : ''))
    .join('\n');
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const c = [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
  return '#' + c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

/**
 * Build a crisp, lightweight (<2 KB) SVG thumbnail faithful to each variant's
 * shape, shell/trim/LED palette, and antenna option.
 */
function buildThumbSvg(spec) {
  const shellHi = mixHex(spec.color, '#ffffff', 0.34);
  const shellMid = spec.color;
  const shellLo = mixHex(spec.color, '#090d18', 0.44);
  const trimHi = mixHex(spec.trimColor, '#ffffff', 0.32);
  const trimLo = mixHex(spec.trimColor, '#111520', 0.38);
  const ledCore = mixHex(spec.screenColor, '#ffffff', 0.55);
  const ledGlow = spec.screenColor;

  const shiftY = spec.antenna ? 0 : -6;
  const scale = spec.antenna ? 1 : 1.08;
  const id = spec.id.replace(/[^a-z0-9]/gi, '');

  let shellEl = '';
  let holeEl = '';
  let glassClipEl = '';
  let earsEl = '';
  let collarY = 26;
  let eyeY = 50;

  if (spec.shape === 'rectangle') {
    collarY = 29;
    eyeY = 51;
    earsEl =
      `<rect x="7" y="48" width="8" height="16" rx="4" fill="url(#t-${id})"/>` +
      `<rect x="81" y="48" width="8" height="16" rx="4" fill="url(#t-${id})"/>`;
    shellEl = `<rect x="13" y="30" width="70" height="50" rx="14" fill="url(#s-${id})" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`;
    holeEl = `<rect x="21" y="38" width="54" height="34" rx="8" fill="#090c11" stroke="rgba(0,0,0,0.45)" stroke-width="1.5"/>`;
    glassClipEl = `<rect x="22" y="39" width="52" height="32" rx="7"/>`;
  } else if (spec.shape === 'square') {
    collarY = 25;
    eyeY = 50;
    earsEl =
      `<rect x="12" y="47" width="8" height="16" rx="4" fill="url(#t-${id})"/>` +
      `<rect x="76" y="47" width="8" height="16" rx="4" fill="url(#t-${id})"/>`;
    shellEl = `<rect x="18" y="26" width="60" height="58" rx="14" fill="url(#s-${id})" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`;
    holeEl = `<rect x="26" y="34" width="44" height="42" rx="9" fill="#090c11" stroke="rgba(0,0,0,0.45)" stroke-width="1.5"/>`;
    glassClipEl = `<rect x="27" y="35" width="42" height="40" rx="8"/>`;
  } else if (spec.shape === 'circle') {
    collarY = 23;
    eyeY = 50;
    earsEl =
      `<rect x="11" y="47" width="8" height="16" rx="4" fill="url(#t-${id})"/>` +
      `<rect x="77" y="47" width="8" height="16" rx="4" fill="url(#t-${id})"/>`;
    shellEl = `<circle cx="48" cy="55" r="31" fill="url(#s-${id})" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`;
    holeEl = `<circle cx="48" cy="55" r="22.5" fill="#090c11" stroke="rgba(0,0,0,0.45)" stroke-width="1.5"/>`;
    glassClipEl = `<circle cx="48" cy="55" r="21.5"/>`;
  } else {
    collarY = 25;
    eyeY = 50;
    earsEl =
      `<rect x="9" y="47" width="8" height="16" rx="4" fill="url(#t-${id})"/>` +
      `<rect x="79" y="47" width="8" height="16" rx="4" fill="url(#t-${id})"/>`;
    const outerHex =
      'M34,26 L62,26 Q68,26 71,31 L81,49 Q84,55 81,61 L71,79 Q68,84 62,84 L34,84 Q28,84 25,79 L15,61 Q12,55 15,49 L25,31 Q28,26 34,26 Z';
    const innerHex =
      'M37,34 L59,34 Q63,34 65,38 L72,51 Q74,55 72,59 L65,72 Q63,76 59,76 L37,76 Q33,76 31,72 L24,59 Q22,55 24,51 L31,38 Q33,34 37,34 Z';
    shellEl = `<path d="${outerHex}" fill="url(#s-${id})" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`;
    holeEl = `<path d="${innerHex}" fill="#090c11" stroke="rgba(0,0,0,0.45)" stroke-width="1.5"/>`;
    glassClipEl = `<path d="${innerHex}"/>`;
  }

  const antennaEl = spec.antenna
    ? `<rect x="43" y="${collarY - 3}" width="10" height="5" rx="2.5" fill="url(#t-${id})"/>` +
      `<line x1="48" y1="${collarY - 3}" x2="48" y2="${collarY - 14}" stroke="#8d97a6" stroke-width="2.4" stroke-linecap="round"/>` +
      `<circle cx="48" cy="${collarY - 16}" r="7.5" fill="#fff7e2" opacity="0.28"/>` +
      `<circle cx="48" cy="${collarY - 16}" r="4.2" fill="url(#b-${id})" stroke="rgba(28,32,42,0.3)" stroke-width="0.7"/>` +
      `<circle cx="46.5" cy="${collarY - 17.5}" r="1.2" fill="#ffffff" opacity="0.9"/>`
    : `<rect x="42.5" y="${collarY - 3.5}" width="11" height="5.5" rx="2.75" fill="url(#t-${id})"/>`;

  const transformAttr = scale !== 1
    ? ` transform="translate(48 54) scale(${scale}) translate(-48 ${-54 + shiftY})"`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">`,
    `  <defs>`,
    `    <linearGradient id="s-${id}" x1="18%" y1="10%" x2="86%" y2="92%">`,
    `      <stop offset="0%" stop-color="${shellHi}"/>`,
    `      <stop offset="48%" stop-color="${shellMid}"/>`,
    `      <stop offset="100%" stop-color="${shellLo}"/>`,
    `    </linearGradient>`,
    `    <linearGradient id="t-${id}" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `      <stop offset="0%" stop-color="${trimHi}"/>`,
    `      <stop offset="100%" stop-color="${trimLo}"/>`,
    `    </linearGradient>`,
    `    <radialGradient id="b-${id}" cx="35%" cy="30%" r="68%">`,
    `      <stop offset="0%" stop-color="#ffffff"/>`,
    `      <stop offset="45%" stop-color="#fff4db"/>`,
    `      <stop offset="100%" stop-color="#a8b0be"/>`,
    `    </radialGradient>`,
    `    <clipPath id="c-${id}">${glassClipEl}</clipPath>`,
    `  </defs>`,
    `  <ellipse cx="48" cy="88" rx="25" ry="3.6" fill="#000000" opacity="0.26"/>`,
    `  <g${transformAttr}>`,
    `    ${antennaEl}`,
    `    ${earsEl}`,
    `    ${shellEl}`,
    `    ${holeEl}`,
    `    <g clip-path="url(#c-${id})">`,
    `      <rect x="31" y="${eyeY - 1.5}" width="11" height="13" rx="3" fill="${ledGlow}" opacity="0.34"/>`,
    `      <rect x="54" y="${eyeY - 1.5}" width="11" height="13" rx="3" fill="${ledGlow}" opacity="0.34"/>`,
    `      <rect x="33" y="${eyeY}" width="7" height="10" rx="1.4" fill="${ledCore}"/>`,
    `      <rect x="56" y="${eyeY}" width="7" height="10" rx="1.4" fill="${ledCore}"/>`,
    `      <polygon points="18,32 54,32 34,76 14,76" fill="#dce8ff" opacity="0.07"/>`,
    `    </g>`,
    `  </g>`,
    `</svg>`,
    '',
  ].join('\n');
}

function build() {
  const sha = verifyUpstreamPin();

  const modColor = compileUpstreamModule('color.ts', 'modColor');
  const modGeometry = compileUpstreamModule('tv/geometry.ts', 'modGeometry');
  const modLight = compileUpstreamModule('tv/light.ts', 'modLight');
  const modFaces = compileUpstreamModule('tv/faces.ts', 'modFaces');
  const modSim = compileUpstreamModule('tv/sim.ts', 'modSim');
  const modRender = compileUpstreamModule('tv/render.ts', 'modRender', {
    './faces': 'modFaces',
    './geometry': 'modGeometry',
    './light': 'modLight',
  });

  const adapterSrc = fs.readFileSync(path.join(__dirname, 'adapter.js'), 'utf8').trim();

  const bundle = [
    `/*!`,
    ` * NightAvatars engine: robot (robot-heads)`,
    ` * Upstream: https://github.com/fayazara/robot-heads`,
    ` * Version: 0.3.0 | Pinned SHA: ${sha}`,
    ` * License: MIT (Copyright (c) 2026 Fayaz Ahmed) — see LICENSE`,
    ` * Built offline with zero runtime dependencies for classic <script> loading.`,
    ` */`,
    `(function (global) {`,
    `  'use strict';`,
    '',
    modColor,
    '',
    modGeometry,
    '',
    modLight,
    '',
    modFaces,
    '',
    modSim,
    '',
    modRender,
    '',
    `  /* ── Local NightAvatars adapter (from adapter.js) ── */`,
    indent(adapterSrc, 2),
    '',
    `  const upstream = {`,
    `    parseColor: modColor.parseColor,`,
    `    HEAD: modGeometry.HEAD,`,
    `    INSET: modGeometry.INSET,`,
    `    getShape: modGeometry.getShape,`,
    `    headMeshes: modGeometry.headMeshes,`,
    `    rotate: modGeometry.rotate,`,
    `    rotation: modGeometry.rotation,`,
    `    KEY: modLight.KEY,`,
    `    linear: modLight.linear,`,
    `    radiance: modLight.radiance,`,
    `    css: modLight.css,`,
    `    shadeCss: modLight.shadeCss,`,
    `    luma: modLight.luma,`,
    `    COLS: modFaces.COLS,`,
    `    ROWS: modFaces.ROWS,`,
    `    FACES: modFaces.FACES,`,
    `    LIGHTS: modFaces.LIGHTS,`,
    `    makeGrid: modFaces.makeGrid,`,
    `    RobotSim: modSim.RobotSim,`,
    `    restPose: modSim.restPose,`,
    `    RobotRenderer: modRender.RobotRenderer,`,
    `    frameFor: modRender.frameFor,`,
    `  };`,
    '',
    `  const engine = createRobotAvatarEngine(upstream);`,
    `  if (global && global.NightAvatars && typeof global.NightAvatars.register === 'function') {`,
    `    global.NightAvatars.register(engine);`,
    `  }`,
    `})(typeof window !== 'undefined' ? window : globalThis);`,
    '',
  ].join('\n');

  // Syntax-check classic script before writing
  new vm.Script(bundle, { filename: 'engine.js' });

  fs.copyFileSync(path.join(UPSTREAM_DIR, 'LICENSE'), path.join(DELIVERY_DIR, 'LICENSE.txt'));
  const outEnginePath = path.join(DELIVERY_DIR, 'engine.js');
  fs.writeFileSync(outEnginePath, bundle, 'utf8');
  targetWebView(outEnginePath);

  // Extract VARIANT_SPECS from adapter.js to generate matching SVG thumbnails
  const specsMatch = adapterSrc.match(/var VARIANT_SPECS = (\[[\s\S]*?\n  \]);/);
  if (!specsMatch) throw new Error('Could not locate VARIANT_SPECS in adapter.js');
  const variantSpecs = vm.runInNewContext('(' + specsMatch[1] + ')');

  const thumbsDir = path.join(DELIVERY_DIR, 'thumbs');
  fs.mkdirSync(thumbsDir, { recursive: true });
  for (const spec of variantSpecs) {
    const svg = buildThumbSvg(spec);
    const thumbFile = path.join(thumbsDir, `${spec.id}.svg`);
    fs.writeFileSync(thumbFile, svg, 'utf8');
  }

  console.log(`Built engine.js (${Buffer.byteLength(bundle, 'utf8')} bytes)`);
  console.log(`Generated ${variantSpecs.length} SVG thumbnails in thumbs/`);
}

build();
