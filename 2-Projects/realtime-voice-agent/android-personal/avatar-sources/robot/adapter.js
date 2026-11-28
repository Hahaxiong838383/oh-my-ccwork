/**
 * NightAvatars adapter for fayazara/robot-heads (MIT, pinned commit 58ebf6439a8125a769f63b22ffd35bc18834b1b5).
 *
 * This file is the maintainable source of truth for the NightAvatars <-> robot-heads bridge.
 * Built into self-contained classic script `engine.js` via `outside-delivery/build.mjs`.
 *
 * Design notes:
 * - Uses upstream `src/color.ts`, `src/tv/geometry.ts`, `src/tv/light.ts`,
 *   `src/tv/faces.ts`, `src/tv/sim.ts`, and `src/tv/render.ts` verbatim.
 * - Host-driven animation loop (`update(frame)`) — no internal rAF or global pointer listeners.
 * - Canvas fits strictly inside the square `host` container with headroom for hops, antenna glow, and floor shadow.
 * - Real-time voice levels (`level`, `localLevel`, `remoteLevel`) and `mood` modulate LED mouth/EQ,
 *   antenna brightness, and head dynamics while preserving upstream spring physics and aesthetics.
 */

function createRobotAvatarEngine(upstream) {
  'use strict';

  var parseColor = upstream.parseColor;
  var getShape = upstream.getShape;
  var linear = upstream.linear;
  var FACES = upstream.FACES;
  var LIGHTS = upstream.LIGHTS;
  var RobotSim = upstream.RobotSim;
  var restPose = upstream.restPose;
  var RobotRenderer = upstream.RobotRenderer;

  /* ── Built-in variants (all 4 upstream shapes + curated upstream playground swatches) ── */
  var VARIANT_SPECS = [
    {
      id: 'rectangle',
      label: '经典 TV',
      shape: 'rectangle',
      color: '#2b49a3',
      trimColor: '#93a6c8',
      screenColor: '#e8f2ff',
      antenna: true,
      followThemeColor: true,
      thumb: 'avatars/robot/thumbs/rectangle.svg',
    },
    {
      id: 'square',
      label: '方屏',
      shape: 'square',
      color: '#2b49a3',
      trimColor: '#93a6c8',
      screenColor: '#e8f2ff',
      antenna: true,
      followThemeColor: true,
      thumb: 'avatars/robot/thumbs/square.svg',
    },
    {
      id: 'circle',
      label: '舷窗圆屏',
      shape: 'circle',
      color: '#2b49a3',
      trimColor: '#93a6c8',
      screenColor: '#e8f2ff',
      antenna: true,
      followThemeColor: true,
      thumb: 'avatars/robot/thumbs/circle.svg',
    },
    {
      id: 'hexagon',
      label: '六角螺母',
      shape: 'hexagon',
      color: '#2b49a3',
      trimColor: '#93a6c8',
      screenColor: '#e8f2ff',
      antenna: true,
      followThemeColor: true,
      thumb: 'avatars/robot/thumbs/hexagon.svg',
    },
    {
      id: 'tv-tomato',
      label: '番茄红 TV',
      shape: 'rectangle',
      color: '#c8372d',
      trimColor: '#c9a45c',
      screenColor: '#ffc46b',
      antenna: true,
      followThemeColor: false,
      thumb: 'avatars/robot/thumbs/tv-tomato.svg',
    },
    {
      id: 'square-mint',
      label: '矩阵薄荷',
      shape: 'square',
      color: '#2f8f58',
      trimColor: '#c4c9d2',
      screenColor: '#7dff9a',
      antenna: true,
      followThemeColor: false,
      thumb: 'avatars/robot/thumbs/square-mint.svg',
    },
    {
      id: 'circle-porcelain',
      label: '白瓷冰蓝',
      shape: 'circle',
      color: '#e6e6ea',
      trimColor: '#93a6c8',
      screenColor: '#7fe7ff',
      antenna: true,
      followThemeColor: false,
      thumb: 'avatars/robot/thumbs/circle-porcelain.svg',
    },
    {
      id: 'hex-graphite',
      label: '石墨琥珀',
      shape: 'hexagon',
      color: '#3a3d44',
      trimColor: '#c27a52',
      screenColor: '#ffc46b',
      antenna: true,
      followThemeColor: false,
      thumb: 'avatars/robot/thumbs/hex-graphite.svg',
    },
    {
      id: 'circle-bubblegum',
      label: '霓虹粉圆',
      shape: 'circle',
      color: '#d9558f',
      trimColor: '#c4c9d2',
      screenColor: '#ff8fd0',
      antenna: true,
      followThemeColor: false,
      thumb: 'avatars/robot/thumbs/circle-bubblegum.svg',
    },
    {
      id: 'tv-compact',
      label: '碧青紧凑',
      shape: 'rectangle',
      color: '#1f8189',
      trimColor: '#c4c9d2',
      screenColor: '#7fe7ff',
      antenna: false,
      followThemeColor: false,
      thumb: 'avatars/robot/thumbs/tv-compact.svg',
    },
    {
      id: 'square-grape',
      label: '紫罗兰方屏',
      shape: 'square',
      color: '#6a45b8',
      trimColor: '#c9a45c',
      screenColor: '#7fe7ff',
      antenna: true,
      followThemeColor: false,
      thumb: 'avatars/robot/thumbs/square-grape.svg',
    },
    {
      id: 'hex-tangerine',
      label: '复古橘六角',
      shape: 'hexagon',
      color: '#e2762a',
      trimColor: '#2a2c31',
      screenColor: '#ffc46b',
      antenna: true,
      followThemeColor: false,
      thumb: 'avatars/robot/thumbs/hex-tangerine.svg',
    },
  ];

  var VARIANT_MAP = Object.create(null);
  for (var vi = 0; vi < VARIANT_SPECS.length; vi++) {
    VARIANT_MAP[VARIANT_SPECS[vi].id] = VARIANT_SPECS[vi];
  }

  /* ── Built-in expressions (all 9 upstream states + upstream poke spin-hop reaction) ── */
  var EXPRESSIONS = [
    { id: 'idle', label: '待机' },
    { id: 'happy', label: '开心' },
    { id: 'thinking', label: '思考' },
    { id: 'searching', label: '搜索' },
    { id: 'listening', label: '聆听' },
    { id: 'speaking', label: '说话' },
    { id: 'working', label: '工作中' },
    { id: 'error', label: '出错' },
    { id: 'sleeping', label: '休眠' },
    { id: 'poke', label: '转圈互动' },
  ];

  var VALID_STATES = {
    idle: true,
    thinking: true,
    searching: true,
    listening: true,
    speaking: true,
    working: true,
    happy: true,
    error: true,
    sleeping: true,
  };

  /* ── Helpers ── */
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function clamp01(v) {
    return typeof v === 'number' && isFinite(v) ? clamp(v, 0, 1) : 0;
  }

  function finiteOr(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  function hashSeed(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    }
    return ((h >>> 0) % 1000) / 1000;
  }

  function systemReducedMotion() {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function makePalette(shellHex, trimHex, screenHex) {
    var shell = parseColor(shellHex) || [43, 73, 163];
    var metal = parseColor(trimHex) || [147, 166, 200];
    var led = parseColor(screenHex) || [232, 242, 255];
    return {
      shell: { albedo: linear(shell), f0: 0.05, metal: 0.15, spec: 0.55, shininess: 70, rim: 0.9 },
      trim: { albedo: linear(metal), f0: 0.2, metal: 0.65, spec: 0.8, shininess: 45, rim: 0.7 },
      led: led,
    };
  }

  /**
   * Compute a Frame that fits strictly inside a `box × box` square host,
   * reserving headroom for hops, antenna glow, and floor shadow so nothing clips
   * even when the host has `overflow: hidden`.
   */
  function fitFrameFor(shape, antenna, box) {
    var topAtRest = shape.hy + (antenna ? 0.322 : 0.036);
    var headroom = antenna ? 0.30 : 0.24;
    var below = shape.hy + 0.20;
    var halfWide = shape.earX + 0.185;
    var totalTall = topAtRest + headroom + below;
    var totalWide = 2 * halfWide;
    var usable = box * 0.96;
    var unit = Math.min(usable / totalTall, usable / totalWide);
    var topMargin = (box - totalTall * unit) / 2;
    return {
      box: box,
      padTop: 0,
      padBottom: 0,
      padSide: 0,
      unit: unit,
      cx: box / 2,
      cy: topMargin + (topAtRest + headroom) * unit,
    };
  }

  function measureHostSquare(host) {
    if (!host) return 0;
    var w = 0;
    var h = 0;
    if (typeof host.getBoundingClientRect === 'function') {
      var rect = host.getBoundingClientRect();
      w = rect.width || 0;
      h = rect.height || 0;
    }
    if (!w && host.clientWidth) w = host.clientWidth;
    if (!h && host.clientHeight) h = host.clientHeight;
    if (!w && host.style && host.style.width) w = parseFloat(host.style.width) || 0;
    if (!h && host.style && host.style.height) h = parseFloat(host.style.height) || 0;
    var size = w && h ? Math.min(w, h) : Math.max(w, h);
    return Math.round(size);
  }

  /* ── Synchronous draw context for non-invasive upstream FACES / LIGHTS audio & mood hooks ── */
  var _renderCtx = null;
  var _hooksInstalled = false;

  function gridPut(g, c, r, v) {
    var x = c + g.ox;
    var y = r + g.oy;
    if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return;
    var i = y * g.cols + x;
    if (v > g.v[i]) g.v[i] = v;
  }

  function gridRect(g, c, r, w, h, v) {
    for (var y = r; y < r + h; y++) {
      for (var x = c; x < c + w; x++) gridPut(g, x, y, v);
    }
  }

  function drawBlockEyes(g, f, h, v, dy, lid) {
    var dx = Math.round(f.lookX);
    var ly = Math.round(f.lookY) + (dy || 0);
    var open = Math.max(1, Math.round(h - (h - 1) * f.blink));
    var top = 5 + Math.floor((4 - h) / 2) + ly + Math.floor((h - open) / 2);
    var cols = [6, 13];
    for (var k = 0; k < 2; k++) {
      var c = cols[k];
      if (lid > 0 && open > 1) {
        gridRect(g, c + dx, top, 3, 1, v * (1 - lid));
        gridRect(g, c + dx, top + 1, 3, open - 1, v);
      } else {
        gridRect(g, c + dx, top, 3, open, v);
      }
    }
  }

  function faceNoise(x) {
    return 0.5 + 0.25 * Math.sin(x * 1.7) + 0.15 * Math.sin(x * 3.1 + 1.3) + 0.1 * Math.sin(x * 5.3 + 4.1);
  }

  function installUpstreamHooks() {
    if (_hooksInstalled) return;
    _hooksInstalled = true;

    var origIdle = FACES.idle;
    var origListening = FACES.listening;
    var origSpeaking = FACES.speaking;
    var origSleeping = FACES.sleeping;
    var origListeningPulse = LIGHTS.listening.pulse;
    var origSpeakingPulse = LIGHTS.speaking.pulse;

    FACES.idle = function (g, f) {
      var rc = _renderCtx;
      if (rc && rc.moodLid > 0.01) {
        drawBlockEyes(g, f, 4, 1, 0, rc.moodLid);
        return;
      }
      origIdle(g, f);
    };

    FACES.listening = function (g, f) {
      var rc = _renderCtx;
      if (!rc || (!rc.listenAudioActive && !rc.reduced)) {
        origListening(g, f);
        return;
      }
      drawBlockEyes(g, f, 4, 1, -1, rc.moodLid * 0.5);
      var amp = rc.listenAmp;
      var t = rc.reduced ? 0.4 : f.time;
      for (var i = 0; i < 12; i++) {
        var centre = 1 - Math.abs(i - 5.5) / 7;
        var wave = rc.reduced
          ? (0.55 + 0.45 * Math.cos((i - 5.5) * 0.55))
          : (0.48 + 0.52 * faceNoise(t * 9.5 + i * 1.9 + f.seed * 10));
        var scaled = wave * centre * (0.14 + amp * 1.05 * rc.energy);
        var h = Math.max(1, Math.min(4, Math.round(scaled * 4.2)));
        var baseBright = clamp(0.42 + amp * 0.52, 0.35, 0.96);
        for (var k = 0; k < h; k++) {
          gridPut(g, 5 + i, 12 - k, Math.max(0.2, baseBright - k * 0.11));
        }
      }
    };

    FACES.speaking = function (g, f) {
      var rc = _renderCtx;
      if (!rc || (!rc.speakAudioActive && !rc.reduced)) {
        origSpeaking(g, f);
        return;
      }
      drawBlockEyes(g, f, 4, 1, -1, rc.moodLid * 0.6);
      var amp = rc.speakAmp;
      if (rc.reduced) {
        var staticAmp = rc.speakAudioActive ? amp : 0.45;
        for (var j = 0; j < 8; j++) {
          var cMid = 1 - Math.abs(j - 3.5) / 4.8;
          var sh = staticAmp < 0.05 ? 1 : (staticAmp * cMid > 0.45 ? 3 : staticAmp * cMid > 0.2 ? 2 : 1);
          var sTop = sh === 3 ? 10 : 11;
          gridRect(g, 7 + j, sTop, 1, sh, staticAmp < 0.05 ? 0.6 : 0.95);
        }
        return;
      }
      if (amp < 0.03) {
        /* crisp lip closure during pauses between words */
        gridRect(g, 8, 11, 6, 1, 0.62);
        return;
      }
      for (var i = 0; i < 8; i++) {
        var centre = 1 - Math.abs(i - 3.5) / 4.6;
        var wave = 0.52 + 0.48 * faceNoise(f.time * 13.5 + i * 1.15 + f.seed * 7);
        var a = amp * wave * centre * 1.2 * rc.energy;
        var h = a > 0.66 ? 4 : a > 0.38 ? 3 : a > 0.16 ? 2 : 1;
        var top = h === 4 ? 9 : h === 3 ? 10 : 11;
        gridRect(g, 7 + i, top, 1, h, clamp(0.75 + amp * 0.3, 0.7, 1));
      }
    };

    FACES.sleeping = function (g, f) {
      var rc = _renderCtx;
      if (rc && rc.muted) {
        /* dim shut eyes (identical geometry to upstream sleeping) + quiet muted line, no Z's */
        var eyeCols = [6, 13];
        for (var k = 0; k < 2; k++) {
          var c = eyeCols[k];
          gridPut(g, c - 1, 7, 0.32);
          gridRect(g, c, 8, 3, 1, 0.42);
          gridPut(g, c + 3, 7, 0.32);
        }
        gridRect(g, 8, 11, 6, 1, 0.28);
        return;
      }
      origSleeping(g, f);
    };

    LIGHTS.listening.pulse = function (t) {
      var rc = _renderCtx;
      if (rc && rc.listenAudioActive) {
        return clamp(0.55 + rc.listenAmp * 0.45, 0.5, 1);
      }
      return origListeningPulse(t);
    };

    LIGHTS.speaking.pulse = function (t) {
      var rc = _renderCtx;
      if (rc && rc.speakAudioActive) {
        return clamp(0.32 + rc.speakAmp * 0.68, 0.3, 1);
      }
      return origSpeakingPulse(t);
    };
  }

  /* ── Mood & Phase mapping ── */
  function analyzeMood(moodRaw) {
    var m = typeof moodRaw === 'string' ? moodRaw.trim().toLowerCase() : '';
    if (!m || m === 'neutral' || m === 'default') {
      return { idleState: null, energy: 1.0, speed: 1.0, pitchBias: 0, lid: 0 };
    }
    if (m === 'happy' || m === 'joy' || m === 'joyful' || m === 'excited' || m === 'delighted' || m === 'playful' || m === 'cheerful' || m === 'love' || m === 'smile') {
      return { idleState: 'happy', energy: 1.25, speed: 1.12, pitchBias: 0.04, lid: 0 };
    }
    if (m === 'working' || m === 'focused' || m === 'busy' || m === 'coding' || m === 'concentrated') {
      return { idleState: 'working', energy: 0.92, speed: 0.98, pitchBias: -0.05, lid: 0.14 };
    }
    if (m === 'curious' || m === 'searching' || m === 'exploring' || m === 'scanning' || m === 'wonder') {
      return { idleState: 'searching', energy: 1.08, speed: 1.05, pitchBias: 0.03, lid: 0 };
    }
    if (m === 'sleepy' || m === 'tired' || m === 'sleeping' || m === 'doze' || m === 'bored') {
      return { idleState: 'sleeping', energy: 0.65, speed: 0.72, pitchBias: -0.1, lid: 0.42 };
    }
    if (m === 'confused' || m === 'puzzled' || m === 'thinking') {
      return { idleState: 'thinking', energy: 0.9, speed: 0.92, pitchBias: 0.04, lid: 0.2 };
    }
    if (m === 'error' || m === 'failed' || m === 'crash') {
      return { idleState: 'error', energy: 1.15, speed: 1.1, pitchBias: -0.04, lid: 0 };
    }
    if (m === 'angry' || m === 'urgent' || m === 'alert' || m === 'frustrated') {
      return { idleState: null, energy: 1.28, speed: 1.18, pitchBias: -0.06, lid: 0.34 };
    }
    if (m === 'sad' || m === 'down' || m === 'upset' || m === 'worried' || m === 'melancholy') {
      return { idleState: null, energy: 0.68, speed: 0.76, pitchBias: -0.14, lid: 0.44 };
    }
    if (m === 'calm' || m === 'relaxed' || m === 'gentle' || m === 'warm' || m === 'serene') {
      return { idleState: null, energy: 0.8, speed: 0.86, pitchBias: 0.01, lid: 0 };
    }
    return { idleState: null, energy: 1.0, speed: 1.0, pitchBias: 0, lid: 0 };
  }

  function resolveVariant(variantId) {
    if (typeof variantId === 'string') {
      var key = variantId.trim().toLowerCase();
      if (VARIANT_MAP[key]) return VARIANT_MAP[key];
      if (key === 'default' || key === 'tv') return VARIANT_SPECS[0];
    }
    return VARIANT_SPECS[0];
  }

  function disposeRenderer(renderer) {
    if (!renderer) return;
    /* Release only instance-owned canvases; never touch shared `front`/`back`/`glass` bakes */
    var owned = ['screen', 'screenBase', 'layer', 'tiny', 'tinyHalf'];
    for (var i = 0; i < owned.length; i++) {
      var c = renderer[owned[i]];
      if (c && typeof c === 'object') {
        c.width = 0;
        c.height = 0;
      }
      renderer[owned[i]] = null;
    }
    renderer.grain = null;
    renderer.tinyImg = null;
  }

  /* ── Mount lifecycle ── */
  function mount(host, variantId) {
    if (!host) throw new Error('NightAvatars robot: mount(host) requires a DOM element');
    installUpstreamHooks();

    var spec = resolveVariant(variantId);
    var shape = getShape(spec.shape);
    var destroyed = false;

    /* Create self-contained canvas inside host */
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'none';
    host.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    var renderer = new RobotRenderer();
    var seed = hashSeed(spec.id + ':' + Math.floor(Math.random() * 10000));
    var sim = new RobotSim(seed, 'idle');
    /* Start just past the dark 0.08s mark so power-on wipe opens crisply when animated */
    sim.age = 0.12;

    var lastFrameTimeMs = NaN;
    var elapsedSec = 0;
    var boxSize = measureHostSquare(host);
    var currentColorKey = spec.color;
    var palette = makePalette(spec.color, spec.trimColor, spec.screenColor);

    /* State & interaction tracking */
    var currentPhase = 'idle';
    var lastResolvedState = 'idle';
    var currentMood = analyzeMood('');
    var currentReduced = systemReducedMotion();
    var isMuted = false;

    /* Audio envelope state */
    var speakAmp = 0;
    var listenAmp = 0;
    var speakAudioSeen = false;
    var listenAudioSeen = false;
    var speakPhaseActive = false;

    /* Gaze & touch tracking */
    var lastGazeX = 0;
    var lastGazeY = 0;
    var gazeActiveUntil = -1;
    var touchGaze = null;
    var dragX = 0;
    var dragY = 0;
    var dragWeight = 0;

    /* Express preview override */
    var expressState = null;
    var voiceExpression = false;
    var renderedId = '';
    var expressUntil = -1;
    var reducedReactUntil = -1;

    /* Static redraw cache for reduced motion */
    var lastStaticSig = '';

    function syncCanvasSize() {
      var measured = measureHostSquare(host);
      if (measured >= 8) boxSize = measured;
      if (boxSize < 8) return null;
      var dpr = Math.min(2, (typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number' && window.devicePixelRatio) || 1);
      var px = Math.round(boxSize * dpr);
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px;
        canvas.height = px;
        lastStaticSig = '';
      }
      return { dpr: dpr, frame: fitFrameFor(shape, spec.antenna, boxSize) };
    }

    function updatePalette(frameColor, customColor) {
      var useFrameColor = customColor === true || spec.followThemeColor;
      var nextColor = (useFrameColor && typeof frameColor === 'string' && frameColor.trim() && parseColor(frameColor))
        ? frameColor.trim()
        : spec.color;
      if (nextColor !== currentColorKey) {
        currentColorKey = nextColor;
        palette = makePalette(nextColor, spec.trimColor, spec.screenColor);
        lastStaticSig = '';
      }
    }

    function resolveTargetState(frame) {
      var phase = (frame && typeof frame.phase === 'string') ? frame.phase.trim().toLowerCase() : 'idle';
      var rawState = (frame && typeof frame.state === 'string') ? frame.state.trim().toLowerCase() : '';
      var validRawState = VALID_STATES[rawState] ? rawState : null;

      /* Cancel express preview early if phase transitions from idle into an active phase */
      if (phase !== currentPhase) {
        if (phase === 'speaking') {
          speakAudioSeen = false;
          speakPhaseActive = true;
        } else {
          speakPhaseActive = false;
        }
        if (phase === 'listening') {
          listenAudioSeen = false;
        }
        if (expressState && !voiceExpression && phase !== 'idle') {
          expressState = null;
          expressUntil = -1;
        }
        currentPhase = phase;
      }

      if (expressState && elapsedSec < expressUntil) {
        isMuted = false;
        return expressState;
      }
      expressState = null;

      isMuted = (phase === 'muted');
      if (phase === 'error') return 'error';
      if (phase === 'muted') return 'sleeping';
      if (phase === 'connecting') return 'searching';
      if (phase === 'speaking') return 'speaking';
      if (phase === 'listening') return 'listening';
      if (phase === 'thinking') {
        if (validRawState === 'searching' || validRawState === 'working') return validRawState;
        if (currentMood.idleState === 'working') return 'working';
        return 'thinking';
      }

      /* idle / default phase */
      if (validRawState && validRawState !== 'idle') return validRawState;
      if (currentMood.idleState) return currentMood.idleState;
      return 'idle';
    }

    function drawCurrent(animated) {
      if (destroyed || !ctx) return;
      var metrics = syncCanvasSize();
      if (!metrics) return;

      var shownState = animated ? sim.shown : (elapsedSec < reducedReactUntil ? 'happy' : lastResolvedState);
      renderedId = (animated ? sim.time < sim.reactUntil : elapsedSec < reducedReactUntil) ? 'poke' : shownState;
      var rc = {
        reduced: !animated,
        muted: isMuted && shownState === 'sleeping' && !expressState,
        speakAmp: speakAmp,
        listenAmp: listenAmp,
        speakAudioActive: speakAudioSeen,
        listenAudioActive: listenAudioSeen,
        energy: currentMood.energy,
        moodLid: currentMood.lid,
      };

      if (!animated) {
        var qSpeak = Math.round(speakAmp * 4);
        var qListen = Math.round(listenAmp * 4);
        var sig = [
          shownState,
          rc.muted ? 1 : 0,
          currentColorKey,
          metrics.frame.box,
          metrics.dpr,
          dragX, dragY,
          rc.speakAudioActive ? qSpeak : -1,
          rc.listenAudioActive ? qListen : -1,
          Math.round(rc.moodLid * 10),
        ].join('|');
        if (sig === lastStaticSig) return;
        lastStaticSig = sig;
      } else {
        lastStaticSig = '';
      }

      var pose;
      if (animated) {
        var sp = sim.pose;
        var extraPitch = currentMood.pitchBias;
        var extraBob = 0;
        var extraRoll = 0;
        var extraAntZ = 0;

        if (shownState === 'speaking' && speakAudioSeen) {
          extraPitch += speakAmp * 0.055 * Math.sin(sim.time * 10.5) * currentMood.energy;
          extraBob += speakAmp * 0.02 * currentMood.energy;
          extraAntZ += speakAmp * 0.08 * Math.sin(sim.time * 9.0);
        } else if (shownState === 'listening' && listenAudioSeen) {
          extraPitch += listenAmp * 0.035;
          extraRoll += listenAmp * 0.04;
          extraBob += listenAmp * 0.008;
        } else if (shownState === 'idle' && listenAmp > 0.15) {
          extraPitch += listenAmp * 0.03;
        }

        pose = {
          // Replace the simulated resting direction while held; yaw from hops
          // and spins stays additive. The same pose projects shell, glass and ears.
          yaw: sp.yaw - sim.yaw.x * dragWeight + dragX * 0.92,
          pitch: clamp(sp.pitch + extraPitch, -0.55, 0.45) - sim.pitch.x * dragWeight - dragY * 0.65,
          roll: clamp(sp.roll + extraRoll, -0.45, 0.45),
          x: sp.x,
          lift: sp.lift + extraBob,
          sx: sp.sx,
          sy: sp.sy,
          antennaX: sp.antennaX,
          antennaZ: clamp(sp.antennaZ + extraAntZ, -0.7, 0.7),
        };
      } else {
        pose = restPose(shownState);
        pose.yaw += dragX * 0.2;
        pose.pitch -= dragY * 0.14;
      }

      _renderCtx = rc;
      try {
        renderer.draw(
          ctx,
          metrics.frame,
          metrics.dpr,
          pose,
          animated ? sim : null,
          shownState,
          shape,
          palette,
          { floorShadow: true, antenna: spec.antenna }
        );
      } finally {
        _renderCtx = null;
      }
    }

    function updateAudioEnvelopes(frame, dt) {
      var overall = clamp01(frame && frame.level);
      var local = clamp01(frame && frame.localLevel);
      var remote = clamp01(frame && frame.remoteLevel);

      var rawSpeak = Math.max(remote, currentPhase === 'speaking' ? overall : 0);
      var rawListen = Math.max(local, currentPhase === 'listening' ? overall : 0);

      if (rawSpeak > 0.02) speakAudioSeen = true;
      if (rawListen > 0.02) listenAudioSeen = true;

      /* Asymmetric envelope follower: crisp attack, smooth decay */
      var attack = 1 - Math.exp(-dt / 0.028);
      var release = 1 - Math.exp(-dt / 0.13);

      speakAmp += (rawSpeak - speakAmp) * (rawSpeak > speakAmp ? attack : release);
      listenAmp += (rawListen - listenAmp) * (rawListen > listenAmp ? attack : release);
      if (speakAmp < 0.002) speakAmp = 0;
      if (listenAmp < 0.002) listenAmp = 0;

      /* Subtle listening micro-nod when user voice spikes */
      if (currentPhase === 'listening' && rawListen > 0.35 && listenAmp < 0.25 && !currentReduced) {
        sim.pitch && (sim.pitch.v -= 0.45 * rawListen);
      }
    }

    function updateDrag(frame, dt) {
      var held = frame.pointerActive === true;
      var x = held ? clamp(finiteOr(frame.gazeX, 0), -1, 1) : 0;
      var y = held ? clamp(finiteOr(frame.gazeY, 0), -1, 1) : 0;
      if (currentReduced) {
        // A few static directions report intent without playing a turn animation.
        dragX = Math.round(x * 4) / 4;
        dragY = Math.round(y * 4) / 4;
        dragWeight = held ? 1 : 0;
        return;
      }
      var blend = 1 - Math.exp(-dt * (held ? 15 : 7));
      dragX += (x - dragX) * blend;
      dragY += (y - dragY) * blend;
      dragWeight += ((held ? 1 : 0) - dragWeight) * blend;
    }

    function updateGaze(frame) {
      var hasGaze = frame && (typeof frame.gazeX === 'number' || typeof frame.gazeY === 'number');
      var gx = hasGaze ? clamp(finiteOr(frame.gazeX, 0), -1, 1) : 0;
      var gy = hasGaze ? clamp(finiteOr(frame.gazeY, 0), -1, 1) : 0;

      if (hasGaze) {
        var moved = Math.abs(gx - lastGazeX) > 0.015 || Math.abs(gy - lastGazeY) > 0.015;
        var nonCenter = Math.hypot(gx, gy) > 0.02;
        if (moved || nonCenter) {
          gazeActiveUntil = elapsedSec + 1.2;
        }
        lastGazeX = gx;
        lastGazeY = gy;
      }

      if (touchGaze && elapsedSec < touchGaze.until) {
        sim.pointer = { x: touchGaze.x * 260, y: touchGaze.y * 260 };
      } else {
        touchGaze = null;
        if (hasGaze && elapsedSec < gazeActiveUntil) {
          sim.pointer = { x: gx * 260, y: gy * 260 };
        } else {
          sim.pointer = null;
        }
      }
    }

    /* Resize handling */
    var ro = null;
    var onWindowResize = null;
    function handleResize() {
      if (destroyed) return;
      var measured = measureHostSquare(host);
      if (measured >= 8 && measured !== boxSize) {
        boxSize = measured;
        lastStaticSig = '';
        drawCurrent(!currentReduced && lastFrameTimeMs === lastFrameTimeMs);
      }
    }

    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(handleResize);
      ro.observe(host);
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      onWindowResize = handleResize;
      window.addEventListener('resize', onWindowResize);
    }

    /* Immediate static paint so host is never blank before first update() */
    drawCurrent(false);

    return {
      update: function (frame) {
        if (destroyed) return;
        frame = frame || {};

        /* Compute dt in seconds from frame.time (ms) */
        var nowMs = (typeof frame.time === 'number' && isFinite(frame.time))
          ? frame.time
          : (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
        var dt = 0;
        if (lastFrameTimeMs === lastFrameTimeMs) {
          var deltaSec = (nowMs - lastFrameTimeMs) / 1000;
          if (deltaSec > 0) dt = Math.min(0.1, deltaSec);
        } else {
          dt = 1 / 60;
        }
        lastFrameTimeMs = nowMs;
        elapsedSec += dt;

        currentReduced = (typeof frame.reduced === 'boolean') ? frame.reduced : systemReducedMotion();
        currentMood = analyzeMood(frame.mood);
        updatePalette(frame.color, frame.customColor);
        var targetState = resolveTargetState(frame);
        lastResolvedState = targetState;
        updateAudioEnvelopes(frame, dt > 0 ? dt : 1 / 60);
        sim.setState(targetState);
        updateDrag(frame, dt);

        if (currentReduced) {
          drawCurrent(false);
          return;
        }

        updateGaze(frame);
        if (dt > 0) {
          var speedMult = currentMood.speed * (speakPhaseActive && speakAudioSeen ? (0.95 + speakAmp * 0.25) : 1);
          sim.update(dt * speedMult);
        }
        drawCurrent(true);
      },

      touch: function (x, y) {
        if (destroyed) return;
        var nx = 0;
        var ny = 0;
        if (typeof x === 'number' && isFinite(x) && typeof y === 'number' && isFinite(y)) {
          if (x < 0 || y < 0) {
            /* Already normalized -1..1 */
            nx = clamp(x, -1, 1);
            ny = clamp(y, -1, 1);
          } else if (x <= 1 && y <= 1) {
            /* Normalized 0..1 */
            nx = clamp((x - 0.5) * 2, -1, 1);
            ny = clamp((y - 0.5) * 2, -1, 1);
          } else {
            /* Local CSS pixels inside host */
            var sz = Math.max(1, boxSize || measureHostSquare(host) || 160);
            nx = clamp((x / sz - 0.5) * 2, -1, 1);
            ny = clamp((y / sz - 0.5) * 2, -1, 1);
          }
        }

        touchGaze = { x: nx, y: ny, until: elapsedSec + 1.8 };
        if (currentReduced) {
          reducedReactUntil = elapsedSec + 1.4;
          lastStaticSig = '';
          drawCurrent(false);
          return;
        }
        /* Steer spin direction by tap side, then trigger upstream poke happy reaction */
        sim.hop(0.24, nx >= 0 ? 1 : -1);
        sim.poke();
        if (lastFrameTimeMs !== lastFrameTimeMs) {
          sim.update(1 / 60);
          drawCurrent(true);
        }
      },

      currentExpression: function () { return renderedId; },
      endVoiceExpression: function () {
        if (voiceExpression) { sim.reactUntil = -1; this.express('idle'); }
      },

      express: function (id, voice) {
        if (destroyed) return;
        var key = typeof id === 'string' ? id.trim().toLowerCase() : '';
        if (!key) return;

        voiceExpression = voice === true;
        if (key === 'poke') {
          if (currentReduced) {
            reducedReactUntil = elapsedSec + 1.6;
            lastStaticSig = '';
            drawCurrent(false);
          } else {
            sim.poke();
            if (lastFrameTimeMs !== lastFrameTimeMs) {
              sim.update(1 / 60);
              drawCurrent(true);
            }
          }
          return;
        }

        if (!VALID_STATES[key]) return;

        if (voiceExpression) { sim.reactUntil = -1; reducedReactUntil = -1; }
        if (key === 'idle' && !voiceExpression) {
          expressState = null;
          expressUntil = -1;
          reducedReactUntil = -1;
          lastResolvedState = 'idle';
          sim.setState('idle');
        } else {
          expressState = key;
          expressUntil = elapsedSec + 3.5;
          lastResolvedState = key;
          isMuted = false;
          sim.setState(key);
        }

        lastStaticSig = '';
        if (currentReduced || lastFrameTimeMs !== lastFrameTimeMs) {
          drawCurrent(!currentReduced && lastFrameTimeMs === lastFrameTimeMs);
        }
      },

      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (ro) {
          ro.disconnect();
          ro = null;
        }
        if (onWindowResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('resize', onWindowResize);
          onWindowResize = null;
        }
        disposeRenderer(renderer);
        renderer = null;
        sim = null;
        ctx = null;
        canvas.width = 0;
        canvas.height = 0;
        if (canvas.parentNode) {
          canvas.parentNode.removeChild(canvas);
        }
        canvas = null;
      },
    };
  }

  return {
    id: 'robot',
    title: 'robot-heads',
    variants: VARIANT_SPECS.map(function (v) {
      return { id: v.id, label: v.label, thumb: v.thumb };
    }),
    expressions: EXPRESSIONS.map(function (e) {
      return { id: e.id, label: e.label };
    }),
    mount: mount,
  };
}
