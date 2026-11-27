// Canvas 2D orthographic rendering of two closed eye contours on a unit sphere.
// Expression data and the motion clock are supplied by orb-reference.js and orb-motion.js.
(function (global) {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mix = (a, b, t) => a + (b - a) * t;

  // Frontal expression parameters, indexed by the reference state's expression IDs.
  // Width, height, smile curvature, mirrored tilt, one-sided eyelid adjustment.
  // The source's 2D rings already contain camera perspective. Author these in the
  // local eye socket so head rotation applies perspective exactly once.
  const faces = [
    [1,1,0,0,0], [1.02,1.05,.04,0,0], [1.26,.64,.68,.055,0,.66],
    [1.14,1.16,0,0,0], [1.05,.52,-.13,0,0,0,.22], [1.06,.88,-.10,.11,.17,0,.16],
    [1.07,.88,.20,.025,0], [.98,.86,-.07,-.07,0], [1.02,1.03,0,.025,.055],
    [1,.90,.04,.025,.10], [1.04,1.06,.03,0,0], [1.30,.60,.77,.045,0,.73],
    [.99,.96,.06,.025,.08], [1.06,.47,-.08,0,0], [1.08,.85,-.12,-.13,.18,0,.18],
    [1.06,1.11,.07,.115,.23,0,.12], [1,.90,.02,-.045,.04], [1.19,.72,.54,.025,0,.53],
    [.99,1.04,.02,-.025,.06], [1.03,1.02,.085,0,0], [1.02,.92,.06,.055,.05],
    [1.15,1.18,.01,.02,.07], [1.10,.50,-.16,.02,0,0,.26], [.98,.88,-.055,-.05,.06],
    [1.02,.85,.13,.035,.04]
  ];

  function eyeShapes() {
    return faces.map(([width, height, arch, tilt, asymmetry, lowerLift = 0, upperFlat = 0]) => [-1,1].map(side => {
      const ring = [], w = .115 * width, h = .25 * (height - (side > 0 ? asymmetry : 0));
      const cap = Math.min(w, h), spine = h-cap;
      const angle = tilt*side, cs = Math.cos(angle), sn = Math.sin(angle);
      for (let i=0; i<48; i++) {
        let x, y;
        if (i<16 || (i>=24 && i<40)) {
          const lower = i>=24;
          const t = (lower ? i-24 : i)*Math.PI/16 + (lower ? 0 : Math.PI);
          x=w*Math.cos(t); y=(lower ? spine : -spine) + cap*Math.sin(t);
        } else {
          const right=i<24, t=(right ? i-16 : i-40)/8;
          x=right ? w : -w; y=(right ? 1 : -1)*mix(-spine,spine,t);
        }
        // The lower lid cuts upward toward the center of a smile. The top lid
        // can flatten independently, before either contour is mapped to the sphere.
        const center = Math.max(0, 1 - (x/w)**2);
        const rimBlend = clamp((y/h+1)/2, 0, 1);
        y += h * (arch*(.55-center) - lowerLift*center*rimBlend
          + upperFlat*center*(1-rimBlend));
        y += side*asymmetry*.12;
        ring.push(cs*x-sn*y,sn*x+cs*y);
      }
      return {centerY:h*.2, ring};
    }));
  }

  function spring(axis, target, dt, rate, reduced) {
    if (reduced) {axis.x=target; axis.v=0; return target;}
    const steps=Math.max(1,Math.ceil(dt*120)), step=dt/steps;
    for (let i=0; i<steps; i++) {
      axis.v+=(rate*rate*(target-axis.x)-1.72*rate*axis.v)*step;
      axis.x+=axis.v*step;
    }
    return axis.x;
  }

  // Each pixel is lit from its actual surface normal. The key, sky reflection and
  // cool rim are fixed in world space. Repaint this material only on size/tint change.
  function paintMaterial(size, rgb) {
    const texture = document.createElement('canvas');
    texture.width = texture.height = size;
    const ctx = texture.getContext('2d');
    const pixels = ctx.createImageData(size, size);
    const out = pixels.data, r = (size - 1) / 2;
    for (let row = 0; row < size; row++) {
      const y = (row - r) / r;
      for (let col = 0; col < size; col++) {
        const x = (col - r) / r, rho2 = x * x + y * y;
        if (rho2 > 1.005) continue;
        const z = Math.sqrt(Math.max(0, 1 - rho2));
        const light = Math.max(0, -.42 * x - .68 * y + .60 * z);
        const diffuse = .17 + .55 * Math.pow(light,1.18) + .085 * z;
        const reflectedX = 2 * z * x, reflectedY = 2 * z * y;
        const u = (reflectedX + .51) / .40, v = (reflectedY + .72) / .27;
        const sheen = z > .55 ? Math.exp(-u * u - v * v) * .18 * (z - .55) / .45 : 0;
        const rim = Math.pow(1 - z, 3.3) * (.14 + .16 * Math.max(0, .82 * x - .50 * y));
        const bounce = Math.max(0, .32 * x + y - .24) * .22;
        const offset = (row * size + col) * 4;
        out[offset]     = rgb[0] * diffuse + 247 * sheen + 130 * rim + 24 * bounce;
        out[offset + 1] = rgb[1] * diffuse + 248 * sheen + 193 * rim + 48 * bounce;
        out[offset + 2] = rgb[2] * diffuse + 251 * sheen + 249 * rim + 95 * bounce;
        out[offset + 3] = 255 * clamp((1 - Math.sqrt(rho2)) * r + .5, 0, 1);
      }
    }
    ctx.putImageData(pixels, 0, 0);
    return texture;
  }

  // Exponential map from the tangent plane to the sphere, followed by yaw and
  // pitch in camera coordinates. Keep depth until the limb has been clipped.
  function surfacePoint(u, v, orient) {
    const d = Math.hypot(u, v), k = d > 1e-6 ? Math.sin(d) / d : 1;
    const x = u * k, y = v * k, z = Math.cos(d);
    const turnedZ = orient.cy * z - orient.sy * x;
    return {
      x: orient.cy * x + orient.sy * z,
      y: orient.cp * y + orient.sp * turnedZ,
      z: orient.cp * turnedZ - orient.sp * y,
    };
  }

  // Eye centres are mirror images at ±18° longitude and 4° above the equator.
  function socket(sign) {
    const lon=sign*Math.PI/10, lat=-4*Math.PI/180;
    return {cy:Math.cos(lon),sy:Math.sin(lon),cp:Math.cos(lat),sp:Math.sin(lat)};
  }
  const leftSocket=socket(-1), rightSocket=socket(1);

  function horizon(a, b) {
    const t = a.z / (a.z - b.z);
    const x = mix(a.x, b.x, t), y = mix(a.y, b.y, t), len = Math.hypot(x, y);
    return { x: x / len, y: y / len };
  }

  // A contour straddling the horizon follows the *circular silhouette* between
  // exit and re-entry. A chord here cuts a visible notch out of the far eye.
  function frontContour(ctx, ring) {
    const first = ring.findIndex(p => p.z > 0);
    if (first < 0) return false;
    let previous = ring[first], exit;
    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    for (let i = 1; i <= ring.length; i++) {
      const next = ring[(first + i) % ring.length];
      if (previous.z > 0 && next.z <= 0) {
        exit = horizon(previous, next);
        ctx.lineTo(exit.x, exit.y);
      } else if (previous.z <= 0 && next.z > 0) {
        const entry = horizon(previous, next);
        const a = Math.atan2(exit.y, exit.x), b = Math.atan2(entry.y, entry.x);
        const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
        ctx.arc(0, 0, 1, a, a + delta, delta < 0);
      }
      if (next.z > 0) ctx.lineTo(next.x, next.y);
      previous = next;
    }
    ctx.closePath();
    return true;
  }

  class NightSphere {
    constructor(canvas, color, seed) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.motion = global.NightOrbMotion.create(seed === undefined ? Math.floor(Math.random() * 0x100000000) : seed);
      this.shapes = eyeShapes();
      this.turn = Array.from({length:4}, () => ({x:0,v:0}));
      this.reduced = global.matchMedia('(prefers-reduced-motion: reduce)');
      this.phase = 'idle';
      this.active = this.muted = false;
      this.playback = this.micTarget = 0;
      this.speech = null;
      // Previous remote-playout levels in 16 ms time bins, shared with the
      // sphere render loop. The center reacts first; the flanks echo each syllable.
      this.pulseTrail = new Float32Array(6);
      this.pulseEnvelope = this.pulseTime = this.pulseLight = 0;
      this.spokenFor = this.quietFor = 0;
      this.yaw = this.pitch = 0;
      this.pointer = null;
      this.geometry = null;
      this.frame = this.lastTime = 0;
      this.onFrame = this.onFrame.bind(this);
      this.setColor(color);
      this.resize();
    }
    setColor(color) {
      if (color === this.color) return;
      const n = parseInt(color.slice(1), 16);
      this.color = color;
      this.rgb = [n >> 16 & 255, n >> 8 & 255, n & 255];
      this.darkInk = this.rgb[0] * .2126 + this.rgb[1] * .7152 + this.rgb[2] * .0722 > 183;
      this.material = null;
    }
    setState(phase, active, muted) {
      this.phase = phase; this.active = active; this.muted = muted;
      if (!active || muted) this.micTarget = 0;
      if (!active || (phase !== 'speaking' && phase !== 'streaming')) this.clearPulse();
      // A cue only belongs to the reply that is being spoken right now.
      if (!active || (phase !== 'speaking' && phase !== 'streaming')) this.speech = null;
    }
    clearPulse() {
      this.playback = this.pulseEnvelope = this.pulseTime = this.pulseLight = 0;
      this.pulseTrail.fill(0);
    }
    setLevel(value) { this.playback = clamp(Number(value) || 0, 0, 1); }
    setSpeech(patch) {
      if (!patch || patch.clear) { this.speech = null; return; }
      const seq = Number(patch.seq);
      this.speech = {
        kind: typeof patch.kind === 'string' ? patch.kind : '',
        text: typeof patch.text === 'string' ? patch.text : '',
        seq: Number.isFinite(seq) ? seq : 0,
      };
    }
    resize() {
      const box = this.canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const dpr = Math.min(global.devicePixelRatio || 1, 3);
      this.width = box.width; this.height = box.height;
      const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
        this.material = null; this.geometry = null;
      }
    }
    localPoint(clientX, clientY) {
      const box = this.canvas.getBoundingClientRect(), g = this.geometry;
      if (!g || !box.width || !box.height) return { x: Infinity, y: Infinity };
      const x = (clientX - box.left) * this.width / box.width - g.cx;
      const y = (clientY - box.top) * this.height / box.height - g.cy;
      return { x: (g.cos * x + g.sin * y) / g.rx, y: (-g.sin * x + g.cos * y) / g.ry };
    }
    hitTest(clientX, clientY) {
      const p = this.localPoint(clientX, clientY);
      return p.x * p.x + p.y * p.y <= 1;
    }
    lookAt(x, y) { this.pointer = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) }; }
    clearLook() { this.pointer = null; }
    touch(x, y) {
      const p = this.pointer || { x: 0, y: 0 };
      this.motion.tap(Number.isFinite(x) ? x : p.x, Number.isFinite(y) ? y : p.y);
    }
    start() {
      if (this.frame) return;
      this.lastTime = performance.now();
      this.frame = global.requestAnimationFrame(this.onFrame);
    }
    stop() {
      global.cancelAnimationFrame(this.frame); this.frame = 0; this.clearPulse();
    }
    onFrame(now) {
      const dt = clamp((now - this.lastTime) / 1000, 0, .050);
      this.lastTime = now;
      this.render(dt);
      this.frame = global.requestAnimationFrame(this.onFrame);
    }
    render(dt) {
      if (!this.ctx || !this.width || !this.height) return;
      const reduced = this.reduced.matches;
      if (this.phase !== 'speaking') {
        this.spokenFor = this.quietFor = 0;
      } else if (this.playback > .025) {
        this.spokenFor += dt; this.quietFor = 0;
      } else {
        this.quietFor += dt;
        if (this.quietFor > .58) this.spokenFor = 0;
      }
      const phase = this.phase === 'speaking' && this.spokenFor > .52 ? 'streaming' : this.phase;
      const pose = this.motion.step(dt, {
        phase: phase, active: this.active, muted: this.muted,
        mic: this.micTarget, playback: this.playback, reduced,
        speech: this.speech,
      });
      const p = this.pointer;
      const x = p ? p.x : pose.gazeX, y = p ? p.y : pose.gazeY;
      const headX = spring(this.turn[0], x*(p ? .59 : .38), dt, p ? 15 : 10, reduced);
      const headY = spring(this.turn[1], y*(p ? .38 : .33), dt, p ? 15 : 10, reduced);
      const eyeX = spring(this.turn[2], x*.11 + (p ? 0 : pose.eyeAimX*.28), dt, 29, reduced);
      const eyeY = spring(this.turn[3], y*.078 + (p ? 0 : pose.eyeAimY*.24), dt, 29, reduced);
      this.yaw = headX+eyeX; this.pitch = headY+eyeY;
      if (!reduced) { pose.roll += headX*.10; pose.lift += headY*.035; }
      this.draw(pose);
      if (this.active && (phase === 'speaking' || phase === 'streaming')) this.drawPulse(dt);
    }
    drawPulse(dt) {
      const level = this.playback > .018 ? Math.pow((this.playback-.018)/.982, .70) : 0;
      const follow = level > this.pulseEnvelope ? 32 : 12;
      this.pulseEnvelope = mix(this.pulseEnvelope, level, 1-Math.exp(-follow*dt));
      if (this.pulseEnvelope < .009) this.pulseEnvelope = 0;
      this.pulseTime += dt;
      while (this.pulseTime >= .016) {
        this.pulseTrail.copyWithin(1, 0);
        this.pulseTrail[0] = this.pulseEnvelope;
        this.pulseTime -= .016;
      }
      this.pulseLight = mix(this.pulseLight, this.pulseEnvelope, 1-Math.exp(-3*dt));
      const reduced = this.reduced.matches, ctx = this.ctx;
      const scale = Math.min(1, this.width/228);
      const midY = this.height*.939;
      const ink = this.rgb.map(v => Math.round(mix(v, 246, .62)));
      ctx.save();
      for (let i=-2; i<=2; i++) {
        const distance = Math.abs(i);
        const echo = distance ? this.pulseTrail[distance*2] : this.pulseEnvelope;
        const value = echo * (1 - .24*distance);
        const radius = 2*scale;
        const half = reduced ? 0 : 8*value*scale;
        const x = this.width/2 + i*12*scale;
        ctx.strokeStyle = 'rgba('+ink.join(',')+','+(.25+.69*(reduced ? this.pulseLight : value))+')';
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = 2*radius; ctx.lineCap = 'round'; ctx.beginPath();
        if (half < .06) { ctx.arc(x,midY,radius,0,TAU); ctx.fill(); }
        else { ctx.moveTo(x,midY-half); ctx.lineTo(x,midY+half); ctx.stroke(); }
      }
      ctx.restore();
    }
    draw(pose) {
      const ctx = this.ctx, w = this.width, h = this.height;
      const radius = Math.min(w, h) * .345;
      const cx = w / 2 + (this.reduced.matches ? 0 : radius*this.turn[0].x*.065), cy = h * .485 + radius * pose.lift;
      const rx = radius * pose.scaleX, ry = radius * pose.scaleY;
      this.geometry = { cx, cy, rx, ry, cos: Math.cos(pose.roll), sin: Math.sin(pose.roll) };
      const size = Math.min(512, Math.max(64, Math.round(2 * radius * this.canvas.width / w)));
      if (!this.material || this.material.width !== size) this.material = paintMaterial(size, this.rgb);
      ctx.setTransform(this.canvas.width / w, 0, 0, this.canvas.height / h, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(cx, h * .485 + radius * 1.12);
      ctx.scale(radius * .86, radius * .105);
      const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      shadow.addColorStop(0, 'rgba(2,3,8,.48)'); shadow.addColorStop(1, 'rgba(2,3,8,0)');
      ctx.fillStyle = shadow; ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();

      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(pose.roll); ctx.scale(rx, ry);
      ctx.save();
      ctx.rotate(-pose.roll); // The lamp stays put as the eye plane and body roll.
      ctx.drawImage(this.material, -1, -1, 2, 2);
      ctx.restore();
      ctx.beginPath(); ctx.arc(0, 0, .999, 0, TAU); ctx.clip();
      const orient = { cy: Math.cos(this.yaw), sy: Math.sin(this.yaw), cp: Math.cos(this.pitch), sp: Math.sin(this.pitch) };
      const eyesFrom = this.shapes[pose.fromExpression], eyesTo = this.shapes[pose.expression];
      for (let side = 0; side < 2; side++) {
        const a = eyesFrom[side], b = eyesTo[side], t = pose.expressionMix;
        const blinkCenter = mix(a.centerY, b.centerY, t);
        const open = Math.max(.052, side === 0 ? pose.eyeOpenL : pose.eyeOpenR);
        const ring = [];
        let depth = 0;
        for (let i = 0; i < a.ring.length; i += 2) {
          const u = mix(a.ring[i], b.ring[i], t);
          const v = blinkCenter + (mix(a.ring[i + 1], b.ring[i + 1], t) - blinkCenter) * open;
          const local = surfacePoint(u, v, side === 0 ? leftSocket : rightSocket);
          const forward = orient.cy*local.z-orient.sy*local.x;
          const pt = {x:orient.cy*local.x+orient.sy*local.z,
            y:orient.cp*local.y+orient.sp*forward,z:orient.cp*forward-orient.sp*local.y};
          ring.push(pt); depth += pt.z;
        }
        if (!frontContour(ctx, ring)) continue;
        const facing = clamp(depth / ring.length, 0, 1);
        // A narrow contact shadow anchors the inlay to the shell without a halo.
        ctx.lineWidth = .014;
        ctx.strokeStyle = this.darkInk ? 'rgba(221,231,245,.22)' : 'rgba(6,10,19,.26)';
        ctx.stroke();
        if (this.darkInk) ctx.fillStyle = 'rgb(20,25,34)';
        else {
          const v = Math.round(216 + 26 * facing + (this.reduced.matches ? 0 : 5*pose.energy));
          ctx.fillStyle = 'rgb(' + v + ',' + (v+2) + ',' + (v+3) + ')';
        }
        ctx.fill();
      }
      ctx.restore();
    }
  }
  global.NightSphere = NightSphere;
})(window);
