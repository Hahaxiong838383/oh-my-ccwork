(function (global) {
  'use strict';

  var STORAGE_KEY = 'xiaoke.night.accent.v1';
  var DEFAULT_COLOR = '#4F7DF3';
  var MAX_STATUS_LEN = 96;

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function normalizeHex(raw) {
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return (
        '#' +
        s[1] + s[1] +
        s[2] + s[2] +
        s[3] + s[3]
      ).toUpperCase();
    }
    return null;
  }

  function hexToRgb(hex) {
    var clean = normalizeHex(hex) || DEFAULT_COLOR;
    var n = parseInt(clean.slice(1), 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255
    };
  }

  function rgbToHsl(r, g, b) {
    var rn = r / 255;
    var gn = g / 255;
    var bn = b / 255;
    var max = Math.max(rn, gn, bn);
    var min = Math.min(rn, gn, bn);
    var h = 0;
    var s = 0;
    var l = (max + min) * 0.5;

    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === rn) {
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
      } else if (max === gn) {
        h = (bn - rn) / d + 2;
      } else {
        h = (rn - gn) / d + 4;
      }
      h /= 6;
    }

    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function hsla(h, s, l, a) {
    var hh = ((h % 360) + 360) % 360;
    return (
      'hsla(' +
      hh.toFixed(1) + ',' +
      clamp(s, 0, 100).toFixed(1) + '%,' +
      clamp(l, 0, 100).toFixed(1) + '%,' +
      clamp(a, 0, 1).toFixed(3) + ')'
    );
  }

  function relativeLuminance(rgb) {
    var rs = rgb.r / 255;
    var gs = rgb.g / 255;
    var bs = rgb.b / 255;
    var r = rs <= 0.03928 ? rs / 12.92 : Math.pow((rs + 0.055) / 1.055, 2.4);
    var g = gs <= 0.03928 ? gs / 12.92 : Math.pow((gs + 0.055) / 1.055, 2.4);
    var b = bs <= 0.03928 ? bs / 12.92 : Math.pow((bs + 0.055) / 1.055, 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function readSavedColor() {
    try {
      var stored = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      return normalizeHex(stored) || DEFAULT_COLOR;
    } catch (_) {
      return DEFAULT_COLOR;
    }
  }

  function saveColor(hex) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(STORAGE_KEY, hex);
      }
    } catch (_) {
      // Ignore storage restrictions inside private/restricted WebViews.
    }
  }

  function formatBoundedStatus(raw) {
    if (raw === null || raw === undefined) return '';
    var text = String(raw).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!text) return '';
    if (text.length > MAX_STATUS_LEN) {
      return text.slice(0, MAX_STATUS_LEN - 1) + '…';
    }
    return text;
  }

  function isErrorState(phase, statusText) {
    if (/^(error|failed|fail|fatal|denied|auth_error|unauthorized)$/.test(phase)) {
      return true;
    }
    if (phase.indexOf('err') !== -1 || phase.indexOf('fail') !== -1) {
      return true;
    }
    if (statusText && /(失败|错误|无效|异常|拒绝|超时|断开|error|failed|denied|invalid)/i.test(statusText)) {
      return true;
    }
    return false;
  }

  function isLiveReplyPhase(phase) {
    return (
      phase === 'speaking' ||
      phase === 'replying' ||
      phase === 'duplex' ||
      phase === 'thinking'
    );
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    var rad = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  /**
   * Original pure-Canvas organic deep-blue orb renderer.
   * Speech shapes follow remote playback; the listening pose follows the local microphone.
   */
  function OrganicOrb(canvas, initialColor) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 240;
    this.height = 240;
    this.dpr = 1;

    this.colorHex = DEFAULT_COLOR;
    this.rgb = hexToRgb(DEFAULT_COLOR);
    this.hsl = rgbToHsl(this.rgb.r, this.rgb.g, this.rgb.b);
    this.lum = relativeLuminance(this.rgb);
    this.setColor(initialColor || DEFAULT_COLOR);

    this.phase = 'idle';
    this.active = false;
    this.muted = false;

    // Audio level driven strictly by external real remote playback signal.
    this.targetLevel = 0;
    this.micTarget = 0;
    this.micAmp = 0;
    this.motionPreference = global.matchMedia('(prefers-reduced-motion: reduce)');
    this.amp = 0;
    this.prevAmp = 0;

    // Subtle organic squash/stretch spring excited only by real audio changes.
    this.stretch = 0;
    this.stretchVel = 0;
    this.wavePhase = 0;

    // Eye gaze & natural blinking state.
    this.clock = 0;
    this.gazeX = 0;
    this.gazeY = 0;
    this.targetGazeX = 0;
    this.targetGazeY = 0;
    this.nextGazeAt = 2.4;

    this.blinkPhase = 0;
    this.isBlinking = false;
    this.pendingDoubleBlink = false;
    this.nextBlinkAt = 2.8;

    this._rafId = 0;
    this._lastTs = 0;
    this._running = false;
    this._frame = this._onFrame.bind(this);

    this.resize();
  }

  OrganicOrb.prototype.setColor = function (hex) {
    var clean = normalizeHex(hex) || DEFAULT_COLOR;
    this.colorHex = clean;
    this.rgb = hexToRgb(clean);
    this.hsl = rgbToHsl(this.rgb.r, this.rgb.g, this.rgb.b);
    this.lum = relativeLuminance(this.rgb);
  };

  OrganicOrb.prototype.setState = function (phase, active, muted) {
    this.phase = phase || 'idle';
    this.active = Boolean(active);
    this.muted = Boolean(muted);
    if (!this.active || this.muted) this.micAmp = this.micTarget = 0;
    if (!this.active) this.amp = this.targetLevel = 0;
  };

  OrganicOrb.prototype.setLevel = function (value) {
    var num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num <= 0) {
      this.targetLevel = 0;
    } else if (num >= 1) {
      this.targetLevel = 1;
    } else {
      this.targetLevel = num;
    }
  };

  OrganicOrb.prototype.blink = function () {
    if (!this.isBlinking) {
      this.isBlinking = true;
      this.blinkPhase = 0;
      this.pendingDoubleBlink = false;
      this.nextBlinkAt = this.clock + 3.4 + Math.random() * 2.6;
    }
  };

  OrganicOrb.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var cssW = rect.width > 0 ? rect.width : 240;
    var cssH = rect.height > 0 ? rect.height : 240;
    var dpr = clamp(global.devicePixelRatio || 1, 1, 3);
    var pxW = Math.max(1, Math.round(cssW * dpr));
    var pxH = Math.max(1, Math.round(cssH * dpr));

    if (this.canvas.width !== pxW || this.canvas.height !== pxH || this.dpr !== dpr) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
      this.width = cssW;
      this.height = cssH;
      this.dpr = dpr;
    }
  };

  OrganicOrb.prototype.start = function () {
    if (this._running) return;
    this._running = true;
    this._lastTs = performance.now();
    this._rafId = global.requestAnimationFrame(this._frame);
  };

  OrganicOrb.prototype.stop = function () {
    if (!this._running) return;
    this._running = false;
    if (this._rafId) {
      global.cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
  };

  OrganicOrb.prototype._onFrame = function (now) {
    if (!this._running) return;
    var dt = (now - this._lastTs) / 1000;
    this._lastTs = now;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.05) dt = 0.05;

    this.step(dt);
    this.draw();
    this._rafId = global.requestAnimationFrame(this._frame);
  };

  OrganicOrb.prototype.step = function (dt) {
    this.clock += dt;
    var micTarget = this.phase === 'listening' && !this.muted ? this.micTarget : 0;
    this.micAmp += (micTarget - this.micAmp) * (1 - Math.exp(-dt * (micTarget > this.micAmp ? 22 : 9)));

    // 1. Real remote playback envelope (fast attack, silky release, zero synthetic floor).
    var rate = this.targetLevel > this.amp ? 26 : 11;
    var alpha = 1 - Math.exp(-dt * rate);
    this.prevAmp = this.amp;
    this.amp += (this.targetLevel - this.amp) * alpha;
    if (this.targetLevel === 0 && this.amp < 0.0008) {
      this.amp = 0;
    }

    // Drive organic wave phase ONLY when real sound is present.
    if (this.amp > 0.002) {
      this.wavePhase += dt * (2.6 + this.amp * 5.4);
    }

    // Subtle squash-and-stretch elastic impulse from real audio transients.
    var dAmp = (this.amp - this.prevAmp) / dt;
    var targetStretch = clamp(dAmp * 0.018, -0.055, 0.055);
    var stiffness = 135;
    var damping = 16;
    var acc = stiffness * (targetStretch - this.stretch) - damping * this.stretchVel;
    this.stretchVel += acc * dt;
    this.stretch += this.stretchVel * dt;
    if (Math.abs(this.stretch) < 0.0002 && Math.abs(this.stretchVel) < 0.0002 && this.amp === 0) {
      this.stretch = 0;
      this.stretchVel = 0;
    }

    // 2. Natural blinking scheduler.
    if (!this.isBlinking && this.clock >= this.nextBlinkAt) {
      this.isBlinking = true;
      this.blinkPhase = 0;
      this.pendingDoubleBlink = Math.random() < 0.16;
      this.nextBlinkAt = this.clock + 3.2 + Math.random() * 3.0;
    }
    if (this.isBlinking) {
      this.blinkPhase += dt / 0.19;
      if (this.blinkPhase >= 1) {
        this.isBlinking = false;
        this.blinkPhase = 0;
        if (this.pendingDoubleBlink) {
          this.pendingDoubleBlink = false;
          this.nextBlinkAt = this.clock + 0.14;
        }
      }
    }

    // 3. Restrained natural gaze posture by phase (no fake audio pulsing).
    if (this.clock >= this.nextGazeAt) {
      this.nextGazeAt = this.clock + 2.2 + Math.random() * 2.4;
      if (this.phase === 'thinking' || this.phase === 'connecting' || this.phase === 'reconnecting') {
        this.targetGazeX = (Math.random() - 0.5) * 0.55;
        this.targetGazeY = -0.26 - Math.random() * 0.14;
      } else if (!this.active || this.muted) {
        this.targetGazeX = (Math.random() - 0.5) * 0.18;
        this.targetGazeY = 0.08 + (Math.random() - 0.5) * 0.08;
      } else {
        this.targetGazeX = (Math.random() - 0.5) * 0.32;
        this.targetGazeY = (Math.random() - 0.5) * 0.18;
      }
    }

    var gazeEase = 1 - Math.exp(-dt * 4.5);
    this.gazeX += (this.targetGazeX - this.gazeX) * gazeEase;
    this.gazeY += (this.targetGazeY - this.gazeY) * gazeEase;
  };

  OrganicOrb.prototype.draw = function () {
    var ctx = this.ctx;
    if (!ctx) return;

    var w = this.width;
    var h = this.height;
    var dpr = this.dpr;
    var reduced = this.motionPreference.matches;
    var amp = reduced ? 0 : this.amp;
    // Reduced motion keeps the three distinct facial postures, without pulsing or wandering.
    var talking = this.phase === 'speaking' && this.active;
    var listening = this.phase === 'listening' && this.active && !this.muted;
    var thinking = this.phase === 'thinking';
    var articulation = talking ? (reduced ? .48 : Math.sqrt(clamp(this.amp, 0, 1))) : 0;
    var attention = listening ? (reduced ? .32 : Math.sqrt(clamp(this.micAmp, 0, 1))) : 0;
    var hsl = this.hsl;
    var isError = this.phase === 'error' || this.phase === 'failed';
    var dimFactor = this.active ? (this.muted ? 0.62 : 1.0) : 0.72;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    var cx = w * 0.5;
    var cy = h * 0.5;
    var baseR = Math.min(w, h) * 0.285;
    // Real sound drives smooth volumetric expansion.
    var R = baseR * (1 + amp * 0.115);
    var stretch = reduced ? 0 : this.stretch;
    var sx = 1 - stretch * 0.65 + amp * 0.025;
    var sy = 1 + stretch * 0.85 + amp * 0.015;

    // 1. Deep Obsidian Outer Ambient Glow
    var auraRadius = Math.min(Math.min(w, h) * 0.495, R * (1.44 + amp * 0.16));
    var auraAlpha = (0.20 * dimFactor) + amp * 0.24;
    var auraHue = isError ? 356 : hsl.h;
    var auraSat = isError ? 76 : Math.max(hsl.s, 36);
    var aura = ctx.createRadialGradient(cx, cy, R * 0.45, cx, cy, auraRadius);
    aura.addColorStop(0, hsla(auraHue, auraSat, Math.min(hsl.l + 10, 62), auraAlpha));
    aura.addColorStop(0.54, hsla(auraHue, auraSat, Math.max(hsl.l - 8, 28), auraAlpha * 0.34));
    aura.addColorStop(1, hsla(auraHue, auraSat, 18, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(cx, cy, auraRadius, 0, Math.PI * 2);
    ctx.fill();

    // 2. Acoustic Halo Ring (calm circular hairline when silent, organic wave when amp > 0)
    var ringR = R * (1.15 + amp * 0.10);
    var ringAlpha = (0.14 * dimFactor) + amp * 0.34;
    ctx.save();
    ctx.strokeStyle = hsla(auraHue, Math.min(auraSat + 10, 96), Math.max(hsl.l + 18, 66), ringAlpha);
    ctx.lineWidth = 1.15 + amp * 0.85;
    ctx.beginPath();
    var ringSegs = 96;
    for (var i = 0; i <= ringSegs; i++) {
      var a = (i / ringSegs) * Math.PI * 2;
      var ringWave = amp > 0.001
        ? amp * (
            Math.sin(a * 4 + this.wavePhase * 1.15) * 3.4 +
            Math.cos(a * 7 - this.wavePhase * 0.85) * 1.7
          )
        : 0;
      var rx = cx + Math.cos(a) * (ringR + ringWave);
      var ry = cy + Math.sin(a) * (ringR + ringWave);
      if (i === 0) ctx.moveTo(rx, ry);
      else ctx.lineTo(rx, ry);
    }
    ctx.closePath();
    ctx.stroke();

    // Secondary soft echo ring only visible when remote playback is audible.
    if (amp > 0.04) {
      var echoR = R * (1.27 + amp * 0.15);
      ctx.strokeStyle = hsla(auraHue, auraSat, Math.min(hsl.l + 24, 76), (amp - 0.04) * 0.24);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(cx, cy, echoR, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // 3. Organic Sphere Contour Path
    var segs = 96;
    var buildOrbPath = function (scaleMult) {
      ctx.beginPath();
      for (var j = 0; j <= segs; j++) {
        var theta = (j / segs) * Math.PI * 2;
        var deform = 1;
        if (amp > 0.001) {
          deform += amp * (
            0.036 * Math.sin(theta * 2 + this.wavePhase) +
            0.022 * Math.cos(theta * 3 - this.wavePhase * 1.35) +
            0.012 * Math.sin(theta * 5 + this.wavePhase * 0.9)
          );
        }
        var rad = R * scaleMult * deform;
        var px = cx + Math.cos(theta) * rad * sx;
        var py = cy + Math.sin(theta) * rad * sy;
        if (j === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }.bind(this);

    // Outer edge bloom tightly hugging the orb
    ctx.save();
    buildOrbPath(1.045);
    var edgeBloom = ctx.createRadialGradient(cx, cy, R * 0.82, cx, cy, R * 1.07);
    edgeBloom.addColorStop(0, hsla(hsl.h, Math.min(hsl.s + 12, 95), Math.min(hsl.l + 20, 76), 0.28 * dimFactor + amp * 0.25));
    edgeBloom.addColorStop(1, hsla(hsl.h, hsl.s, hsl.l, 0));
    ctx.fillStyle = edgeBloom;
    ctx.fill();
    ctx.restore();

    // Main spherical body (clipped multi-layer velvet-glass shading)
    ctx.save();
    buildOrbPath(1.0);
    ctx.clip();

    // Deep-blue velvet spherical volume gradient
    var lightX = cx - R * 0.30;
    var lightY = cy - R * 0.34;
    var bodyGrad = ctx.createRadialGradient(lightX, lightY, R * 0.08, cx, cy, R * 1.15);
    var coreL = clamp(hsl.l * 0.72 + amp * 6, 22, 76);
    var midL = clamp(hsl.l * 0.42 + amp * 4, 12, 56);
    var deepL = clamp(hsl.l * 0.19, 6, 32);
    bodyGrad.addColorStop(0, hsla(hsl.h - 6, Math.min(hsl.s + 10, 96), Math.min(coreL + 16, 82), 1));
    bodyGrad.addColorStop(0.38, hsla(hsl.h, Math.min(hsl.s + 6, 94), coreL, 1));
    bodyGrad.addColorStop(0.76, hsla(hsl.h + 7, Math.min(hsl.s + 10, 95), midL, 1));
    bodyGrad.addColorStop(1, hsla(hsl.h + 14, Math.min(hsl.s + 8, 92), deepL, 1));
    ctx.fillStyle = bodyGrad;
    ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);

    // Subsurface luminous under-glow (responds to real audio)
    var subGrad = ctx.createRadialGradient(cx + R * 0.08, cy + R * 0.62, R * 0.06, cx, cy + R * 0.48, R * 0.92);
    subGrad.addColorStop(0, hsla(hsl.h - 14, Math.min(hsl.s + 16, 100), Math.min(hsl.l + 24, 80), 0.24 * dimFactor + amp * 0.34));
    subGrad.addColorStop(0.6, hsla(hsl.h - 8, hsl.s, Math.min(hsl.l + 10, 68), 0.08 + amp * 0.12));
    subGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = subGrad;
    ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);

    // Soft diffused velvet-glass highlight at top-left
    var specGrad = ctx.createRadialGradient(cx - R * 0.32, cy - R * 0.38, R * 0.04, cx - R * 0.22, cy - R * 0.28, R * 0.68);
    specGrad.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
    specGrad.addColorStop(0.45, 'rgba(255, 255, 255, 0.06)');
    specGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = specGrad;
    ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);

    // Subtle dark vignette at lower edge for volumetric contrast
    var shadeGrad = ctx.createRadialGradient(cx, cy - R * 0.14, R * 0.55, cx, cy, R * 1.08);
    shadeGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shadeGrad.addColorStop(1, 'rgba(3, 6, 16, 0.36)');
    ctx.fillStyle = shadeGrad;
    ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);

    ctx.restore();

    // Crisp Fresnel Rim Stroke
    ctx.save();
    buildOrbPath(0.996);
    ctx.strokeStyle = hsla(hsl.h - 10, Math.min(hsl.s + 14, 96), Math.min(hsl.l + 30, 86), 0.32 * dimFactor + amp * 0.24);
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.restore();

    // 4. Expressive Eyes & Natural Blinking
    var blinkAmt = 0;
    if (this.isBlinking && !reduced) {
      // Smooth sine bell 0 -> 1 -> 0
      blinkAmt = Math.sin(clamp(this.blinkPhase, 0, 1) * Math.PI);
      blinkAmt = blinkAmt * blinkAmt;
    }

    var gazeX = reduced ? 0 : this.gazeX;
    var gazeY = reduced ? 0 : this.gazeY;
    var eyeOffsetX = gazeX * R * .17 + (thinking ? R * .10 : 0);
    var eyeOffsetY = gazeY * R * .14 - R * (thinking ? .12 : attention * .11);
    var eyeSpacing = R * .285;
    var eyeW = R * .145;
    var baseEyeH = R * (this.muted && !talking ? .095 : thinking ? .17 : .25);
    baseEyeH += R * (attention * .11 - articulation * .08);

    var openH = Math.max(2.2, baseEyeH * (1 - blinkAmt * 0.92));
    var eyeRadius = Math.min(eyeW * 0.5, openH * 0.5);
    var eyeCenterY = cy - R * .12 + eyeOffsetY;

    var useDarkEyes = this.lum > 0.62;
    var eyeFill = useDarkEyes ? 'rgba(9, 13, 24, 0.92)' : 'rgba(246, 250, 255, 0.95)';

    ctx.save();
    if (!useDarkEyes) {
      ctx.shadowColor = hsla(hsl.h - 8, 90, 84, 0.45 + amp * 0.35);
      ctx.shadowBlur = 10 + amp * 8;
    }
    ctx.fillStyle = eyeFill;

    // Slight spherical foreshortening based on gazeX
    var leftScaleX = 1 - Math.max(0, -gazeX) * 0.12;
    var rightScaleX = 1 - Math.max(0, gazeX) * 0.12;

    var leftX = cx - eyeSpacing + eyeOffsetX;
    var rightX = cx + eyeSpacing + eyeOffsetX;

    var lw = eyeW * leftScaleX;
    var rw = eyeW * rightScaleX;

    roundRectPath(ctx, leftX - lw * 0.5, eyeCenterY - openH * 0.5, lw, openH, eyeRadius);
    ctx.fill();

    roundRectPath(ctx, rightX - rw * 0.5, eyeCenterY - openH * 0.5, rw, openH, eyeRadius);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.lineCap = 'round';
    ctx.strokeStyle = eyeFill;
    if (listening || thinking) {
      // Lift both brows to meet the user's voice; an asymmetric brow marks thought.
      var lift = R * (.23 + attention * .19);
      for (var side = -1; side <= 1; side += 2) {
        var ex = cx + side * eyeSpacing + eyeOffsetX;
        var ey = eyeCenterY - lift - (thinking && side === 1 ? R * .09 : 0);
        ctx.lineWidth = R * .047;
        ctx.beginPath();
        ctx.moveTo(ex - R * .10, ey);
        ctx.quadraticCurveTo(ex, ey - R * (.075 + attention * .045), ex + R * .10, ey - side * R * .035);
        ctx.stroke();
      }
    }
    var mouthX = cx + eyeOffsetX * .45;
    var mouthY = cy + R * .25;
    if (talking) {
      var half = R * (.21 - articulation * .075);
      var opening = R * (.018 + articulation * .26);
      ctx.beginPath();
      ctx.moveTo(mouthX - half, mouthY);
      ctx.bezierCurveTo(mouthX - half * .75, mouthY - opening, mouthX + half * .75, mouthY - opening, mouthX + half, mouthY);
      ctx.bezierCurveTo(mouthX + half, mouthY + opening * 1.45, mouthX - half, mouthY + opening * 1.45, mouthX - half, mouthY);
      ctx.closePath();
      ctx.fillStyle = '#111b36';
      ctx.fill();
      ctx.strokeStyle = 'rgba(236,247,255,.94)';
      ctx.lineWidth = Math.max(1.5, R * .036);
      ctx.stroke();
    } else {
      // Small relaxed smile, or a thoughtful lopsided line while waiting.
      var halfSmile = R * (thinking ? .11 : .19);
      var curve = R * (thinking || this.muted ? .015 : .1 + attention * .08);
      ctx.lineWidth = R * .046;
      ctx.beginPath();
      ctx.moveTo(mouthX - halfSmile, mouthY);
      ctx.quadraticCurveTo(mouthX, mouthY + curve, mouthX + halfSmile, mouthY - (thinking ? R * .04 : 0));
      ctx.stroke();
    }

    // Subtle specular glint inside eyes when open
    if (!useDarkEyes && openH > eyeW * 0.9) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      var glintR = Math.max(1.2, eyeW * 0.14);
      ctx.beginPath();
      ctx.arc(leftX - lw * 0.16, eyeCenterY - openH * 0.24, glintR, 0, Math.PI * 2);
      ctx.arc(rightX - rw * 0.16, eyeCenterY - openH * 0.24, glintR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.restore();
  };

  // ================= DOM BINDING & PUBLIC API =================

  var appEl = document.getElementById('app');
  var canvasEl = document.getElementById('orb-canvas');
  var avatarWrapEl = document.getElementById('avatar-wrap');
  var statusBannerEl = document.getElementById('status-banner');
  var statusTextEl = document.getElementById('status-text');
  var subtitlesEl = document.getElementById('subtitles');
  var mineWrapEl = document.getElementById('mine-wrap');
  var mineTextEl = document.getElementById('mine-text');
  var replyWrapEl = document.getElementById('reply-wrap');
  var replyTextEl = document.getElementById('reply-text');
  var replyCursorEl = document.getElementById('reply-cursor');

  var panelPairEl = document.getElementById('panel-pair');
  var panelStartEl = document.getElementById('panel-start');
  var panelActiveEl = document.getElementById('panel-active');

  var pairFormEl = document.getElementById('pair-form');
  var pairInputEl = document.getElementById('pair-key');
  var btnStartEl = document.getElementById('btn-start');
  var btnMuteEl = document.getElementById('btn-mute');
  var muteLabelEl = document.getElementById('mute-label');
  var btnInterruptEl = document.getElementById('btn-interrupt');
  var btnStopEl = document.getElementById('btn-stop');
  var btnForgetEl = document.getElementById('btn-forget');

  var btnPaletteEl = document.getElementById('btn-palette');
  var colorPopoverEl = document.getElementById('color-popover');
  var colorHexEl = document.getElementById('color-hex');
  var colorCustomEl = document.getElementById('color-custom');
  var swatchEls = Array.prototype.slice.call(document.querySelectorAll('.swatch-dot'));

  var currentState = {
    phase: 'idle',
    mine: '',
    reply: '',
    status: '',
    muted: false,
    paired: false,
    active: false
  };

  var initialColor = readSavedColor();
  var orb = canvasEl ? new OrganicOrb(canvasEl, initialColor) : null;

  function applyColor(rawHex, persist) {
    var hex = normalizeHex(rawHex) || DEFAULT_COLOR;
    var rgb = hexToRgb(hex);

    document.documentElement.style.setProperty('--accent', hex);
    document.documentElement.style.setProperty('--accent-rgb', rgb.r + ', ' + rgb.g + ', ' + rgb.b);

    if (colorHexEl) {
      colorHexEl.textContent = hex;
    }
    if (colorCustomEl && colorCustomEl.value.toUpperCase() !== hex) {
      colorCustomEl.value = hex;
    }

    for (var i = 0; i < swatchEls.length; i++) {
      var dot = swatchEls[i];
      var dotColor = (dot.getAttribute('data-color') || '').toUpperCase();
      dot.classList.toggle('is-active', dotColor === hex);
    }

    if (orb) {
      orb.setColor(hex);
    }
    if (persist) {
      saveColor(hex);
    }
  }

  function setPopoverOpen(open) {
    if (!colorPopoverEl || !btnPaletteEl) return;
    colorPopoverEl.hidden = !open;
    btnPaletteEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function callVoice(method) {
    var voice = global.Voice;
    if (!voice || typeof voice[method] !== 'function') return;
    var args = Array.prototype.slice.call(arguments, 1);
    return voice[method].apply(voice, args);
  }

  function scrollSubtitlesToEnd() {
    if (!subtitlesEl) return;
    subtitlesEl.scrollTop = subtitlesEl.scrollHeight;
  }

  function applyStateToDom(prevState) {
    var s = currentState;

    if (appEl) {
      appEl.dataset.phase = s.phase;
      appEl.dataset.paired = s.paired ? 'true' : 'false';
      appEl.dataset.active = s.active ? 'true' : 'false';
      appEl.dataset.muted = s.muted ? 'true' : 'false';
    }

    // Pairing / Start / Active panels
    if (panelPairEl) panelPairEl.hidden = s.paired;
    if (panelStartEl) panelStartEl.hidden = !s.paired || s.active;
    if (panelActiveEl) panelActiveEl.hidden = !s.paired || !s.active;
    if (btnForgetEl) btnForgetEl.hidden = !s.paired;

    if (!prevState.paired && s.paired && pairInputEl) {
      pairInputEl.value = '';
      pairInputEl.blur();
    }

    // Bounded status / error banner (never fabricates text when empty)
    var boundedStatus = formatBoundedStatus(s.status);
    if (statusBannerEl && statusTextEl) {
      if (boundedStatus) {
        statusTextEl.textContent = boundedStatus;
        statusBannerEl.classList.toggle('is-error', isErrorState(s.phase, boundedStatus));
        statusBannerEl.hidden = false;
      } else {
        statusTextEl.textContent = '';
        statusBannerEl.classList.remove('is-error');
        statusBannerEl.hidden = true;
      }
    }

    // Subtitles under avatar (strictly textContent)
    var subtitleChanged = false;
    if (mineWrapEl && mineTextEl) {
      if (s.mine) {
        if (mineTextEl.textContent !== s.mine) {
          mineTextEl.textContent = s.mine;
          subtitleChanged = true;
        }
        mineWrapEl.hidden = false;
      } else {
        mineTextEl.textContent = '';
        mineWrapEl.hidden = true;
      }
    }

    if (replyWrapEl && replyTextEl) {
      if (s.reply) {
        if (replyTextEl.textContent !== s.reply) {
          replyTextEl.textContent = s.reply;
          subtitleChanged = true;
        }
        replyWrapEl.hidden = false;
      } else {
        replyTextEl.textContent = '';
        replyWrapEl.hidden = true;
      }
    }

    if (replyCursorEl) {
      replyCursorEl.hidden = !(s.reply && s.active && isLiveReplyPhase(s.phase));
    }

    if (subtitlesEl) {
      subtitlesEl.hidden = !(s.mine || s.reply);
    }

    if (subtitleChanged) {
      scrollSubtitlesToEnd();
    }

    // Mute button
    if (btnMuteEl && muteLabelEl) {
      btnMuteEl.classList.toggle('is-muted', s.muted);
      btnMuteEl.setAttribute('aria-pressed', s.muted ? 'true' : 'false');
      muteLabelEl.textContent = s.muted ? '取消静音' : '静音';
    }

    // Interrupt pulse indicator
    if (btnInterruptEl) {
      btnInterruptEl.classList.toggle('is-pulsing', s.active && isLiveReplyPhase(s.phase));
    }

    if (orb) {
      orb.setState(s.phase, s.active, s.muted);
    }
  }

  function render(state) {
    if (!state || typeof state !== 'object') {
      return;
    }

    var prev = {
      paired: currentState.paired,
      active: currentState.active
    };

    if ('phase' in state) {
      currentState.phase = state.phase === null || state.phase === undefined
        ? 'idle'
        : String(state.phase).trim().toLowerCase() || 'idle';
    }
    if ('mine' in state) {
      currentState.mine = state.mine === null || state.mine === undefined ? '' : String(state.mine);
    }
    if ('reply' in state) {
      currentState.reply = state.reply === null || state.reply === undefined ? '' : String(state.reply);
    }
    if ('status' in state) {
      currentState.status = state.status === null || state.status === undefined ? '' : String(state.status);
    }
    if ('muted' in state) {
      currentState.muted = Boolean(state.muted);
    }
    if ('paired' in state) {
      currentState.paired = Boolean(state.paired);
    }
    if ('active' in state) {
      currentState.active = Boolean(state.active);
    }

    if ('level' in state && state.level !== undefined) {
      if (orb) orb.setLevel(state.level);
    } else if (!currentState.active && prev.active && orb) {
      orb.setLevel(0);
    }

    applyStateToDom(prev);
  }

  function level(value) {
    if (orb) {
      orb.setLevel(value);
    }
  }

  // Wire UI Events
  if (btnPaletteEl) {
    btnPaletteEl.addEventListener('click', function (e) {
      e.stopPropagation();
      setPopoverOpen(colorPopoverEl ? colorPopoverEl.hidden : false);
    });
  }

  if (colorPopoverEl) {
    colorPopoverEl.addEventListener('click', function (e) {
      e.stopPropagation();
    });
  }

  for (var i = 0; i < swatchEls.length; i++) {
    swatchEls[i].addEventListener('click', function () {
      var hex = this.getAttribute('data-color');
      applyColor(hex, true);
    });
  }

  if (colorCustomEl) {
    colorCustomEl.addEventListener('input', function () {
      applyColor(this.value, true);
    });
  }

  document.addEventListener('click', function () {
    setPopoverOpen(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      setPopoverOpen(false);
    }
  });

  if (avatarWrapEl) {
    avatarWrapEl.addEventListener('click', function () {
      setPopoverOpen(false);
      if (orb) orb.blink();
    });
  }

  if (pairFormEl) {
    pairFormEl.addEventListener('submit', function (e) {
      e.preventDefault();
      var key = pairInputEl ? pairInputEl.value.trim() : '';
      if (!key) {
        if (pairInputEl) pairInputEl.focus();
        return;
      }
      callVoice('pair', key);
    });
  }

  if (btnStartEl) {
    btnStartEl.addEventListener('click', function () {
      setPopoverOpen(false);
      callVoice('start');
    });
  }

  if (btnMuteEl) {
    btnMuteEl.addEventListener('click', function () {
      setPopoverOpen(false);
      callVoice('mute');
    });
  }

  if (btnInterruptEl) {
    btnInterruptEl.addEventListener('click', function () {
      setPopoverOpen(false);
      callVoice('interrupt');
    });
  }

  if (btnStopEl) {
    btnStopEl.addEventListener('click', function () {
      setPopoverOpen(false);
      callVoice('stop');
    });
  }

  if (btnForgetEl) {
    btnForgetEl.addEventListener('click', function () {
      setPopoverOpen(false);
      callVoice('forget');
    });
  }

  // Resize & visibility lifecycle
  function handleResize() {
    if (orb) orb.resize();
  }

  global.addEventListener('resize', handleResize, { passive: true });
  if (typeof global.ResizeObserver === 'function' && avatarWrapEl) {
    var ro = new global.ResizeObserver(handleResize);
    ro.observe(avatarWrapEl);
  }

  document.addEventListener('visibilitychange', function () {
    if (!orb) return;
    if (document.hidden) {
      orb.stop();
    } else {
      orb.resize();
      orb.start();
    }
  });

  // Initialize color, clean initial DOM, and animation loop
  applyColor(initialColor, false);
  applyStateToDom({ paired: false, active: false });
  if (orb && !document.hidden) {
    orb.start();
  }

  global.NightView = {
    render: render,
    level: level,
    micLevel: function (value) {
      if (orb) orb.micTarget = clamp(Number(value) || 0, 0, 1);
    }
  };
})(window);
