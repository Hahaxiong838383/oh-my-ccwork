/*!
 * NightAvatars BoopFace Engine (offline classic-script bundle)
 * Upstream: https://github.com/CX-ArtLab/BoopFace
 * Version: 0.9.0
 * Commit: 940fdf7dd844c2052b5ae846374e1ce60b0f5c33
 * License: MIT (see LICENSE)
 */
(function(global) {
  "use strict";
  var __modules = /* @__PURE__ */ Object.create(null);
  var __cache = /* @__PURE__ */ Object.create(null);
  function __define(id, factory) {
    __modules[id] = factory;
  }
  function __require(id) {
    if (__cache[id]) return __cache[id];
    var factory = __modules[id];
    if (!factory) throw new Error("BoopFace bundle missing module: " + id);
    var exports = {};
    __cache[id] = exports;
    factory(__require, __import, exports);
    return exports;
  }
  function __import(id) {
    return Promise.resolve(__require(id));
  }
  __define("src/boopface-core.js", function(__require2, __import2, exports) {
    const BoopFace = (() => {
      const HTMLElementBase = typeof HTMLElement === "undefined" ? class {
      } : HTMLElement;
      const EASE = {
        outQuint: (t) => 1 - Math.pow(1 - t, 5),
        inOutCubic: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
        outCubic: (t) => 1 - Math.pow(1 - t, 3)
      };
      const CURSOR_MS = 160;
      const POSES = {
        idle: {
          w: 54,
          h: 58,
          rx: 27,
          topY: -36,
          bottomY: 36,
          topAL: 0,
          topAR: 0,
          bottomAL: 0,
          bottomAR: 0,
          scale: 1
        },
        happy: {
          w: 58,
          h: 58,
          rx: 29,
          topY: -36,
          bottomY: 0,
          topAL: 0,
          topAR: 0,
          bottomAL: 0,
          bottomAR: 0,
          scale: 1
        },
        sad: {
          w: 58,
          h: 58,
          rx: 29,
          topY: -5,
          bottomY: 36,
          topAL: -16,
          topAR: 16,
          bottomAL: 0,
          bottomAR: 0,
          scale: 1
        },
        angry: {
          w: 58,
          h: 58,
          rx: 29,
          topY: -5,
          bottomY: 36,
          topAL: 16,
          topAR: -16,
          bottomAL: 0,
          bottomAR: 0,
          scale: 1
        },
        sleepy: {
          w: 58,
          h: 56,
          rx: 28,
          topY: 0,
          bottomY: 36,
          topAL: 0,
          topAR: 0,
          bottomAL: 0,
          bottomAR: 0,
          scale: 1
        },
        input: {
          w: 15,
          h: 78,
          rx: 2,
          topY: -44,
          bottomY: 44,
          topAL: 0,
          topAR: 0,
          bottomAL: 0,
          bottomAR: 0,
          scale: 1
        },
        // Same eye as sleepy; the lids meet in a thin slit instead of squashing it.
        sleep: {
          w: 58,
          h: 56,
          rx: 28,
          topY: 7,
          bottomY: 14,
          topAL: 0,
          topAR: 0,
          bottomAL: 0,
          bottomAR: 0,
          scale: 1
        },
        surprise: {
          w: 68,
          h: 68,
          rx: 34,
          topY: -40,
          bottomY: 40,
          topAL: 0,
          topAR: 0,
          bottomAL: 0,
          bottomAR: 0,
          scale: 1
        }
      };
      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
      const setA = (el, name, value) => {
        if (el.getAttribute(name) !== value) el.setAttribute(name, value);
      };
      const PULL_REACH = 18.75;
      const stiffPull = (p) => {
        const m = Math.min(Math.abs(p), PULL_REACH);
        return Math.sign(p) * (m - m ** 5 / (5 * PULL_REACH ** 4));
      };
      const lerp = (a, b, t) => a + (b - a) * t;
      const clonePose = (p) => ({ ...p });
      const DEFAULT_SIZE = 112;
      const parseSize = (value) => {
        const text = String(value ?? "").trim();
        if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.test(text)) return DEFAULT_SIZE;
        const numeric = Number.parseFloat(text);
        return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_SIZE;
      };
      const connectedFaces = /* @__PURE__ */ new Set();
      const forEachConnectedFace = (callback) => {
        for (const face of connectedFaces) {
          if (face.isConnected) callback(face);
        }
      };
      const handleGlobalPointerMove = (event) => {
        forEachConnectedFace((face) => {
          var _a;
          face._onPointerMove(event);
          if (face._dragJelly.active || ((_a = face._gestureFx) == null ? void 0 : _a.held)) face._onDragMove(event);
        });
      };
      const handleGlobalPointerDown = (event) => forEachConnectedFace((face) => {
        if (typeof face._noteEnvironmentActivity === "function") face._noteEnvironmentActivity(event);
        else face.noteActivity();
      });
      const handleGlobalKeyDown = (event) => forEachConnectedFace((face) => {
        if (typeof face._noteEnvironmentActivity === "function") face._noteEnvironmentActivity(event);
        else face.noteActivity();
      });
      const handleGlobalPointerEnd = (event) => {
        forEachConnectedFace((face) => {
          var _a;
          if (face._dragJelly.active || ((_a = face._gestureFx) == null ? void 0 : _a.held)) face._onDragEnd(event);
        });
      };
      const handleGlobalVisibility = () => forEachConnectedFace((face) => face._onVisibility());
      function registerConnectedFace(face) {
        if (connectedFaces.has(face)) return;
        const first = connectedFaces.size === 0;
        connectedFaces.add(face);
        if (!first) return;
        window.addEventListener("pointermove", handleGlobalPointerMove, { passive: true });
        window.addEventListener("pointerdown", handleGlobalPointerDown, { passive: true });
        window.addEventListener("keydown", handleGlobalKeyDown, { passive: true });
        window.addEventListener("pointerup", handleGlobalPointerEnd, { passive: true });
        window.addEventListener("pointercancel", handleGlobalPointerEnd, { passive: true });
        document.addEventListener("visibilitychange", handleGlobalVisibility);
      }
      function unregisterConnectedFace(face) {
        connectedFaces.delete(face);
        if (connectedFaces.size > 0) return;
        window.removeEventListener("pointermove", handleGlobalPointerMove);
        window.removeEventListener("pointerdown", handleGlobalPointerDown);
        window.removeEventListener("keydown", handleGlobalKeyDown);
        window.removeEventListener("pointerup", handleGlobalPointerEnd);
        window.removeEventListener("pointercancel", handleGlobalPointerEnd);
        document.removeEventListener("visibilitychange", handleGlobalVisibility);
      }
      class AgentFace extends HTMLElementBase {
        constructor() {
          super();
          this.attachShadow({ mode: "open" });
          this._state = "idle";
          this._pose = clonePose(POSES.idle);
          this._fromPose = clonePose(this._pose);
          this._toPose = clonePose(this._pose);
          this._morphStart = performance.now();
          this._morphDuration = 0;
          this._morphEase = EASE.outQuint;
          this._wander = { x: 0, y: 0 };
          this._wanderTarget = { x: 0, y: 0 };
          this._nextWanderAt = performance.now() + 500;
          this._pointer = { x: 0, y: 0, active: false, lastMove: 0 };
          this._look = { x: 0, y: 0 };
          this._headFollowPose = { x: 0, y: 0, rot: 0 };
          this._headFollowVel = { x: 0, y: 0, rot: 0 };
          this._headCenteringUntil = 0;
          this._eyeMicro = { lX: 0, lY: 0, rX: 0, rY: 0 };
          this._blink = 1;
          this._blinkAnim = null;
          this._nextBlinkAt = performance.now() + 1800 + Math.random() * 1800;
          this._inputPhase = 0;
          this._eyeNod = null;
          this._eyeBob = null;
          this._angryEyeDrop = null;
          this._surpriseShake = null;
          this._expressionLock = false;
          this._transitionToken = 0;
          this._inputWanted = false;
          this._sleeping = false;
          this._idleTimer = null;
          this._pendingWaits = /* @__PURE__ */ new Map();
          this._boredRoutine = null;
          this._boredLookSpeed = null;
          this._autoSleepMs = Number(this.getAttribute("auto-sleep")) || 0;
          this._lastActivity = performance.now();
          this._running = true;
          this._framePaused = false;
          this._lastFrame = 0;
          this._raf = 0;
          this._dragJelly = {
            active: false,
            returning: false,
            snapped: false,
            moved: false,
            pointerId: null,
            startX: 0,
            startY: 0,
            hotX: 120,
            hotY: 120,
            targetX: 0,
            targetY: 0,
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            targetStretch: 0,
            stretch: 0,
            stretchVel: 0,
            angle: 0,
            threshold: 52,
            ux: 0,
            uy: 0,
            anchorX: 50,
            anchorY: 50,
            shear: 0,
            targetShear: 0,
            shearVel: 0,
            targetPullX: 0,
            targetPullY: 0,
            pullX: 0,
            pullY: 0,
            pullVX: 0,
            pullVY: 0,
            maxDist: 0,
            angryThreshold: 32,
            pendingReaction: null,
            intent: "angry"
          };
          this._suppressClick = false;
          this._boundDragStart = (e) => this._onDragStart(e);
          this._boundClickCapture = (e) => this._onClickCapture(e);
          this._renderShell();
        }
        connectedCallback() {
          registerConnectedFace(this);
          this.addEventListener("pointerdown", this._boundDragStart);
          this.addEventListener("click", this._boundClickCapture, true);
          this._running = !document.hidden;
          this._lastActivity = performance.now();
          this._resumeFrames();
        }
        disconnectedCallback() {
          var _a;
          this._runtimeDisconnecting = true;
          try {
            unregisterConnectedFace(this);
            this.removeEventListener("pointerdown", this._boundDragStart);
            this.removeEventListener("click", this._boundClickCapture, true);
            this._resetToIdle(false);
            this._blinkAnim = null;
            this._blink = 1;
            this._pointer.active = false;
            this._pointer.influence = 0;
            const drag = this._dragJelly;
            if (drag.pointerId != null) {
              try {
                this.releasePointerCapture(drag.pointerId);
              } catch (_) {
              }
            }
            drag.active = false;
            drag.pointerId = null;
            this._finishDragReturn(null);
            this._suppressClick = false;
            this._running = false;
            cancelAnimationFrame(this._raf);
            this._raf = 0;
          } finally {
            (_a = this._teardownRuntime) == null ? void 0 : _a.call(this);
            this._runtimeDisconnecting = false;
          }
        }
        static get observedAttributes() {
          return ["color", "size", "auto-sleep"];
        }
        attributeChangedCallback(name, oldV, newV) {
          var _a;
          if (oldV === newV) return;
          if (name === "color") this._applyColor(newV);
          if (name === "size") this._syncSizeAttribute();
          if (name === "auto-sleep") {
            this._autoSleepMs = Number(newV) || 0;
            (_a = this._scheduleAutoSleep) == null ? void 0 : _a.call(this);
          }
        }
        _syncSizeAttribute() {
          if (!this.hasAttribute("size")) {
            this.style.removeProperty("--face-size");
            return DEFAULT_SIZE;
          }
          const size = parseSize(this.getAttribute("size"));
          this.style.setProperty("--face-size", `${size}px`);
          return size;
        }
        _applyColor(value) {
          const color = value || "#08090b";
          for (const part of [this._head, this._leftTop, this._rightTop, this._leftBottom, this._rightBottom, this._antennaDot]) {
            if (part) part.setAttribute("fill", color);
          }
        }
        _renderShell() {
          this.shadowRoot.innerHTML = `
        <style>
          :host{display:inline-block;width:var(--face-size,112px);height:var(--face-size,112px);contain:layout style;overflow:visible;cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:manipulation}
          svg{display:block;width:100%;height:100%;overflow:visible}
          #dragMotion{transform-box:view-box;transform-origin:120px 120px;will-change:transform}
          #headFollow{will-change:transform}
          #headMotion{transform-origin:120px 120px;will-change:transform}
          #inputL,#inputR{opacity:1}
        </style>
        <svg viewBox="0 0 240 240" role="img" aria-label="Robot avatar">
          <defs>
            <path id="headShape" d="M 120.00 20.00 L 132.80 20.05 L 139.87 20.20 L 145.68 20.44 L 150.79 20.78 L 155.43 21.22 L 159.71 21.76 L 163.69 22.40 L 167.44 23.14 L 170.99 23.97 L 174.34 24.90 L 177.53 25.93 L 180.57 27.07 L 183.46 28.30 L 186.22 29.63 L 188.85 31.06 L 191.36 32.59 L 193.75 34.22 L 196.03 35.96 L 198.19 37.80 L 200.25 39.75 L 202.20 41.81 L 204.04 43.97 L 205.78 46.25 L 207.41 48.64 L 208.94 51.15 L 210.37 53.78 L 211.70 56.54 L 212.93 59.43 L 214.07 62.47 L 215.10 65.66 L 216.03 69.01 L 216.86 72.56 L 217.60 76.31 L 218.24 80.29 L 218.78 84.57 L 219.22 89.21 L 219.56 94.32 L 219.80 100.13 L 219.95 107.20 L 220.00 120.00 L 219.95 132.80 L 219.80 139.87 L 219.56 145.68 L 219.22 150.79 L 218.78 155.43 L 218.24 159.71 L 217.60 163.69 L 216.86 167.44 L 216.03 170.99 L 215.10 174.34 L 214.07 177.53 L 212.93 180.57 L 211.70 183.46 L 210.37 186.22 L 208.94 188.85 L 207.41 191.36 L 205.78 193.75 L 204.04 196.03 L 202.20 198.19 L 200.25 200.25 L 198.19 202.20 L 196.03 204.04 L 193.75 205.78 L 191.36 207.41 L 188.85 208.94 L 186.22 210.37 L 183.46 211.70 L 180.57 212.93 L 177.53 214.07 L 174.34 215.10 L 170.99 216.03 L 167.44 216.86 L 163.69 217.60 L 159.71 218.24 L 155.43 218.78 L 150.79 219.22 L 145.68 219.56 L 139.87 219.80 L 132.80 219.95 L 120.00 220.00 L 107.20 219.95 L 100.13 219.80 L 94.32 219.56 L 89.21 219.22 L 84.57 218.78 L 80.29 218.24 L 76.31 217.60 L 72.56 216.86 L 69.01 216.03 L 65.66 215.10 L 62.47 214.07 L 59.43 212.93 L 56.54 211.70 L 53.78 210.37 L 51.15 208.94 L 48.64 207.41 L 46.25 205.78 L 43.97 204.04 L 41.81 202.20 L 39.75 200.25 L 37.80 198.19 L 35.96 196.03 L 34.22 193.75 L 32.59 191.36 L 31.06 188.85 L 29.63 186.22 L 28.30 183.46 L 27.07 180.57 L 25.93 177.53 L 24.90 174.34 L 23.97 170.99 L 23.14 167.44 L 22.40 163.69 L 21.76 159.71 L 21.22 155.43 L 20.78 150.79 L 20.44 145.68 L 20.20 139.87 L 20.05 132.80 L 20.00 120.00 L 20.05 107.20 L 20.20 100.13 L 20.44 94.32 L 20.78 89.21 L 21.22 84.57 L 21.76 80.29 L 22.40 76.31 L 23.14 72.56 L 23.97 69.01 L 24.90 65.66 L 25.93 62.47 L 27.07 59.43 L 28.30 56.54 L 29.63 53.78 L 31.06 51.15 L 32.59 48.64 L 34.22 46.25 L 35.96 43.97 L 37.80 41.81 L 39.75 39.75 L 41.81 37.80 L 43.97 35.96 L 46.25 34.22 L 48.64 32.59 L 51.15 31.06 L 53.78 29.63 L 56.54 28.30 L 59.43 27.07 L 62.47 25.93 L 65.66 24.90 L 69.01 23.97 L 72.56 23.14 L 76.31 22.40 L 80.29 21.76 L 84.57 21.22 L 89.21 20.78 L 94.32 20.44 L 100.13 20.20 L 107.20 20.05 Z"/>
            <clipPath id="headClip"><use href="#headShape" transform="translate(7.2 7.2) scale(.94)"/></clipPath>
            <clipPath id="eyeMaskClip" clipPathUnits="userSpaceOnUse"><rect x="-40" y="-54" width="80" height="108"/></clipPath>
          </defs>
          <g id="dragMotion">
            <g id="headFollow">
              <g id="headMotion">
              <use id="head" href="#headShape" fill="#08090b" transform="translate(7.2 7.2) scale(.94)"/>
              <g clip-path="url(#headClip)">
                <g id="leftEye" transform="translate(86 126)">
                  <ellipse id="leftBase" cx="0" cy="0" rx="27" ry="29" fill="#fff"/>
                  <rect id="leftInputBase" x="-6" y="-39" width="12" height="78" rx="3" fill="#fff" opacity="0"/>
                  <g clip-path="url(#eyeMaskClip)">
                    <rect id="leftTop" x="-70" y="-96" width="140" height="60" fill="#08090b"/>
                    <rect id="leftBottom" x="-70" y="36" width="140" height="60" fill="#08090b"/>
                  </g>
                </g>
                <g id="rightEye" transform="translate(154 126)">
                  <ellipse id="rightBase" cx="0" cy="0" rx="27" ry="29" fill="#fff"/>
                  <rect id="rightInputBase" x="-6" y="-39" width="12" height="78" rx="3" fill="#fff" opacity="0"/>
                  <g clip-path="url(#eyeMaskClip)">
                    <rect id="rightTop" x="-70" y="-96" width="140" height="60" fill="#08090b"/>
                    <rect id="rightBottom" x="-70" y="36" width="140" height="60" fill="#08090b"/>
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
        </svg>`;
          this._headShape = this.shadowRoot.getElementById("headShape");
          this._dragMotion = this.shadowRoot.getElementById("dragMotion");
          this._headFollow = this.shadowRoot.getElementById("headFollow");
          this._headMotion = this.shadowRoot.getElementById("headMotion");
          this._head = this.shadowRoot.getElementById("head");
          this._leftEye = this.shadowRoot.getElementById("leftEye");
          this._rightEye = this.shadowRoot.getElementById("rightEye");
          this._leftBase = this.shadowRoot.getElementById("leftBase");
          this._rightBase = this.shadowRoot.getElementById("rightBase");
          this._leftInputBase = this.shadowRoot.getElementById("leftInputBase");
          this._rightInputBase = this.shadowRoot.getElementById("rightInputBase");
          this._leftTop = this.shadowRoot.getElementById("leftTop");
          this._rightTop = this.shadowRoot.getElementById("rightTop");
          this._leftBottom = this.shadowRoot.getElementById("leftBottom");
          this._rightBottom = this.shadowRoot.getElementById("rightBottom");
          this._applyColor(this.getAttribute("color"));
          this._baseHeadPathD = this._headShape.getAttribute("d");
          this._baseHeadPoints = this._parseHeadPoints(this._baseHeadPathD);
        }
        _parseHeadPoints(d) {
          const nums = (d.match(/-?\d*\.?\d+/g) || []).map(Number);
          const pts = [];
          for (let i = 0; i < nums.length - 1; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
          return pts;
        }
        _pointsToPath(points) {
          if (!points.length) return this._baseHeadPathD || "";
          let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
          for (let i = 1; i < points.length; i++) d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
          return `${d} Z`;
        }
        _clientToLocal(clientX, clientY) {
          const r = this.getBoundingClientRect();
          return {
            x: clamp((clientX - r.left) / Math.max(1, r.width) * 240, 0, 240),
            y: clamp((clientY - r.top) / Math.max(1, r.height) * 240, 0, 240)
          };
        }
        _applyHeadDeform() {
          var _a;
          const j = this._dragJelly;
          if (!this._headShape || !((_a = this._baseHeadPoints) == null ? void 0 : _a.length)) return;
          const amount = Math.hypot(j.pullX, j.pullY);
          if (amount < 0.015) {
            setA(this._headShape, "d", this._baseHeadPathD);
            return;
          }
          const radius = (50 + amount * 0.8) * 0.92;
          const pts = this._baseHeadPoints.map((p) => {
            const dx = p.x - j.hotX;
            const dy = p.y - j.hotY;
            const w = Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius));
            return { x: p.x + j.pullX * w, y: p.y + j.pullY * w };
          });
          setA(this._headShape, "d", this._pointsToPath(pts));
        }
        _onVisibility() {
          var _a;
          this._running = !document.hidden;
          if (this._running) this._resumeFrames();
          else {
            (_a = this._cancelGesture) == null ? void 0 : _a.call(this);
            cancelAnimationFrame(this._raf);
            this._raf = 0;
          }
        }
        _onClickCapture(e) {
          if (!this._suppressClick) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          this._suppressClick = false;
        }
        _onPointerMove(e) {
          const r = this.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const dx = e.clientX - cx;
          const dy = e.clientY - cy;
          const near = Math.max(r.width, r.height) * 2.55;
          const dist = Math.hypot(dx, dy);
          const influence = clamp(1 - dist / near, 0, 1);
          const scale = Math.min(1, 120 / Math.max(1, r.width, r.height));
          this._pointer.x = clamp(dx * 0.42 * scale, -48, 48);
          this._pointer.y = clamp(dy * 0.38 * scale, -34, 34);
          this._pointer.active = influence > 1e-3;
          this._pointer.influence = influence;
          this._pointer.lastMove = performance.now();
          if ((this._pointer.influence || 0) > 0.65 && this._boredRoutine) {
            this._boredRoutine = null;
            this._boredLookSpeed = null;
          }
        }
        _onDragStart(e) {
          if (e.button != null && e.button !== 0) return;
          const r = this.getBoundingClientRect();
          const j = this._dragJelly;
          j.active = true;
          j.returning = false;
          j.snapped = false;
          j.moved = false;
          j.pointerId = e.pointerId;
          j.startX = e.clientX;
          j.startY = e.clientY;
          const local = this._clientToLocal(e.clientX, e.clientY);
          j.hotX = local.x;
          j.hotY = local.y;
          j.targetX = j.x;
          j.targetY = j.y;
          j.targetStretch = j.stretch;
          j.targetShear = j.shear;
          j.targetPullX = j.pullX;
          j.targetPullY = j.pullY;
          j.threshold = clamp(r.width * 0.4, 24, 46);
          j.maxDist = 0;
          j.pendingReaction = null;
          j.intent = "angry";
          j.angryThreshold = Math.max(j.threshold * 0.76, 22);
          this._suppressClick = false;
          this._boredRoutine = null;
          this._boredLookSpeed = null;
          this._wanderTarget.x = this._wanderTarget.y = 0;
          try {
            this.setPointerCapture(e.pointerId);
          } catch (_) {
          }
        }
        _onDragMove(e) {
          const j = this._dragJelly;
          if (!j.active || e.pointerId !== j.pointerId) return;
          const dx = e.clientX - j.startX;
          const dy = e.clientY - j.startY;
          const dist = Math.hypot(dx, dy);
          j.maxDist = Math.max(j.maxDist, dist);
          if (dist > 2.5) {
            j.moved = true;
            this._suppressClick = true;
          }
          const r = this.getBoundingClientRect();
          const size = Math.max(1, Math.max(r.width, r.height));
          const localScale = 240 / size;
          const pdx = dx * localScale;
          const pdy = dy * localScale;
          const cx = 120, cy = 120;
          const rx = j.hotX - cx;
          const ry = j.hotY - cy;
          const rl = Math.max(1, Math.hypot(rx, ry));
          const rux = rx / rl;
          const ruy = ry / rl;
          const radial = pdx * rux + pdy * ruy;
          const tangent = -pdx * ruy + pdy * rux;
          const motionLen = Math.max(1, Math.hypot(pdx, pdy));
          j.ux = pdx / motionLen;
          j.uy = pdy / motionLen;
          j.angle = Math.atan2(j.uy, j.ux);
          j.intent = radial < -6 ? "success" : "angry";
          const gain = dist > j.threshold * 0.6 ? 0.24 : 0.19;
          j.targetPullX = stiffPull(pdx * gain);
          j.targetPullY = stiffPull(pdy * gain);
          j.targetX = clamp(dx * 0.065, -5.2, 5.2);
          j.targetY = clamp(dy * 0.065, -5.2, 5.2);
          j.targetStretch = clamp(radial / 240 * 0.08, -0.028, 0.052);
          j.targetShear = clamp(tangent / 240 * 0.05, -0.022, 0.022);
          j.anchorX = clamp(50 - rux * 31, 15, 85);
          j.anchorY = clamp(50 - ruy * 31, 15, 85);
        }
        _onDragEnd(e) {
          const j = this._dragJelly;
          if (!j.active || e.pointerId !== j.pointerId) return;
          j.active = false;
          try {
            this.releasePointerCapture(e.pointerId);
          } catch (_) {
          }
          j.pointerId = null;
          const reactionThreshold = Math.max(j.angryThreshold, 22);
          j.pendingReaction = j.maxDist >= reactionThreshold ? j.intent : null;
          j.returning = true;
          j.targetX = 0;
          j.targetY = 0;
          j.targetStretch = 0;
          j.targetShear = 0;
          j.targetPullX = 0;
          j.targetPullY = 0;
        }
        _finishDragReturn(reaction) {
          const j = this._dragJelly;
          j.returning = false;
          j.pendingReaction = null;
          j.x = j.y = j.vx = j.vy = 0;
          j.stretch = j.stretchVel = 0;
          j.shear = j.shearVel = 0;
          j.pullX = j.pullY = j.pullVX = j.pullVY = 0;
          if (this._dragMotion) this._dragMotion.style.transform = "";
          if (this._headShape) setA(this._headShape, "d", this._baseHeadPathD);
          if (reaction === "angry") this.angry({ fromDrag: true });
          else if (reaction === "success") this.success({ fromDrag: true });
        }
        _updateDragJelly(dt) {
          const j = this._dragJelly;
          const dtS = Math.min(dt, 34) / 1e3;
          if (j.active) {
            const fast = Math.min(1, dt / 14);
            const k = 0.36 + 0.3 * fast;
            j.x = lerp(j.x, j.targetX, k);
            j.y = lerp(j.y, j.targetY, k);
            j.stretch = lerp(j.stretch, j.targetStretch, k * 0.85);
            j.shear = lerp(j.shear, j.targetShear, k * 0.8);
            j.pullX = lerp(j.pullX, j.targetPullX, k * 0.95);
            j.pullY = lerp(j.pullY, j.targetPullY, k * 0.95);
          } else if (j.returning) {
            const kx = 135, dx = 8.2;
            const ax = -j.x * kx - j.vx * dx;
            const ay = -j.y * kx - j.vy * dx;
            j.vx += ax * dtS;
            j.vy += ay * dtS;
            j.x += j.vx * dtS;
            j.y += j.vy * dtS;
            const ks = 128, ds = 7.5;
            const as = -j.stretch * ks - j.stretchVel * ds;
            j.stretchVel += as * dtS;
            j.stretch += j.stretchVel * dtS;
            const kh = 118, dh = 7.2;
            const ah = -j.shear * kh - j.shearVel * dh;
            j.shearVel += ah * dtS;
            j.shear += j.shearVel * dtS;
            const kp = 118, dp = 7.1;
            const apx = -j.pullX * kp - j.pullVX * dp;
            const apy = -j.pullY * kp - j.pullVY * dp;
            j.pullVX += apx * dtS;
            j.pullVY += apy * dtS;
            j.pullX += j.pullVX * dtS;
            j.pullY += j.pullVY * dtS;
            const visuallyRecovered = Math.abs(j.x) < 0.34 && Math.abs(j.y) < 0.34 && Math.abs(j.stretch) < 8e-3 && Math.abs(j.shear) < 35e-4 && Math.abs(j.pullX) < 0.4 && Math.abs(j.pullY) < 0.4;
            if (j.pendingReaction && visuallyRecovered) {
              this._finishDragReturn(j.pendingReaction);
            } else if (Math.abs(j.x) < 0.02 && Math.abs(j.y) < 0.02 && Math.abs(j.vx) < 0.04 && Math.abs(j.vy) < 0.04 && Math.abs(j.stretch) < 1e-3 && Math.abs(j.stretchVel) < 3e-3 && Math.abs(j.shear) < 5e-4 && Math.abs(j.shearVel) < 2e-3 && Math.abs(j.pullX) < 0.03 && Math.abs(j.pullY) < 0.03 && Math.abs(j.pullVX) < 0.06 && Math.abs(j.pullVY) < 0.06) {
              this._finishDragReturn(null);
            }
          }
          j.stretch = clamp(j.stretch, -0.035, 0.055);
          j.shear = clamp(j.shear, -0.026, 0.026);
          j.pullX = clamp(j.pullX, -26, 26);
          j.pullY = clamp(j.pullY, -26, 26);
          if (!j.active && !j.returning && !j.pendingReaction && !j.x && !j.y && !j.stretch && !j.shear && !j.pullX && !j.pullY) return;
          this._applyHeadDeform();
          if (this._dragMotion) {
            const sx = 1 + j.stretch;
            const sy = 1 - j.stretch * 0.3;
            const shearDeg = j.shear * 180 / Math.PI;
            this._dragMotion.style.transformOrigin = `${j.anchorX.toFixed(2)}% ${j.anchorY.toFixed(2)}%`;
            this._dragMotion.style.transform = `translate(${j.x.toFixed(2)}px, ${j.y.toFixed(2)}px) rotate(${j.angle.toFixed(4)}rad) scale(${sx.toFixed(4)}, ${sy.toFixed(4)}) skewY(${shearDeg.toFixed(3)}deg) rotate(${(-j.angle).toFixed(4)}rad)`;
          }
        }
        noteActivity(wake = true) {
          this._lastActivity = performance.now();
          this._resumeFrames();
          if (wake && this._sleeping) this.wake();
        }
        play(name) {
          const action = String(name || "").trim().toLowerCase();
          switch (action) {
            case "idle":
              return this.reset();
            case "bored":
              return this.bored();
            case "input":
              return this.input(true);
            case "send":
              return this.send();
            case "success":
              return this.success();
            case "error":
              return this.error();
            case "angry":
              return this.angry();
            case "surprise":
              return this.surprise();
            case "sleep":
              return this.sleep();
            case "wake":
              return this.wake();
            default:
              throw new Error(`Unknown BoopFace action: ${name}`);
          }
        }
        reset() {
          return this._resetToIdle();
        }
        _resetToIdle(notify = true) {
          var _a;
          (_a = this._resetExtensionEffects) == null ? void 0 : _a.call(this);
          this._inputWanted = false;
          ++this._transitionToken;
          this._cancelPendingWaits();
          this._boredRoutine = null;
          this._boredLookSpeed = null;
          this._sleeping = false;
          this._eyeNod = null;
          this._eyeBob = null;
          this._angryEyeDrop = null;
          this._surpriseShake = null;
          this.setState("idle", { notify, duration: notify ? 320 : 0 });
          return this;
        }
        setState(name, opts = {}) {
          if (!POSES[name]) throw new Error(`Unknown AgentFace state: ${name}`);
          this._resumeFrames();
          this._state = name;
          this._sleeping = name === "sleep";
          if (name === "idle" && !opts.keepGazeLock) this._releaseExpressionLock();
          this._startMorph(POSES[name], opts.duration ?? (name === "surprise" ? 170 : 320), opts.ease || EASE.outQuint);
          if (opts.notify !== false) this.dispatchEvent(new CustomEvent("face-state", { detail: { state: name } }));
          return this;
        }
        _startMorph(target, duration, ease) {
          this._fromPose = clonePose(this._pose);
          this._toPose = clonePose(target);
          this._centerFrom = this._center ?? 0;
          this._centerTo = this._state === "input" ? 1 : 0;
          if (Math.abs(this._centerTo - this._centerFrom) > 0.01 && duration > 0) {
            duration = CURSOR_MS;
            ease = EASE.outCubic;
          }
          this._morphStart = performance.now();
          this._morphDuration = Math.max(0, duration);
          this._morphEase = ease;
        }
        async success(opts = {}) {
          const fromDrag = !!opts.fromDrag;
          this.noteActivity();
          this._inputWanted = false;
          if (fromDrag) {
            ++this._transitionToken;
            this._expressionLock = true;
            this._eyeMicro.lX = this._eyeMicro.lY = 0;
            this._eyeMicro.rX = this._eyeMicro.rY = 0;
            this._wanderTarget.x = this._wanderTarget.y = 0;
            this._headCenteringUntil = performance.now() + 120;
            this._look.x = 0;
            this._look.y = 0;
          } else {
            if (!await this._prepareExpression({ normalizePose: true, duration: 180, pause: 320 })) return;
          }
          const token = this._transitionToken;
          this.setState("happy", { duration: fromDrag ? 180 : 220, keepGazeLock: true });
          this._eyeBob = { start: performance.now(), duration: 620, amp: 8 };
          this._animateHead([
            { transform: "translateY(0px)" },
            { transform: "translateY(-2.4px)", offset: 0.42 },
            { transform: "translateY(0px)" }
          ], 760);
          await this._wait(980);
          if (token !== this._transitionToken) return;
          this._eyeBob = null;
          if (this._state === "happy") await this._returnToIdle(520);
        }
        async error() {
          this.noteActivity();
          this._inputWanted = false;
          if (!await this._prepareExpression({ normalizePose: true, duration: 180, pause: 320 })) return;
          const token = this._transitionToken;
          this.setState("sad", { duration: 320, keepGazeLock: true });
          this._eyeBob = { start: performance.now(), duration: 700, amp: 7 };
          this._animateHead([
            { transform: "translateY(0px)" },
            { transform: "translateY(2.6px)", offset: 0.46 },
            { transform: "translateY(0px)" }
          ], 820);
          await this._wait(1180);
          if (token !== this._transitionToken) return;
          this._eyeBob = null;
          if (this._state === "sad") {
            await this._returnToIdle(560);
          }
        }
        async angry(opts = {}) {
          const fromDrag = !!opts.fromDrag;
          this.noteActivity();
          this._inputWanted = false;
          if (fromDrag) {
            ++this._transitionToken;
            this._expressionLock = true;
            this._eyeMicro.lX = this._eyeMicro.lY = 0;
            this._eyeMicro.rX = this._eyeMicro.rY = 0;
            this._wanderTarget.x = this._wanderTarget.y = 0;
            this._headCenteringUntil = performance.now() + 120;
            this._look.x = 0;
            this._look.y = 0;
          } else {
            if (!await this._prepareExpression({ normalizePose: true, duration: 180, pause: 320 })) return;
          }
          const token = this._transitionToken;
          this.setState("angry", { duration: fromDrag ? 180 : 280, keepGazeLock: true });
          this._angryEyeDrop = { start: performance.now(), duration: 680, amount: 4.8 };
          this._animateHead([
            { transform: "translateY(0px)" },
            { transform: "translateY(2.6px)", offset: 0.46 },
            { transform: "translateY(0px)" }
          ], 820);
          await this._wait(980);
          if (token !== this._transitionToken) return;
          this._angryEyeDrop = null;
          if (this._state === "angry") await this._returnToIdle(500);
        }
        async surprise() {
          this.noteActivity();
          this._inputWanted = false;
          if (!await this._prepareExpression({ normalizePose: true, duration: 180, pause: 320 })) return;
          const token = this._transitionToken;
          this._surpriseShake = null;
          const pre = { ...POSES.idle, w: 34, h: 36, rx: 18 };
          this._startMorph(pre, 235, EASE.inOutCubic);
          await this._wait(235);
          if (token !== this._transitionToken || this._state !== "idle") return;
          this.setState("surprise", { duration: 175, ease: EASE.outQuint, keepGazeLock: true });
          this._animateHead([{ transform: "scale(1)" }, { transform: "scale(1.035)" }], 175);
          await this._wait(175);
          if (token !== this._transitionToken || this._state !== "surprise") return;
          this._surpriseShake = { start: performance.now(), duration: 420 };
          await this._wait(420);
          if (token !== this._transitionToken) return;
          this._surpriseShake = null;
          if (this._state === "surprise") {
            this._animateHead([{ transform: "scale(1.035)" }, { transform: "scale(1)" }], 430);
            await this._returnToIdle(430, EASE.inOutCubic);
          }
        }
        async send() {
          this.noteActivity();
          this._inputWanted = false;
          if (!await this._prepareExpression({ normalizePose: true, duration: 180, pause: 320 })) return;
          const token = this._transitionToken;
          this._eyeNod = { start: performance.now(), duration: 760 };
          this._animateHead([
            { transform: "translateY(0px)" },
            { transform: "translateY(5px)", offset: 0.52 },
            { transform: "translateY(0px)" }
          ], 920);
          await this._wait(860);
          if (token !== this._transitionToken) return;
          this._eyeNod = null;
          this._releaseExpressionLock();
        }
        async sleep() {
          if (this._sleeping) return;
          if (!await this._prepareExpression({ normalizePose: true, duration: 160 })) return;
          const token = this._transitionToken;
          this._blinkAnim = null;
          this._blink = 1;
          this._nextBlinkAt = performance.now() + 1e4;
          this.setState("sleepy", { duration: 940, ease: EASE.inOutCubic, keepGazeLock: true });
          await this._wait(980);
          if (token !== this._transitionToken || this._state !== "sleepy") return;
          const reopen = { ...POSES.idle, topY: -22, bottomY: 36 };
          this._startMorph(reopen, 105, EASE.outQuint);
          await this._wait(120);
          if (token !== this._transitionToken || this._state !== "sleepy") return;
          this.setState("sleepy", { duration: 820, ease: EASE.inOutCubic, keepGazeLock: true });
          await this._wait(870);
          if (token !== this._transitionToken || this._state !== "sleepy") return;
          await this._wait(120);
          if (token !== this._transitionToken || this._state !== "sleepy") return;
          this._animateHead([{ transform: "translateY(0)" }, { transform: "translateY(4px)" }], 980);
          this._startMorph(POSES.sleep, 980, EASE.inOutCubic);
          this._state = "sleep";
          this.dispatchEvent(new CustomEvent("face-state", { detail: { state: "sleep" } }));
          this._sleeping = true;
          this._nextBlinkAt = performance.now() + 3200 + Math.random() * 2200;
        }
        async wake() {
          if (!this._sleeping && this._state !== "sleep") return;
          const token = ++this._transitionToken;
          this._expressionLock = true;
          this._sleeping = false;
          this._animateHead([
            { transform: "translateY(4px) scale(1)" },
            { transform: "translateY(-2px) scale(1.015)", offset: 0.55 },
            { transform: "translateY(0) scale(1)" }
          ], 500);
          this.setState("sleepy", { duration: 240, keepGazeLock: true });
          await this._wait(260);
          if (token !== this._transitionToken) return;
          this.setState("surprise", { duration: 120, keepGazeLock: true });
          await this._wait(190);
          if (token !== this._transitionToken) return;
          await this._returnToIdle(300);
          if (token !== this._transitionToken) return;
          this._lastActivity = performance.now();
        }
        async input(active = true) {
          this.noteActivity();
          if (active) {
            if (this._inputWanted || this._state === "input") return;
            this._inputWanted = true;
            if (!await this._prepareExpression({ normalizePose: true, duration: 140 })) return;
            if (!this._inputWanted) return;
            this.setState("input", { duration: 210, keepGazeLock: true });
          } else {
            this._inputWanted = false;
            ++this._transitionToken;
            if (this._state === "input") this.setState("idle", { duration: 260 });
            else this._releaseExpressionLock();
          }
        }
        _animateHead(frames, duration) {
          if (!this._headMotion.animate) return;
          const token = this._transitionToken;
          const anim = this._headMotion.animate(frames, { duration, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" });
          anim.onfinish = () => {
            if (token === this._transitionToken) {
              this._headMotion.style.transform = frames[frames.length - 1].transform || "";
            }
          };
          return anim;
        }
        _wait(ms) {
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              this._pendingWaits.delete(timer);
              resolve();
            }, ms);
            this._pendingWaits.set(timer, resolve);
          });
        }
        _cancelPendingWaits() {
          for (const [timer, resolve] of this._pendingWaits) {
            clearTimeout(timer);
            resolve();
          }
          this._pendingWaits.clear();
        }
        async _returnToIdle(duration = 320, ease = EASE.outQuint) {
          const token = this._transitionToken;
          this.setState("idle", { duration, ease, keepGazeLock: true });
          this._headCenteringUntil = Math.max(this._headCenteringUntil || 0, performance.now() + duration);
          await this._wait(duration);
          if (token === this._transitionToken && this._state === "idle") this._releaseExpressionLock();
        }
        async _prepareExpression({ normalizePose = true, duration = 180, pause = 320 } = {}) {
          const token = ++this._transitionToken;
          this._expressionLock = true;
          this._eyeMicro.lX = this._eyeMicro.lY = 0;
          this._eyeMicro.rX = this._eyeMicro.rY = 0;
          this._wanderTarget.x = this._wanderTarget.y = 0;
          this._headCenteringUntil = performance.now() + duration + pause;
          const fromCursor = (this._center ?? 0) > 0.01;
          if (normalizePose && this._state !== "idle") {
            this.setState("idle", { duration: Math.min(140, duration), keepGazeLock: true });
          }
          await this._wait(fromCursor ? Math.max(duration, CURSOR_MS) : duration);
          if (token !== this._transitionToken) return false;
          if (pause > 0) await this._wait(pause);
          return token === this._transitionToken;
        }
        async bored() {
          this.noteActivity();
          this._inputWanted = false;
          this._sleeping = false;
          if (!await this._prepareExpression({ normalizePose: true, duration: 180, pause: 620 })) return;
          this._expressionLock = false;
          this._look.x = 0;
          this._look.y = 0;
          this._wander.x = 0;
          this._wander.y = 0;
          this._startBoredRoutine(performance.now());
        }
        _startBoredRoutine(now) {
          this._boredRoutine = {
            index: 0,
            nextAt: now,
            steps: [
              { x: -18, y: -11, hold: 1400, lookSpeed: 2 },
              { x: 18, y: -11, hold: 1400, lookSpeed: 2 },
              { x: 0, y: 0, hold: 320, lookSpeed: 2 }
            ]
          };
        }
        _updateBored(now) {
          if (!this._boredRoutine) return false;
          if (now < this._boredRoutine.nextAt) return true;
          const step = this._boredRoutine.steps[this._boredRoutine.index];
          if (!step) {
            this._boredRoutine = null;
            this._boredLookSpeed = null;
            this._wanderTarget.x = this._wanderTarget.y = 0;
            return false;
          }
          this._wanderTarget.x = step.x;
          this._wanderTarget.y = step.y;
          this._boredLookSpeed = step.lookSpeed ?? null;
          this._boredRoutine.index += 1;
          this._boredRoutine.nextAt = now + step.hold;
          return true;
        }
        _releaseExpressionLock() {
          this._expressionLock = false;
          this._headCenteringUntil = 0;
        }
        _updateMorph(now) {
          if (!this._morphDuration) {
            this._pose = clonePose(this._toPose);
            this._center = this._centerTo ?? 0;
            return;
          }
          const t = clamp((now - this._morphStart) / this._morphDuration, 0, 1);
          const k = this._morphEase(t);
          this._center = lerp(this._centerFrom ?? 0, this._centerTo ?? 0, k);
          const p = {};
          for (const key of Object.keys(this._toPose)) p[key] = lerp(this._fromPose[key], this._toPose[key], k);
          this._pose = p;
          if (t >= 1) this._morphDuration = 0;
        }
        _updateBlink(now) {
          if (this._sleeping || this._state === "input") return;
          if (this._blinkAnim) {
            const t = clamp((now - this._blinkAnim.start) / this._blinkAnim.duration, 0, 1);
            this._blink = t < 0.5 ? lerp(1, 0.08, t * 2) : lerp(0.08, 1, (t - 0.5) * 2);
            if (t >= 1) {
              this._blinkAnim = null;
              this._blink = 1;
              this._nextBlinkAt = now + 1900 + Math.random() * 2600;
            }
          } else if (!this._expressionLock && now >= this._nextBlinkAt) {
            this._blinkAnim = { start: now, duration: 150 + Math.random() * 70 };
          }
        }
        _updateLook(now, dt) {
          var _a;
          this._updateBored(now);
          const pointerFresh = now - this._pointer.lastMove < 900;
          const antennaGaze = ((_a = this._gestureFx) == null ? void 0 : _a.kind) === "antenna-drag" && this._gestureFx.held;
          const gazeLocked = this._expressionLock && !antennaGaze;
          const idleGaze = this._idleGaze ?? String(this.getAttribute("idle-gaze") ?? "").trim().toLowerCase() !== "false";
          if (!idleGaze && !this._boredRoutine) this._wanderTarget.x = this._wanderTarget.y = 0;
          if (idleGaze && !this._expressionLock && !this._boredRoutine && !this._sleeping && this._state !== "input" && now >= this._nextWanderAt) {
            const ampX = 12 + Math.random() * 13;
            const ampY = 5 + Math.random() * 9;
            this._wanderTarget.x = (Math.random() * 2 - 1) * ampX;
            this._wanderTarget.y = (Math.random() * 2 - 1) * ampY;
            this._nextWanderAt = now + 1150 + Math.random() * 1900;
          }
          const draggingJelly = this._dragJelly.active || this._dragJelly.returning;
          const pointerMix = !gazeLocked && !this._boredRoutine && pointerFresh && this._pointer.active && !this._sleeping && this._state !== "input" ? Math.pow(this._pointer.influence || 0, 1.6) : 0;
          let targetX = antennaGaze ? this._gestureFx.gazeX : gazeLocked ? 0 : lerp(this._wanderTarget.x, this._pointer.x, pointerMix);
          let targetY = antennaGaze ? this._gestureFx.gazeY : gazeLocked ? 0 : lerp(this._wanderTarget.y, this._pointer.y, pointerMix);
          const reach = Math.hypot(targetX / 48, targetY / 34);
          if (reach > 1) {
            targetX /= reach;
            targetY /= reach;
          }
          const lookSpeed = antennaGaze ? 0.42 : gazeLocked ? 0.4 : draggingJelly ? 0.42 : this._boredRoutine && this._boredLookSpeed != null ? this._boredLookSpeed : pointerMix > 0.05 ? 0.28 : 0.16;
          const kL = 1 - Math.pow(1 - clamp(lookSpeed, 0.02, 0.9), dt / 16.67);
          this._look.x = lerp(this._look.x, targetX, kL);
          this._look.y = lerp(this._look.y, targetY, kL);
          if (this._sleeping) {
            this._look.x *= 0.92;
            this._look.y *= 0.92;
          }
        }
        _autoSleep(now) {
          if (!this._autoSleepMs || this._sleeping || this._expressionLock || ["input", "happy", "sad", "surprise"].includes(this._state)) return;
          if (now - this._lastActivity > this._autoSleepMs) this.sleep();
        }
        _updateHeadFollow(now, dt) {
          const pointerFresh = now - this._pointer.lastMove < 900;
          const pointerInRange = pointerFresh && this._pointer.active && (this._pointer.influence || 0) > 0.03;
          const headCentering = now < (this._headCenteringUntil || 0);
          const jellyBusy = this._dragJelly.active || this._dragJelly.returning;
          const canFollowPointer = pointerInRange && !jellyBusy && !this._sleeping && !this._boredRoutine && !headCentering && !this._expressionLock;
          const srcX = canFollowPointer ? this._pointer.x : this._look.x;
          const srcY = canFollowPointer ? this._pointer.y : this._look.y;
          const nx = clamp(srcX / 48, -1, 1);
          const ny = clamp(srcY / 34, -1, 1);
          const diag = clamp(nx * ny, -1, 1);
          const targetRot = diag * 8;
          const targetX = canFollowPointer ? nx * 4.2 : 0;
          const targetY = canFollowPointer ? ny * 4.2 : 0;
          const dtS = Math.min(dt, 34) / 1e3;
          const rotStiffness = canFollowPointer ? 70 : 56;
          const rotDamping = canFollowPointer ? 15 : 13;
          const aRot = (targetRot - this._headFollowPose.rot) * rotStiffness - this._headFollowVel.rot * rotDamping;
          this._headFollowVel.rot += aRot * dtS;
          this._headFollowPose.rot += this._headFollowVel.rot * dtS;
          const stiffness = canFollowPointer ? 95 : 80;
          const damping = canFollowPointer ? 16 : 14;
          const ax = (targetX - this._headFollowPose.x) * stiffness - this._headFollowVel.x * damping;
          const ay = (targetY - this._headFollowPose.y) * stiffness - this._headFollowVel.y * damping;
          this._headFollowVel.x += ax * dtS;
          this._headFollowVel.y += ay * dtS;
          this._headFollowPose.x += this._headFollowVel.x * dtS;
          this._headFollowPose.y += this._headFollowVel.y * dtS;
          if (!canFollowPointer) {
            if (Math.abs(this._headFollowPose.x) < 0.01 && Math.abs(this._headFollowVel.x) < 0.01) {
              this._headFollowPose.x = 0;
              this._headFollowVel.x = 0;
            }
            if (Math.abs(this._headFollowPose.y) < 0.01 && Math.abs(this._headFollowVel.y) < 0.01) {
              this._headFollowPose.y = 0;
              this._headFollowVel.y = 0;
            }
            if (Math.abs(this._headFollowPose.rot) < 0.01 && Math.abs(this._headFollowVel.rot) < 0.01) {
              this._headFollowPose.rot = 0;
              this._headFollowVel.rot = 0;
            }
          }
          if (this._headFollow) {
            const a = this._headFollowPose.rot.toFixed(2);
            const tx = this._headFollowPose.x.toFixed(2);
            const ty = this._headFollowPose.y.toFixed(2);
            setA(this._headFollow, "transform", `translate(${tx} ${ty}) translate(120 120) rotate(${a}) translate(-120 -120)`);
          }
        }
        _draw(now) {
          const p = this._pose;
          let nodY = 0;
          let nodScaleY = 1;
          if (this._eyeNod) {
            const elapsed = now - this._eyeNod.start;
            let depth = 0;
            if (elapsed < 150) depth = elapsed / 150;
            else if (elapsed < 300) depth = 1 - (elapsed - 150) / 150;
            else if (elapsed < 450) depth = (elapsed - 300) / 150;
            else if (elapsed < 760) depth = 1 - (elapsed - 450) / 310;
            else {
              depth = 0;
              this._eyeNod = null;
            }
            depth = clamp(depth, 0, 1);
            nodY = 31 * depth;
            nodScaleY = 1 - 0.3 * depth;
          }
          let angryDropY = 0;
          if (this._angryEyeDrop) {
            const t = clamp((now - this._angryEyeDrop.start) / this._angryEyeDrop.duration, 0, 1);
            const settle = 1 - Math.exp(-5.2 * t) * Math.cos(8.6 * t);
            angryDropY = this._angryEyeDrop.amount * settle;
            if (t >= 1) angryDropY = this._angryEyeDrop.amount;
          }
          let emotionBobY = 0;
          if (this._eyeBob) {
            const t = clamp((now - this._eyeBob.start) / this._eyeBob.duration, 0, 1);
            const cycles = 2;
            emotionBobY = Math.sin(t * Math.PI * cycles * 2) * this._eyeBob.amp * (1 - 0.38 * t);
            if (t >= 1) this._eyeBob = null;
          }
          let surpriseScale = 1;
          if (this._surpriseShake) {
            const t = clamp((now - this._surpriseShake.start) / this._surpriseShake.duration, 0, 1);
            surpriseScale = 1 + 0.022 * Math.sin(t * Math.PI * 8) * (1 - 0.18 * t);
            if (t >= 1) this._surpriseShake = null;
          }
          const blinkH = Math.max(2.6, p.h * this._blink * nodScaleY * surpriseScale);
          const yAdjust = (p.h - blinkH) * 0.02;
          const cursorPeriod = 1060;
          const inputBlinkOn = this._state === "input" ? Math.floor(now / (cursorPeriod / 2)) % 2 === 0 : true;
          const inputPulseL = this._state === "input" ? inputBlinkOn ? 1 : 0 : 1;
          const inputPulseR = inputPulseL;
          const jellyEyeOffset = (cx, cy) => {
            const j = this._dragJelly;
            const amount = Math.hypot(j.pullX, j.pullY);
            if (amount < 0.05) return { x: 0, y: 0 };
            const radius = (50 + amount * 0.8) * 0.92;
            const dx = cx - j.hotX;
            const dy = cy - j.hotY;
            const w = Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius)) * 0.24;
            return { x: j.pullX * w, y: j.pullY * w };
          };
          const cursor = clamp(this._center ?? 0, 0, 1);
          const cursorCorner = String(this.getAttribute("eye-style") || "").trim().toLowerCase() === "sharp" ? 3 : p.w / 2;
          const setEye = (base, inputBase, top, bottom, side, cx, microX, microY, opacity) => {
            const isInput = this._state === "input" || cursor > 1e-3;
            const projectedX = cx + this._look.x + microX;
            const edgeDistance = side === "L" ? projectedX - 32 : 208 - projectedX;
            const edgeFactor = clamp(1 - edgeDistance / 58, 0, 1);
            const baseW = p.w * surpriseScale;
            const baseH = blinkH;
            const w = baseW * (1 - 0.22 * edgeFactor * edgeFactor);
            const h = baseH * (1 - 0.08 * edgeFactor * edgeFactor);
            const inwardShift = (baseW - w) * 0.58 * (side === "L" ? 1 : -1);
            if (isInput) {
              setA(base, "opacity", "0");
              setA(inputBase, "x", (-p.w / 2).toFixed(2));
              setA(inputBase, "y", (-p.h / 2 + yAdjust).toFixed(2));
              setA(inputBase, "width", p.w.toFixed(2));
              setA(inputBase, "height", p.h.toFixed(2));
              setA(inputBase, "rx", lerp(p.w / 2, cursorCorner, cursor).toFixed(2));
              setA(inputBase, "ry", lerp(p.h / 2, cursorCorner, cursor).toFixed(2));
              setA(inputBase, "opacity", opacity.toFixed(3));
            } else {
              setA(inputBase, "opacity", "0");
              setA(base, "cx", "0");
              setA(base, "cy", yAdjust.toFixed(2));
              setA(base, "rx", (w / 2).toFixed(2));
              setA(base, "ry", (h / 2).toFixed(2));
              setA(base, "opacity", opacity.toFixed(3));
            }
            const topY = p.topY;
            const bottomY = p.bottomY;
            const ta = side === "L" ? p.topAL : p.topAR;
            const ba = side === "L" ? p.bottomAL : p.bottomAR;
            setA(top, "y", (topY - 90).toFixed(2));
            setA(top, "height", "90");
            setA(top, "transform", `rotate(${ta.toFixed(2)} 0 ${topY.toFixed(2)})`);
            setA(bottom, "y", bottomY.toFixed(2));
            setA(bottom, "height", "90");
            setA(bottom, "transform", `rotate(${ba.toFixed(2)} 0 ${bottomY.toFixed(2)})`);
            const jelly = jellyEyeOffset(cx, 126);
            return `translate(${(cx + this._look.x + microX + jelly.x + (isInput ? 0 : inwardShift)).toFixed(2)} ${(126 + this._look.y + microY + jelly.y + nodY + angryDropY + emotionBobY).toFixed(2)})`;
          };
          const inputCenter = clamp(this._center ?? 0, 0, 1);
          const surpriseSpread = this._state === "surprise" ? 3.4 * EASE.outQuint(clamp((p.w - 34) / (POSES.surprise.w - 34), 0, 1)) : 0;
          const leftCX = lerp(86 - surpriseSpread, 120, inputCenter);
          const rightCX = lerp(154 + surpriseSpread, 120, inputCenter);
          setA(this._leftEye, "transform", setEye(this._leftBase, this._leftInputBase, this._leftTop, this._leftBottom, "L", leftCX, this._eyeMicro.lX, this._eyeMicro.lY, inputPulseL));
          setA(this._rightEye, "transform", setEye(this._rightBase, this._rightInputBase, this._rightTop, this._rightBottom, "R", rightCX, this._eyeMicro.rX, this._eyeMicro.rY, inputPulseR));
        }
        _resumeFrames() {
          if (!this.isConnected || document.hidden || this._raf) return;
          this._running = true;
          this._framePaused = false;
          this._lastFrame = performance.now();
          this._raf = requestAnimationFrame(this._loop);
        }
        // Shapes designed as one, drawn by both eyes on top of each other: the
        // heart, the voice kit's circle and crossed ovals (and the morphs between
        // them), and the shape wait. While the two eyes overlap there, a skin
        // paints them as one surface; otherwise each eye's own shading shows a
        // seam. Eyes that only pass each other (spin, dizzy) stay two eyes.
        // margin: how close (avatar units) already counts as touching; the 3D head
        // draws the eyes a little larger on its curved face, so it asks early.
        _eyesAsOne(margin = 0) {
          var _a, _b, _c;
          if (!(this._loveFx || this._voiceFx || this._voiceExit || ((_a = this._leftBase) == null ? void 0 : _a.hasAttribute("data-shape")))) return false;
          const parent = (_b = this._leftEye) == null ? void 0 : _b.parentElement;
          if (!((_c = parent == null ? void 0 : parent.getCTM) == null ? void 0 : _c.call(parent))) return false;
          const box = (eye) => {
            const b = eye.getBBox(), m = parent.getCTM().inverse().multiply(eye.getCTM());
            const xs = [], ys = [];
            for (const [x, y] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]) {
              xs.push(m.a * x + m.c * y + m.e);
              ys.push(m.b * x + m.d * y + m.f);
            }
            return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
          };
          const a = box(this._leftBase), c = box(this._rightBase);
          return a.x1 + margin > c.x0 && c.x1 + margin > a.x0 && a.y1 + margin > c.y0 && c.y1 + margin > a.y0;
        }
        _canPauseFrames(now) {
          var _a, _b;
          if (!this._sleeping || this._state !== "sleep") return false;
          if (now - this._morphStart < this._morphDuration) return false;
          if (this._dragJelly.active || this._dragJelly.returning) return false;
          if (this._waitingFx || this._inspectFx || this._failureFx || this._warningFx || this._systemErrorShake) return false;
          const animations = ((_b = (_a = this._headMotion) == null ? void 0 : _a.getAnimations) == null ? void 0 : _b.call(_a)) || [];
          return !animations.some((animation) => animation.playState === "running" || animation.playState === "pending");
        }
        _loop = (ts = performance.now()) => {
          if (!this._running || !this.isConnected) {
            this._raf = 0;
            return;
          }
          if (ts - this._lastFrame >= 33) {
            const dt = Math.min(66, ts - (this._lastFrame || ts - 33));
            this._lastFrame = ts;
            this._updateMorph(ts);
            this._updateBlink(ts);
            this._updateLook(ts, dt);
            this._updateHeadFollow(ts, dt);
            this._updateDragJelly(dt);
            this._draw(ts);
          }
          if (this._canPauseFrames(ts)) {
            this._framePaused = true;
            this._raf = 0;
            return;
          }
          this._raf = requestAnimationFrame(this._loop);
        };
      }
      if (typeof customElements !== "undefined" && !customElements.get("boop-face")) {
        customElements.define("boop-face", AgentFace);
      }
      if (typeof customElements !== "undefined" && !customElements.get("agent-robot-avatar")) {
        let warnedOldTag = false;
        customElements.define("agent-robot-avatar", class extends AgentFace {
          connectedCallback() {
            if (!warnedOldTag) {
              warnedOldTag = true;
              console.warn("boopface: <agent-robot-avatar> is now <boop-face>. The old tag stops working in 1.0.");
            }
            super.connectedCallback();
          }
        });
      }
      if (typeof window !== "undefined") window.BoopFace = window.AgentRobotAvatar = AgentFace;
      return AgentFace;
    })();
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
  });
  __define("src/boopface-extension-host.js", function(__require2, __import2, exports) {
    const BoopFace = __require2("src/boopface-core.js").default;
    const proto = BoopFace.prototype;
    const basePlay = proto.play;
    const baseReset = proto.reset;
    const baseDraw = proto._draw;
    const extensionNames = /* @__PURE__ */ new Set();
    const actionHandlers = /* @__PURE__ */ new Map();
    const beforePlayHooks = [];
    const afterPlayHooks = [];
    const resetHooks = [];
    const drawHooks = [];
    function registerAvatarExtension({
      name,
      actions = {},
      beforePlay,
      afterPlay,
      reset,
      draw
    }) {
      if (!name || extensionNames.has(name)) {
        throw new Error(`BoopFace extension already registered: ${name || "(unnamed)"}`);
      }
      extensionNames.add(name);
      for (const [action, handler] of Object.entries(actions)) {
        if (actionHandlers.has(action)) {
          throw new Error(`BoopFace action already registered: ${action}`);
        }
        actionHandlers.set(action, handler);
      }
      if (beforePlay) beforePlayHooks.push(beforePlay);
      if (afterPlay) afterPlayHooks.push(afterPlay);
      if (reset) resetHooks.push(reset);
      if (draw) drawHooks.push(draw);
    }
    proto.play = function(name) {
      var _a;
      (_a = this._resumeFrames) == null ? void 0 : _a.call(this);
      const action = String(name || "").trim().toLowerCase();
      const context = {};
      for (const hook of beforePlayHooks) hook.call(this, action, context);
      let result;
      try {
        const handler = actionHandlers.get(action);
        result = handler ? handler.call(this, action) : basePlay.call(this, action);
      } catch (error) {
        context.error = error;
        for (const hook of afterPlayHooks) hook.call(this, action, void 0, context);
        throw error;
      }
      for (const hook of afterPlayHooks) hook.call(this, action, result, context);
      return result;
    };
    proto._resetExtensionEffects = function() {
      for (const hook of resetHooks) hook.call(this);
    };
    proto.reset = function() {
      var _a;
      (_a = this._resumeFrames) == null ? void 0 : _a.call(this);
      return baseReset.call(this);
    };
    proto._draw = function(now) {
      baseDraw.call(this, now);
      for (const hook of drawHooks) hook.call(this, now);
    };
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.registerAvatarExtension = registerAvatarExtension;
  });
  __define("src/boopface-actions.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    if (!BoopFace) {
      throw new Error("BoopFace core failed to load.");
    }
    const proto = BoopFace.prototype;
    const baseUpdateLook = proto._updateLook;
    const baseOnPointerMove = proto._onPointerMove;
    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    const lerp = (a, b, t) => a + (b - a) * t;
    const outQuint = (t) => 1 - Math.pow(1 - t, 5);
    const smooth = (t) => {
      t = clamp01(t);
      return t * t * (3 - 2 * t);
    };
    const WARNING_TIMING = Object.freeze({
      W1: 480,
      W2: 400,
      W4: 600,
      W5: 200,
      W5P: 300,
      W6: 200,
      W6P: 500,
      W7: 100,
      W8: 800,
      W9: 227
    });
    function buildWarningPhases() {
      let cursor = 0;
      const phases = {};
      for (const key of ["W2", "W4", "W5", "W5P", "W6", "W6P", "W7", "W8", "W9"]) {
        phases[`${key.toLowerCase()}Start`] = cursor;
        cursor += WARNING_TIMING[key];
        phases[`${key.toLowerCase()}End`] = cursor;
      }
      phases.duration = cursor;
      return Object.freeze(phases);
    }
    const WARNING_PHASES = buildWarningPhases();
    function segment(t, a, b, from, to) {
      if (t <= a) return from;
      if (t >= b) return to;
      return lerp(from, to, smooth((t - a) / (b - a)));
    }
    function errorEyeSweep(t) {
      if (t < 0.16) return segment(t, 0, 0.16, 0, -1);
      if (t < 0.4) return segment(t, 0.16, 0.4, -1, 1);
      if (t < 0.64) return segment(t, 0.4, 0.64, 1, -0.88);
      if (t < 0.84) return segment(t, 0.64, 0.84, -0.88, 0.58);
      return segment(t, 0.84, 1, 0.58, 0);
    }
    function dispatchActionState(instance, state) {
      instance.dispatchEvent(new CustomEvent("face-state", { detail: { state } }));
    }
    function centerHeadTransform(instance) {
      if (!instance._headMotion) return;
      instance._headMotion.style.transformBox = "view-box";
      instance._headMotion.style.transformOrigin = "120px 120px";
    }
    function cancelCustomMotion(instance) {
      instance._systemErrorShake = null;
      instance._warningFx = null;
      instance._look.x = 0;
      instance._look.y = 0;
    }
    function interruptRunningAction(instance) {
      var _a;
      ++instance._transitionToken;
      instance._inputWanted = false;
      instance._boredRoutine = null;
      instance._boredLookSpeed = null;
      instance._eyeNod = null;
      instance._eyeBob = null;
      instance._angryEyeDrop = null;
      instance._surpriseShake = null;
      cancelCustomMotion(instance);
      if ((_a = instance._headMotion) == null ? void 0 : _a.getAnimations) {
        instance._headMotion.getAnimations().forEach((animation) => animation.cancel());
      }
      if (instance._headMotion) instance._headMotion.style.transform = "";
    }
    function playBuiltInAction(action) {
      if (action === "idle") return this.reset();
      if (action === "input" && (this._inputWanted || this._state === "input")) return this;
      if (action === "wake" && !this._sleeping && this._state !== "sleep") return this;
      if (action === "sleep" && this._sleeping) return this;
      interruptRunningAction(this);
      if (action === "warning") return this.warning();
      if (action === "system-error" || action === "connection-error") return this.error();
      if (action === "blocked" || action === "policy-blocked") return this.angry();
      return this[action]();
    }
    const BUILT_IN_ACTIONS = [
      "idle",
      "bored",
      "input",
      "send",
      "success",
      "warning",
      "error",
      "system-error",
      "connection-error",
      "angry",
      "blocked",
      "policy-blocked",
      "surprise",
      "sleep",
      "wake"
    ];
    const actionHandlers = Object.fromEntries(BUILT_IN_ACTIONS.map((action) => [
      action,
      function() {
        return playBuiltInAction.call(this, action);
      }
    ]));
    proto.setIdleGaze = function(enabled = true) {
      var _a;
      this._idleGaze = enabled !== false;
      if (!this._idleGaze && !this._boredRoutine) {
        this._wanderTarget.x = this._wanderTarget.y = 0;
      }
      (_a = this._resumeFrames) == null ? void 0 : _a.call(this);
      return this;
    };
    proto.setPointerFollow = function(enabled = true) {
      this._pointerFollowEnabled = enabled !== false;
      if (!this._pointerFollowEnabled) {
        this._pointer.active = false;
        this._pointer.influence = 0;
        this._pointer.lastMove = 0;
        this._headCenteringUntil = performance.now() + 320;
      }
      return this;
    };
    proto._onPointerMove = function(event) {
      if (this._pointerFollowEnabled === false) return;
      return baseOnPointerMove.call(this, event);
    };
    proto._returnToIdle = async function(duration = 320, ease = outQuint) {
      const token = this._transitionToken;
      this.setState("idle", { duration, ease, keepGazeLock: true });
      this._headCenteringUntil = Math.max(this._headCenteringUntil || 0, performance.now() + duration);
      await this._wait(duration);
      if (token === this._transitionToken && this._state === "idle") this._releaseExpressionLock();
    };
    proto.send = async function() {
      this.noteActivity();
      this._inputWanted = false;
      if (!await this._prepareExpression({ normalizePose: true, duration: 180, pause: 320 })) return;
      const token = this._transitionToken;
      this._eyeNod = { start: performance.now(), duration: 760 };
      this._animateHead([
        { transform: "translateY(0px)" },
        { transform: "translateY(5px)", offset: 0.52 },
        { transform: "translateY(0px)" }
      ], 920);
      await this._wait(860);
      if (token !== this._transitionToken) return;
      this._eyeNod = null;
      this._releaseExpressionLock();
    };
    proto.wake = async function() {
      var _a;
      if (!this._sleeping && this._state !== "sleep") return;
      (_a = this._resumeFrames) == null ? void 0 : _a.call(this);
      const token = ++this._transitionToken;
      this._expressionLock = true;
      this._sleeping = false;
      this._animateHead([
        { transform: "translateY(4px) scale(1)" },
        { transform: "translateY(-2px) scale(1.015)", offset: 0.55 },
        { transform: "translateY(0) scale(1)" }
      ], 500);
      this.setState("sleepy", { duration: 240, keepGazeLock: true });
      await this._wait(260);
      if (token !== this._transitionToken) return;
      this.setState("surprise", { duration: 120, keepGazeLock: true });
      await this._wait(190);
      if (token !== this._transitionToken) return;
      await this._returnToIdle(300);
      if (token !== this._transitionToken) return;
      this._lastActivity = performance.now();
    };
    proto.error = async function() {
      var _a;
      this.noteActivity();
      this._inputWanted = false;
      cancelCustomMotion(this);
      if (!await this._prepareExpression({ normalizePose: true, duration: 180, pause: 240 })) return;
      const token = this._transitionToken;
      const eyeDuration = 980;
      const headDuration = 1380;
      this._systemErrorShake = { start: performance.now(), duration: eyeDuration };
      dispatchActionState(this, "refuse");
      centerHeadTransform(this);
      if ((_a = this._headMotion) == null ? void 0 : _a.animate) {
        const animationToken = this._transitionToken;
        const anim = this._headMotion.animate([
          { transform: "translateX(0px)", offset: 0, easing: "cubic-bezier(.38,0,.28,1)" },
          { transform: "translateX(-4px)", offset: 0.34, easing: "cubic-bezier(.35,0,.22,1)" },
          { transform: "translateX(4px)", offset: 0.72, easing: "cubic-bezier(.35,0,.22,1)" },
          { transform: "translateX(0px)", offset: 1 }
        ], { duration: headDuration, easing: "linear", fill: "forwards" });
        anim.onfinish = () => {
          if (animationToken === this._transitionToken) this._headMotion.style.transform = "translateX(0px)";
        };
      }
      await this._wait(headDuration + 40);
      if (token !== this._transitionToken) return;
      this._systemErrorShake = null;
      this._look.x = 0;
      this._look.y = 0;
      this._releaseExpressionLock();
      dispatchActionState(this, "idle");
    };
    proto.warning = async function() {
      var _a;
      this.noteActivity();
      this._inputWanted = false;
      cancelCustomMotion(this);
      if (!await this._prepareExpression({ normalizePose: true, duration: 200, pause: WARNING_TIMING.W1 - 200 })) return;
      const token = this._transitionToken;
      const duration = WARNING_PHASES.duration;
      this._warningFx = { start: performance.now(), duration };
      dispatchActionState(this, "wary");
      centerHeadTransform(this);
      if ((_a = this._headMotion) == null ? void 0 : _a.animate) {
        const animationToken = this._transitionToken;
        const anim = this._headMotion.animate([
          { transform: "translateY(0px)", offset: 0 },
          { transform: "translateY(0px)", offset: WARNING_PHASES.w5Start / duration, easing: "cubic-bezier(.38,0,.25,1)" },
          { transform: "translateY(5px)", offset: WARNING_PHASES.w5End / duration, easing: "cubic-bezier(.35,0,.22,1)" },
          { transform: "translateY(5px)", offset: WARNING_PHASES.w5pEnd / duration, easing: "cubic-bezier(.35,0,.22,1)" },
          { transform: "translateY(-4px)", offset: WARNING_PHASES.w6End / duration },
          { transform: "translateY(-4px)", offset: WARNING_PHASES.w6pEnd / duration, easing: "cubic-bezier(.35,0,.22,1)" },
          { transform: "translateY(0px)", offset: WARNING_PHASES.w7End / duration },
          { transform: "translateY(0px)", offset: 1 }
        ], { duration, easing: "linear", fill: "forwards" });
        anim.onfinish = () => {
          if (animationToken === this._transitionToken) this._headMotion.style.transform = "translateY(0px)";
        };
      }
      await this._wait(duration + 40);
      if (token !== this._transitionToken) return;
      this._warningFx = null;
      this._look.x = 0;
      this._look.y = 0;
      this._releaseExpressionLock();
      dispatchActionState(this, "idle");
    };
    proto._startBoredRoutine = function(now) {
      this._boredRoutine = {
        index: 0,
        nextAt: now,
        steps: [
          { x: -18, y: -16, hold: 1400, lookSpeed: 0.5 },
          { x: 18, y: -16, hold: 1400, lookSpeed: 0.5 },
          { x: 0, y: 0, hold: 320, lookSpeed: 0.5 }
        ]
      };
    };
    proto._updateLook = function(now, dt) {
      baseUpdateLook.call(this, now, dt);
      if (this._systemErrorShake) {
        const t = clamp01((now - this._systemErrorShake.start) / this._systemErrorShake.duration);
        this._look.x = errorEyeSweep(t) * 30;
        this._look.y = 0;
        if (t >= 1) this._systemErrorShake = null;
      }
    };
    function drawWarning(now) {
      const fx = this._warningFx;
      if (!fx) return;
      const elapsed = Math.max(0, Math.min(fx.duration, now - fx.start));
      let proximity = elapsed < WARNING_PHASES.w2End ? smooth(elapsed / WARNING_TIMING.W2) : 1;
      let lids = elapsed < WARNING_PHASES.w2End ? smooth(elapsed / WARNING_TIMING.W2) : 1;
      const release = elapsed > WARNING_PHASES.w8End ? 1 - smooth((elapsed - WARNING_PHASES.w8End) / WARNING_TIMING.W9) : 1;
      proximity *= release;
      lids *= release;
      let lidShift = 0;
      const lightPress = 4.2;
      const w4PressEnd = Math.min(WARNING_PHASES.w4Start + 120, WARNING_PHASES.w4End);
      if (elapsed >= WARNING_PHASES.w4Start && elapsed < WARNING_PHASES.w4End) {
        lidShift = elapsed < w4PressEnd ? segment(elapsed, WARNING_PHASES.w4Start, w4PressEnd, 0, lightPress) : lightPress;
      } else if (elapsed >= WARNING_PHASES.w5Start && elapsed < WARNING_PHASES.w5End) {
        lidShift = segment(elapsed, WARNING_PHASES.w5Start, WARNING_PHASES.w5End, lightPress, 20.5);
      } else if (elapsed >= WARNING_PHASES.w5pStart && elapsed < WARNING_PHASES.w5pEnd) {
        lidShift = 20.5;
      } else if (elapsed >= WARNING_PHASES.w6Start && elapsed < WARNING_PHASES.w6End) {
        lidShift = segment(elapsed, WARNING_PHASES.w6Start, WARNING_PHASES.w6End, 20.5, -6.5);
      } else if (elapsed >= WARNING_PHASES.w6pStart && elapsed < WARNING_PHASES.w6pEnd) {
        lidShift = -6.5;
      } else if (elapsed >= WARNING_PHASES.w7Start && elapsed < WARNING_PHASES.w7End) {
        lidShift = segment(elapsed, WARNING_PHASES.w7Start, WARNING_PHASES.w7End, -6.5, lightPress);
      } else if (elapsed >= WARNING_PHASES.w8Start && elapsed < WARNING_PHASES.w8End) {
        lidShift = lightPress;
      }
      let farLowOffset = 0;
      if (elapsed >= WARNING_PHASES.w5Start && elapsed < WARNING_PHASES.w5End) {
        farLowOffset = segment(elapsed, WARNING_PHASES.w5Start, WARNING_PHASES.w5End, 0, 2.4);
      } else if (elapsed >= WARNING_PHASES.w5pStart && elapsed < WARNING_PHASES.w5pEnd) {
        farLowOffset = 2.4;
      } else if (elapsed >= WARNING_PHASES.w6Start && elapsed < WARNING_PHASES.w6End) {
        farLowOffset = segment(elapsed, WARNING_PHASES.w6Start, WARNING_PHASES.w6End, 2.4, 0);
      }
      let farDeepLidDrop = 0;
      if (elapsed >= WARNING_PHASES.w5Start && elapsed < WARNING_PHASES.w5End) {
        farDeepLidDrop = segment(elapsed, WARNING_PHASES.w5Start, WARNING_PHASES.w5End, 0, 3.5);
      } else if (elapsed >= WARNING_PHASES.w5pStart && elapsed < WARNING_PHASES.w5pEnd) {
        farDeepLidDrop = 3.5;
      } else if (elapsed >= WARNING_PHASES.w6Start && elapsed < WARNING_PHASES.w6End) {
        farDeepLidDrop = segment(elapsed, WARNING_PHASES.w6Start, WARNING_PHASES.w6End, 3.5, 0);
      }
      const nearSX = lerp(1, 1.37, proximity);
      const nearSY = lerp(1, 1.4, proximity);
      const farSX = lerp(1, 0.68, proximity);
      const farSY = lerp(1, 0.99, proximity);
      const nearTilt = lerp(0, -6.5, proximity);
      const farTilt = lerp(0, 7.5, proximity);
      const nearX = lerp(86, 102, proximity);
      const farX = lerp(154, 174.5, proximity);
      const nearY = lerp(126, 125.5, proximity);
      const farY = lerp(126, 133.5, proximity) + farLowOffset;
      this._leftEye.setAttribute(
        "transform",
        `translate(${nearX.toFixed(2)} ${nearY.toFixed(2)}) rotate(${nearTilt.toFixed(2)}) scale(${nearSX.toFixed(3)} ${nearSY.toFixed(3)})`
      );
      this._rightEye.setAttribute(
        "transform",
        `translate(${farX.toFixed(2)} ${farY.toFixed(2)}) rotate(${farTilt.toFixed(2)}) scale(${farSX.toFixed(3)} ${farSY.toFixed(3)})`
      );
      const nearTopY = lerp(-36, -8, lids) + lidShift;
      const farTopY = lerp(-36, -10, lids) + lidShift * 0.95 + farDeepLidDrop;
      const nearTopRot = lerp(0, 25, lids);
      const farTopRot = lerp(0, -17, lids);
      this._leftTop.setAttribute("y", (nearTopY - 90).toFixed(2));
      this._leftTop.setAttribute("height", "90");
      this._leftTop.setAttribute("transform", `rotate(${nearTopRot.toFixed(2)} 0 ${nearTopY.toFixed(2)})`);
      this._rightTop.setAttribute("y", (farTopY - 90).toFixed(2));
      this._rightTop.setAttribute("height", "90");
      this._rightTop.setAttribute("transform", `rotate(${farTopRot.toFixed(2)} 0 ${farTopY.toFixed(2)})`);
      const nearBottomY = lerp(36, 35.3, lids);
      const farBottomY = lerp(36, 35.6, lids);
      this._leftBottom.setAttribute("y", nearBottomY.toFixed(2));
      this._leftBottom.setAttribute("height", "90");
      this._leftBottom.setAttribute("transform", `rotate(0 0 ${nearBottomY.toFixed(2)})`);
      this._rightBottom.setAttribute("y", farBottomY.toFixed(2));
      this._rightBottom.setAttribute("height", "90");
      this._rightBottom.setAttribute("transform", `rotate(0 0 ${farBottomY.toFixed(2)})`);
    }
    registerAvatarExtension({
      name: "actions",
      actions: actionHandlers,
      reset() {
        interruptRunningAction(this);
      },
      draw: drawWarning
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
  });
  __define("src/boopface-geometry.js", function(__require2, __import2, exports) {
    const DEFAULT_HEAD_HEIGHT_SCALE = 0.9;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const smooth01 = (value) => {
      const t = clamp(value, 0, 1);
      return t * t * (3 - 2 * t);
    };
    function flattenHeadPoints(points, heightScale = DEFAULT_HEAD_HEIGHT_SCALE) {
      if (!(points == null ? void 0 : points.length)) return [];
      const source = points.map((point) => ({ x: point.x, y: point.y }));
      const minY = Math.min(...source.map((point) => point.y));
      const maxY = Math.max(...source.map((point) => point.y));
      const height = maxY - minY;
      if (!(height > 0)) return source;
      const scale = clamp(Number(heightScale), 0.1, 1);
      const centerY = (minY + maxY) / 2;
      const inset = height * (1 - scale) / 2;
      const upperLockY = minY + height * 0.4;
      const lowerLockY = maxY - height * 0.4;
      return source.map((point) => {
        let shiftY = 0;
        if (point.y <= upperLockY) {
          shiftY = inset;
        } else if (point.y < centerY) {
          const t = (centerY - point.y) / Math.max(1e-3, centerY - upperLockY);
          shiftY = inset * smooth01(t);
        } else if (point.y >= lowerLockY) {
          shiftY = -inset;
        } else if (point.y > centerY) {
          const t = (point.y - centerY) / Math.max(1e-3, lowerLockY - centerY);
          shiftY = -inset * smooth01(t);
        }
        return { x: point.x, y: point.y + shiftY };
      });
    }
    exports.DEFAULT_HEAD_HEIGHT_SCALE = DEFAULT_HEAD_HEIGHT_SCALE;
    exports.flattenHeadPoints = flattenHeadPoints;
  });
  __define("src/boopface-antenna.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const { DEFAULT_HEAD_HEIGHT_SCALE, flattenHeadPoints } = __require2("src/boopface-geometry.js");
    const setA = (el, name, value) => {
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    };
    const SVG_NS = "http://www.w3.org/2000/svg";
    const ANTENNA_DEFAULTS = Object.freeze({
      x: 120,
      y: 12,
      radius: 15,
      stiffness: 180,
      damping: 5.6
    });
    const runtimeWindow = typeof window !== "undefined" ? window : null;
    const antennaConfig = (runtimeWindow == null ? void 0 : runtimeWindow.BoopFaceAntennaConfig) && typeof runtimeWindow.BoopFaceAntennaConfig === "object" ? runtimeWindow.BoopFaceAntennaConfig : {};
    for (const [key, value] of Object.entries(ANTENNA_DEFAULTS)) {
      if (!Number.isFinite(Number(antennaConfig[key]))) antennaConfig[key] = value;
    }
    if (runtimeWindow) {
      runtimeWindow.BoopFaceAntennaConfig = antennaConfig;
      runtimeWindow.BoopFaceAntennaDefaults = ANTENNA_DEFAULTS;
    }
    function configNumber(key, fallback, min, max) {
      const value = Number(antennaConfig[key]);
      if (!Number.isFinite(value)) return fallback;
      return Math.max(min, Math.min(max, value));
    }
    function antennaHome() {
      return {
        x: configNumber("x", ANTENNA_DEFAULTS.x, 60, 180),
        y: configNumber("y", ANTENNA_DEFAULTS.y, -40, 60)
      };
    }
    function flattenHead(instance) {
      var _a;
      if (instance._headFlattenedR32 || !instance._headShape || !((_a = instance._baseHeadPoints) == null ? void 0 : _a.length)) return;
      const flattened = flattenHeadPoints(instance._baseHeadPoints, DEFAULT_HEAD_HEIGHT_SCALE);
      const path = typeof instance._pointsToPath === "function" ? instance._pointsToPath(flattened) : `M ${flattened.map((point, index) => `${index ? "L " : ""}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ")} Z`;
      instance._baseHeadPoints = flattened;
      instance._baseHeadPathD = path;
      setA(instance._headShape, "d", path);
      instance._headFlattenedR32 = true;
    }
    function ensureAntenna(instance, now) {
      var _a, _b, _c;
      flattenHead(instance);
      if (((_a = instance._antennaDot) == null ? void 0 : _a.isConnected) && instance._antennaSpring) return true;
      const svg = (_b = instance.shadowRoot) == null ? void 0 : _b.querySelector("svg");
      if (!svg || !instance._headMotion) return false;
      const home = antennaHome();
      let dot = instance.shadowRoot.getElementById("antennaDot");
      if (!dot) {
        dot = document.createElementNS(SVG_NS, "circle");
        dot.id = "antennaDot";
        dot.setAttribute("cx", String(home.x));
        dot.setAttribute("cy", String(home.y));
        dot.setAttribute("r", String(configNumber("radius", ANTENNA_DEFAULTS.radius, 2, 40)));
        dot.setAttribute("fill", ((_c = instance._head) == null ? void 0 : _c.getAttribute("fill")) || "#08090b");
        dot.setAttribute("aria-hidden", "true");
        dot.style.pointerEvents = "auto";
        svg.appendChild(dot);
      }
      instance._antennaDot = dot;
      instance._antennaSpring = {
        x: home.x,
        y: home.y,
        vx: 0,
        vy: 0,
        last: now,
        initialized: false
      };
      return true;
    }
    function antennaTarget(instance) {
      var _a, _b, _c, _d;
      const svg = (_a = instance.shadowRoot) == null ? void 0 : _a.querySelector("svg");
      const headMatrix = (_c = (_b = instance._headMotion) == null ? void 0 : _b.getScreenCTM) == null ? void 0 : _c.call(_b);
      const svgMatrix = (_d = svg == null ? void 0 : svg.getScreenCTM) == null ? void 0 : _d.call(svg);
      const home = antennaHome();
      if (!svg || !headMatrix || !svgMatrix || typeof DOMPoint === "undefined") return home;
      try {
        const screenPoint = new DOMPoint(home.x, home.y).matrixTransform(headMatrix);
        const localPoint = screenPoint.matrixTransform(svgMatrix.inverse());
        return { x: localPoint.x, y: localPoint.y };
      } catch (_) {
        return home;
      }
    }
    function updateAntenna(instance, now) {
      var _a, _b;
      if (!ensureAntenna(instance, now)) return;
      const spring = instance._antennaSpring;
      const dot = instance._antennaDot;
      const shown = String(instance.getAttribute("antenna") ?? "").trim().toLowerCase() !== "false" ? "" : "none";
      if (dot.style.display !== shown) dot.style.display = shown;
      const target = antennaTarget(instance);
      if ((_a = instance._isReducedMotion) == null ? void 0 : _a.call(instance)) {
        spring.x = target.x;
        spring.y = target.y;
        spring.vx = 0;
        spring.vy = 0;
        spring.last = now;
        spring.initialized = true;
      } else {
        if (!spring.initialized) {
          spring.x = target.x;
          spring.y = target.y;
          spring.last = now;
          spring.initialized = true;
        }
        const dt = Math.max(1e-3, Math.min(0.05, (now - spring.last) / 1e3 || 0.033));
        spring.last = now;
        const stiffness = configNumber("stiffness", ANTENNA_DEFAULTS.stiffness, 5, 300);
        const damping = configNumber("damping", ANTENNA_DEFAULTS.damping, 0.5, 40);
        const ax = (target.x - spring.x) * stiffness - spring.vx * damping;
        const ay = (target.y - spring.y) * stiffness - spring.vy * damping;
        spring.vx += ax * dt;
        spring.vy += ay * dt;
        spring.x += spring.vx * dt;
        spring.y += spring.vy * dt;
      }
      setA(dot, "cx", spring.x.toFixed(2));
      setA(dot, "cy", spring.y.toFixed(2));
      setA(dot, "r", configNumber("radius", ANTENNA_DEFAULTS.radius, 2, 40).toFixed(2));
      setA(dot, "fill", ((_b = instance._head) == null ? void 0 : _b.getAttribute("fill")) || "#08090b");
    }
    function drawAntenna(now) {
      updateAntenna(this, now);
    }
    registerAvatarExtension({
      name: "antenna",
      draw: drawAntenna
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.ANTENNA_DEFAULTS = ANTENNA_DEFAULTS;
  });
  __define("src/boopface-wrap.js", function(__require2, __import2, exports) {
    const WRAP_CYCLE = 2400;
    const RADIUS = 85;
    const EYE_ANGLE = Math.asin(34 / RADIUS);
    const HALF_WIDTH = 27 / Math.cos(EYE_ANGLE);
    const FRAMES = [
      [0, 0, null],
      [834, -Math.PI / 2 + EYE_ANGLE, [0.6123122262631361, 0, 0.8763337613684284, 0.3403039133642485]],
      [996, -Math.PI / 2 - EYE_ANGLE, null],
      [1260, -3 * Math.PI / 2 + EYE_ANGLE, null],
      [1390, -3 * Math.PI / 2 - EYE_ANGLE, null],
      [2400, -2 * Math.PI, [0.16771539711108435, 0.7245980352977247, 0.32366613843706765, 1]]
    ];
    function progress(t, curve) {
      if (!curve || t <= 0 || t >= 1) return t;
      const b = (s, a, z) => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * z + s * s * s;
      let lo = 0, hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (b(mid, curve[0], curve[2]) < t) lo = mid;
        else hi = mid;
      }
      return b((lo + hi) / 2, curve[1], curve[3]);
    }
    function wrapEyeHeight(width) {
      const side = Math.max(0, Math.min(1, 1 - width / 54));
      return 58 - 18 * side * side * (3 - 2 * side);
    }
    function wrapEyeX(x, width) {
      const side = Math.max(0, Math.min(1, 1 - width / 54));
      return x + Math.sign(x - 120) * 9 * side ** 3;
    }
    function sampleWrapPose(elapsed) {
      const time = Math.max(0, Math.min(WRAP_CYCLE, elapsed));
      const index = Math.max(1, FRAMES.findIndex((frame) => frame[0] >= time));
      const a = FRAMES[index - 1], b = FRAMES[index], t = progress((time - a[0]) / (b[0] - a[0]), b[2]);
      const angle = a[1] + (b[1] - a[1]) * t;
      const pose = {};
      for (const [side, offset] of [["left", -EYE_ANGLE], ["right", EYE_ANGLE]]) {
        const eyeAngle = angle + offset;
        const front = Math.cos(eyeAngle);
        pose[side + "Y"] = 126;
        pose[side + "Width"] = front > 1e-10 ? 2 * HALF_WIDTH * front : 0;
        pose[side + "X"] = wrapEyeX(120 + RADIUS * Math.sin(eyeAngle), pose[side + "Width"]);
        pose[side + "Height"] = wrapEyeHeight(pose[side + "Width"]);
        pose[side + "Opacity"] = 1;
      }
      return pose;
    }
    function drawWrapWaiting(instance, elapsed) {
      const pose = sampleWrapPose(elapsed);
      for (const side of ["left", "right"]) {
        instance["_" + side + "Eye"].setAttribute("transform", `translate(${pose[side + "X"]} 126)`);
        const eye = instance["_" + side + "Base"];
        eye.setAttribute("rx", pose[side + "Width"] / 2);
        eye.setAttribute("ry", pose[side + "Height"] / 2);
        eye.setAttribute("opacity", "1");
        instance["_" + side + "InputBase"].setAttribute("opacity", "0");
      }
    }
    exports.wrapEyeHeight = wrapEyeHeight;
    exports.wrapEyeX = wrapEyeX;
    exports.sampleWrapPose = sampleWrapPose;
    exports.drawWrapWaiting = drawWrapWaiting;
    exports.WRAP_CYCLE = WRAP_CYCLE;
  });
  __define("src/boopface-waiting.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const { WRAP_CYCLE, drawWrapWaiting } = __require2("src/boopface-wrap.js");
    const WAITING_CYCLE = 3200;
    const WAVE_WAITING_CYCLE = 1100;
    const WAVE_WAITING_REPEATS = 3;
    const proto = BoopFace.prototype;
    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    const smooth = (value) => {
      const t = clamp01(value);
      return t * t * (3 - 2 * t);
    };
    const waitingDuration = (variant) => variant === "wave" ? WAVE_WAITING_CYCLE * WAVE_WAITING_REPEATS : variant === "wrap" ? WRAP_CYCLE : WAITING_CYCLE;
    function dispatchWaitingState(instance, state) {
      instance.dispatchEvent(new CustomEvent("face-state", {
        detail: { state }
      }));
    }
    function readEyeY(eye) {
      const raw = (eye == null ? void 0 : eye.getAttribute("transform")) || "";
      const match = raw.match(/translate\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/);
      return match ? Number(match[2]) : 126;
    }
    function setEyeOrbitTransform(eye, x, scaleX, scaleY) {
      if (!eye) return;
      const y = readEyeY(eye);
      eye.setAttribute(
        "transform",
        `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)})`
      );
    }
    async function enterWaiting(instance, continuous, source, options = {}) {
      const requested = (options == null ? void 0 : options.variant) ?? "default";
      const variant = requested === "spin" ? "default" : requested;
      if (variant !== "default" && variant !== "wrap" && variant !== "wave") throw new TypeError(`Unknown waiting variant: ${requested}`);
      instance.noteActivity();
      instance._inputWanted = false;
      instance.reset();
      instance._waitingRequested = true;
      if (!await instance._prepareExpression({ normalizePose: true, duration: 120, pause: 0 })) return null;
      if (!instance._waitingRequested) return null;
      const token = instance._transitionToken;
      instance._expressionLock = true;
      instance._look.x = 0;
      instance._look.y = 0;
      instance._waitingFx = {
        start: performance.now(),
        duration: waitingDuration(variant),
        variant,
        continuous: continuous === true,
        source
      };
      dispatchWaitingState(instance, "waiting");
      return token;
    }
    proto.waiting = async function(options = {}) {
      const token = await enterWaiting(this, false, "play", options);
      if (token == null) return;
      await this._wait(waitingDuration(options == null ? void 0 : options.variant));
      if (token !== this._transitionToken || !this._waitingRequested) return;
      this._waitingRequested = false;
      this._waitingFx = null;
      this._releaseExpressionLock();
      dispatchWaitingState(this, "idle");
    };
    proto.startWaiting = async function(options = {}) {
      if (((options == null ? void 0 : options.variant) === "bloom" || (options == null ? void 0 : options.variant) === "cross") && typeof this._startBloom === "function") return this._startBloom(options.variant);
      await enterWaiting(this, true, "runtime", options);
      return this;
    };
    proto.stopWaiting = function() {
      return this.reset();
    };
    function drawWaiting(now) {
      const fx = this._waitingFx;
      if (!fx) return;
      const elapsed = Math.max(0, now - fx.start);
      const phaseMs = fx.continuous ? elapsed % fx.duration : Math.min(fx.duration, elapsed);
      const t = clamp01(phaseMs / fx.duration);
      if (fx.variant === "wrap") {
        drawWrapWaiting(this, phaseMs);
        return;
      }
      if (fx.variant === "wave") {
        let amplitude = 10 * smooth(elapsed / 140);
        if (!fx.continuous) amplitude *= smooth((fx.duration - phaseMs) / 140);
        const angle2 = elapsed % WAVE_WAITING_CYCLE / WAVE_WAITING_CYCLE * Math.PI * 2;
        for (const [side, x, offset] of [["left", 86, 0], ["right", 154, 0.7]]) {
          this[`_${side}Base`].setAttribute("cx", "0");
          this[`_${side}Base`].setAttribute("cy", "0");
          this[`_${side}Base`].setAttribute("rx", "27");
          this[`_${side}Base`].setAttribute("ry", "29");
          this[`_${side}Eye`].setAttribute(
            "transform",
            `translate(${x} ${(126 + Math.sin(angle2 + offset) * amplitude).toFixed(2)})`
          );
        }
        return;
      }
      const angle = t * Math.PI * 4;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const leftX = 120 - 34 * cosA;
      const rightX = 120 + 34 * cosA;
      const foreshorten = 0.72 + 0.28 * Math.abs(cosA);
      const leftDepth = 1 + 0.08 * sinA;
      const rightDepth = 1 - 0.08 * sinA;
      setEyeOrbitTransform(this._leftEye, leftX, foreshorten * leftDepth, leftDepth);
      setEyeOrbitTransform(this._rightEye, rightX, foreshorten * rightDepth, rightDepth);
    }
    registerAvatarExtension({
      name: "waiting",
      actions: {
        waiting() {
          return this.waiting();
        },
        wait() {
          return this.waiting();
        },
        "waiting-wrap"() {
          return this.waiting({ variant: "wrap" });
        },
        "waiting-wave"() {
          return this.waiting({ variant: "wave" });
        }
      },
      beforePlay(action) {
        if (action === "waiting" || action === "wait" || action === "waiting-wrap" || action === "waiting-wave") return;
        this._waitingRequested = false;
        this._waitingFx = null;
      },
      reset() {
        this._waitingRequested = false;
        this._waitingFx = null;
      },
      draw: drawWaiting
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.WAITING_CYCLE = WAITING_CYCLE;
    exports.WAVE_WAITING_CYCLE = WAVE_WAITING_CYCLE;
  });
  __define("src/boopface-voice.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const SET = Object.freeze({
      listen: { size: 93, x: 120, y: 121, pulse: 19, tempo: 1.5 },
      think: { size: 111, x: 120, y: 121, rotation: 57, angle: 0, thin: 54.8, thick: 75.4, period: 4, horizontal: 100, vertical: 100, verticalThickness: 100, phase: 38 }
    });
    const NEUTRAL = Object.freeze([
      Object.freeze({ x: 86.03, y: 126, rx: 26.97, ry: 28.99 }),
      Object.freeze({ x: 153.97, y: 126, rx: 26.97, ry: 28.99 })
    ]);
    const MERGE = 420;
    const MORPH = 420;
    const SPLIT = 640;
    const SETTLE = 140;
    const EXIT = 260;
    const LEVEL_FRESH = 260;
    const ROUNDS = Object.freeze({ listening: 2600, thinking: 3600, speaking: 2600 });
    const KEYS = ["x", "y", "rx", "ry", "capX", "capY", "angle"];
    const OWN_ACTIONS = ["listening", "speaking", "waiting-bloom", "waiting-cross"];
    const proto = BoopFace.prototype;
    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    const mix = (a, b, t) => a + (b - a) * t;
    const smootherstep = (t) => {
      const x = clamp01(t);
      return x * x * x * (x * (x * 6 - 15) + 10);
    };
    const neutralPose = (index) => ({ ...NEUTRAL[index], capX: NEUTRAL[index].rx, capY: NEUTRAL[index].ry, angle: 0 });
    function reducedMotion(instance) {
      const motion = String(instance.getAttribute("motion") || "auto").trim().toLowerCase();
      if (motion === "reduce") return true;
      if (motion === "full") return false;
      return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    function between(from, to, t) {
      const ease = smootherstep(t);
      const angle = ((from.angle + 90) % 180 + 180) % 180 - 90;
      const out = {};
      for (const key of KEYS) out[key] = mix(key === "angle" ? angle : from[key], to[key], ease);
      return out;
    }
    function speechRhythm(ms, offset) {
      const s = ms / 1e3 + offset;
      const syllable = Math.max(0, Math.sin(s * Math.PI * 2 * 4.1 + 0.9 * Math.sin(s * 2.3)));
      const phrase = 0.55 + 0.45 * Math.sin(s * Math.PI * 2 * 0.37);
      return ms % 2900 > 2350 ? 0 : Math.pow(syllable, 0.8) * phrase;
    }
    const CROSS = Object.freeze({ step: 850, long: 55.5, thin: 0.548, full: 0.754 });
    const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    function crossPoses(fx, now) {
      const p = SET.think, ms = fx.reduced ? 0 : Math.max(0, now - fx.modeStart);
      const n = Math.floor(ms / CROSS.step), u = easeInOut(ms % CROSS.step / CROSS.step);
      const angle = ((45 + 90 * n + 90 * u + 180) % 360 + 360) % 360 - 180;
      const slim = n % 2 ? 1 - u : u, short = CROSS.long * (CROSS.full + (CROSS.thin - CROSS.full) * slim);
      return [0, 1].map((i) => {
        const rx = i === 0 ? CROSS.long : short, ry = i === 0 ? short : CROSS.long;
        return { x: p.x, y: p.y, rx, ry, capX: rx, capY: ry, angle };
      });
    }
    function targetPoses(fx, now) {
      const [all, low, high] = fx.levels;
      if (fx.mode === "listening") {
        const r = (SET.listen.size + SET.listen.pulse * all) / 2;
        const pose = { x: SET.listen.x, y: SET.listen.y, rx: r, ry: r, capX: r, capY: r, angle: 0 };
        return [pose, { ...pose }];
      }
      if (fx.mode === "thinking" && fx.style === "cross") return crossPoses(fx, now);
      if (fx.mode === "thinking") {
        const p = SET.think;
        const time = fx.reduced ? p.period / 4 : (now - fx.modeStart) / 1e3;
        const phase = time * 2 * Math.PI / p.period;
        const rotation = fx.reduced ? 0 : time * p.rotation % 360;
        return [0, 1].map((i) => {
          const breath = (1 - Math.cos(phase + i * p.phase * Math.PI / 180)) / 2;
          const long = p.size / 2 * (i === 0 ? p.horizontal : p.vertical) / 100;
          const short = long * Math.max(0.1, Math.min(1, mix(p.thin, p.thick, breath) / 100 * (i === 0 ? 1 : p.verticalThickness / 100)));
          const rx = i === 0 ? long : short;
          const ry = i === 0 ? short : long;
          return { x: p.x, y: p.y, rx, ry, capX: rx, capY: ry, angle: ((rotation + p.angle + 180) % 360 + 360) % 360 - 180 };
        });
      }
      return [low, high].map((level, i) => {
        const base = neutralPose(i);
        return { ...base, ry: base.ry + 27 * Math.min(0.48, 0.44 * Math.tanh(level * 1.65)) };
      });
    }
    function shownPoses(instance) {
      var _a;
      return ((_a = instance._voiceShown) == null ? void 0 : _a.map((pose) => ({ ...pose }))) || [neutralPose(0), neutralPose(1)];
    }
    function dispatchVoiceState(instance, state) {
      instance.dispatchEvent(new CustomEvent("face-state", { detail: { state: state === "thinking" ? "waiting" : state } }));
    }
    async function enterVoice(instance, mode, continuous, style = "bloom") {
      var _a;
      instance.noteActivity();
      const fx = instance._voiceFx;
      if (fx && fx.mode === mode && fx.continuous && continuous && (fx.style || "bloom") === style) return instance._transitionToken;
      if (fx) {
        ++instance._transitionToken;
        (_a = instance._cancelPendingWaits) == null ? void 0 : _a.call(instance);
      } else {
        instance._inputWanted = false;
        instance.reset();
        instance._voiceRequested = mode;
        if (!await instance._prepareExpression({ normalizePose: true, duration: 120, pause: 0 })) return null;
        if (instance._voiceRequested !== mode) return null;
        instance._voiceShown = instance._voiceExit ? currentExitPoses(instance, performance.now()) : null;
      }
      const token = instance._transitionToken;
      const start = performance.now();
      instance._expressionLock = true;
      instance._look.x = 0;
      instance._look.y = 0;
      instance._voiceRequested = mode;
      const previous = instance._voiceFx;
      instance._voiceFx = {
        mode,
        continuous,
        style,
        start: (previous == null ? void 0 : previous.start) ?? start,
        modeStart: start,
        last: start,
        reduced: reducedMotion(instance),
        levels: (previous == null ? void 0 : previous.levels) ? [...previous.levels] : [0, 0, 0],
        transition: {
          from: shownPoses(instance),
          start,
          duration: mode === "listening" ? MERGE : mode === "thinking" ? MORPH : SPLIT,
          settle: mode === "speaking" ? SETTLE : 0,
          split: mode === "speaking"
        }
      };
      instance._voiceExit = null;
      dispatchVoiceState(instance, mode);
      return token;
    }
    async function voiceRound(instance, mode, style) {
      var _a;
      const token = await enterVoice(instance, mode, false, style);
      if (token == null) return;
      const fx = instance._voiceFx;
      const lead = (fx == null ? void 0 : fx.transition) ? fx.transition.duration + fx.transition.settle : 0;
      await instance._wait(lead + ROUNDS[mode]);
      if (token !== instance._transitionToken || ((_a = instance._voiceFx) == null ? void 0 : _a.mode) !== mode) return;
      clearVoice(instance);
      instance._releaseExpressionLock();
      dispatchVoiceState(instance, "idle");
    }
    function clearVoice(instance) {
      if (instance._voiceFx && instance._voiceShown) {
        instance._voiceExit = { from: shownPoses(instance), start: performance.now() };
      }
      instance._voiceRequested = null;
      instance._voiceFx = null;
    }
    function currentExitPoses(instance, now) {
      const exit = instance._voiceExit;
      const t = clamp01((now - exit.start) / EXIT);
      return exit.from.map((pose, i) => between(pose, neutralPose(i), t));
    }
    proto.startListening = async function() {
      await enterVoice(this, "listening", true);
      return this;
    };
    proto._startBloom = async function(style = "bloom") {
      await enterVoice(this, "thinking", true, style === "cross" ? "cross" : "bloom");
      return this;
    };
    proto.startSpeaking = async function() {
      await enterVoice(this, "speaking", true);
      return this;
    };
    proto.setVoiceLevel = function(level) {
      var _a;
      const pair = Array.isArray(level) ? level : [level, level];
      const [low, high] = pair.map((value) => Number.isFinite(Number(value)) ? clamp01(Number(value)) : 0);
      this._voiceLevels = [Math.max(low, high), low, high];
      this._voiceLevelAt = performance.now();
      if (this._voiceFx) (_a = this._resumeFrames) == null ? void 0 : _a.call(this);
      return this;
    };
    function readEye(eye, base) {
      const transform = (eye == null ? void 0 : eye.getAttribute("transform")) || "";
      const translate = transform.match(/translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
      const scale = transform.match(/scale\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)/);
      const sx = scale ? Number(scale[1]) : 1;
      const sy = scale ? Number(scale[2] ?? scale[1]) : 1;
      const rx = Number(base == null ? void 0 : base.getAttribute("rx")) * sx || 0;
      const ry = Number(base == null ? void 0 : base.getAttribute("ry")) * sy || 0;
      return { x: translate ? Number(translate[1]) : 120, y: (translate ? Number(translate[2]) : 126) + Number((base == null ? void 0 : base.getAttribute("cy")) || 0) * sy, rx, ry, capX: rx, capY: ry, angle: 0 };
    }
    function paint(instance, poses, hideLids) {
      const parts = [
        [instance._leftEye, instance._leftBase, instance._leftInputBase, instance._leftTop, instance._leftBottom],
        [instance._rightEye, instance._rightBase, instance._rightInputBase, instance._rightTop, instance._rightBottom]
      ];
      parts.forEach(([eye, base, shape, top, bottom], i) => {
        if (!eye || !shape) return;
        const o = poses[i];
        eye.setAttribute("transform", `translate(${o.x.toFixed(3)} ${o.y.toFixed(3)}) rotate(${o.angle.toFixed(3)})`);
        shape.setAttribute("x", (-o.rx).toFixed(3));
        shape.setAttribute("y", (-o.ry).toFixed(3));
        shape.setAttribute("width", (2 * o.rx).toFixed(3));
        shape.setAttribute("height", (2 * o.ry).toFixed(3));
        shape.setAttribute("rx", Math.min(o.rx, o.capX).toFixed(3));
        shape.setAttribute("ry", Math.min(o.ry, o.capY).toFixed(3));
        shape.setAttribute("opacity", "1");
        base == null ? void 0 : base.setAttribute("opacity", "0");
        if (hideLids) {
          top == null ? void 0 : top.setAttribute("y", "-500");
          top == null ? void 0 : top.setAttribute("transform", "");
          bottom == null ? void 0 : bottom.setAttribute("y", "500");
          bottom == null ? void 0 : bottom.setAttribute("transform", "");
        }
      });
    }
    function drawVoice(now) {
      const fx = this._voiceFx;
      if (!fx) {
        drawExit(this, now);
        return;
      }
      const dt = Math.min(50, Math.max(0, now - fx.last)) / 1e3;
      fx.last = now;
      fx.reduced = reducedMotion(this);
      const transition = fx.transition;
      const transitionTime = transition ? now - transition.start : Infinity;
      const settling = (transition == null ? void 0 : transition.split) && transitionTime < transition.duration + transition.settle;
      const fresh = now - (this._voiceLevelAt ?? -Infinity) < LEVEL_FRESH;
      let raw = [0, 0, 0];
      if (fx.reduced) raw = fx.mode === "speaking" ? [0.35, 0.35, 0.35] : [0, 0, 0];
      else if (settling || fx.mode === "thinking") raw = [0, 0, 0];
      else if (fresh) raw = this._voiceLevels || raw;
      else if (fx.mode === "speaking") {
        const elapsed = now - fx.modeStart;
        const low = speechRhythm(elapsed, 0);
        const high = speechRhythm(elapsed, 0.11) * 0.85;
        raw = [Math.max(low, high), low, high];
      }
      const speed = fx.mode === "listening" ? SET.listen.tempo : 1;
      fx.levels = fx.reduced ? raw : fx.levels.map((value, i) => mix(value, raw[i], 1 - Math.exp(-dt * speed / (raw[i] > value ? 0.035 : 0.09))));
      let poses = targetPoses(fx, now);
      if (transition && !fx.reduced) {
        if (transition.split) {
          if (transitionTime < transition.duration) poses = transition.from.map((pose, i) => between(pose, neutralPose(i), transitionTime / transition.duration));
          else if (transitionTime < transition.duration + transition.settle) poses = [neutralPose(0), neutralPose(1)];
          else fx.transition = null;
        } else if (transitionTime < transition.duration) {
          poses = transition.from.map((pose, i) => between(pose, poses[i], transitionTime / transition.duration));
        } else {
          fx.transition = null;
        }
      } else if (transition) {
        fx.transition = null;
      }
      this._voiceShown = poses.map((pose) => ({ ...pose }));
      paint(this, poses, true);
    }
    function drawExit(instance, now) {
      const exit = instance._voiceExit;
      if (!exit) return;
      const t = (now - exit.start) / EXIT;
      if (t >= 1 || reducedMotion(instance)) {
        instance._voiceExit = null;
        instance._voiceShown = null;
        return;
      }
      const targets = [
        readEye(instance._leftEye, instance._leftBase),
        readEye(instance._rightEye, instance._rightBase)
      ];
      if (instance._state === "input") {
        instance._voiceExit = null;
        instance._voiceShown = null;
        return;
      }
      const poses = exit.from.map((pose, i) => between(pose, targets[i], t));
      instance._voiceShown = poses;
      paint(instance, poses, t < 0.75);
    }
    registerAvatarExtension({
      name: "voice",
      actions: {
        listening() {
          return voiceRound(this, "listening");
        },
        "waiting-bloom"() {
          return voiceRound(this, "thinking");
        },
        "waiting-cross"() {
          return voiceRound(this, "thinking", "cross");
        },
        speaking() {
          return voiceRound(this, "speaking");
        }
      },
      beforePlay(action) {
        if (OWN_ACTIONS.includes(action)) return;
        clearVoice(this);
      },
      reset() {
        clearVoice(this);
      },
      draw: drawVoice
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.VOICE_SETTINGS = SET;
  });
  __define("src/boopface-inspect.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const proto = BoopFace.prototype;
    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    const lerp = (a, b, t) => a + (b - a) * t;
    const smooth = (t) => {
      t = clamp01(t);
      return t * t * (3 - 2 * t);
    };
    const INSPECT_DEFAULTS = Object.freeze({
      aperture: 16,
      scanOffset: 16,
      prepPause: 120,
      close: 220,
      holdClosed: 880,
      down1: 400,
      holdDown1: 560,
      up1: 160,
      holdUp1: 580,
      center1: 140,
      holdCenter: 760,
      down2: 140,
      holdDown2: 620,
      up2: 180,
      holdUp2: 620,
      center2: 100,
      holdAfter: 940,
      open: 260
    });
    const INSPECT_BOUNDS = Object.freeze({
      aperture: [6, 40],
      scanOffset: [0, 24],
      prepPause: [0, 2400],
      close: [40, 2400],
      holdClosed: [0, 2400],
      down1: [40, 2400],
      holdDown1: [0, 2400],
      up1: [40, 2400],
      holdUp1: [0, 2400],
      center1: [40, 2400],
      holdCenter: [0, 2400],
      down2: [40, 2400],
      holdDown2: [0, 2400],
      up2: [40, 2400],
      holdUp2: [0, 2400],
      center2: [40, 2400],
      holdAfter: [0, 2400],
      open: [40, 2400]
    });
    const runtimeWindow = typeof window !== "undefined" ? window : null;
    const inspectConfig = (runtimeWindow == null ? void 0 : runtimeWindow.BoopFaceInspectConfig) && typeof runtimeWindow.BoopFaceInspectConfig === "object" ? runtimeWindow.BoopFaceInspectConfig : {};
    function normalizeConfigValue(key, value) {
      const fallback = INSPECT_DEFAULTS[key];
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      const [min, max] = INSPECT_BOUNDS[key];
      return Math.max(min, Math.min(max, numeric));
    }
    for (const key of Object.keys(INSPECT_DEFAULTS)) {
      inspectConfig[key] = normalizeConfigValue(key, inspectConfig[key]);
    }
    if (runtimeWindow) {
      runtimeWindow.BoopFaceInspectConfig = inspectConfig;
      runtimeWindow.BoopFaceInspectDefaults = INSPECT_DEFAULTS;
    }
    function currentInspectConfig() {
      const config = {};
      for (const key of Object.keys(INSPECT_DEFAULTS)) {
        config[key] = normalizeConfigValue(key, inspectConfig[key]);
      }
      return config;
    }
    function dispatchInspectState(instance, state) {
      instance.dispatchEvent(new CustomEvent("face-state", {
        detail: { state }
      }));
    }
    function makeTimeline(config) {
      let cursor = 0;
      const phases = {};
      const add = (key) => {
        phases[`${key}Start`] = cursor;
        cursor += config[key];
        phases[`${key}End`] = cursor;
      };
      for (const key of [
        "close",
        "holdClosed",
        "down1",
        "holdDown1",
        "up1",
        "holdUp1",
        "center1",
        "holdCenter",
        "down2",
        "holdDown2",
        "up2",
        "holdUp2",
        "center2",
        "holdAfter",
        "open"
      ]) add(key);
      phases.duration = cursor;
      return phases;
    }
    function move(elapsed, start, end, from, to) {
      if (elapsed <= start) return from;
      if (elapsed >= end) return to;
      const span = Math.max(1, end - start);
      return lerp(from, to, smooth((elapsed - start) / span));
    }
    function verticalShift(elapsed, phases, offset) {
      if (elapsed < phases.down1Start) return 0;
      if (elapsed < phases.down1End) return move(elapsed, phases.down1Start, phases.down1End, 0, offset);
      if (elapsed < phases.holdDown1End) return offset;
      if (elapsed < phases.up1End) return move(elapsed, phases.up1Start, phases.up1End, offset, -offset);
      if (elapsed < phases.holdUp1End) return -offset;
      if (elapsed < phases.center1End) return move(elapsed, phases.center1Start, phases.center1End, -offset, 0);
      if (elapsed < phases.holdCenterEnd) return 0;
      if (elapsed < phases.down2End) return move(elapsed, phases.down2Start, phases.down2End, 0, offset);
      if (elapsed < phases.holdDown2End) return offset;
      if (elapsed < phases.up2End) return move(elapsed, phases.up2Start, phases.up2End, offset, 0);
      return 0;
    }
    function animateInspectHead(instance, phases) {
      var _a;
      if (!((_a = instance._headMotion) == null ? void 0 : _a.animate)) return;
      const token = instance._transitionToken;
      const start = phases.down1Start;
      const end = phases.center1End;
      const duration = Math.max(1, end - start);
      const offset = (time) => Math.max(0, Math.min(1, (time - start) / duration));
      instance._headMotion.style.transformBox = "view-box";
      instance._headMotion.style.transformOrigin = "120px 120px";
      const anim = instance._headMotion.animate([
        { transform: "translateY(0px)", offset: 0, easing: "cubic-bezier(.38,0,.25,1)" },
        { transform: "translateY(5px)", offset: offset(phases.down1End) },
        { transform: "translateY(5px)", offset: offset(phases.holdDown1End), easing: "cubic-bezier(.35,0,.22,1)" },
        { transform: "translateY(-4px)", offset: offset(phases.up1End) },
        { transform: "translateY(-4px)", offset: offset(phases.holdUp1End), easing: "cubic-bezier(.35,0,.22,1)" },
        { transform: "translateY(0px)", offset: 1 }
      ], {
        duration,
        delay: start,
        easing: "linear",
        fill: "forwards"
      });
      anim.onfinish = () => {
        if (token === instance._transitionToken) instance._headMotion.style.transform = "translateY(0px)";
      };
    }
    proto.inspect = async function() {
      this.noteActivity();
      this._inputWanted = false;
      const config = currentInspectConfig();
      this.reset();
      if (!await this._prepareExpression({ normalizePose: true, duration: 160, pause: config.prepPause })) return;
      const token = this._transitionToken;
      this._expressionLock = true;
      this._look.x = 0;
      this._look.y = 0;
      const phases = makeTimeline(config);
      this._inspectFx = { start: performance.now(), duration: phases.duration, config, phases };
      dispatchInspectState(this, "inspect");
      animateInspectHead(this, phases);
      await this._wait(phases.duration + 30);
      if (token !== this._transitionToken) return;
      this._inspectFx = null;
      this._look.x = 0;
      this._look.y = 0;
      this._releaseExpressionLock();
      dispatchInspectState(this, "idle");
    };
    function drawInspect(now) {
      const fx = this._inspectFx;
      if (!fx) return;
      const config = fx.config || currentInspectConfig();
      const phases = fx.phases || makeTimeline(config);
      const elapsed = Math.max(0, Math.min(phases.duration, now - fx.start));
      let lidBlend = 1;
      if (elapsed < phases.closeEnd) {
        lidBlend = smooth(elapsed / Math.max(1, config.close));
      } else if (elapsed >= phases.openStart) {
        lidBlend = 1 - smooth((elapsed - phases.openStart) / Math.max(1, config.open));
      }
      const yShift = verticalShift(elapsed, phases, config.scanOffset);
      this._leftEye.setAttribute("transform", `translate(86 ${(126 + yShift).toFixed(2)}) scale(1 1)`);
      this._rightEye.setAttribute("transform", `translate(154 ${(126 + yShift).toFixed(2)}) scale(1 1)`);
      const apertureHalf = config.aperture / 2;
      const topEdge = lerp(-36, -apertureHalf, lidBlend);
      const bottomEdge = lerp(36, apertureHalf, lidBlend);
      for (const top of [this._leftTop, this._rightTop]) {
        top.setAttribute("y", (topEdge - 90).toFixed(2));
        top.setAttribute("height", "90");
        top.setAttribute("transform", `rotate(0 0 ${topEdge.toFixed(2)})`);
      }
      for (const bottom of [this._leftBottom, this._rightBottom]) {
        bottom.setAttribute("y", bottomEdge.toFixed(2));
        bottom.setAttribute("height", "90");
        bottom.setAttribute("transform", `rotate(0 0 ${bottomEdge.toFixed(2)})`);
      }
    }
    registerAvatarExtension({
      name: "inspect",
      actions: {
        inspect() {
          return this.inspect();
        },
        verify() {
          return this.inspect();
        },
        review() {
          return this.inspect();
        }
      },
      beforePlay(action) {
        if (action === "inspect" || action === "verify" || action === "review") return;
        this._inspectFx = null;
      },
      reset() {
        this._inspectFx = null;
      },
      draw: drawInspect
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.INSPECT_DEFAULTS = INSPECT_DEFAULTS;
  });
  __define("src/boopface-failure.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const proto = BoopFace.prototype;
    const FAILURE_HEAD_DROP = 5.5;
    const FAILURE_EYE_DROP = 4.8;
    function dispatchFailureState(instance, state) {
      instance.dispatchEvent(new CustomEvent("face-state", {
        detail: { state }
      }));
    }
    function animateFailureHead(instance, frames, duration) {
      var _a;
      if (!((_a = instance._headMotion) == null ? void 0 : _a.animate)) return null;
      const token = instance._transitionToken;
      instance._headMotion.style.transformBox = "view-box";
      instance._headMotion.style.transformOrigin = "120px 120px";
      const anim = instance._headMotion.animate(frames, {
        duration,
        easing: "cubic-bezier(.32,0,.24,1)",
        fill: "forwards"
      });
      anim.onfinish = () => {
        if (token === instance._transitionToken) {
          instance._headMotion.style.transform = frames[frames.length - 1].transform || "";
        }
      };
      return anim;
    }
    function smooth01(t) {
      t = Math.max(0, Math.min(1, t));
      return t * t * (3 - 2 * t);
    }
    function failureEyeDrop(fx, now) {
      const elapsed = Math.max(0, now - fx.start);
      if (elapsed < fx.headDown) {
        return FAILURE_EYE_DROP * smooth01(elapsed / Math.max(1, fx.headDown));
      }
      if (elapsed < fx.headDown + fx.hold) return FAILURE_EYE_DROP;
      const recoverElapsed = elapsed - fx.headDown - fx.hold;
      if (recoverElapsed < fx.recover) {
        return FAILURE_EYE_DROP * (1 - smooth01(recoverElapsed / Math.max(1, fx.recover)));
      }
      return 0;
    }
    function addEyeDrop(eye, amount) {
      if (!eye || Math.abs(amount) < 1e-3) return;
      const current = eye.getAttribute("transform") || "";
      eye.setAttribute("transform", `${current} translate(0 ${amount.toFixed(2)})`);
    }
    proto.failure = async function() {
      this.noteActivity();
      this._inputWanted = false;
      this._failureFx = null;
      this.reset();
      if (!await this._prepareExpression({ normalizePose: true, duration: 180, pause: 260 })) return;
      const token = this._transitionToken;
      const eyeIn = 320;
      this.setState("sad", { duration: eyeIn, keepGazeLock: true });
      dispatchFailureState(this, "failure");
      await this._wait(eyeIn);
      if (token !== this._transitionToken || this._state !== "sad") return;
      const headDown = 720;
      const loweredHold = 720;
      const recover = 520;
      this._failureFx = {
        start: performance.now(),
        headDown,
        hold: loweredHold,
        recover
      };
      animateFailureHead(this, [
        { transform: "translateY(0px)" },
        { transform: `translateY(${FAILURE_HEAD_DROP}px)` }
      ], headDown);
      await this._wait(headDown);
      if (token !== this._transitionToken) return;
      await this._wait(loweredHold);
      if (token !== this._transitionToken) return;
      animateFailureHead(this, [
        { transform: `translateY(${FAILURE_HEAD_DROP}px)` },
        { transform: "translateY(0px)" }
      ], recover);
      if (this._state === "sad") await this._returnToIdle(recover);
      if (token !== this._transitionToken) return;
      this._failureFx = null;
    };
    function drawFailure(now) {
      const fx = this._failureFx;
      if (!fx) return;
      const drop = failureEyeDrop(fx, now);
      addEyeDrop(this._leftEye, drop);
      addEyeDrop(this._rightEye, drop);
    }
    registerAvatarExtension({
      name: "failure",
      actions: {
        failure() {
          return this.failure();
        },
        failed() {
          return this.failure();
        },
        fail() {
          return this.failure();
        }
      },
      beforePlay(action) {
        if (action === "failure" || action === "failed" || action === "fail") return;
        this._failureFx = null;
      },
      reset() {
        this._failureFx = null;
      },
      draw: drawFailure
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
  });
  __define("src/boopface-love.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const proto = BoopFace.prototype;
    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    const lerp = (a, b, t) => a + (b - a) * t;
    const smooth = (t) => {
      t = clamp01(t);
      return t * t * (3 - 2 * t);
    };
    const LOVE_DEFAULTS = Object.freeze({
      rx: 28,
      ry: 43,
      tilt: 42,
      cross: 13,
      centerY: 126,
      pulse: 0.155,
      prep: 120,
      morphIn: 240,
      beat: 760,
      beats: 3,
      morphOut: 360,
      swayAngle: 0,
      swayLift: 2
    });
    const LOVE_BOUNDS = Object.freeze({
      rx: [10, 50],
      ry: [20, 70],
      tilt: [0, 60],
      cross: [-10, 20],
      centerY: [90, 150],
      pulse: [0, 0.3],
      prep: [0, 1200],
      morphIn: [40, 1500],
      beat: [200, 2e3],
      beats: [1, 60],
      morphOut: [40, 1500],
      swayAngle: [0, 8],
      swayLift: [0, 8]
    });
    const runtimeWindow = typeof window !== "undefined" ? window : null;
    const loveConfig = (runtimeWindow == null ? void 0 : runtimeWindow.BoopFaceLoveConfig) && typeof runtimeWindow.BoopFaceLoveConfig === "object" ? runtimeWindow.BoopFaceLoveConfig : {};
    function normalizeConfigValue(key, value) {
      const fallback = LOVE_DEFAULTS[key];
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      const [min, max] = LOVE_BOUNDS[key];
      return Math.max(min, Math.min(max, numeric));
    }
    if (runtimeWindow) {
      runtimeWindow.BoopFaceLoveConfig = loveConfig;
      runtimeWindow.BoopFaceLoveDefaults = LOVE_DEFAULTS;
      runtimeWindow.BoopFaceLoveBounds = LOVE_BOUNDS;
    }
    function currentLoveConfig() {
      const config = {};
      for (const key of Object.keys(LOVE_DEFAULTS)) config[key] = normalizeConfigValue(key, loveConfig[key]);
      config.beats = Math.round(config.beats);
      return config;
    }
    function loveDuration(config) {
      return config.morphIn + config.beat * config.beats + config.morphOut;
    }
    function reducedMotion(instance) {
      const requested = String(instance.getAttribute("motion") || "auto").trim().toLowerCase();
      if (requested === "reduce") return true;
      if (requested === "full") return false;
      return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    function dispatchLoveState(instance, state) {
      instance.dispatchEvent(new CustomEvent("face-state", { detail: { state } }));
    }
    function animateLoveHead(instance, config, duration, elapsed = 0) {
      var _a;
      if (!((_a = instance._headMotion) == null ? void 0 : _a.animate)) return;
      const token = instance._transitionToken;
      const { swayAngle, swayLift } = config;
      instance._headMotion.style.transformBox = "view-box";
      instance._headMotion.style.transformOrigin = "120px 120px";
      const anim = instance._headMotion.animate([
        { transform: "translateY(0px) rotate(0deg)", offset: 0, easing: "cubic-bezier(.38,0,.25,1)" },
        { transform: `translateY(${-swayLift}px) rotate(${-swayAngle}deg)`, offset: 0.3, easing: "cubic-bezier(.35,0,.22,1)" },
        { transform: `translateY(${-swayLift / 2}px) rotate(${swayAngle}deg)`, offset: 0.68, easing: "cubic-bezier(.35,0,.22,1)" },
        { transform: "translateY(0px) rotate(0deg)", offset: 1 }
      ], { duration, delay: -elapsed, easing: "linear", fill: "forwards" });
      anim.onfinish = () => {
        if (token === instance._transitionToken) instance._headMotion.style.transform = "translateY(0px)";
      };
    }
    proto.love = async function() {
      this.noteActivity();
      this._inputWanted = false;
      const config = currentLoveConfig();
      this.reset();
      if (!await this._prepareExpression({ normalizePose: true, duration: 160, pause: config.prep })) return;
      const token = this._transitionToken;
      this._expressionLock = true;
      this._look.x = 0;
      this._look.y = 0;
      const duration = loveDuration(config);
      this._loveFx = { start: performance.now(), duration, timing: config, headStarted: false };
      dispatchLoveState(this, "love");
      if (!reducedMotion(this)) {
        this._loveFx.headStarted = true;
        animateLoveHead(this, config, duration);
      }
      await this._wait(duration + 30);
      if (token !== this._transitionToken) return;
      this._loveFx = null;
      this._look.x = 0;
      this._look.y = 0;
      this._releaseExpressionLock();
      dispatchLoveState(this, "idle");
    };
    function drawLove(now) {
      const fx = this._loveFx;
      if (!fx) return;
      const timing = fx.timing;
      const shape = currentLoveConfig();
      const elapsed = Math.max(0, Math.min(fx.duration, now - fx.start));
      const holdEnd = timing.morphIn + timing.beat * timing.beats;
      const reduced = reducedMotion(this);
      if (!reduced && !fx.headStarted) {
        fx.headStarted = true;
        animateLoveHead(this, timing, fx.duration, elapsed);
      }
      let morph = 1;
      if (reduced) morph = 1;
      else if (elapsed < timing.morphIn) morph = smooth(elapsed / timing.morphIn);
      else if (elapsed > holdEnd) morph = 1 - smooth((elapsed - holdEnd) / timing.morphOut);
      let pulse = 0;
      if (!reduced && elapsed >= timing.morphIn && elapsed <= holdEnd) {
        const phase = (elapsed - timing.morphIn) % timing.beat / timing.beat;
        const swell = (centre, width) => Math.max(0, 1 - Math.abs(phase - centre) / width);
        pulse = Math.max(smooth(swell(0.12, 0.12)), 0.6 * smooth(swell(0.36, 0.12)));
      }
      const scale = 1 + shape.pulse * pulse;
      const tiltRad = shape.tilt * Math.PI / 180;
      const baseY = shape.centerY + (shape.ry - 3) * Math.cos(tiltRad);
      const beat = `translate(120 ${shape.centerY}) scale(${scale.toFixed(3)}) translate(-120 -${shape.centerY})`;
      const eyes = [
        [this._leftEye, this._leftBase, this._leftTop, this._leftBottom, 86, -1],
        [this._rightEye, this._rightBase, this._rightTop, this._rightBottom, 154, 1]
      ];
      for (const [eye, base, top, bottom, restX, side] of eyes) {
        const x = lerp(restX, 120 - side * shape.cross, morph);
        const y = lerp(126, baseY, morph);
        const tilt = side * shape.tilt * morph;
        eye.setAttribute("transform", `${beat} translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${tilt.toFixed(2)})`);
        base.setAttribute("cx", "0");
        base.setAttribute("cy", lerp(0, -(shape.ry - 3), morph).toFixed(2));
        base.setAttribute("rx", lerp(27, shape.rx, morph).toFixed(2));
        base.setAttribute("ry", lerp(29, shape.ry, morph).toFixed(2));
        base.setAttribute("opacity", "1");
        const topY = lerp(-36, -150, morph);
        const bottomY = lerp(36, 150, morph);
        top.setAttribute("y", (topY - 90).toFixed(2));
        top.setAttribute("height", "90");
        top.setAttribute("transform", `rotate(0 0 ${topY.toFixed(2)})`);
        bottom.setAttribute("y", bottomY.toFixed(2));
        bottom.setAttribute("height", "90");
        bottom.setAttribute("transform", `rotate(0 0 ${bottomY.toFixed(2)})`);
      }
    }
    registerAvatarExtension({
      name: "love",
      actions: {
        love() {
          return this.love();
        }
      },
      beforePlay(action) {
        if (action === "love") return;
        this._loveFx = null;
      },
      reset() {
        this._loveFx = null;
      },
      draw: drawLove
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.LOVE_DEFAULTS = LOVE_DEFAULTS;
  });
  __define("src/boopface-random.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const proto = BoopFace.prototype;
    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    const smooth = (t) => {
      t = clamp01(t);
      return t * t * (3 - 2 * t);
    };
    const RANDOM_DEFAULTS = Object.freeze({
      radius: 50,
      gap: 0,
      squeeze: 12.5,
      speed: 0.6,
      ramp: 220,
      spin: 1e3,
      stagger: 420,
      slowDist: 40,
      overshoot: 8,
      bouncePeriod: 200,
      damping: 0.3,
      prep: 120
    });
    const RANDOM_BOUNDS = Object.freeze({
      radius: [50, 100],
      gap: [0, 200],
      squeeze: [0, 30],
      speed: [0.15, 1.6],
      ramp: [40, 800],
      spin: [100, 4e3],
      stagger: [0, 1500],
      slowDist: [40, 400],
      overshoot: [0, 40],
      bouncePeriod: [120, 800],
      damping: [0.1, 0.9],
      prep: [0, 1200]
    });
    const runtimeWindow = typeof window !== "undefined" ? window : null;
    const randomConfig = (runtimeWindow == null ? void 0 : runtimeWindow.BoopFaceRandomConfig) && typeof runtimeWindow.BoopFaceRandomConfig === "object" ? runtimeWindow.BoopFaceRandomConfig : {};
    function normalizeConfigValue(key, value) {
      const fallback = RANDOM_DEFAULTS[key];
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      const [min, max] = RANDOM_BOUNDS[key];
      return Math.max(min, Math.min(max, numeric));
    }
    if (runtimeWindow) {
      runtimeWindow.BoopFaceRandomConfig = randomConfig;
      runtimeWindow.BoopFaceRandomDefaults = RANDOM_DEFAULTS;
      runtimeWindow.BoopFaceRandomBounds = RANDOM_BOUNDS;
    }
    function currentRandomConfig() {
      const config = {};
      for (const key of Object.keys(RANDOM_DEFAULTS)) config[key] = normalizeConfigValue(key, randomConfig[key]);
      return config;
    }
    function planReel(config, slowAt) {
      const { speed: v, ramp, period: P, slowDist: L, overshoot: O, bouncePeriod, damping: zeta } = config;
      const spinPos = (t) => t < ramp ? v * t * t / (2 * ramp) : v * (t - ramp / 2);
      const rampEnd = v * ramp / 2;
      let n = Math.max(1, Math.round((spinPos(slowAt) + L - O) / P));
      while (n * P + O - L < rampEnd) n += 1;
      const target = n * P;
      const pStop = target + O - L;
      const tStop = pStop / v + ramp / 2;
      const D = 2 * L / v;
      const wd = 2 * Math.PI / bouncePeriod;
      const w = wd / Math.sqrt(1 - zeta * zeta);
      const decay = zeta * w;
      const bounceLength = O > 0.1 ? Math.log(O / 0.1) / decay : 0;
      const tLand = tStop + D;
      const tEnd = tLand + bounceLength;
      const position = (t) => {
        if (t < tStop) return spinPos(t);
        if (t < tLand) {
          const u = (t - tStop) / D;
          const h10 = u * u * u - 2 * u * u + u;
          const h01 = -2 * u * u * u + 3 * u * u;
          return pStop + L * (2 * h10 + h01);
        }
        if (t >= tEnd) return target;
        const tau = t - tLand;
        return target + O * Math.exp(-decay * tau) * (Math.cos(wd * tau) + decay / wd * Math.sin(wd * tau));
      };
      return { position, tEnd, tStop, tLand, period: P };
    }
    function reducedMotion(instance) {
      const requested = String(instance.getAttribute("motion") || "auto").trim().toLowerCase();
      if (requested === "reduce") return true;
      if (requested === "full") return false;
      return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    function dispatchRandomState(instance, state) {
      instance.dispatchEvent(new CustomEvent("face-state", { detail: { state } }));
    }
    function buildRandomFx(config, start, extra = {}) {
      const period = Math.PI * config.radius + config.gap;
      const reel = { ...config, period };
      const plans = [planReel(reel, config.spin), planReel(reel, config.spin + config.stagger)];
      return {
        start,
        duration: Math.max(plans[0].tEnd, plans[1].tEnd),
        plans,
        period,
        radius: config.radius,
        squeeze: config.squeeze,
        ...extra
      };
    }
    proto._previewRandom = function(elapsed) {
      var _a, _b, _c;
      if (elapsed === null) {
        if ((_a = this._randomFx) == null ? void 0 : _a.preview) {
          this._randomFx = null;
          this._releaseExpressionLock();
          dispatchRandomState(this, "idle");
        }
        return 0;
      }
      if (!((_b = this._randomFx) == null ? void 0 : _b.preview)) {
        this.reset();
        this._expressionLock = true;
        this._look.x = 0;
        this._look.y = 0;
        dispatchRandomState(this, "random");
      }
      this._randomFx = buildRandomFx(currentRandomConfig(), 0, { preview: true, frozenAt: elapsed });
      (_c = this._resumeFrames) == null ? void 0 : _c.call(this);
      return this._randomFx.duration;
    };
    proto.random = async function() {
      this.noteActivity();
      this._inputWanted = false;
      const config = currentRandomConfig();
      this.reset();
      if (!await this._prepareExpression({ normalizePose: true, duration: 160, pause: config.prep })) return;
      const token = this._transitionToken;
      this._expressionLock = true;
      this._look.x = 0;
      this._look.y = 0;
      this._randomFx = buildRandomFx(config, performance.now());
      const duration = this._randomFx.duration;
      dispatchRandomState(this, "random");
      await this._wait(duration + 30);
      if (token !== this._transitionToken) return;
      this._randomFx = null;
      this._look.x = 0;
      this._look.y = 0;
      this._releaseExpressionLock();
      dispatchRandomState(this, "idle");
    };
    function drawRandom(now) {
      const fx = this._randomFx;
      if (!fx) return;
      const elapsed = fx.frozenAt ?? Math.max(0, now - fx.start);
      const reduced = fx.preview ? false : reducedMotion(this);
      const { period: P, radius: R, squeeze } = fx;
      const half = Math.PI * R / 2;
      fx.plans.forEach((plan, index) => {
        if (elapsed >= plan.tEnd) return;
        const base = index === 0 ? this._leftBase : this._rightBase;
        const top = index === 0 ? this._leftTop : this._rightTop;
        const bottom = index === 0 ? this._leftBottom : this._rightBottom;
        const position = reduced ? P * 0.3 : plan.position(elapsed);
        let offset = (position % P + P) % P;
        if (offset > P / 2) offset -= P;
        const angle = Math.abs(offset) < half ? offset / R : Math.sign(offset) * Math.PI / 2;
        const front = Math.abs(offset) < half ? Math.cos(angle) : 0;
        const side = 1 - front;
        const width = 54 - squeeze * smooth(side);
        const y = R * Math.sin(angle) + Math.sign(angle) * 6 * side ** 3;
        base.setAttribute("cx", "0");
        base.setAttribute("cy", y.toFixed(2));
        base.setAttribute("rx", (width / 2).toFixed(2));
        base.setAttribute("ry", (29 * front).toFixed(2));
        base.setAttribute("opacity", "1");
        top.setAttribute("y", "-240");
        top.setAttribute("height", "90");
        top.setAttribute("transform", "rotate(0 0 -150)");
        bottom.setAttribute("y", "150");
        bottom.setAttribute("height", "90");
        bottom.setAttribute("transform", "rotate(0 0 150)");
      });
    }
    registerAvatarExtension({
      name: "random",
      actions: {
        random() {
          return this.random();
        },
        slot() {
          return this.random();
        }
      },
      beforePlay(action) {
        if (action === "random" || action === "slot") return;
        this._randomFx = null;
      },
      reset() {
        this._randomFx = null;
      },
      draw: drawRandom
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.RANDOM_DEFAULTS = RANDOM_DEFAULTS;
  });
  __define("src/boopface-version.js", function(__require2, __import2, exports) {
    const VERSION = "0.9.0";
    exports.VERSION = VERSION;
  });
  __define("src/boopface-head-roundness.js", function(__require2, __import2, exports) {
    const BoopFace = __require2("src/boopface-extension-host.js").default;
    const { flattenHeadPoints } = __require2("src/boopface-geometry.js");
    const { VERSION } = __require2("src/boopface-version.js");
    const proto = BoopFace.prototype;
    const DEFAULT_ROUNDNESS = 50;
    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }
    function ensureDefaultGeometry(instance) {
      var _a, _b;
      if (!(instance == null ? void 0 : instance._headShape) || !((_a = instance._baseHeadPoints) == null ? void 0 : _a.length)) return false;
      if ((_b = instance._headRoundnessDefaultPoints) == null ? void 0 : _b.length) return true;
      let points = instance._baseHeadPoints.map((point) => ({ x: point.x, y: point.y }));
      if (!instance._headFlattenedR32) {
        points = flattenHeadPoints(points);
        instance._headFlattenedR32 = true;
        instance._baseHeadPoints = points.map((point) => ({ ...point }));
        instance._baseHeadPathD = instance._pointsToPath(points);
        instance._headShape.setAttribute("d", instance._baseHeadPathD);
      }
      instance._headRoundnessDefaultPoints = instance._baseHeadPoints.map((point) => ({ x: point.x, y: point.y }));
      instance._headRoundness = DEFAULT_ROUNDNESS;
      return true;
    }
    function superellipsePoint(angle, cx, cy, halfW, halfH, exponent) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const xTerm = Math.pow(Math.abs(cos) / Math.max(1e-3, halfW), exponent);
      const yTerm = Math.pow(Math.abs(sin) / Math.max(1e-3, halfH), exponent);
      const denom = Math.pow(xTerm + yTerm, 1 / exponent);
      const radius = denom > 0 ? 1 / denom : 0;
      return { x: cx + cos * radius, y: cy + sin * radius };
    }
    function targetShape(points, exponent) {
      const minX = Math.min(...points.map((point) => point.x));
      const maxX = Math.max(...points.map((point) => point.x));
      const minY = Math.min(...points.map((point) => point.y));
      const maxY = Math.max(...points.map((point) => point.y));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const halfW = (maxX - minX) / 2;
      const halfH = (maxY - minY) / 2;
      return points.map((point) => {
        const angle = Math.atan2(point.y - cy, point.x - cx);
        return superellipsePoint(angle, cx, cy, halfW, halfH, exponent);
      });
    }
    function mixPoints(from, to, amount) {
      const t = clamp(amount, 0, 1);
      return from.map((point, index) => ({
        x: point.x + (to[index].x - point.x) * t,
        y: point.y + (to[index].y - point.y) * t
      }));
    }
    proto.setHeadRoundness = function(value = DEFAULT_ROUNDNESS) {
      var _a, _b, _c;
      if (!ensureDefaultGeometry(this)) return this;
      const roundness = clamp(Number(value) || 0, 0, 100);
      const baseline = this._headRoundnessDefaultPoints;
      let points = baseline.map((point) => ({ ...point }));
      if (roundness < DEFAULT_ROUNDNESS) {
        const squarer = targetShape(baseline, 10);
        points = mixPoints(baseline, squarer, (DEFAULT_ROUNDNESS - roundness) / DEFAULT_ROUNDNESS);
      } else if (roundness > DEFAULT_ROUNDNESS) {
        const rounder = targetShape(baseline, 2.2);
        points = mixPoints(baseline, rounder, (roundness - DEFAULT_ROUNDNESS) / DEFAULT_ROUNDNESS);
      }
      this._headRoundness = roundness;
      this._baseHeadPoints = points;
      this._baseHeadPathD = this._pointsToPath(points);
      if (((_a = this._dragJelly) == null ? void 0 : _a.active) || ((_b = this._dragJelly) == null ? void 0 : _b.returning)) (_c = this._applyHeadDeform) == null ? void 0 : _c.call(this);
      else this._headShape.setAttribute("d", this._baseHeadPathD);
      this.dispatchEvent(new CustomEvent("head-roundness-change", {
        detail: { value: roundness, version: VERSION }
      }));
      return this;
    };
    proto.getHeadRoundness = function() {
      return Number.isFinite(this._headRoundness) ? this._headRoundness : DEFAULT_ROUNDNESS;
    };
    if (typeof window !== "undefined") {
      window.BoopFaceVersion = VERSION;
      window.BoopFaceHeadRoundnessDefault = DEFAULT_ROUNDNESS;
    }
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.DEFAULT_ROUNDNESS = DEFAULT_ROUNDNESS;
    exports.VERSION = VERSION;
  });
  __define("src/boopface-gestures.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const proto = BoopFace.prototype;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const disabled = (face, key) => face.getAttribute(key) === "false";
    const emit = (face, state) => face.dispatchEvent(new CustomEvent("face-state", { detail: { state } }));
    const ANTENNA_GAZE_REACH = 0.6;
    const gazeTarget = (box, event) => {
      const x = (event.clientX - box.left - box.width / 2) * 0.42, y = (event.clientY - box.top - box.height / 2) * 0.38;
      const k = Math.min(1, ANTENNA_GAZE_REACH / (Math.hypot(x / 48, y / 34) || 1));
      return { x: x * k, y: y * k };
    };
    const SQUEEZE_HOLD_SECONDS = 0.14;
    const PULL_REACH = 18.75;
    const stiffPull = (p) => {
      const m = Math.min(Math.abs(p), PULL_REACH);
      return Math.sign(p) * (m - m ** 5 / (5 * PULL_REACH ** 4));
    };
    function restore(face) {
      var _a;
      face._headMotion.style.transform = "";
      face._headMotion.removeAttribute("transform");
      face._dragMotion.style.transform = "";
      face._dragMotion.style.transformOrigin = "";
      face._headShape.setAttribute("d", face._baseHeadPathD);
      (_a = face._antennaDot) == null ? void 0 : _a.removeAttribute("transform");
      if (face._antennaSpring) face._antennaSpring.initialized = false;
      face._releaseExpressionLock();
    }
    proto._cancelGesture = function(silent = false) {
      var _a;
      const fx = this._gestureFx;
      if (!fx) return;
      this._gestureFx = null;
      try {
        if (fx.pointerId != null && this.hasPointerCapture(fx.pointerId)) this.releasePointerCapture(fx.pointerId);
      } catch (_) {
      }
      if (!fx.committed) return;
      restore(this);
      (_a = this._endGestureAction) == null ? void 0 : _a.call(this, "cancel", false, silent);
    };
    function commit(face, s, look = null) {
      var _a;
      if (s.committed || face._gestureFx !== s) return false;
      face._gestureFx = null;
      face.reset();
      face._gestureFx = s;
      s.committed = true;
      face.noteActivity(false);
      face._expressionLock = true;
      if (look) {
        face._look.x = look.x;
        face._look.y = look.y;
      }
      (_a = face._beginGestureAction) == null ? void 0 : _a.call(face, s.kind);
      emit(face, s.kind);
      face._resumeFrames();
      return true;
    }
    proto.setPressSqueeze = function(enabled = true) {
      var _a;
      this.setAttribute("press-squeeze", String(Boolean(enabled)));
      if (!enabled && ((_a = this._gestureFx) == null ? void 0 : _a.kind) === "squeeze") this._cancelGesture();
      return this;
    };
    let warnedAntennaFlash = false;
    proto.setAntennaFlash = function() {
      if (!warnedAntennaFlash) {
        warnedAntennaFlash = true;
        console.warn("boopface: setAntennaFlash() was removed in 0.6 and does nothing. It will be deleted in 1.0.");
      }
      return this;
    };
    proto.setAntennaDrag = function(enabled = true) {
      var _a;
      this.setAttribute("antenna-drag", String(Boolean(enabled)));
      if (!enabled && ((_a = this._gestureFx) == null ? void 0 : _a.kind) === "antenna-drag") this._cancelGesture();
      return this;
    };
    proto._startGesture = function(event) {
      var _a;
      if (event.button !== 0 || event.isPrimary === false || ((_a = this._gestureFx) == null ? void 0 : _a.held)) return false;
      const box = this.getBoundingClientRect(), dot = this._antennaDot;
      const x = (event.clientX - box.left) / box.width - 0.5, y = (event.clientY - box.top) / box.height - 0.5;
      const r = dot == null ? void 0 : dot.getBoundingClientRect(), radius = r ? Math.max(10, Math.max(r.width, r.height) / 2 + 3) : 0;
      const onAntenna = r && Number(dot.getAttribute("opacity") ?? 1) > 0.01 && Math.hypot(event.clientX - r.left - r.width / 2, event.clientY - r.top - r.height / 2) <= radius;
      const kind = onAntenna && !disabled(this, "antenna-drag") ? "antenna-drag" : !onAntenna && event.pointerType !== "touch" && !disabled(this, "press-squeeze") && x * x + y * y <= 0.32 * 0.32 ? "squeeze" : null;
      if (!kind) return false;
      event.preventDefault();
      const home = { x: Number((dot == null ? void 0 : dot.getAttribute("cx")) ?? 120), y: Number((dot == null ? void 0 : dot.getAttribute("cy")) ?? 12) };
      const gaze = kind === "antenna-drag" ? gazeTarget(box, event) : null;
      const currentLook = gaze ? { ...this._look } : null;
      this._gestureFx = {
        kind,
        held: true,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        pointerType: event.pointerType,
        size: Math.max(1, box.width),
        threshold: clamp(box.width * 0.4, 24, 46),
        home,
        start: performance.now(),
        last: performance.now(),
        age: 0,
        releaseAge: 0,
        maxDist: 0,
        react: false,
        committed: false,
        gazeX: (gaze == null ? void 0 : gaze.x) ?? 0,
        gazeY: (gaze == null ? void 0 : gaze.y) ?? 0,
        q: 0,
        v: 0,
        pressure: 0,
        apex: 0,
        releaseDepth: 1,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        hx: 0,
        hy: 0,
        hvx: 0,
        hvy: 0,
        tx: 0,
        ty: 0
      };
      try {
        this.setPointerCapture(event.pointerId);
      } catch (_) {
      }
      if (kind === "antenna-drag") commit(this, this._gestureFx, currentLook);
      this._resumeFrames();
      return true;
    };
    proto._moveGesture = function(event) {
      var _a;
      const s = this._gestureFx;
      if (!(s == null ? void 0 : s.held) || s.pointerId !== event.pointerId) return;
      if (s.kind === "antenna-drag") {
        const gaze = gazeTarget(this.getBoundingClientRect(), event);
        s.gazeX = gaze.x;
        s.gazeY = gaze.y;
      }
      const dx = event.clientX - s.startX, dy = event.clientY - s.startY, dist = Math.hypot(dx, dy);
      s.maxDist = Math.max(s.maxDist, dist);
      if (s.kind === "squeeze" && dist > 4) {
        this._cancelGesture(true);
        (_a = this._startHeadDragFromGesture) == null ? void 0 : _a.call(this, event, s);
        return;
      }
      if (dist > 2.5) this._suppressClick = true;
      const gain = dist > s.threshold * 0.6 ? 0.24 : 0.19, scale = 240 / s.size;
      s.tx = clamp(dx * scale * gain, -25, 25);
      s.ty = clamp(dy * scale * gain, -25, 25);
      this._runtimeVisualDirty = true;
      this._resumeFrames();
    };
    proto._endGesture = function(event) {
      const s = this._gestureFx;
      if (!(s == null ? void 0 : s.held) || s.pointerId !== event.pointerId) return;
      if (event.type === "pointercancel") {
        this._cancelGesture();
        return;
      }
      if (!s.committed) {
        this._cancelGesture(true);
        return;
      }
      s.held = false;
      s.releaseAge = 0;
      s.react = s.kind === "antenna-drag" && s.maxDist > 2.5;
      s.releaseDepth = Math.min(1, Math.abs(s.q));
      const id = s.pointerId;
      s.pointerId = null;
      try {
        if (this.hasPointerCapture(id)) this.releasePointerCapture(id);
      } catch (_) {
      }
      if (s.kind === "squeeze" && s.age > 0.15) this._suppressClick = true;
      this._runtimeVisualDirty = true;
      this._resumeFrames();
    };
    function finish(face, s) {
      var _a;
      face._gestureFx = null;
      restore(face);
      emit(face, "idle");
      (_a = face._endGestureAction) == null ? void 0 : _a.call(face, "end", s.react);
    }
    function drawSqueeze(face, s, dt, reduced) {
      if (reduced) {
        s.q = s.held ? 1 : 0;
        s.v = 0;
      } else {
        const omega = 6 / 0.57, k = s.held ? omega * omega : 190, d = s.held ? 2 * omega : 9, oldV = s.v;
        for (let remaining = dt; remaining > 0; ) {
          const h = Math.min(1 / 240, remaining);
          remaining -= h;
          s.v += ((s.held ? 1 : 0) - s.q) * k * h - s.v * d * h;
          s.q += s.v * h;
        }
        if (!s.held && !s.apex && oldV < 0 && s.v >= 0 && s.q < 0) s.apex = s.age;
      }
      const pressure = s.held ? clamp((s.q - 0.94) / 0.06, 0, 1) : s.pressure * Math.exp(-s.releaseAge * 20);
      if (s.held) s.pressure = pressure;
      const phase = s.age * 2 * Math.PI, jitter = reduced ? 0 : 2 * pressure;
      const ripple = s.apex ? 0.012 * Math.exp(-(s.age - s.apex) * 12) * Math.sin((s.age - s.apex) * 72) * s.releaseDepth : 0;
      const jelly = jitter * 5e-3 * Math.sin(phase * 11) + ripple, scale = 1 - 0.29 * s.q;
      face._headFollow.setAttribute("transform", "");
      face._headMotion.style.transform = `translate(${jitter * (0.7 * Math.sin(phase * 13) + 0.3 * Math.sin(phase * 19))}px,${jitter * 0.45 * Math.sin(phase * 17)}px) scale(${scale + jelly},${scale - jelly})`;
      for (const [side, home, delta] of [["left", 86, 24], ["right", 154, -24]]) {
        face["_" + side + "Eye"].setAttribute("transform", `translate(${home + delta * s.q} 126)`);
        const eye = face["_" + side + "Base"];
        eye.setAttribute("rx", Math.max(0, 54 - 31 * s.q) / 2);
        eye.setAttribute("ry", Math.max(0.1, 58 - 20 * s.q) / 2);
        eye.setAttribute("opacity", "1");
        face["_" + side + "InputBase"].setAttribute("opacity", "0");
        face["_" + side + "Top"].setAttribute("y", "-126");
        face["_" + side + "Top"].setAttribute("height", "90");
        face["_" + side + "Bottom"].setAttribute("y", "36");
      }
      if (face._antennaDot) {
        face._antennaDot.setAttribute("cx", s.home.x + jitter * 0.6 * Math.sin(phase * 11 - 0.5));
        face._antennaDot.setAttribute("cy", s.home.y + (1 - scale + jelly) * 78 - s.v * 0.5);
      }
      return !s.held && (reduced || s.releaseAge > 0.35 && Math.abs(s.q) < 15e-4 && Math.abs(s.v) < 0.018);
    }
    function drawAntennaDrag(face, s, dt, reduced) {
      const settle = clamp((s.releaseAge - 0.45) / 0.35, 0, 1);
      if (reduced) {
        s.x = s.held ? s.tx : 0;
        s.y = s.held ? s.ty : 0;
        s.hx = s.x * 0.45;
        s.hy = s.y * 0.45;
      } else for (let remaining = dt; remaining > 0; ) {
        const h = Math.min(1 / 240, remaining);
        remaining -= h;
        if (s.held) {
          const b = 1 - Math.exp(-45 * h);
          s.x += (s.tx - s.x) * b;
          s.y += (s.ty - s.y) * b;
          s.vx = s.vy = 0;
        } else {
          const d2 = 10 + 14 * settle;
          s.vx += (-460 * s.x - d2 * s.vx) * h;
          s.vy += (-460 * s.y - d2 * s.vy) * h;
          s.x += s.vx * h;
          s.y += s.vy * h;
        }
        const k = s.held ? 118 : 330, d = s.held ? 7.1 : 10 + 12 * settle;
        s.hvx += (k * ((s.held ? s.x * 0.45 : 0) - s.hx) - d * s.hvx) * h;
        s.hvy += (k * ((s.held ? s.y * 0.45 : 0) - s.hy) - d * s.hvy) * h;
        s.hx += s.hvx * h;
        s.hy += s.hvy * h;
      }
      const pullX = stiffPull(s.hx), pullY = stiffPull(s.hy), radius = (50 + Math.hypot(pullX, pullY) * 0.8) * 0.92;
      const points = face._baseHeadPoints.map((p) => {
        const w = Math.exp(-((p.x - s.home.x) ** 2 + (p.y - clamp(s.home.y, 20, 220)) ** 2) / (2 * radius * radius));
        return { x: p.x + pullX * w, y: p.y + pullY * w };
      });
      face._headShape.setAttribute("d", face._pointsToPath(points));
      face._headFollow.setAttribute("transform", "");
      face._headMotion.style.transform = `translate(${s.hx * 0.12}px,${s.hy * 0.12}px) rotate(${s.hx * 0.08}deg)`;
      const dot = face._antennaDot;
      if (dot) {
        const x = s.home.x + s.x, y = s.home.y + s.y, stretch = clamp(s.vy * 4e-4, -0.06, 0.06);
        dot.setAttribute("cx", x);
        dot.setAttribute("cy", y);
        dot.setAttribute("transform", `translate(${x} ${y}) scale(${1 + stretch} ${1 - stretch}) translate(${-x} ${-y})`);
      }
      return !s.held && (reduced || Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.hx), Math.abs(s.hy)) < 0.025 && Math.max(Math.abs(s.vx), Math.abs(s.vy), Math.abs(s.hvx), Math.abs(s.hvy)) < 0.06);
    }
    registerAvatarExtension({ name: "gestures", reset() {
      this._cancelGesture(this._runtimeResetNotify === false);
    }, draw(now) {
      var _a, _b;
      const s = this._gestureFx;
      if (!s) return;
      const dt = Math.min(0.034, Math.max(0, (now - s.last) / 1e3));
      s.last = now;
      s.age += dt;
      if (!s.held) s.releaseAge += dt;
      if (s.kind === "squeeze" && !s.committed) {
        if (s.age < SQUEEZE_HOLD_SECONDS) return;
        if (!commit(this, s)) return;
      }
      const done = s.kind === "squeeze" ? drawSqueeze(this, s, dt, (_a = this._isReducedMotion) == null ? void 0 : _a.call(this)) : drawAntennaDrag(this, s, dt, (_b = this._isReducedMotion) == null ? void 0 : _b.call(this));
      if (done) finish(this, s);
    } });
  });
  __define("src/boopface-new-expressions.js", function(__require2, __import2, exports) {
    const { registerAvatarExtension } = __require2("src/boopface-extension-host.js");
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const outQuint = (t) => 1 - Math.pow(1 - t, 5);
    const bell = (t, a, b) => t <= a || t >= b ? 0 : Math.sin(Math.PI * (t - a) / (b - a));
    const env = (t, i = 0.12, o = 0.2) => clamp(Math.min(t / i, (1 - t) / o), 0, 1);
    const IDLE = { w: 54, h: 58, rx: 27, topY: -36, bottomY: 36, topAL: 0, topAR: 0, bottomAL: 0, bottomAR: 0, scale: 1 };
    const OFFICIAL = {
      happy: { ...IDLE, w: 58, h: 58, rx: 29, bottomY: 0 },
      sleepy: { ...IDLE, w: 58, h: 56, rx: 28, topY: 0 },
      sleep: { ...IDLE, w: 58, h: 56, rx: 28, topY: 7, bottomY: 14 },
      surprise: { ...IDLE, w: 68, h: 68, rx: 34, topY: -40, bottomY: 40 },
      preSurprise: { ...IDLE, w: 34, h: 36, rx: 18 }
    };
    const P = {
      arc: OFFICIAL.happy,
      dot: OFFICIAL.preSurprise,
      small: OFFICIAL.preSurprise,
      wide: OFFICIAL.surprise,
      sleepy: OFFICIAL.sleepy,
      nearlyShut: OFFICIAL.sleep,
      smug: OFFICIAL.happy,
      squint: IDLE,
      // A touch smaller than normal: the brief gather before leaning in (much
      // milder than surprise's small round eye).
      gather: { ...IDLE, w: 48, h: 52, rx: 24 },
      // The normal eye, a little flatter (thinking, to tell it from bored).
      think: { ...IDLE, h: 50 }
    };
    const WINK_MS = 2200, WINK_PEAK = 0.38 * WINK_MS;
    const WINK_SHUT = WINK_PEAK * 0.72 + 18, WINK_CLOSE = 200, WINK_HOLD = 250, WINK_OPEN = 180;
    const winkLid = (ms) => ms < WINK_SHUT - WINK_CLOSE ? 0 : ms < WINK_SHUT ? ease((ms - WINK_SHUT + WINK_CLOSE) / WINK_CLOSE) : ms < WINK_SHUT + WINK_HOLD ? 1 : ms < WINK_SHUT + WINK_HOLD + WINK_OPEN ? 1 - ease((ms - WINK_SHUT - WINK_HOLD) / WINK_OPEN) : 0;
    const MORPHW = { formMs: 420, stepMs: 1200, steps: 4, circleR: 39, squareA: 38.5, squareN: 4.2, bigR: 51, y: 120, fromR: 46.5 };
    MORPHW.spin = MORPHW.formMs + 120;
    MORPHW.unform = MORPHW.spin + MORPHW.steps * MORPHW.stepMs + 160 + MORPHW.formMs;
    MORPHW.total = MORPHW.unform + 120;
    function superellipse(a, n) {
      let d = "";
      for (let i = 0; i < 72; i++) {
        const t = i / 72 * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
        const x = a * Math.sign(c) * Math.abs(c) ** (2 / n), y = a * Math.sign(s) * Math.abs(s) ** (2 / n);
        d += (i ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2);
      }
      return d + "Z";
    }
    const BOUNCE = { period: 700, height: 30, contact: 80, total: 4400 };
    function bounceBall(ms) {
      const c = BOUNCE.contact, T = BOUNCE.period, m = ms % T;
      if (m < c) return { h: 0, v: 0, contact: Math.sin(Math.PI * m / c) };
      const u = (m - c) / (T - c);
      return { h: 4 * u * (1 - u), v: Math.abs(1 - 2 * u), contact: 0 };
    }
    const smugAt = (h) => {
      const u = clamp((h - 0.45) / 0.4, 0, 1);
      return u * u * (3 - 2 * u);
    };
    function bouncePost(stretchK, squashK) {
      return (f, t, ms, fade = 1) => {
        var _a;
        const k = env(t, 0.06, 0.12) * fade, { h, v, contact } = bounceBall(ms);
        const stretch = stretchK * v * (1 - contact), squash = squashK * contact;
        for (const side of ["left", "right"]) {
          const sy = 1 + (stretch - squash) * k, sx = 1 + (squash * 0.6 - stretch * 0.5) * k;
          const ry = +(((_a = f.shadowRoot.getElementById(side + "Base")) == null ? void 0 : _a.getAttribute("ry")) || 29);
          shiftEye(f, side, 0, (BOUNCE.height * (0.5 - h) + ry * (1 - sy)) * k);
          widenEye(f, side, sx);
          squashEye(f, side, sy);
        }
      };
    }
    const SMUG_HOPS_MS = 2 * BOUNCE.period + BOUNCE.contact + 420;
    const smugHop = (ms) => ms < 2 * BOUNCE.period + BOUNCE.contact ? ms : 2 * BOUNCE.period;
    const smugPost = bouncePost(0.07, 0.14);
    function bounceDip(ms) {
      const tc = ms % BOUNCE.period;
      return Math.exp(-tc / 140) * Math.cos(2 * Math.PI * tc / 330) * Math.min(1, tc / 40);
    }
    const LEAN = { gather: 200, zoomIn: 520, firstGlance: 1e3, move: 75, hold: 185, pause: 600, holdUp: 500, holdDown: 400, back: 110, linger: 300, zoomOut: 550, antennaDrop: 5 };
    const LEAN_KEYS = (() => {
      const L = LEAN, k = [[0, 0, 0], [L.firstGlance, 0, 0]];
      let t = L.firstGlance;
      const go = (x, y, hold) => {
        t += L.move;
        k.push([t, x, y]);
        t += hold;
        k.push([t, x, y]);
      };
      go(-0.14, 0, L.hold);
      go(0.14, 0, L.pause);
      go(0, -0.16, L.holdUp);
      go(0, 0.16, L.holdDown);
      t += L.back;
      k.push([t, 0, 0]);
      return k;
    })();
    const LEAN_OUT = LEAN_KEYS[LEAN_KEYS.length - 1][0] + LEAN.linger, LEAN_TOTAL = LEAN_OUT + LEAN.zoomOut;
    const leanZoom = (ms) => (ms < LEAN.gather ? -0.15 * ease(ms / LEAN.gather) : -0.15 + 1.15 * outQuint(clamp((ms - LEAN.gather) / LEAN.zoomIn, 0, 1))) * (1 - ease(clamp((ms - LEAN_OUT) / LEAN.zoomOut, 0, 1)));
    const leanGaze = (ms) => path(ms, LEAN_KEYS.concat([[LEAN_TOTAL, 0, 0]]));
    const NEW_FX = {
      // A bow: one deep nod, a pause at the bottom, then back up.
      // A bow: one deep nod, a pause at the bottom, then back up. The eyes go
      // down with it, at least as low as affirm's, and flatten a little.
      // Like failure: the head sinks slowly (flat: moves down without squashing;
      // 3D: tips forward and sinks a little too).
      nod: {
        zh: "鞠躬",
        ms: 2100,
        eyes: [[0, IDLE, 200]],
        motion: (t, ms, flat) => {
          const d = bow(t);
          return flat ? { y: 11 * d, keepShape: true } : { pitch: -24 * d, y: 7 * d };
        },
        post: (f, t, ms, fade = 1) => {
          const d = bow(t) * fade;
          shiftEye(f, "left", 0, 30 * d);
          shiftEye(f, "right", 0, 30 * d);
          squashEye(f, "left", 1 - 0.2 * d);
          squashEye(f, "right", 1 - 0.2 * d);
        }
      },
      // The eyes lead: they swing to the side a beat before the head follows,
      // wide, like a person looking away while shaking their head. Slightly
      // narrowed eyes read as "no".
      // Flat face: the head stays still; the eyes slide and change width the way
      // the 3D eyes do (measured on the 3D card: the eye on the side it turns to
      // about 17% narrower, the other about 7% wider, heights unchanged).
      shake: {
        zh: "摇头",
        ms: 1400,
        flatTurn: { shift: 0.67, near: 0.0106, far: 44e-4, widthOnly: true },
        eyes: [[0, P.squint, 180], [0.85, IDLE, 300]],
        motion: (t, ms, flat) => {
          const ph = 2 * Math.PI * 2.5 * t, fade = (1 - t * 0.85) * env(t, 0.1, 0.08);
          return { yaw: 16 * Math.sin(ph) * fade, gx: flat ? 0 : 0.85 * Math.sin(ph + 0.55) * fade, headStill: true };
        }
      },
      // Leans in with wide eyes, set a little further apart than surprise. The
      // head grows only as much as surprise does at its biggest, and
      // the antenna drops a little, like a wide lens close up. Once close the head
      // holds still; the eyes glance left, right (pause), up (pause), down, home.
      // Timings in LEAN (ms); LEAN.pause is the stop on the right.
      // On the way out the eyes shrink with the head: same start, length and easing.
      lean: {
        zh: "观察",
        ms: LEAN_TOTAL,
        eyes: [[0, P.gather, 170], [LEAN.gather / LEAN_TOTAL, P.wide, 300], [LEAN_OUT / LEAN_TOTAL, IDLE, LEAN.zoomOut, ease]],
        // Grows as much as surprise does at its biggest on each card (measured:
        // flat 107%, 3D 105%).
        motion: (t, ms, flat) => {
          const k = leanZoom(ms), [gx, gy] = leanGaze(ms), z = flat ? 0.07 : 0.035;
          return { sx: 1 + z * k, sy: 1 + z * k, y: 2 * k, pitch: -4 * k, gx, gy };
        },
        post: (f, t, ms, fade = 1) => {
          const k = Math.max(0, leanZoom(ms)) * fade;
          shiftEye(f, "left", -3 * k, 0);
          shiftEye(f, "right", 3 * k, 0);
          const dot = f._antennaDot, sp = f._antennaSpring;
          if (dot && sp) dot.setAttribute("cy", (sp.y + LEAN.antennaDrop * k).toFixed(2));
        }
      },
      // Bored's eyes and look-around, except the move to the right is slow and
      // it comes straight back without stopping: up-left (quick, like bored),
      // hold, drift slowly up-right, drift slowly back, home. Eyes as high as bored's.
      think: {
        zh: "思考",
        ms: 4900,
        flatTurn: { shift: 0.45, near: 3e-3, far: 2e-3, widthOnly: true },
        eyes: [[0, IDLE, 200]],
        motion: (t, ms) => {
          const [gx, gy] = thinkPath(ms);
          return { gx, gy, yaw: 9 * gx, pitch: 6 * -gy, roll: 2 * gx };
        },
        post: (f, t, ms, fade = 1) => {
          const up = -thinkPath(ms)[1] / 0.7 * fade;
          shiftEye(f, "left", 0, -6.5 * up);
          shiftEye(f, "right", 0, -6.5 * up);
        }
      },
      // Bored, looking down: the head and eyes go straight down (eyes narrowed to
      // inspect's slit, 16 units), pause; glance left, pause; right, pause; back
      // to the middle, pause; then everything comes back up.
      lookDown: {
        zh: "沉思",
        ms: 4400,
        flatTurn: { shift: 0.45, near: 3e-3, far: 2e-3, widthOnly: true },
        eyes: [[0, IDLE, 200]],
        motion: (t, ms, flat) => {
          const d = downK(ms), [gx] = path(ms, DOWN_KEYS);
          return flat ? { y: 7 * d, keepShape: true, gx, gy: 1.15 * d } : { pitch: -14 * d, y: 4 * d, gx, gy: 1.15 * d, yaw: 6 * gx };
        },
        post: (f, t, ms, fade = 1) => {
          const d = downK(ms) * fade;
          if (d > 0) {
            squintEye(f, "left", d, 8);
            squintEye(f, "right", d, 8);
          }
        }
      },
      // Same windmill steps, one shape: the eyes merge into one circle in the
      // middle; every quarter turn it changes between a circle and a rounded
      // square (the head's own two outlines), then splits back into two eyes.
      // The eye ellipse is drawn large and clipped to the shape (data-shape, read
      // by roundeyes.js on the flat and 3D faces).
      morph: {
        zh: "方圆等待",
        ms: MORPHW.total,
        // From the voice kit's listening circle (opts.fromCenter) it starts already
        // merged: the circle shrinks from the kit's size to its own.
        post: (f, t, ms, fade = 1, opts = {}) => {
          const r = f.shadowRoot, W = MORPHW, fc = !!opts.fromCenter;
          const form = (ms < W.formMs ? fc ? 1 : ease(ms / W.formMs) : ms < W.unform - W.formMs ? 1 : ms < W.unform ? 1 - ease((ms - W.unform + W.formMs) / W.formMs) : 0) * fade;
          const circleR = fc && ms < W.formMs ? W.fromR + (W.circleR - W.fromR) * ease(ms / W.formMs) : W.circleR;
          const sm = clamp(ms - W.spin, 0, W.steps * W.stepMs), step = Math.min(W.steps - 1, Math.floor(sm / W.stepMs)), u = ms < W.spin ? 0 : ease(clamp((sm - step * W.stepMs) / W.stepMs, 0, 1));
          const from = step % 2 ? 1 : 0, to = 1 - from, sq = from + (to - from) * u;
          const angle = ms < W.spin ? 0 : 180 * u * fade;
          const shape = superellipse(circleR + (W.squareA - circleR) * sq, 2 + (W.squareN - 2) * sq);
          for (const side of ["left", "right"]) {
            const g = r.getElementById(side + "Eye"), base = r.getElementById(side + "Base"), top = r.getElementById(side + "Top"), bottom = r.getElementById(side + "Bottom");
            if (!g || !base) continue;
            if (form <= 0) {
              base.removeAttribute("data-shape");
              continue;
            }
            const m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(g.getAttribute("transform") || "");
            if (!m) continue;
            const x = +m[1] + (120 - +m[1]) * form, y = +m[2] + (W.y - +m[2]) * form;
            const rx0 = +base.getAttribute("rx"), ry0 = +base.getAttribute("ry"), rad = W.bigR;
            g.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${angle.toFixed(2)})`);
            base.setAttribute("cy", "0");
            base.setAttribute("rx", (rx0 + (rad - rx0) * form).toFixed(2));
            base.setAttribute("ry", (ry0 + (rad - ry0) * form).toFixed(2));
            base.setAttribute("data-shape", shape);
            const edge = Math.max(36, rad + 6);
            if (top) {
              top.setAttribute("y", (-edge - 90).toFixed(2));
              top.setAttribute("transform", `rotate(0 0 ${(-edge).toFixed(2)})`);
            }
            if (bottom) {
              bottom.setAttribute("y", edge.toFixed(2));
              bottom.setAttribute("transform", `rotate(0 0 ${edge.toFixed(2)})`);
            }
          }
        },
        cleanup: (f) => {
          var _a;
          for (const side of ["left", "right"]) (_a = f.shadowRoot.getElementById(side + "Base")) == null ? void 0 : _a.removeAttribute("data-shape");
        }
      },
      // A ball bouncing, both eyes together: stretched while falling and rising,
      // squashed on landing; the head takes each landing with a springy dip.
      bounce: {
        zh: "弹跳",
        ms: BOUNCE.total,
        eyes: [[0, IDLE, 200]],
        // The head rises a little with each hop and takes the landing with a dip.
        motion: (t, ms) => {
          const k = env(t, 0.06, 0.12), d = bounceDip(ms), { h } = bounceBall(ms);
          return { y: (5 * d - 4 * (h - 0.5)) * k, sx: 1 + 0.02 * d * k, sy: 1 - 0.025 * d * k, keepShape: true };
        },
        // Stretch 11% while falling, squash 19% on landing (得意弹跳 keeps 7% / 14%).
        post: bouncePost(0.11, 0.19)
      },
      // 弹跳 + 得意: the bounce with happy (smiling) eyes the whole time, no eye
      // change; on each hop up the head tilts, left on the first, right on the
      // next, and so on.
      smugBounce: {
        zh: "得意弹跳",
        ms: SMUG_HOPS_MS,
        eyes: [[0, P.smug, 260], [(SMUG_HOPS_MS - 360) / SMUG_HOPS_MS, IDLE, 320]],
        motion: (t, ms) => {
          const k = env(t, 0.06, 0.12), m = smugHop(ms), d = bounceDip(ms), { h } = bounceBall(m), side = Math.floor(m / BOUNCE.period) % 2 ? 1 : -1;
          return { y: (5 * d - 4 * (h - 0.5)) * k, sx: 1 + 0.02 * d * k, sy: 1 - 0.025 * d * k, keepShape: true, roll: 7 * side * h * k };
        },
        post: (f, t, ms, fade = 1) => smugPost(f, t, smugHop(ms), fade)
      },
      // Normal-size eyes circling in opposite directions (they cross in the
      // middle); as they go round, one grows while the other shrinks.
      dizzy: {
        zh: "眩晕",
        ms: 3e3,
        eyes: [[0, IDLE, 240]],
        motion: (t, ms) => {
          const k = env(t, 0.1, 0.18), a = ms / 200;
          return { x: 2.4 * Math.cos(a) * k, y: 2.4 * Math.sin(a) * k, roll: 5 * Math.sin(a) * k };
        },
        post: (f, t, ms, fade = 1) => {
          const k = env(t, 0.1, 0.18) * fade, a = ms / 190, r = 8.5 * k, s = 0.12 * k * Math.sin(a);
          const b = a + Math.PI / 2;
          shiftEye(f, "left", Math.cos(a) * r, Math.sin(a) * r * 1.6);
          shiftEye(f, "right", Math.cos(-b + Math.PI) * r, Math.sin(-b + Math.PI) * r * 1.6);
          scaleEye(f, "left", 1 + s);
          scaleEye(f, "right", 1 - s);
        }
      },
      // The head tilts (the old 歪头 move, for depth); at the top of the tilt the
      // right eye narrows to a slit and opens again, a wink.
      // The eye starts closing during the tilt and is shut just as the tilt arrives.
      // No hold: tilt, wink, and straight back, settling with a little spring.
      wink: {
        zh: "挤眼",
        ms: WINK_MS,
        eyes: [[0, IDLE, 200]],
        motion: (t) => {
          const k = winkTilt(t);
          return { roll: 13 * k, yaw: 6 * k, gy: -0.25 * Math.max(0, k), gx: 0.15 * Math.max(0, k) };
        },
        // The blink keeps its own pace (not the head's), see winkLid.
        post: (f, t, ms, fade = 1) => pinchEye(f, "right", winkLid(ms) * fade),
        cleanup: (f) => pinchEye(f, "right", 0)
      },
      // Starts from normal eyes and pose. While it looks up to the left, chin
      // rising, the eyes narrow into the smug shape; then up to the right with the
      // head turning right, back to the left, and home. Eyes as high as thinking.
      smug: {
        zh: "得意",
        ms: 4800,
        flatTurn: { shift: 0.45, near: 3e-3, far: 2e-3, widthOnly: true },
        eyes: [[0.04, P.smug, 1e3], [0.86, IDLE, 360]],
        motion: (t) => {
          const k = ease(clamp((t - 0.04) / 0.24, 0, 1)) * (1 - ease(clamp((t - 0.84) / 0.12, 0, 1)));
          const [gx, gy] = path(t, [[0, 0, 0], [0.04, 0, 0], [0.28, -0.4, -1], [0.38, -0.4, -1], [0.56, 0.4, -1], [0.64, 0.4, -1], [0.78, -0.4, -1], [0.84, -0.4, -1], [0.96, 0, 0], [1, 0, 0]]);
          return { pitch: 9 * k, roll: 5 * k * -gx / 0.4, y: -2 * k, gx, gy, yaw: 8 * gx / 0.4 * k };
        }
      }
    };
    const WINK_ANTI = 0.12, WINK_ANTI_K = 9 / 13;
    const sineInOut = (u) => (1 - Math.cos(Math.PI * u)) / 2;
    const winkTilt = (t) => {
      if (t < WINK_ANTI) return -WINK_ANTI_K * sineInOut(t / WINK_ANTI);
      if (t < 0.38) return -WINK_ANTI_K + (1 + WINK_ANTI_K) * ease((t - WINK_ANTI) / (0.38 - WINK_ANTI));
      const u = (t - 0.38) / 0.62;
      return Math.exp(-4 * u) * Math.cos(u * 2.6 * Math.PI) * (1 - u);
    };
    const DOWN_KEYS = [[0, 0, 0], [1e3, 0, 0], [1200, -0.75, 0], [2e3, -0.75, 0], [2250, 0.75, 0], [3050, 0.75, 0], [3250, 0, 0], [4400, 0, 0]];
    const downK = (ms) => ease(clamp(ms / 450, 0, 1)) * (1 - ease(clamp((ms - 3850) / 500, 0, 1)));
    const bow = (t) => t < 0.38 ? ease(t / 0.38) : t < 0.52 ? 1 : 1 - ease(clamp((t - 0.52) / 0.36, 0, 1));
    const thinkPath = (ms) => path(ms, [[0, 0, 0], [320, -0.75, -0.7], [1500, -0.75, -0.7], [2950, 0.75, -0.7], [4400, -0.75, -0.7], [4900, 0, 0]]);
    function squashEye(f, side, s) {
      const b = f.shadowRoot.getElementById(side + "Base");
      if (b) b.setAttribute("ry", (+b.getAttribute("ry") * s).toFixed(2));
    }
    function flatTurn(f, yaw, { shift = 0.45, near: kn = 0.012, far: kf = 7e-3, widthOnly = false } = {}) {
      if (!yaw) return;
      const dx = yaw * shift;
      shiftEye(f, "left", dx, 0);
      shiftEye(f, "right", dx, 0);
      const a = Math.abs(yaw), near = yaw > 0 ? "right" : "left", far = yaw > 0 ? "left" : "right";
      const size = widthOnly ? widenEye : scaleEye;
      size(f, near, 1 - a * kn);
      size(f, far, 1 + a * kf);
    }
    function path(t, keys) {
      for (let i = 1; i < keys.length; i++) {
        const [t1, x1, y1] = keys[i];
        if (t <= t1) {
          const [t0, x0, y0] = keys[i - 1], u = ease(clamp((t - t0) / (t1 - t0 || 1), 0, 1));
          return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u];
        }
      }
      const last = keys[keys.length - 1];
      return [last[1], last[2]];
    }
    function widenEye(f, side, s) {
      const b = f.shadowRoot.getElementById(side + "Base");
      if (b) b.setAttribute("rx", (+b.getAttribute("rx") * s).toFixed(2));
    }
    function scaleEye(f, side, s) {
      const b = f.shadowRoot.getElementById(side + "Base");
      if (!b) return;
      b.setAttribute("rx", (+b.getAttribute("rx") * s).toFixed(2));
      b.setAttribute("ry", (+b.getAttribute("ry") * s).toFixed(2));
    }
    function squintEye(f, side, k, gap = 3.2) {
      const r = f.shadowRoot, top = r.getElementById(side + "Top"), bottom = r.getElementById(side + "Bottom"), b = r.getElementById(side + "Base");
      if (!top || !bottom || !b) return;
      const cy = +b.getAttribute("cy") || 0;
      const tY = -36 + (cy - gap - -36) * k, bY = 36 + (cy + gap - 36) * k;
      top.setAttribute("y", (tY - 90).toFixed(2));
      top.setAttribute("height", "90");
      top.setAttribute("transform", `rotate(0 0 ${tY.toFixed(2)})`);
      bottom.setAttribute("y", bY.toFixed(2));
      bottom.setAttribute("height", "90");
      bottom.setAttribute("transform", `rotate(0 0 ${bY.toFixed(2)})`);
    }
    const WINK_LINE = 9;
    function pinchEye(f, side, k) {
      const b = f.shadowRoot.getElementById(side + "Base");
      if (!b) return;
      if (!(k > 0)) {
        if (b.dataset.pinch) {
          b.removeAttribute("data-shape");
          delete b.dataset.pinch;
        }
        return;
      }
      const cy = +b.getAttribute("cy") || 0, a = +b.getAttribute("rx") || 27, ry = +b.getAttribute("ry") || 29;
      const h = ry + (WINK_LINE / 2 - ry) * k, cx = a + (h - a) * k;
      const n = (v) => v.toFixed(2), x0 = -a, x1 = a, y0 = cy - h, y1 = cy + h;
      b.setAttribute("data-shape", `M${n(x0 + cx)} ${n(y0)}H${n(x1 - cx)}A${n(cx)} ${n(h)} 0 0 1 ${n(x1)} ${n(cy)}A${n(cx)} ${n(h)} 0 0 1 ${n(x1 - cx)} ${n(y1)}H${n(x0 + cx)}A${n(cx)} ${n(h)} 0 0 1 ${n(x0)} ${n(cy)}A${n(cx)} ${n(h)} 0 0 1 ${n(x0 + cx)} ${n(y0)}Z`);
      b.dataset.pinch = "1";
    }
    function lidDown(f, side, amount) {
      if (amount <= 0) return;
      const r = f.shadowRoot, top = r.getElementById(side + "Top");
      if (!top) return;
      const y = +top.getAttribute("y") + 90 + amount;
      top.setAttribute("y", (y - 90).toFixed(2));
      top.setAttribute("transform", `rotate(0 0 ${y.toFixed(2)})`);
    }
    function squeezeEye(f, side, k) {
      if (k <= 0) return;
      const b = f.shadowRoot.getElementById(side + "Base");
      if (!b) return;
      const ry = +b.getAttribute("ry");
      b.setAttribute("ry", Math.max(1.3, ry * (1 - k)).toFixed(2));
    }
    function shiftEye(f, side, dx, dy) {
      const g = f.shadowRoot.getElementById(side + "Eye"), m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec((g == null ? void 0 : g.getAttribute("transform")) || "");
      if (!m) return;
      if (!dx && !dy) return;
      g.setAttribute("transform", g.getAttribute("transform").replace(m[0], `translate(${(+m[1] + dx).toFixed(2)} ${(+m[2] + dy).toFixed(2)})`));
    }
    function endOfficialAction(f) {
      var _a, _b;
      const prevNotify = f._runtimeResetNotify;
      f._runtimeResetNotify = false;
      try {
        (_a = f._resetExtensionEffects) == null ? void 0 : _a.call(f);
      } finally {
        f._runtimeResetNotify = prevNotify;
      }
      f._inputWanted = false;
      f._sleeping = false;
      f._boredRoutine = null;
      f._boredLookSpeed = null;
      ++f._transitionToken;
      (_b = f._cancelPendingWaits) == null ? void 0 : _b.call(f);
    }
    const SETTLE_MS = 180 + 240, RELEASE_MS = 220;
    const scaled = (m, k) => ({
      ...m,
      x: (m.x || 0) * k,
      y: (m.y || 0) * k,
      roll: (m.roll || 0) * k,
      yaw: (m.yaw || 0) * k,
      pitch: (m.pitch || 0) * k,
      gx: (m.gx || 0) * k,
      gy: (m.gy || 0) * k,
      sx: 1 + ((m.sx ?? 1) - 1) * k,
      sy: 1 + ((m.sy ?? 1) - 1) * k
    });
    function createPlayer(face) {
      const flat = face, brains = () => [], busy = () => false;
      let cur = null;
      let rel = null;
      const last = /* @__PURE__ */ new Map();
      const faces = () => [flat, ...brains()];
      const is3d = (f) => !!f._view3d;
      function motionNow(f, now) {
        var _a, _b;
        if (cur && now >= cur.start) {
          const ms = now - cur.start, t = clamp(ms / cur.def.ms, 0, 1);
          return ((_b = (_a = cur.def).motion) == null ? void 0 : _b.call(_a, t, ms, !is3d(f))) || {};
        }
        if (rel) {
          const u = clamp((now - rel.start) / RELEASE_MS, 0, 1);
          if (u < 1 && rel.from.has(f)) return scaled(rel.from.get(f), 1 - ease(u));
        }
        return null;
      }
      function afterDraw(f, now) {
        var _a, _b, _c, _d, _e, _f;
        {
          const m = motionNow(f, now);
          if (!m) return;
          if (!is3d(f)) flatTurn(f, m.yaw || 0, (_b = (_a = cur || rel) == null ? void 0 : _a.def) == null ? void 0 : _b.flatTurn);
          if (m.gx || m.gy) {
            shiftEye(f, "left", (m.gx || 0) * 20, (m.gy || 0) * 14);
            shiftEye(f, "right", (m.gx || 0) * 20, (m.gy || 0) * 14);
          }
          if (cur && now >= cur.start) {
            const ms = now - cur.start;
            (_d = (_c = cur.def).post) == null ? void 0 : _d.call(_c, f, clamp(ms / cur.def.ms, 0, 1), ms, 1, cur.opts);
          } else if (rel) {
            const u = clamp((now - rel.start) / RELEASE_MS, 0, 1);
            if (u < 1) (_f = (_e = rel.def).post) == null ? void 0 : _f.call(_e, f, rel.t, rel.ms, 1 - ease(u), rel.opts);
          }
        }
      }
      function headTransform(m, flatFace) {
        let { x = 0, y = 0, roll = 0, sx = 1, sy = 1 } = m;
        if (flatFace && !m.keepShape && !m.headStill) {
          const yaw = m.yaw || 0, pitch = m.pitch || 0;
          x += yaw * 0.22;
          y += -pitch * 0.22;
          if (!m.keepSize) {
            sx *= 1 - Math.abs(yaw) * 35e-4;
            sy *= 1 - Math.abs(pitch) * 35e-4;
          }
        }
        return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${roll.toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      }
      function play(name, opts = {}) {
        var _a, _b;
        const def = NEW_FX[name];
        if (!def) return;
        const now = performance.now();
        const wasBusy = !!cur || !!rel || busy() || faces().some((f) => f._state !== "idle" || f._voiceFx || f._voiceExit || f._headMotion.style.transform || f._boredRoutine || f._waitingFx || JSON.stringify(f._toPose) !== JSON.stringify(IDLE));
        if (cur) finish(true);
        for (const f of faces()) {
          (_a = f.noteActivity) == null ? void 0 : _a.call(f);
          const look = { ...f._look };
          endOfficialAction(f);
          Object.assign(f._look, look);
          f._eyeBob = f._eyeNod = f._angryEyeDrop = f._surpriseShake = null;
          if (f._eyeMicro) f._eyeMicro.lX = f._eyeMicro.lY = f._eyeMicro.rX = f._eyeMicro.rY = 0;
          if (f._wanderTarget) f._wanderTarget.x = f._wanderTarget.y = 0;
          f._expressionLock = true;
          f._headCenteringUntil = 0;
          if (f._state !== "idle") f.setState("idle", { duration: 140, notify: false, keepGazeLock: true });
          else if (JSON.stringify(f._toPose) !== JSON.stringify(IDLE)) f._startMorph(IDLE, 140, outQuint);
          f._nextBlinkAt = Infinity;
          const hm = f._headMotion;
          (_b = hm.getAnimations) == null ? void 0 : _b.call(hm).forEach((a) => a.cancel());
          hm.style.transformBox = "view-box";
          hm.style.transformOrigin = "120px 128px";
        }
        if (opts.fromCenter) for (const f of faces()) {
          f._voiceExit = null;
          f._voiceShown = null;
        }
        let done;
        const finished = new Promise((r) => {
          done = r;
        });
        cur = { name, def, opts, start: now + (wasBusy && !opts.direct ? SETTLE_MS : 0), stage: 0, done };
        return finished;
      }
      function finish(quick) {
        var _a, _b, _c, _d, _e;
        const was = cur;
        cur = null;
        if (!was) return;
        (_a = was.done) == null ? void 0 : _a.call(was);
        const now = performance.now();
        const released = quick && now >= was.start;
        if (released) {
          const ms = now - was.start;
          rel = { from: new Map(last), start: now, def: was.def, opts: was.opts, ms, t: clamp(ms / was.def.ms, 0, 1) };
        }
        if (!released) for (const f of faces()) (_c = (_b = was.def).cleanup) == null ? void 0 : _c.call(_b, f);
        for (const f of faces()) {
          if (!released) f._headMotion.style.transform = "";
          f._nextBlinkAt = performance.now() + 700 + Math.random() * 1500;
          const away = JSON.stringify(f._toPose) !== JSON.stringify(IDLE);
          if (quick) {
            if (f._state !== "idle") f.setState("idle", { duration: 220, notify: false, keepGazeLock: true });
            else if (away) f._startMorph(IDLE, 220, outQuint);
            f._expressionLock = false;
            continue;
          }
          if (away) (_d = f._returnToIdle) == null ? void 0 : _d.call(f, 300);
          else (_e = f._releaseExpressionLock) == null ? void 0 : _e.call(f);
        }
      }
      let raf = 0;
      const wake = () => {
        if (!raf) raf = requestAnimationFrame(tick);
      };
      function tick(now) {
        var _a, _b, _c;
        raf = 0;
        if (cur || rel) raf = requestAnimationFrame(tick);
        if (rel && now - rel.start >= RELEASE_MS) {
          for (const f of faces()) (_b = (_a = rel.def).cleanup) == null ? void 0 : _b.call(_a, f);
          rel = null;
          if (!cur || now < cur.start) for (const f of faces()) f._headMotion.style.transform = "";
        }
        if (!cur && !rel) return;
        if (cur && now >= cur.start) {
          const ms = now - cur.start, t = clamp(ms / cur.def.ms, 0, 1);
          const stages = cur.def.eyes || [];
          while (cur.stage < stages.length && t >= stages[cur.stage][0]) {
            const [, pose, d, curve = outQuint] = stages[cur.stage++];
            for (const f of faces()) {
              if (pose.state) {
                f.setState(pose.state, { duration: d, notify: false, keepGazeLock: true });
                if (pose.pose) f._startMorph(pose.pose, d, curve);
              } else f._startMorph(pose, d, curve);
            }
          }
        }
        for (const f of faces()) {
          const m = motionNow(f, now);
          if (m) {
            if (cur && now >= cur.start) last.set(f, m);
            f._headMotion.style.transform = headTransform(m, !is3d(f));
          }
          (_c = f._resumeFrames) == null ? void 0 : _c.call(f);
        }
        if (cur && now >= cur.start && now - cur.start >= cur.def.ms) finish(false);
      }
      return {
        afterDraw,
        play: (name, opts) => {
          const p = play(name, opts);
          wake();
          return p;
        },
        stop: (gentle = false) => {
          finish(!gentle);
          wake();
        },
        get active() {
          return (cur == null ? void 0 : cur.name) || null;
        },
        // The 3D faces' turn while an expression runs (or eases out), blended
        // over the pointer pose.
        pose3d(pose) {
          var _a, _b;
          const now = performance.now(), f = flat;
          let m = null, w = 0;
          if (cur && now >= cur.start) {
            const ms = now - cur.start, t = clamp(ms / cur.def.ms, 0, 1);
            m = ((_b = (_a = cur.def).motion) == null ? void 0 : _b.call(_a, t, ms)) || {};
            w = env(t, 0.1, 0.14);
          } else if (rel) {
            const u = clamp((now - rel.start) / RELEASE_MS, 0, 1), k = 1 - ease(u);
            const from = rel.from.get(f);
            if (from) {
              m = scaled(from, k);
              w = k;
            }
          }
          if (!m) return pose;
          return { yaw: pose.yaw * (1 - w) + (m.yaw || 0), pitch: pose.pitch * (1 - w) + (m.pitch || 0), gazeX: pose.gazeX * (1 - w), gazeY: pose.gazeY * (1 - w) };
        }
      };
    }
    const ACTIONS = {
      bow: "nod",
      shake: "shake",
      observe: "lean",
      think: "think",
      ponder: "lookDown",
      "shape-wait": "morph",
      bounce: "bounce",
      "smug-bounce": "smugBounce",
      dizzy: "dizzy",
      wink: "wink",
      smug: "smug"
    };
    const players = /* @__PURE__ */ new WeakMap();
    const playerOf = (f) => {
      let p = players.get(f);
      if (!p) players.set(f, p = createPlayer(f));
      return p;
    };
    const NAMES = new Set(Object.keys(ACTIONS));
    registerAvatarExtension({
      name: "new-expressions",
      actions: Object.fromEntries(Object.entries(ACTIONS).map(([action, key]) => [action, function() {
        return playerOf(this).play(key);
      }])),
      // Any other action ends ours first (eased back, never a jump).
      beforePlay(action) {
        var _a;
        if (!NAMES.has(action)) (_a = players.get(this)) == null ? void 0 : _a.stop();
      },
      reset() {
        var _a;
        (_a = players.get(this)) == null ? void 0 : _a.stop();
      },
      draw(now) {
        var _a;
        (_a = players.get(this)) == null ? void 0 : _a.afterDraw(this, now);
      }
    });
    function newExpressionPose(face, pose) {
      const p = players.get(face);
      return p ? p.pose3d(pose) : pose;
    }
    const NEW_EXPRESSIONS = Object.freeze(Object.keys(ACTIONS));
    exports.endOfficialAction = endOfficialAction;
    exports.newExpressionPose = newExpressionPose;
    exports.NEW_EXPRESSIONS = NEW_EXPRESSIONS;
  });
  __define("src/boopface-body-motion.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const bell = (t, a, b) => t <= a || t >= b ? 0 : Math.sin(Math.PI * (t - a) / (b - a));
    const env = (t, i = 0.12, o = 0.2) => clamp(Math.min(t / i, (1 - t) / o), 0, 1);
    const FOLLOW = { yaw: 14, pitch: 10, roll: 9 };
    const THINK_MOTION = {
      "think-bloom": { ms: 0, follow: false, motion: (t, ms) => {
        const a = ms / 1e3 * 2 * Math.PI / 3.2;
        return { pitch: 3 + 2 * Math.cos(a), yaw: 6 * Math.sin(a), roll: 1.5 * Math.sin(a) };
      } },
      // Each quarter turn of the cross nudges the head along with it, then it settles.
      "think-cross": { ms: 0, follow: false, motion: (t, ms) => {
        const u = ms % 850 / 850, sw = Math.sin(Math.PI * u);
        return { pitch: 3, yaw: 5 * sw, roll: 3 * sw, s: 1 + 0.015 * sw };
      } }
    };
    const REDO = {
      idle: { zh: "正常", ms: 650, motion: (t) => ({ pitch: -3 * bell(t, 0, 1) }) },
      bored: { zh: "发呆", ms: 0, motion: () => ({ y: 2 }) },
      // The official eyes orbit round a vertical axis like a turntable (two turns
      // per 3.2 s). The head turns a little with the spin, is flung wider (and
      // flatter) when the eyes swing out to the sides, as if by centrifugal pull,
      // and rises and sinks gently twice a turn.
      "waiting-spin": { zh: "等待 · 旋转", ms: 0, motion: (t, ms, b, now) => {
        const fx = b._waitingFx;
        if (!fx || fx.variant !== "default") return { pitch: 3 };
        const e = now - fx.start, ph = (fx.continuous ? e % fx.duration : Math.min(e, fx.duration)) / fx.duration, A = ph * Math.PI * 4;
        const k = Math.min(1, e / 300) * (fx.continuous ? 1 : Math.min(1, (fx.duration - Math.min(e, fx.duration)) / 300));
        return { pitch: 3 + 1.5 * Math.cos(2 * A) * k, yaw: 7 * Math.sin(A) * k, roll: 2 * Math.sin(A) * Math.cos(A) * k, y: 1.2 * Math.cos(2 * A) * k, sq: 0.035 * Math.cos(A) ** 2 * k };
      } },
      "waiting-wrap": { zh: "等待 · 环绕", ms: 0, motion: () => ({ pitch: 3 }) },
      "waiting-wave": { zh: "等待 · 波动", ms: 0, motion: () => ({ pitch: 3 }) },
      // Jelly, in time with the cursor: each time the official bars light up,
      // the swell reaches the head a moment later (as if passed through jelly):
      // a gentle rise to a small peak, a slight quiver, then it settles. No big
      // movement when input starts.
      input: { zh: "输入", ms: 0, motion: (t, ms, b, now) => {
        if (b._state !== "input") return { pitch: -2 };
        const d = now % 530 - 70;
        if (d <= 0) return { pitch: -2 };
        const swell = d / 110 * Math.exp(1 - d / 110);
        return { pitch: -2, jit: { s: 0.018 * swell, sq: 7e-3 * Math.exp(-d / 140) * Math.sin(2 * Math.PI * d / 150) } };
      } },
      affirm: { zh: "肯定", ms: 950, motion: (t) => ({ pitch: -11 * Math.sin(Math.PI * clamp(t * 2.1, 0, 2)) ** 2 * (t < 0.5 ? 1 : 0.65) }) },
      success: { zh: "成功", ms: 1100, motion: (t) => ({ y: -7 * bell(t, 0.08, 0.5), pitch: 7 * bell(t, 0, 0.8), roll: 4 * Math.sin(t * Math.PI * 3) * env(t, 0.1, 0.3), s: 1 + 0.03 * bell(t, 0.08, 0.5) }) },
      failure: { zh: "失败", ms: 1700, motion: (t) => {
        const k = ease(env(t, 0.3, 0.3));
        return { pitch: -10 * k, y: 4 * k };
      } },
      // The official wary eyes: the left one grows (near), the right one narrows
      // and drops (far), both moving right: the face turned to show one eye.
      // The head turns right to the full pointer-follow angle as the left eye grows.
      // The full turn is the pointer-follow maximum (pointer at the card's edge,
      // 18°, reached at the top of the spring's small overshoot); the eyes' own
      // sideways move is not added on top.
      wary: { zh: "警惕", ms: 0, follow: false, motion: (t, ms, b) => {
        const k = warnProximity(b);
        return { yaw: 16.5 * k, pitch: -2 * k, s: 1 + 0.06 * k, y: 1 * k };
      } },
      // leans in: the centre line grows, the near side most
      inspect: { zh: "审视", ms: 0, motion: () => ({ s: 1.06 }) },
      // Timed from the official eye drop: the head lowers with the eyes; once the
      // eyes have arrived it trembles, then puffs up hard for an instant and is
      // straight back ("about to explode").
      angry: { zh: "生气", ms: 0, motion: (t, ms, b, now, st) => {
        if (b._angryEyeDrop) st.drop ?? (st.drop = b._angryEyeDrop.start);
        if (st.drop == null) return {};
        const e = now - st.drop, down = clamp(e / 400, 0, 1) * (e < 1100 ? 1 : clamp(1 - (e - 1100) / 400, 0, 1));
        const tremble = clamp((e - 330) / 120, 0, 1) * (e < 720 ? 1 : 0);
        const pop = e < 720 ? 0 : e < 790 ? (e - 720) / 70 : e < 960 ? 1 - ease((e - 790) / 170) : 0;
        return { pitch: -8 * down, jit: { yaw: 2.6 * Math.sin(e / 21) * tremble, roll: 1.8 * Math.sin(e / 16) * tremble, s: 0.14 * pop } };
      } },
      // The official refusal sweeps the eyes side to side; the head follows them.
      refuse: { zh: "拒绝", ms: 1400, motion: () => ({}) },
      // Head up with the surprise, and a faint shiver while the official eyes
      // shake (in their time).
      surprise: { zh: "惊讶", ms: 0, motion: (t, ms, b, now) => {
        const up = b._state === "surprise" ? 1 : 0, sh = b._surpriseShake;
        if (!sh) return { pitch: 1.5 * up, y: -3 * up, s: 1 + 0.02 * up };
        const u = clamp((now - sh.start) / sh.duration, 0, 1), fade = 1 - 0.5 * u;
        const shiver = (1 - u) ** 2;
        return { pitch: 1.5, y: -3, s: 1.02, jit: { s: 0.01 * Math.sin(u * Math.PI * 4) * shiver, roll: 0.6 * Math.sin(u * Math.PI * 4) * shiver, yaw: 1 * Math.sin(u * Math.PI * 4 + 1) * shiver } };
      } },
      // Head down, then still: a sleeping avatar draws nothing (rests: the loop stops once settled).
      sleep: { zh: "睡着", ms: 0, rests: 1600, motion: (t, ms) => {
        const k = ease(clamp(ms / 1400, 0, 1));
        return { pitch: -10 * k, y: 4 * k };
      } },
      wake: { zh: "醒来", ms: 1500, motion: (t, ms) => {
        const up = ease(clamp(t / 0.45, 0, 1));
        return { pitch: -10 * (1 - up), y: 4 * (1 - up), yaw: 5 * Math.sin(ms / 85) * bell(t, 0.45, 0.75), s: 1 + 0.03 * bell(t, 0.4, 0.7) };
      } },
      // The head beats with the heart: it swells on each "lub-dub" of the official
      // heart and quivers a little while it does.
      love: { zh: "喜欢", ms: 0, motion: (t, ms, b, now) => {
        const S = heartScale(b), beat = clamp((S - 1) / 0.155, 0, 1);
        return { s: 1.03, pitch: 4, jit: { s: 0.05 * beat, roll: 1.2 * Math.sin(now / 28) * beat } };
      } },
      // Slot-machine eyes: while the reels roll the eyes downward, the head nods
      // down with them (like "affirm"), more the faster they roll. Each reel then
      // brakes, the left first: as a reel stops, the head dips on that side with
      // the stop's inertia, the right reel's stop dips the other side, then
      // everything springs back level.
      random: { zh: "随机", ms: 0, follow: false, brake: true, motion: (t, ms, b, now, st) => ({ pitch: -10 * clamp((st.reelSpeed || 0) / 0.5, 0, 1) }) }
    };
    function warnProximity(b) {
      var _a, _b;
      if (!b._warningFx) return 0;
      const m = /scale\(([\d.]+)/.exec(((_b = (_a = b.shadowRoot) == null ? void 0 : _a.getElementById("leftEye")) == null ? void 0 : _b.getAttribute("transform")) || "");
      return m ? clamp((+m[1] - 1) / 0.37, 0, 1) : 0;
    }
    function heartScale(b) {
      var _a, _b;
      if (!b._loveFx) return 1;
      const m = /scale\(([\d.]+)\)/.exec(((_b = (_a = b.shadowRoot) == null ? void 0 : _a.getElementById("leftEye")) == null ? void 0 : _b.getAttribute("transform")) || "");
      return m ? +m[1] : 1;
    }
    function createRedo({ flat, brains, hosts }) {
      let cur = null;
      const IN = 220, OUT = 380;
      const busy = (f) => {
        var _a, _b;
        return !!(f._voiceFx || f._expressionLock || f._state !== "idle" || f._sleeping || f._boredRoutine || f._waitingFx || f._inspectFx || f._loveFx || f._randomFx || f._failureFx || f._warningFx || f._systemErrorShake || ((_b = (_a = f._headMotion) == null ? void 0 : _a.getAnimations) == null ? void 0 : _b.call(_a).some((a) => a.playState === "running" || a.playState === "pending")));
      };
      const sample = (now) => {
        var _a, _b, _c, _d, _e, _f;
        if (!cur) return null;
        const ms = now - cur.start, b = brains()[0] || flat;
        let w2;
        if (cur.def.ms) {
          const t = ms / cur.def.ms;
          w2 = clamp(Math.min(ms / IN, (cur.def.ms - ms) / OUT + 1), 0, 1);
          if (t >= 1) {
            w2 = clamp(1 - (ms - cur.def.ms) / OUT, 0, 1);
          }
        } else {
          const on = busy(b) || !!((_a = cur.hold) == null ? void 0 : _a.call(cur));
          if (ms > 400 && !on) cur.idleSince ?? (cur.idleSince = now);
          else if (on) cur.idleSince = null;
          w2 = clamp(ms / IN, 0, 1) * (cur.idleSince ? clamp(1 - (now - cur.idleSince) / OUT, 0, 1) : 1);
        }
        if (ms > 300 && w2 <= 0) {
          cur = null;
          return null;
        }
        const pos = (id) => {
          var _a2, _b2;
          return /translate\(([-\d.]+)[ ,]+([-\d.]+)/.exec(((_b2 = (_a2 = b.shadowRoot) == null ? void 0 : _a2.getElementById(id)) == null ? void 0 : _b2.getAttribute("transform")) || "");
        };
        const l = pos("leftEye"), r = pos("rightEye");
        const ex = l && r ? (+l[1] - 86 + (+r[1] - 154)) / 2 : 0, ey = l && r ? (+l[2] - 126 + (+r[2] - 126)) / 2 : 0;
        const L = { x: clamp(ex / 40, -1, 1), y: clamp(ey / 30, -1, 1) };
        const m = { ...cur.def.motion(clamp(cur.def.ms ? ms / cur.def.ms : 0, 0, 1), ms, b, now, cur.st) };
        if (cur.def.follow !== false) {
          m.yaw = (m.yaw || 0) + FOLLOW.yaw * L.x;
          m.pitch = (m.pitch || 0) - FOLLOW.pitch * L.y;
          m.roll = (m.roll || 0) + FOLLOW.roll * L.x * L.y * 2;
        }
        if (cur.def.brake) {
          for (const [side, sign] of [["left", -1], ["right", 1]]) {
            const e = b.shadowRoot.getElementById(side + "Base"), cy = +((e == null ? void 0 : e.getAttribute("cy")) || 0), ry = +((e == null ? void 0 : e.getAttribute("ry")) || 29);
            const q = (_b = cur.st)[side] ?? (_b[side] = { cy, t: now, rolled: false, done: false });
            if (cy === q.cy) {
              if (now - q.t > 80) {
                q.v = 0;
                cur.st.reelSpeed = ((((_c = cur.st.left) == null ? void 0 : _c.v) || 0) + (((_d = cur.st.right) == null ? void 0 : _d.v) || 0)) / 2;
              }
              continue;
            }
            const speed = Math.abs(cy - q.cy) / Math.max(1, now - q.t);
            if (Math.abs(cy - q.cy) < 30) q.v = cy > q.cy ? speed : 0;
            cur.st.reelSpeed = ((((_e = cur.st.left) == null ? void 0 : _e.v) || 0) + (((_f = cur.st.right) == null ? void 0 : _f.v) || 0)) / 2;
            if (Math.abs(cy) > 30) q.rolled = true;
            if (q.rolled && !q.done && ry > 27 && q.cy < -0.5 && cy >= -0.5 && speed < 0.45) {
              brakeKick.push(sign);
              q.done = true;
            }
            q.cy = cy;
            q.t = now;
          }
        }
        return { w: w2, m };
      };
      const KEYS = ["yaw", "pitch", "roll", "x", "y", "s", "sq"], SPRING = { w: 10, z: 0.48 };
      const sp = Object.fromEntries(KEYS.map((k) => [k, { x: 0, v: 0 }]));
      let out = null, w = 0, last = performance.now();
      const brake = { x: 0, v: 0 }, brakeKick = [];
      let raf = 0;
      const wake = () => {
        if (!raf) {
          last = performance.now();
          raf = requestAnimationFrame(tick);
        }
      };
      function tick(now) {
        raf = 0;
        const dt = Math.min(0.05, (now - last) / 1e3);
        last = now;
        const s = sample(now);
        w = s ? s.w : 0;
        let moving = false;
        for (const k of KEYS) {
          const target = s ? (k === "s" ? (s.m.s || 1) - 1 : s.m[k] || 0) * s.w : 0, q = sp[k];
          q.v += (SPRING.w * SPRING.w * (target - q.x) - 2 * SPRING.z * SPRING.w * q.v) * dt;
          q.x += q.v * dt;
          if (Math.abs(q.x - target) > 0.01 || Math.abs(q.v) > 0.01) moving = true;
          else if (!s) {
            q.x = 0;
            q.v = 0;
          }
        }
        while (brakeKick.length) brake.v += brakeKick.shift() * 60;
        brake.v += (-144 * brake.x - 2 * 0.3 * 12 * brake.v) * dt;
        brake.x += brake.v * dt;
        const braking = Math.abs(brake.x) > 0.02 || Math.abs(brake.v) > 0.05;
        if (!braking && !s) brake.x = brake.v = 0;
        const jit = (s == null ? void 0 : s.m.jit) || {};
        out = s || moving || braking ? Object.fromEntries(KEYS.map((k) => [k, sp[k].x + (k === "s" ? jit.s || 0 : jit[k] || 0) * (s ? s.w : 0)])) : null;
        if (out) {
          out.roll += brake.x;
          out.pitch -= Math.abs(brake.x) * 0.5;
          out.y += Math.abs(brake.x) * 0.3;
        }
        for (const [el, isFlat] of hosts()) {
          if (!el) continue;
          if (!out) {
            if (el.style.transform) el.style.transform = "";
            continue;
          }
          const { yaw, pitch } = out;
          let x = out.x, y = out.y, sx = (1 + out.s) * (1 + out.sq), sy = (1 + out.s) / (1 + out.sq);
          if (isFlat) {
            x += yaw * 0.22;
            y += -pitch * 0.22;
            sx *= 1 - Math.abs(yaw) * 35e-4;
            sy *= 1 - Math.abs(pitch) * 35e-4;
          }
          const k = (flat.clientWidth || flat.getBoundingClientRect().width) / 240 || 1;
          el.style.transformOrigin = "50% 55%";
          el.style.transform = `translate(${(x * k).toFixed(2)}px,${(y * k).toFixed(2)}px) rotate(${out.roll.toFixed(2)}deg) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
        }
        const resting = (cur == null ? void 0 : cur.def.rests) && now - cur.start > cur.def.rests && !moving && !braking;
        if ((cur || out) && !resting) raf = requestAnimationFrame(tick);
      }
      return {
        stop() {
          cur = null;
          wake();
        },
        // Head motion only, for an action started elsewhere (the voice row's
        // thinking styles): a REDO entry or one of THINK_MOTION. hold() keeps it
        // going while something the brains do not show as busy still runs.
        follow(name, hold) {
          const def = REDO[name] || THINK_MOTION[name];
          if (def) {
            cur = { name, def, start: performance.now(), idleSince: null, st: {}, hold };
            wake();
          }
        },
        // Still running, or the head still settling on its spring.
        get active() {
          return !!(cur || out);
        },
        // The 3D turn for the 3D faces, blended over the pointer pose.
        pose3d(pose) {
          if (!out) return pose;
          return { yaw: pose.yaw * (1 - w) + out.yaw, pitch: pose.pitch * (1 - w) + out.pitch, gazeX: pose.gazeX * (1 - w), gazeY: pose.gazeY * (1 - w) };
        }
      };
    }
    const players = /* @__PURE__ */ new WeakMap();
    function playerOf(face) {
      let p = players.get(face);
      if (!p) {
        p = createRedo({ flat: face, brains: () => [], hosts: () => {
          var _a;
          return [[face._motionHost || ((_a = face.shadowRoot) == null ? void 0 : _a.querySelector("svg")), !face._view3d]];
        } });
        players.set(face, p);
      }
      return p;
    }
    const REDONE = new Set(Object.keys(REDO));
    const still = (face) => {
      var _a;
      const m = String(face.getAttribute("motion") || "auto").trim().toLowerCase();
      if (m === "reduce") return true;
      if (m === "full") return false;
      return typeof window !== "undefined" && ((_a = window.matchMedia) == null ? void 0 : _a.call(window, "(prefers-reduced-motion: reduce)").matches) === true;
    };
    const RENAMED = { warning: "wary", send: "affirm", error: "refuse", waiting: "waiting-spin" };
    registerAvatarExtension({
      name: "body-motion",
      afterPlay(raw) {
        var _a;
        const action = RENAMED[raw] || raw;
        if (REDONE.has(action) && !still(this)) playerOf(this).follow(action);
        else (_a = players.get(this)) == null ? void 0 : _a.stop();
      },
      reset() {
        var _a;
        (_a = players.get(this)) == null ? void 0 : _a.stop();
      }
    });
    const baseStartWaiting = BoopFace.prototype.startWaiting;
    BoopFace.prototype.startWaiting = function(options = {}) {
      const result = baseStartWaiting.call(this, options);
      const v = options == null ? void 0 : options.variant;
      const name = !v || v === "spin" || v === "default" ? "waiting-spin" : `waiting-${v}`;
      if (REDONE.has(name) && !still(this)) playerOf(this).follow(name);
      return result;
    };
    function bodyMotionPose(face, pose) {
      const p = players.get(face);
      return (p == null ? void 0 : p.active) ? p.pose3d(pose) : pose;
    }
    exports.bodyMotionPose = bodyMotionPose;
  });
  __define("src/boopface-petting.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const { endOfficialAction } = __require2("src/boopface-new-expressions.js");
    const EASE = (t) => 1 - Math.pow(1 - t, 5);
    const SLEEP_EYES = { w: 58, h: 56, rx: 28, topY: -22, bottomY: -13, topAL: -8, topAR: 8, bottomAL: -8, bottomAR: 8, scale: 1 };
    const EYES_UP = 16;
    const TILT_UP = 11;
    const SPREAD = 0, RUB = 3.5, RUB_PERIOD = 2.2;
    const MIN_RUBS = 1;
    const SQUEEZE = 4;
    const SWAY_DEG = 3.5, SWAY_SLIDE = 1.5, SWAY_YAW = 5;
    function attachPet({ views, faces, options, isFlat = () => false, onStart = () => {
    }, enabled = () => true }) {
      let starting = false, fastOut = false, dir = 0, run = 0, lastX = null, strokes = [], petting = false, lastStroke = 0, hand = 0, handTarget = 0, lean = 0, strokeView = null, petFaces = [];
      const STROKES_TO_START = 3, WINDOW = 1600, STOP_AFTER = 750;
      const inForehead = (e, v) => {
        const r = v.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        return x > 0.14 && x < 0.86 && y > 0.04 && y < 0.42 ? { x, r } : null;
      };
      const onUpperHead = (e) => {
        if (!strokeView) return false;
        const r = strokeView.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        return x > 0.1 && x < 0.9 && y > 0 && y < 0.5;
      };
      let handInside = false;
      const onLeave = () => {
        handInside = false;
      };
      const onMove = (e) => {
        if (petting) handInside = onUpperHead(e);
        if (e.buttons || !enabled()) {
          lastX = null;
          return;
        }
        const v = views().find((v2) => inForehead(e, v2));
        const hit = v && inForehead(e, v);
        if (!hit) {
          lastX = null;
          dir = 0;
          run = 0;
          return;
        }
        if (v !== strokeView) {
          if (petting) return;
          strokeView = v;
          lastX = null;
          dir = 0;
          run = 0;
          strokes = [];
        }
        handTarget = hit.x * 2 - 1;
        const x = e.clientX / hit.r.width;
        if (lastX !== null) {
          const dx = x - lastX, d = Math.sign(dx);
          if (d && d !== dir) {
            if (run > 0.12) countStroke();
            dir = d;
            run = 0;
          }
          run += Math.abs(dx);
          if (petting && Math.abs(dx) > 4e-3) lastStroke = performance.now();
        }
        lastX = x;
      };
      function countStroke() {
        const now = performance.now();
        strokes = strokes.filter((t2) => now - t2 < WINDOW);
        strokes.push(now);
        lastStroke = now;
        if (!petting && strokes.length >= STROKES_TO_START) {
          start();
          wake();
        }
      }
      const saved = /* @__PURE__ */ new Map();
      function afterDraw(f) {
        var _a;
        if (!(f.__petUp > 0.01)) return;
        for (const side of ["left", "right"]) {
          const dx = (side === "left" ? -1 : 1) * (f.__petSpread || 0) + (f.__petRub || 0);
          const g = f.shadowRoot.getElementById(side + "Eye");
          if (g) g.setAttribute("transform", `translate(${dx.toFixed(2)} ${(-f.__petUp).toFixed(2)}) ${g.getAttribute("transform") || ""}`);
          const lid = f.shadowRoot.getElementById(side + "Bottom"), o = f.__petSqueeze || 0;
          if (lid && o > 0.01) {
            const y = +lid.getAttribute("y") - o, a = ((_a = /rotate\(([-\d.]+)/.exec(lid.getAttribute("transform") || "")) == null ? void 0 : _a[1]) || 0;
            lid.setAttribute("y", y.toFixed(2));
            lid.setAttribute("transform", `rotate(${a} 0 ${y.toFixed(2)})`);
          }
        }
      }
      function start() {
        var _a, _b;
        onStart();
        const next = faces(strokeView);
        for (const f of petFaces) if (!next.includes(f)) release(f);
        petting = true;
        handInside = true;
        lean = 0;
        swayT = 0;
        petFaces = next;
        starting = true;
        for (const f of petFaces) {
          (_a = f.noteActivity) == null ? void 0 : _a.call(f);
          const look = { ...f._look };
          try {
            endOfficialAction(f);
          } finally {
            starting = false;
          }
          Object.assign(f._look, look);
          f._expressionLock = true;
          if (f._eyeMicro) f._eyeMicro.lX = f._eyeMicro.lY = f._eyeMicro.rX = f._eyeMicro.rY = 0;
          if (f._wanderTarget) f._wanderTarget.x = f._wanderTarget.y = 0;
          f._eyeBob = f._eyeNod = null;
          f._startMorph(SLEEP_EYES, 420, EASE);
          saved.set(f, f._nextBlinkAt);
          f._nextBlinkAt = Infinity;
          const hm = f._headMotion;
          (_b = hm.getAnimations) == null ? void 0 : _b.call(hm).forEach((a) => a.cancel());
          hm.style.transformBox = "view-box";
          hm.style.transformOrigin = "120px 150px";
        }
      }
      async function stop() {
        var _a;
        petting = false;
        strokes = [];
        for (const f of petFaces) {
          f._nextBlinkAt = performance.now() + 900 + Math.random() * 1200;
          (_a = f._returnToIdle) == null ? void 0 : _a.call(f, 650);
        }
      }
      let prev = performance.now(), t = 0, swayT = 0, rubNow = 0, endAt = null;
      let raf = 0;
      const wake = () => {
        if (!raf) {
          prev = performance.now();
          raf = requestAnimationFrame(frame);
        }
      };
      function frame(now) {
        var _a, _b, _c;
        raf = 0;
        if (petting || lean > 0) raf = requestAnimationFrame(frame);
        const dt = Math.min(0.05, (now - prev) / 1e3);
        prev = now;
        t += dt;
        if (petting && !handInside) {
          endAt ?? (endAt = Math.max(MIN_RUBS, Math.ceil(swayT / RUB_PERIOD - 1e-6)) * RUB_PERIOD);
          if (swayT >= endAt) stop();
        } else endAt = null;
        const target = petting ? 1 : 0;
        lean += (target - lean) * (1 - Math.exp(-dt / (petting ? 0.25 : fastOut ? 0.07 : 0.35)));
        if (fastOut && !petting && lean < 0.05) lean = 0;
        hand += (handTarget - hand) * (1 - Math.exp(-dt / 0.18));
        if (lean < 2e-3 && !petting) {
          fastOut = false;
          if (lean !== 0 || petFaces.some((f) => f.__petUp)) {
            lean = 0;
            for (const f of petFaces) {
              f.__petUp = f.__petSpread = f.__petRub = f.__petSqueeze = 0;
              if (!((_b = (_a = f._headMotion).getAnimations) == null ? void 0 : _b.call(_a).length)) f._headMotion.style.transform = "";
            }
          }
          return;
        }
        if (petting) swayT += dt;
        const rub = Math.sin(2 * Math.PI * swayT / RUB_PERIOD) * Math.min(1, swayT / (RUB_PERIOD / 2));
        rubNow = rub;
        const sway = SWAY_DEG * rub;
        const purr = options().purr ? Math.sin(t * 2 * Math.PI * 7) * 0.35 * lean : 0;
        const up = -2 * lean + purr;
        const tilt = TILT_UP * lean;
        for (const f of petFaces) {
          const flat = isFlat(f), y = up - (flat ? tilt * 0.22 : 0), sy = flat ? 1 - tilt * 35e-4 : 1;
          f.__petUp = EYES_UP * lean + 0.02;
          f.__petSpread = SPREAD * lean;
          f.__petRub = RUB * rub * lean;
          f.__petSqueeze = options().blink ? SQUEEZE * Math.abs(rub) ** 2 * lean : 0;
          f._headMotion.style.transform = `translate(${(SWAY_SLIDE * rub * lean).toFixed(2)}px, ${y.toFixed(2)}px) rotate(${(sway * lean).toFixed(2)}deg) scale(1, ${sy.toFixed(4)})`;
          (_c = f._resumeFrames) == null ? void 0 : _c.call(f);
        }
      }
      function release(f) {
        var _a, _b;
        f.__petUp = f.__petSpread = f.__petRub = f.__petSqueeze = 0;
        if (f._nextBlinkAt === Infinity) f._nextBlinkAt = performance.now() + 900 + Math.random() * 1200;
        if (!((_b = (_a = f._headMotion).getAnimations) == null ? void 0 : _b.call(_a).length)) f._headMotion.style.transform = "";
      }
      function cancel() {
        if (starting || !petting && lean === 0) return;
        petting = false;
        strokes = [];
        endAt = null;
        fastOut = true;
        wake();
        for (const f of petFaces) if (f._nextBlinkAt === Infinity) f._nextBlinkAt = performance.now() + 900 + Math.random() * 1200;
      }
      return {
        onMove,
        onLeave,
        afterDraw,
        get petting() {
          return petting;
        },
        start,
        stop,
        cancel,
        // Is this face being petted (or easing out of it)?
        holds: (f) => lean > 2e-3 && petFaces.includes(f),
        // The 3D pitch up for a petted 3D face, added to its pose.
        pose3d: (f, pose) => lean > 2e-3 && petFaces.includes(f) ? { ...pose, pitch: pose.pitch * (1 - lean) + TILT_UP * lean, yaw: pose.yaw * (1 - lean) + SWAY_YAW * rubNow * lean, gazeX: pose.gazeX * (1 - lean), gazeY: pose.gazeY * (1 - lean) } : pose
      };
    }
    const pets = /* @__PURE__ */ new WeakMap();
    const live = /* @__PURE__ */ new Set();
    let listening = false;
    function listen() {
      if (listening || typeof window === "undefined") return;
      listening = true;
      const leave = () => {
        for (const p of live) p.onLeave();
      };
      document.addEventListener("pointerleave", leave);
      window.addEventListener("blur", leave);
    }
    function petOf(face) {
      let p = pets.get(face);
      if (!p) {
        p = attachPet({
          views: () => face.isConnected ? [face] : [],
          faces: () => [face],
          options: () => ({ purr: true, blink: true }),
          isFlat: (f) => !f._view3d,
          // setPetting() wins once called; otherwise petting="false" turns it off.
          enabled: () => {
            var _a;
            return (face._pettingEnabled ?? String(face.getAttribute("petting") ?? "").trim().toLowerCase() !== "false") && !((_a = face._dragJelly) == null ? void 0 : _a.active);
          }
        });
        pets.set(face, p);
      }
      if (face.isConnected) {
        live.add(p);
        listen();
      }
      return p;
    }
    const baseOnPointerMove = BoopFace.prototype._onPointerMove;
    BoopFace.prototype._onPointerMove = function(event) {
      var _a;
      baseOnPointerMove.call(this, event);
      (_a = pets.get(this)) == null ? void 0 : _a.onMove(event);
    };
    BoopFace.prototype.setPetting = function(enabled = true) {
      var _a;
      this._pettingEnabled = enabled !== false;
      if (!this._pettingEnabled) (_a = pets.get(this)) == null ? void 0 : _a.cancel();
      return this;
    };
    registerAvatarExtension({
      name: "petting",
      // Any action ends the petting (eased back, never a jump).
      beforePlay() {
        var _a;
        (_a = pets.get(this)) == null ? void 0 : _a.cancel();
      },
      // Reset also runs on disconnect: a removed avatar stops listening.
      reset() {
        const p = pets.get(this);
        p == null ? void 0 : p.cancel();
        if (p && !this.isConnected) live.delete(p);
      },
      draw() {
        petOf(this).afterDraw(this);
      }
    });
    function petPose(face, pose) {
      const p = pets.get(face);
      return p ? p.pose3d(face, pose) : pose;
    }
    exports.petPose = petPose;
  });
  __define("src/skins/catalog.js", function(__require2, __import2, exports) {
    const SKIN_SERIES = [
      { "number": 1, "id": "glaze", "zh": "彩色玻璃", "en": "Glaze", "skins": ["101", "102", "103", "104", "105", "106"] },
      { "number": 2, "id": "ice", "zh": "淡彩玻璃", "en": "Ice glass", "skins": ["201", "202", "203", "204", "205", "206"] },
      { "number": 3, "id": "gummy", "zh": "软糖", "en": "Gummy", "skins": ["301", "302", "303", "304", "305", "306", "307", "308", "309", "310", "311", "312"] },
      { "number": 4, "id": "candy", "zh": "糖果玻璃", "en": "Candy glass", "skins": ["401", "402", "403", "404", "405", "406"] },
      { "number": 5, "id": "acrylic", "zh": "亚克力", "en": "Acrylic", "skins": ["501", "502", "503", "504", "505", "506", "507", "508", "509", "510", "511", "512"] },
      { "number": 6, "id": "jelly", "zh": "果冻", "en": "Jelly", "skins": ["601", "602", "603", "604", "605", "606", "607", "608", "609", "610", "611", "612"] },
      { "number": 7, "id": "gradient", "zh": "渐变", "en": "Gradient", "skins": ["701", "702", "703", "704", "705", "706", "707", "708", "709", "710", "711", "712"] },
      { "number": 8, "id": "frosted", "zh": "磨砂玻璃系列", "en": "Frosted glass", "skins": ["801", "802", "803", "804", "805", "806"] },
      { "number": 9, "id": "metal", "zh": "磨砂金属", "en": "Metal", "skins": ["901", "902", "903", "904", "905", "906", "907", "908", "909", "910", "911", "912", "913", "914", "915", "916", "917", "918", "919", "920", "921", "922", "923", "924", "925", "926", "927", "928", "929", "930"] },
      { "number": 10, "id": "gem", "zh": "宝石与陶瓷", "en": "Gems and ceramics", "skins": ["1001", "1002", "1003", "1004", "1005", "1006", "1007", "1008", "1009", "1010", "1011", "1012"] },
      { "number": 11, "id": "wood", "zh": "木系列", "en": "Wood", "skins": ["1101", "1102", "1103", "1104", "1105", "1106"] },
      { "number": 12, "id": "ball", "zh": "球类", "en": "Balls", "skins": ["1201", "1202", "1203", "1204", "1205", "1206", "1207", "1208", "1209", "1210"] },
      { "number": 13, "id": "gloss", "zh": "透明与流光", "en": "Clear and shimmer", "skins": ["1301", "1302", "1303", "1304", "1305"] },
      { "number": 14, "id": "fabric", "zh": "织物与皮革", "en": "Fabric and leather", "skins": ["1401", "1402", "1403", "1404", "1405", "1406", "1407", "1408", "1409", "1410", "1411", "1412"] },
      { "number": 15, "id": "food", "zh": "甜点与水果", "en": "Sweets and fruit", "skins": ["1501", "1502", "1503", "1504", "1505", "1506", "1507", "1508", "1509", "1510", "1511", "1512"] },
      { "number": 16, "id": "nature", "zh": "自然", "en": "Nature", "skins": ["1601", "1602", "1603", "1604", "1605", "1606", "1607", "1608", "1609", "1610", "1611", "1612"] },
      { "number": 17, "id": "pattern", "zh": "图案与科技", "en": "Patterns and tech", "skins": ["1701", "1702", "1703", "1704", "1705", "1706", "1707", "1708", "1709", "1710", "1711", "1712", "1713", "1714", "1715", "1716", "1717"] }
    ];
    const RETIRED_SKINS = [];
    const SKIN_CATALOG = {
      "101": { "series": "glaze", "zh": "曜石黑", "en": "Glaze · Black", "base": ["#39434f", "#39434f", "#101923", "#090d14"], "material": "blackglaze", "eyeColor": false },
      "102": { "series": "glaze", "zh": "湖蓝", "en": "Glaze · Blue", "base": ["#58b7eb", "#2c98e2", "#2674da", "#2939bf"], "material": "blueglaze", "eyeColor": false },
      "103": { "series": "glaze", "zh": "翡翠绿", "en": "Glaze · Jade", "base": ["#40c49b", "#40c49b", "#12856c", "#086953"], "material": "jadeglaze", "eyeColor": false },
      "104": { "series": "glaze", "zh": "莓果粉", "en": "Glaze · Berry", "base": ["#ec77ac", "#ec77ac", "#c13b7b", "#9e285f"], "material": "berryglaze", "eyeColor": false },
      "105": { "series": "glaze", "zh": "琥珀橙", "en": "Glaze · Amber", "base": ["#f4b053", "#f4b053", "#db762b", "#ae531b"], "material": "amberglaze", "eyeColor": false },
      "106": { "series": "glaze", "zh": "鸢尾紫", "en": "Glaze · Iris", "base": ["#aa83ef", "#aa83ef", "#7846cf", "#5831a8"], "material": "irisglaze", "eyeColor": false },
      "201": { "series": "ice", "zh": "冰透蓝", "en": "Ice glass · Blue", "base": ["#d5e4f5", "#bfd2e9", "#a9c2de", "#8ba9cb"], "material": "iceglaze", "eyeColor": false },
      "202": { "series": "ice", "zh": "冰透薄荷绿", "en": "Ice glass · Mint", "base": ["#d7f0e5", "#d7f0e5", "#b3d8c9", "#8bbcae"], "material": "mintice", "eyeColor": false },
      "203": { "series": "ice", "zh": "冰透樱花粉", "en": "Ice glass · Blush", "base": ["#f5dfe9", "#f5dfe9", "#e2bed0", "#c093ab"], "material": "blushice", "eyeColor": false },
      "204": { "series": "ice", "zh": "冰透香槟金", "en": "Ice glass · Champagne", "base": ["#f4e9d2", "#f4e9d2", "#e0cda8", "#c2ac81"], "material": "champagneice", "eyeColor": false },
      "205": { "series": "ice", "zh": "冰透薰衣紫", "en": "Ice glass · Lavender", "base": ["#e8e1f6", "#e8e1f6", "#cec1e8", "#a89ac9"], "material": "lavenderice", "eyeColor": false },
      "206": { "series": "ice", "zh": "冰透霜白", "en": "Ice glass · White", "base": ["#f6fbff", "#f6fbff", "#dce8ef", "#c0cdd6"], "material": "whiteice", "eyeColor": false },
      "301": { "series": "gummy", "zh": "软糖 · 蓝", "en": "Gummy · Blue", "base": ["#90b9fe", "#619bff", "#4287ff", "#5295ff"], "native": "glow-blue", "eyeColor": false },
      "302": { "series": "gummy", "zh": "软糖 · 红", "en": "Gummy · Red", "base": ["#fe9590", "#ff6961", "#ff4c42", "#ff5752"], "native": "glow-red", "eyeColor": false },
      "303": { "series": "gummy", "zh": "软糖 · 嫩绿", "en": "Gummy · Lime", "base": ["#b9ff94", "#92ec55", "#72d232", "#57c200"], "native": "custom-1793262923292", "eyeColor": false },
      "304": { "series": "gummy", "zh": "软糖 · 紫", "en": "Gummy · Purple", "base": ["#ca90fe", "#b561ff", "#a742ff", "#ab52ff"], "native": "glow-purple", "eyeColor": false },
      "305": { "series": "gummy", "zh": "软糖 · 粉", "en": "Gummy · Pink", "base": ["#fe90c8", "#ff61b0", "#ff42a0", "#ff52ac"], "native": "glow-pink", "eyeColor": false },
      "306": { "series": "gummy", "zh": "软糖 · 橙", "en": "Gummy · Orange", "base": ["#febb89", "#ffa159", "#ff8f39", "#ff9449"], "native": "glow-orange", "eyeColor": false },
      "307": { "series": "gummy", "zh": "软糖 · 淡蓝", "en": "Gummy · Light Blue", "base": ["#90d4fe", "#80d9ff", "#4dc9ff", "#38a9ff"], "native": "custom-1793262553386", "eyeColor": false },
      "308": { "series": "gummy", "zh": "软糖 · 灰", "en": "Gummy · Gray", "base": ["#b9cad4", "#9bb8c5", "#8198a2", "#8a959e"], "native": "custom-1793262790531", "eyeColor": false },
      "309": { "series": "gummy", "zh": "软糖 · 粉红", "en": "Gummy · Rose", "base": ["#ff94fb", "#ff1f1f", "#fe5881", "#c20000"], "native": "custom-1793263007260", "eyeColor": false },
      "310": { "series": "gummy", "zh": "软糖 · 蓝绿", "en": "Gummy · Teal", "base": ["#47c8ff", "#27ecbb", "#30cfb4", "#0f4bff"], "native": "custom-1793263221394", "eyeColor": false },
      "311": { "series": "gummy", "zh": "软糖 · 黄", "en": "Gummy · Yellow", "base": ["#ffe014", "#ffd642", "#ffbd2e", "#ffd35c"], "native": "custom-1793263313834", "eyeColor": false },
      "312": { "series": "gummy", "zh": "软糖 · 绿", "en": "Gummy · Green", "base": ["#90d89e", "#61c876", "#42bd5b", "#52c267"], "native": "glow-green", "eyeColor": false },
      "401": { "series": "candy", "zh": "糖果蓝", "en": "Candy glass · Blue", "base": ["#2e7bff", "#337aff", "#0056f5", "#023bca"], "native": "gem-blue", "eyeColor": false },
      "402": { "series": "candy", "zh": "糖果红", "en": "Candy glass · Red", "base": ["#ff312e", "#ff3a33", "#f50700", "#ca1502"], "native": "gem-red", "eyeColor": false },
      "403": { "series": "candy", "zh": "糖果绿", "en": "Candy glass · Green", "base": ["#14ce29", "#15d42e", "#0f9620", "#0d7621"], "native": "gem-green", "eyeColor": false },
      "404": { "series": "candy", "zh": "糖果紫", "en": "Candy glass · Purple", "base": ["#992eff", "#a033ff", "#8200f5", "#7902ca"], "native": "gem-purple", "eyeColor": false },
      "405": { "series": "candy", "zh": "糖果粉红", "en": "Candy glass · Pink", "base": ["#ff2e94", "#ff3392", "#f50073", "#ca0253"], "native": "gem-pink", "eyeColor": false },
      "406": { "series": "candy", "zh": "糖果橙", "en": "Candy glass · Orange", "base": ["#ff7f25", "#ff862a", "#eb6500", "#c16102"], "native": "gem-orange", "eyeColor": false },
      "501": { "series": "acrylic", "zh": "亮光蓝", "en": "Acrylic · Gloss Blue", "base": ["#5a9dff", "#2f7cf6", "#286fea", "#1c5ed8"], "native": "gleam-blue", "eyeColor": false },
      "502": { "series": "acrylic", "zh": "亮光红", "en": "Acrylic · Gloss Red", "base": ["#ff5c5a", "#f6362f", "#ea3328", "#d8291c"], "native": "gleam-red", "eyeColor": false },
      "503": { "series": "acrylic", "zh": "亮光绿", "en": "Acrylic · Gloss Green", "base": ["#2cea41", "#1bbf31", "#20a434", "#1e8630"], "native": "gleam-green", "eyeColor": false },
      "504": { "series": "acrylic", "zh": "亮光黄", "en": "Acrylic · Gloss Yellow", "base": ["#ffe35a", "#f6d82f", "#ead128", "#d8c31c"], "native": "gleam-yellow", "eyeColor": false },
      "505": { "series": "acrylic", "zh": "亮光紫", "en": "Acrylic · Gloss Purple", "base": ["#af5aff", "#992ff6", "#9428ea", "#871cd8"], "native": "gleam-purple", "eyeColor": false },
      "506": { "series": "acrylic", "zh": "亮光粉", "en": "Acrylic · Gloss Pink", "base": ["#ff5ab0", "#f62f92", "#ea2885", "#d81c73"], "native": "gleam-pink", "eyeColor": false },
      "507": { "series": "acrylic", "zh": "清透蓝", "en": "Acrylic · Clear Blue", "base": ["#75acff", "#428eff", "#337aff", "#001442"], "native": "clear-blue", "eyeColor": false },
      "508": { "series": "acrylic", "zh": "清透红", "en": "Acrylic · Clear Red", "base": ["#ff7a75", "#ff4842", "#ff4533", "#420900"], "native": "clear-red", "eyeColor": false },
      "509": { "series": "acrylic", "zh": "清透绿", "en": "Acrylic · Clear Green", "base": ["#48ed5f", "#16e332", "#15d439", "#010d04"], "native": "clear-green", "eyeColor": false },
      "510": { "series": "acrylic", "zh": "清透紫", "en": "Acrylic · Clear Purple", "base": ["#bf75ff", "#a742ff", "#ab33ff", "#2a0042"], "native": "clear-purple", "eyeColor": false },
      "511": { "series": "acrylic", "zh": "清透粉红", "en": "Acrylic · Clear Pink", "base": ["#ff75b5", "#ff429a", "#ff3387", "#420018"], "native": "clear-pink", "eyeColor": false },
      "512": { "series": "acrylic", "zh": "清透橙", "en": "Acrylic · Clear Orange", "base": ["#ffad6d", "#ff8f39", "#ff922a", "#3c2000"], "native": "clear-orange", "eyeColor": false },
      "601": { "series": "jelly", "zh": "果冻蓝", "en": "Jelly · Blue", "base": ["#3cabec", "#2a67d0", "#1e3cb4", "#12228a"], "native": "slab-blue", "eyeColor": false },
      "602": { "series": "jelly", "zh": "果冻红", "en": "Jelly · Red", "base": ["#ec3c64", "#d0302a", "#b43c1e", "#8a3212"], "native": "slab-red", "eyeColor": false },
      "603": { "series": "jelly", "zh": "果冻绿", "en": "Jelly · Green", "base": ["#a6ec3c", "#62d02a", "#38b41e", "#1e8a12"], "native": "slab-green", "eyeColor": false },
      "604": { "series": "jelly", "zh": "果冻紫", "en": "Jelly · Purple", "base": ["#6b3cec", "#832ad0", "#871eb4", "#6e128a"], "native": "slab-purple", "eyeColor": false },
      "605": { "series": "jelly", "zh": "果冻粉", "en": "Jelly · Pink", "base": ["#ec3cc3", "#d02a7d", "#b41e50", "#8a1232"], "native": "slab-pink", "eyeColor": false },
      "606": { "series": "jelly", "zh": "果冻橙", "en": "Jelly · Orange", "base": ["#f1856f", "#de9259", "#dc962e", "#b68218"], "native": "slab-orange", "eyeColor": false },
      "607": { "series": "jelly", "zh": "渐变靛", "en": "Jelly · Prism Indigo", "base": ["#3f81f0", "#4034c9", "#bb30e8", "#ff1f8b"], "native": "prism-indigo", "eyeColor": false },
      "608": { "series": "jelly", "zh": "渐变红", "en": "Jelly · Prism Red", "base": ["#f03f8a", "#c93934", "#e8b230", "#97ff1f"], "native": "prism-red", "eyeColor": false },
      "609": { "series": "jelly", "zh": "渐变青柠", "en": "Jelly · Prism Lime", "base": ["#cfe537", "#6ab237", "#29dc57", "#18eff3"], "native": "prism-lime", "eyeColor": false },
      "610": { "series": "jelly", "zh": "渐变玫红", "en": "Jelly · Prism Rose", "base": ["#f03fbc", "#c93459", "#e87e30", "#d6ff1f"], "native": "prism-rose", "eyeColor": false },
      "611": { "series": "jelly", "zh": "渐变天蓝", "en": "Jelly · Prism Sky", "base": ["#3ff0da", "#3497c9", "#3130e8", "#cb1fff"], "native": "prism-sky", "eyeColor": false },
      "612": { "series": "jelly", "zh": "渐变紫", "en": "Jelly · Prism Purple", "base": ["#9a3ff0", "#c534c9", "#e83071", "#ff7a1f"], "native": "prism-purple", "eyeColor": false },
      "701": { "series": "gradient", "zh": "海洋", "en": "Gradient · Ocean", "base": ["#7ff0e4", "#3cc3e0", "#2b7fd4", "#3b3fb0"], "native": "ocean" },
      "702": { "series": "gradient", "zh": "森林", "en": "Gradient · Forest", "base": ["#d9f99d", "#7bd389", "#2f9e7a", "#1e5f6b"], "native": "forest" },
      "703": { "series": "gradient", "zh": "渐变 · 黄", "en": "Gradient · Yellow", "base": ["#f0bf7f", "#e0c73c", "#b6d42b", "#65b03b"], "native": "gradient-yellow" },
      "704": { "series": "gradient", "zh": "渐变 · 紫", "en": "Gradient · Purple", "base": ["#a29aeb", "#c592f1", "#eb95cf", "#e7c49b"], "native": "gradient-purple" },
      "705": { "series": "gradient", "zh": "糖果", "en": "Gradient · Candy", "base": ["#fbd651", "#fe4d9d", "#a724ff", "#3da1ff"], "native": "candy" },
      "706": { "series": "gradient", "zh": "流光", "en": "Gradient · Aurora", "base": ["#9aebea", "#92c9f1", "#a795eb", "#e79bc7"], "native": "aurora" },
      "707": { "series": "gradient", "zh": "珍珠", "en": "Gradient · Pearl", "base": ["#ffffff", "#eaf2ff", "#f4e9ff", "#e2f6ee"], "native": "pearl" },
      "708": { "series": "gradient", "zh": "樱花", "en": "Gradient · Sakura", "base": ["#ffffff", "#fdeaf0", "#f3c7d4", "#d697ab"], "native": "sakura" },
      "709": { "series": "gradient", "zh": "薰衣草", "en": "Gradient · Lavender", "base": ["#ffffff", "#ece6ff", "#cbbcf2", "#9c88d6"], "native": "lavender" },
      "710": { "series": "gradient", "zh": "柠檬", "en": "Gradient · Lemon", "base": ["#fffef0", "#fff2a8", "#f5d757", "#c9a21d"], "native": "lemon" },
      "711": { "series": "gradient", "zh": "天空", "en": "Gradient · Sky", "base": ["#ffffff", "#dff1ff", "#a9d6f7", "#5ea4d8"], "native": "sky" },
      "712": { "series": "gradient", "zh": "薄荷", "en": "Gradient · Mint", "base": ["#f5fffb", "#cdf3e5", "#93dcc3", "#52ad90"], "native": "mint" },
      "801": { "series": "frosted", "zh": "雾白透银", "en": "Frosted glass · Mist", "base": ["#ffffff", "#eff5f7", "#d8e4ea", "#b3c5d0"], "material": "clearwhite" },
      "802": { "series": "frosted", "zh": "透光液态银", "en": "Frosted glass · Silver", "base": ["#fcfaf6", "#d3dbdf", "#98a6ae", "#66767f"], "material": "clearsilver" },
      "803": { "series": "frosted", "zh": "厚底透银", "en": "Frosted glass · Weighted", "base": ["#fcfaf6", "#d3dbdf", "#98a6ae", "#66767f"], "material": "clearweighted" },
      "804": { "series": "frosted", "zh": "硬光透银", "en": "Frosted glass · Hard Light", "base": ["#fcfaf6", "#d3dbdf", "#98a6ae", "#66767f"], "material": "clearhard" },
      "805": { "series": "frosted", "zh": "烟灰透银", "en": "Frosted glass · Smoke", "base": ["#dce5e9", "#abbac3", "#778e9d", "#485f70"], "material": "clearsmoke" },
      "806": { "series": "frosted", "zh": "墨灰透银", "en": "Frosted glass · Ink", "base": ["#bacbd6", "#7e97a8", "#4b687e", "#2a4257"], "material": "clearink" },
      "901": { "series": "metal", "zh": "液态金", "en": "Metal · Liquid Gold", "base": ["#fcfbf6", "#f0e4c5", "#dcc37d", "#c69f35"], "material": "golddrop" },
      "902": { "series": "metal", "zh": "钛金", "en": "Metal · Titanium Gold", "base": ["#f6e1b8", "#d4a446", "#a57009", "#704a00"], "material": "deepmetalgold" },
      "903": { "series": "metal", "zh": "深玫瑰金", "en": "Metal · Deep Rose Gold", "base": ["#fcdcd9", "#e19991", "#b3645b", "#833f38"], "material": "deepmetalrose" },
      "904": { "series": "metal", "zh": "深铜", "en": "Metal · Deep Copper", "base": ["#f0ded4", "#d29c7e", "#ac663d", "#734428"], "material": "copperdeep" },
      "905": { "series": "metal", "zh": "红铜", "en": "Metal · Red Copper", "base": ["#ffddc9", "#ec9969", "#c0652f", "#8d4012"], "material": "deepmetalcopper" },
      "906": { "series": "metal", "zh": "星宇橙", "en": "Metal · Cosmic Orange", "base": ["#ffdecc", "#ff9962", "#e3611c", "#ae3d01"], "material": "iphonecosmicorange" },
      "907": { "series": "metal", "zh": "青铜", "en": "Metal · Bronze", "base": ["#e8e5bc", "#b5ac51", "#827a14", "#585100"], "material": "deepmetalbronze" },
      "908": { "series": "metal", "zh": "黑钛", "en": "Metal · Black Titanium", "base": ["#dbe4ee", "#97aac2", "#627791", "#3d4f66"], "material": "deepmetaltitanium" },
      "909": { "series": "metal", "zh": "铂金白", "en": "Metal · Platinum White", "base": ["#eff0f2", "#cacdd2", "#a5aab0", "#848990"], "material": "deepmetalplatinum" },
      "910": { "series": "metal", "zh": "浅香槟", "en": "Metal · Champagne", "base": ["#f1eadc", "#cebb97", "#a78f61", "#816a3c"], "material": "deepmetalchampagne" },
      "911": { "series": "metal", "zh": "冰蓝钛", "en": "Metal · Ice Blue", "base": ["#d4ecf8", "#86bfdc", "#4d92b6", "#2a6b8d"], "material": "deepmetaliceblue" },
      "912": { "series": "metal", "zh": "群青", "en": "Metal · Ultramarine", "base": ["#dae0ff", "#8ea0ff", "#576bd6", "#34459c"], "material": "iphoneultramarine" },
      "913": { "series": "metal", "zh": "紫钛", "en": "Metal · Violet", "base": ["#efd8ff", "#ce88ff", "#9e4fd5", "#6c2e98"], "material": "deepmetalviolet" },
      "914": { "series": "metal", "zh": "勃艮第酒红", "en": "Metal · Burgundy", "base": ["#fbbfd3", "#be5f7e", "#702b42", "#38131f"], "material": "iphoneburgundy" },
      "915": { "series": "metal", "zh": "深青", "en": "Metal · Teal", "base": ["#cdeae9", "#76bab7", "#3d8986", "#1d605e"], "material": "iphoneteal" },
      "916": { "series": "metal", "zh": "深墨绿", "en": "Metal · Forest", "base": ["#bad4ca", "#588272", "#26453a", "#10221b"], "material": "deepmetalforest" },
      "917": { "series": "metal", "zh": "原色钛", "en": "Metal · Natural Titanium", "base": ["#eceae7", "#c1bcb4", "#969085", "#716b60"], "material": "iphonenatural" },
      "918": { "series": "metal", "zh": "暗紫", "en": "Metal · Deep Purple", "base": ["#d7ccdc", "#86748f", "#4a3c50", "#251d28"], "material": "iphonedeepurple" },
      "919": { "series": "metal", "zh": "浅粉", "en": "Metal · Pink", "base": ["#f8eff1", "#e5ccd1", "#cda8b0", "#b28890"], "material": "iphonepink" },
      "920": { "series": "metal", "zh": "鼠尾草绿", "en": "Metal · Sage", "base": ["#e8ece4", "#b8c2ac", "#8b987b", "#667357"], "material": "iphonesage" },
      "921": { "series": "metal", "zh": "薰衣草紫", "en": "Metal · Lavender", "base": ["#eeebf6", "#c8bfdb", "#a095ba", "#7d7198"], "material": "iphonelavender" },
      "922": { "series": "metal", "zh": "铂金银", "en": "Metal · Platinum", "base": ["#bcc0c4", "#7e868e", "#5b6269", "#44494e"], "material": "satinplatinum" },
      "923": { "series": "metal", "zh": "玫瑰金", "en": "Metal · Rose Gold", "base": ["#d5aca1", "#ac604d", "#774235", "#512d24"], "material": "satinrose" },
      "924": { "series": "metal", "zh": "暖红铜", "en": "Metal · Warm Copper", "base": ["#dba483", "#a65c30", "#6a3a1f", "#412413"], "material": "satinredcopper" },
      "925": { "series": "metal", "zh": "暖青铜", "en": "Metal · Warm Bronze", "base": ["#c6b680", "#7f6f39", "#4d4322", "#2d2714"], "material": "satinbronze" },
      "926": { "series": "metal", "zh": "枪灰钛", "en": "Metal · Gunmetal", "base": ["#7a8a9b", "#353e46", "#1a1e22", "#0c0e10"], "material": "satingunmetal" },
      "927": { "series": "metal", "zh": "亮银", "en": "Metal · Bright Silver", "base": ["#ffffff", "#f0f3f3", "#d5dee2", "#a5b5bf"], "material": "silverbright" },
      "928": { "series": "metal", "zh": "液态银", "en": "Metal · Liquid Silver", "base": ["#fcfaf6", "#d5dde0", "#a3afb6", "#71818a"], "material": "silverdrop" },
      "929": { "series": "metal", "zh": "深银", "en": "Metal · Deep Silver", "base": ["#dce4e8", "#9baab4", "#657784", "#3d505e"], "material": "silverdeep" },
      "930": { "series": "metal", "zh": "石墨银", "en": "Metal · Graphite", "base": ["#aabac5", "#647987", "#3b505f", "#213440"], "material": "silvergraphite" },
      "1001": { "series": "gem", "zh": "黑曜石", "en": "Gems · Obsidian", "base": ["#7b8796", "#313a47", "#101722", "#05080e"], "native": "obsidian" },
      "1002": { "series": "gem", "zh": "午夜蓝", "en": "Gems · Midnight", "base": ["#7f98d4", "#2c4381", "#111e4a", "#060b22"], "native": "midnight" },
      "1003": { "series": "gem", "zh": "墨玉", "en": "Gems · Jade", "base": ["#7fb5a3", "#2f6d5b", "#123e33", "#06201a"], "native": "jade" },
      "1004": { "series": "gem", "zh": "琥珀", "en": "Gems · Amber", "base": ["#ffe2a6", "#f2a73c", "#c46812", "#6b3005"], "native": "amber" },
      "1005": { "series": "gem", "zh": "红宝石", "en": "Gems · Ruby", "base": ["#ff8a9a", "#d0243f", "#7a0d22", "#3a0410"], "native": "ruby" },
      "1006": { "series": "gem", "zh": "蓝宝石", "en": "Gems · Sapphire", "base": ["#8fc0ff", "#2a6fd6", "#103f8c", "#071d44"], "native": "sapphire" },
      "1007": { "series": "gem", "zh": "祖母绿", "en": "Gems · Emerald", "base": ["#8ff0c0", "#1fae74", "#0b6a45", "#033321"], "native": "emerald" },
      "1008": { "series": "gem", "zh": "曜石釉", "en": "Gems · Obsidian", "base": ["#7b8796", "#313a47", "#101722", "#05080e"], "material": "obsidian" },
      "1009": { "series": "gem", "zh": "白瓷", "en": "Gems · Porcelain", "base": ["#ffffff", "#f5f4ec", "#d9dad3", "#a3aaab"], "material": "porcelain" },
      "1010": { "series": "gem", "zh": "磨砂陶土", "en": "Gems · Clay", "base": ["#e6b59a", "#d9997d", "#c58065", "#ad674e"], "material": "clay" },
      "1011": { "series": "gem", "zh": "彩色水磨石", "en": "Gems · Terrazzo", "base": ["#fff9ed", "#f1e7d7", "#e1d3c1", "#cab9a8"], "material": "terrazzo" },
      "1012": { "series": "gem", "zh": "青花小瓷", "en": "Gems · Blue Floral", "base": ["#fffaf0", "#eee5d3", "#d5c5aa", "#b5a58b"], "material": "ceramicblue" },
      "1101": { "series": "wood", "zh": "浅枫木", "en": "Wood · Maple", "base": ["#f7e8ca", "#e4c999", "#c9a575", "#a87d50"], "material": "woodmaple" },
      "1102": { "series": "wood", "zh": "暖橡木", "en": "Wood · Oak", "base": ["#efd3a0", "#cea065", "#ad7844", "#82532e"], "material": "woodoak" },
      "1103": { "series": "wood", "zh": "深胡桃木", "en": "Wood · Walnut", "base": ["#b58d67", "#865b3c", "#5e3b28", "#38251c"], "material": "woodwalnut" },
      "1104": { "series": "wood", "zh": "红木", "en": "Wood · Rosewood", "base": ["#cf9376", "#a65d42", "#773d2c", "#48251e"], "material": "woodrose" },
      "1105": { "series": "wood", "zh": "黑檀木", "en": "Wood · Ebony", "base": ["#696052", "#42382d", "#2a221c", "#171411"], "material": "woodebony" },
      "1106": { "series": "wood", "zh": "软木积木", "en": "Wood · Cork", "base": ["#e8cb99", "#cfad76", "#b99159", "#9c7646"], "material": "cork" },
      "1201": { "series": "ball", "zh": "足球 · 沟槽", "en": "Balls · Soccer", "base": ["#4a4d55", "#24262b", "#131417", "#060607"], "native": "soccer-grooves" },
      "1202": { "series": "ball", "zh": "橘子篮球", "en": "Balls · Orange Basketball", "base": ["#ffbd63", "#ed8836", "#d26320", "#93421c"], "material": "basketball" },
      "1203": { "series": "ball", "zh": "篮球", "en": "Balls · Basketball", "base": ["#ffb066", "#f07a1e", "#c95a0e", "#7a3305"], "native": "basketball" },
      "1204": { "series": "ball", "zh": "橄榄球", "en": "Balls · Football", "base": ["#c07a4a", "#8f4a22", "#6a3112", "#3a1606"], "native": "football" },
      "1205": { "series": "ball", "zh": "网球", "en": "Balls · Tennis", "base": ["#f4ff8a", "#d7f43a", "#aacb10", "#66800a"], "native": "tennis" },
      "1206": { "series": "ball", "zh": "棒球", "en": "Balls · Baseball", "base": ["#fffdf7", "#f6f1e6", "#e2d9c7", "#b5a98f"], "native": "baseball" },
      "1207": { "series": "ball", "zh": "经典棒球", "en": "Balls · Classic Baseball", "base": ["#fffdf4", "#f3eee0", "#e2dccb", "#bfb7a4"], "material": "baseball" },
      "1208": { "series": "ball", "zh": "垒球", "en": "Balls · Softball", "base": ["#fbff9a", "#eef55a", "#cfd61f", "#8a8f0a"], "native": "softball" },
      "1209": { "series": "ball", "zh": "板球", "en": "Balls · Cricket", "base": ["#e05a4f", "#b52a22", "#851812", "#470806"], "native": "cricket" },
      "1210": { "series": "ball", "zh": "高尔夫", "en": "Balls · Golf", "base": ["#ffffff", "#f6f6f4", "#e2e2de", "#acaca6"], "native": "golf" },
      "1301": { "series": "gloss", "zh": "流光彩色", "en": "Clear · Aurora", "base": ["#9aebea", "#92c9f1", "#a795eb", "#e79bc7"], "material": "aurora" },
      "1302": { "series": "gloss", "zh": "贝壳珍珠", "en": "Clear · Nacre", "base": ["#fff8eb", "#ecd8e6", "#c6ddd8", "#b5afcf"], "material": "pearl" },
      "1303": { "series": "gloss", "zh": "镭射糖纸", "en": "Clear · Hologram", "base": ["#88e9df", "#c5b6f5", "#f6b8d0", "#f5ebad", "#9adce0"], "material": "hologram" },
      "1304": { "series": "gloss", "zh": "冰川水晶", "en": "Clear · Glacier", "base": ["#f0ffff", "#b6e9f2", "#71b9d4", "#437baf"], "material": "ice" },
      "1305": { "series": "gloss", "zh": "彩虹泡泡", "en": "Clear · Bubble", "base": ["#f9eafa", "#bfe6ed", "#ded1f0", "#bad9e6"], "material": "soap" },
      "1401": { "series": "fabric", "zh": "复古牛仔", "en": "Fabric · Denim", "base": ["#558aaf", "#18517c", "#003f66", "#07233b"], "material": "denim" },
      "1402": { "series": "fabric", "zh": "焦糖皮革", "en": "Fabric · Leather", "base": ["#c79665", "#ab784c", "#8f5d38", "#6a432b"], "material": "leather" },
      "1403": { "series": "fabric", "zh": "莓果毛衣", "en": "Fabric · Knit", "base": ["#d5a4b6", "#b5809b", "#925d7c", "#70465f"], "material": "knit" },
      "1404": { "series": "fabric", "zh": "午夜蕾丝", "en": "Fabric · Lace", "base": ["#4d526f", "#353a57", "#252b46", "#1c2138"], "material": "lace" },
      "1405": { "series": "fabric", "zh": "苏格兰格纹", "en": "Fabric · Tartan", "base": ["#ffbcc7", "#ef899e", "#d86383", "#b34364"], "material": "tartan" },
      "1406": { "series": "fabric", "zh": "菱格背心", "en": "Fabric · Argyle", "base": ["#e4d6ef", "#bcabd5", "#9a88bc", "#776397"], "material": "argyle" },
      "1407": { "series": "fabric", "zh": "靛蓝刺子绣", "en": "Fabric · Sashiko", "base": ["#546b8b", "#394f71", "#273b5b", "#1a2a43"], "material": "sashiko" },
      "1408": { "series": "fabric", "zh": "拼布小被", "en": "Fabric · Patchwork", "base": ["#ffe7db", "#f3bfb9", "#df969f", "#bd738c"], "material": "quilt" },
      "1409": { "series": "fabric", "zh": "灯芯绒衣", "en": "Fabric · Corduroy", "base": ["#ffd5a0", "#f5b267", "#de8941", "#b5672d"], "material": "corduroy" },
      "1410": { "series": "fabric", "zh": "亚麻布袋", "en": "Fabric · Linen", "base": ["#fffaf0", "#eee5d3", "#d5c5aa", "#b5a58b"], "material": "linen" },
      "1411": { "series": "fabric", "zh": "苏格兰格", "en": "Fabric · Plaid", "base": ["#d04848", "#a82d30", "#7d1c20", "#4a0e12"], "native": "tartan" },
      "1412": { "series": "fabric", "zh": "竹编小篮", "en": "Fabric · Bamboo", "base": ["#e7d49b", "#ceb574", "#b79b5b", "#937a40"], "material": "bamboo" },
      "1501": { "series": "food", "zh": "糖果条纹", "en": "Sweets · Candy Stripe", "base": ["#ffd5df", "#f4a2bf", "#e782a7", "#c85d89"], "material": "candy" },
      "1502": { "series": "food", "zh": "奶牛软糖", "en": "Sweets · Milk Candy", "base": ["#fffdf5", "#f4f0e6", "#deded5", "#bfc8c6"], "material": "cow" },
      "1503": { "series": "food", "zh": "西瓜汽水", "en": "Sweets · Watermelon", "base": ["#ffaca3", "#ea5353", "#ec4141", "#fe2a2a"], "material": "watermelon" },
      "1504": { "series": "food", "zh": "草莓奶冻", "en": "Sweets · Strawberry", "base": ["#ffbcc7", "#ef899e", "#d86383", "#b34364"], "material": "strawberry" },
      "1505": { "series": "food", "zh": "奇异果切片", "en": "Sweets · Kiwi", "base": ["#e2efb0", "#bdd574", "#94b94e", "#627f35"], "material": "kiwi" },
      "1506": { "series": "food", "zh": "柠檬切片", "en": "Sweets · Lemon", "base": ["#fff3ac", "#f6d657", "#eab62c", "#c58c22"], "material": "lemon" },
      "1507": { "series": "food", "zh": "橘皮软糖", "en": "Sweets · Orange Peel", "base": ["#ffd5a0", "#f5b267", "#de8941", "#b5672d"], "material": "orangepeel" },
      "1508": { "series": "food", "zh": "火龙果点点", "en": "Sweets · Dragon Fruit", "base": ["#fffefa", "#f6f4ec", "#e6e4df", "#c4cccb"], "material": "dragonfruit" },
      "1509": { "series": "food", "zh": "巧克力方砖", "en": "Sweets · Chocolate", "base": ["#b38a69", "#8a6046", "#6a4334", "#493027"], "material": "chocolate" },
      "1510": { "series": "food", "zh": "蜂格华夫", "en": "Sweets · Waffle", "base": ["#ffd5a0", "#f5b267", "#de8941", "#b5672d"], "material": "waffle" },
      "1511": { "series": "food", "zh": "曲奇碎碎", "en": "Sweets · Cookie", "base": ["#fff2a4", "#efcf61", "#d9a438", "#b97b25"], "material": "cookie" },
      "1512": { "series": "food", "zh": "糖针甜甜圈", "en": "Sweets · Sprinkles", "base": ["#ffbcc7", "#ef899e", "#d86383", "#b34364"], "material": "donut" },
      "1601": { "series": "nature", "zh": "大理石", "en": "Nature · Marble", "base": ["#ffffff", "#f6f6f4", "#e6e6e2", "#bcbcb6"], "native": "marble" },
      "1602": { "series": "nature", "zh": "黑金大理石", "en": "Nature · Black Marble", "base": ["#4a4a4f", "#25252a", "#141417", "#050506"], "native": "black-marble" },
      "1603": { "series": "nature", "zh": "树叶", "en": "Nature · Leaves", "base": ["#f0fbe6", "#cfeeb2", "#97d37b", "#4f9a45"], "native": "leaves" },
      "1604": { "series": "nature", "zh": "樱瓣", "en": "Nature · Blossoms", "base": ["#fffafd", "#ffeaf2", "#ffd0e0", "#f0a3c0"], "native": "blossoms" },
      "1605": { "series": "nature", "zh": "仙人掌球", "en": "Nature · Cactus", "base": ["#d4e6a0", "#a9c568", "#7f9d47", "#597538"], "material": "cactus" },
      "1606": { "series": "nature", "zh": "口袋星空", "en": "Nature · Galaxy", "base": ["#6545ad", "#45277f", "#193b70", "#101b3a"], "material": "galaxy" },
      "1607": { "series": "nature", "zh": "青芽绒绒", "en": "Nature · Sprout", "base": ["#d1ef9b", "#96c953", "#6ba737", "#3e6e29"], "material": "matcharib" },
      "1608": { "series": "nature", "zh": "云朵棉花", "en": "Nature · Clouds", "base": ["#b5e0f2", "#86bfe0", "#5f9bc9", "#3e73a4"], "material": "cloud" },
      "1609": { "series": "nature", "zh": "青海波纹", "en": "Nature · Waves", "base": ["#5b7fa5", "#3f648e", "#2b4c77", "#20395d"], "material": "wave" },
      "1610": { "series": "nature", "zh": "雨窗水滴", "en": "Nature · Raindrops", "base": ["#dbd9d0", "#b9bbb4", "#919a97", "#6b7b7c"], "material": "raindrop" },
      "1611": { "series": "nature", "zh": "雪花毛毯", "en": "Nature · Snowflakes", "base": ["#546b8b", "#394f71", "#273b5b", "#1a2a43"], "material": "snowflake" },
      "1612": { "series": "nature", "zh": "霓虹", "en": "Nature · Neon", "base": ["#5b3df5", "#2a1673", "#120a3a", "#06041a"], "native": "neon" },
      "1701": { "series": "pattern", "zh": "奶油波点", "en": "Patterns · Cream Dots", "base": ["#af9beb", "#8c72d9", "#7860c4", "#5a469e"], "material": "polka" },
      "1702": { "series": "pattern", "zh": "碳纤维", "en": "Patterns · Carbon", "base": ["#4a5557", "#2c3639", "#1b2428", "#10191e"], "material": "carbon" },
      "1703": { "series": "pattern", "zh": "工程蓝图", "en": "Patterns · Blueprint", "base": ["#6a9ed4", "#477ebc", "#2d609f", "#244a85"], "material": "blueprint" },
      "1704": { "series": "pattern", "zh": "折纸山谷", "en": "Patterns · Origami", "base": ["#f5e5d3", "#e6c7b0", "#b9c7c1", "#a0a8bb"], "material": "origami" },
      "1705": { "series": "pattern", "zh": "电路精灵", "en": "Patterns · Circuit", "base": ["#3c6c61", "#235347", "#163b34", "#102b29"], "material": "circuit" },
      "1706": { "series": "pattern", "zh": "森林迷彩", "en": "Patterns · Camo", "base": ["#b0b594", "#8e9e75", "#71835e", "#4c6247"], "material": "camo" },
      "1707": { "series": "pattern", "zh": "等高线地图", "en": "Patterns · Topo", "base": ["#7dbbb6", "#519a98", "#347b80", "#235d68"], "material": "topo" },
      "1708": { "series": "pattern", "zh": "金线扇影", "en": "Patterns · Art Deco", "base": ["#546b8b", "#394f71", "#273b5b", "#1a2a43"], "material": "artdeco" },
      "1709": { "series": "pattern", "zh": "孟菲斯派对", "en": "Patterns · Memphis", "base": ["#e4d6ef", "#bcabd5", "#9a88bc", "#776397"], "material": "memphis" },
      "1710": { "series": "pattern", "zh": "彩色人字纹", "en": "Patterns · Chevron", "base": ["#f3e8cd", "#e4d5b3", "#c8b48f", "#9e8e70"], "material": "chevron" },
      "1711": { "series": "pattern", "zh": "六角装甲", "en": "Patterns · Hex Armor", "base": ["#dbd9d0", "#b9bbb4", "#919a97", "#6b7b7c"], "material": "hexbolt" },
      "1712": { "series": "pattern", "zh": "铆钉机甲", "en": "Patterns · Rivets", "base": ["#546b8b", "#394f71", "#273b5b", "#1a2a43"], "material": "rivet" },
      "1713": { "series": "pattern", "zh": "波点", "en": "Patterns · Polka", "base": ["#ff9db2", "#ff5d84", "#e03a64", "#9b1c3e"], "native": "polka" },
      "1714": { "series": "pattern", "zh": "彩纸", "en": "Patterns · Confetti", "base": ["#ffffff", "#fbfaf7", "#efece6", "#c9c4bb"], "native": "confetti" },
      "1715": { "series": "pattern", "zh": "网点", "en": "Patterns · Halftone", "base": ["#ffe6ee", "#ffb3c7", "#ff7aa0", "#d6406c"], "native": "halftone", "eyeColor": false },
      "1716": { "series": "pattern", "zh": "水磨石", "en": "Patterns · Terrazzo", "base": ["#ffffff", "#fbfaf7", "#efece6", "#c9c4bb"], "native": "terrazzo", "eyeColor": false },
      "1717": { "series": "pattern", "zh": "像素", "en": "Patterns · Pixel", "base": ["#3a3a4a", "#24242f", "#16161d", "#0a0a10"], "native": "pixel", "eyeColor": false }
    };
    exports.SKIN_SERIES = SKIN_SERIES;
    exports.RETIRED_SKINS = RETIRED_SKINS;
    exports.SKIN_CATALOG = SKIN_CATALOG;
  });
  __define("src/boopface-eye-shape.js", function(__require2, __import2, exports) {
    const SAMPLES = 96;
    function roundInto(t, R) {
      var _a;
      const targets = [t.base, ...t.also || []].filter(Boolean), inputs = [t.input, ...t.alsoInput || []].filter(Boolean);
      if (!(R > 0) && !((_a = t.base) == null ? void 0 : _a.hasAttribute("data-shape"))) {
        for (const el of targets) if (el.hasAttribute("clip-path")) el.removeAttribute("clip-path");
        return;
      }
      for (const el of inputs) {
        const rx = ((+el.getAttribute("width") || 0) / 2).toFixed(2);
        if (el.getAttribute("rx") !== rx) el.setAttribute("rx", rx);
      }
      if (!t.base || !t.top || !t.bottom) return;
      if (!t.path) {
        const ns = t.svg.namespaceURI;
        let defs = t.svg.querySelector("defs");
        if (!defs) {
          defs = document.createElementNS(ns, "defs");
          t.svg.prepend(defs);
        }
        const clip2 = document.createElementNS(ns, "clipPath");
        clip2.id = t.id;
        t.path = document.createElementNS(ns, "path");
        clip2.append(t.path);
        defs.append(clip2);
      }
      const d = eyePath(t, R);
      if (d === null) {
        for (const el of targets) if (el.hasAttribute("clip-path")) el.removeAttribute("clip-path");
        return;
      }
      t.path.setAttribute("d", d);
      for (const el of targets) if (el.getAttribute("clip-path") !== `url(#${t.id})`) el.setAttribute("clip-path", `url(#${t.id})`);
    }
    function matrixOf(el) {
      var _a;
      const list = (_a = el == null ? void 0 : el.transform) == null ? void 0 : _a.baseVal;
      if (!list || !list.numberOfItems) return null;
      let m = new DOMMatrix();
      for (let i = 0; i < list.numberOfItems; i++) m = m.multiply(DOMMatrix.fromMatrix(list.getItem(i).matrix));
      return m;
    }
    const apply2 = (m, x, y) => m ? [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] : [x, y];
    function lidPlane(rect, isTop, inv) {
      const x = +rect.getAttribute("x") || 0, y = +rect.getAttribute("y") || 0;
      const w = +rect.getAttribute("width") || 0, h = +rect.getAttribute("height") || 0;
      const m = matrixOf(rect), ey = isTop ? y + h : y;
      const to = (px, py) => {
        const [gx, gy] = apply2(m, px, py);
        return apply2(inv, gx, gy);
      };
      const a = to(x, ey), b = to(x + w, ey), c = to(x + w / 2, y + h / 2);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const inside = Math.sign(dx * (c[1] - a[1]) - dy * (c[0] - a[0]));
      return { a, dx, dy, keep: -inside };
    }
    function eyePath(p, R) {
      const e = p.base;
      const given = e.getAttribute("data-shape");
      if (given) return given;
      if (!(R > 0)) return null;
      const cx = +e.getAttribute("cx") || 0, cy = +e.getAttribute("cy") || 0, rx = +e.getAttribute("rx") || 0, ry = +e.getAttribute("ry") || 0;
      const em = matrixOf(e), inv = em ? em.inverse() : null;
      let poly = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t = i / SAMPLES * Math.PI * 2;
        poly.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t), corner: false });
      }
      const planes = [lidPlane(p.top, true, inv), lidPlane(p.bottom, false, inv)];
      for (const pl of planes) poly = clip(poly, pl);
      if (poly.length < 3) return "M0 0Z";
      if (!poly.some((q) => q.corner)) return null;
      let top = Infinity, bottom = -Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a.x - cx) * (b.x - cx) > 0 || a.x === b.x) continue;
        const y = a.y + (b.y - a.y) * (cx - a.x) / (b.x - a.x);
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
      if (!(bottom > top)) {
        for (const q of poly) {
          if (q.y < top) top = q.y;
          if (q.y > bottom) bottom = q.y;
        }
      }
      const h = bottom - top, w = Math.min(1, Math.max(0, (24 - h) / 10)), k = w * w * (3 - 2 * w);
      if (h <= 14) return capsule(poly, planes, cx, (top + bottom) / 2, h, { cx, cy, rx, ry });
      return rounded(poly, R + k * (h / 2 - R));
    }
    function capsule(poly, planes, cx, cy, h, ell) {
      let [ux, uy] = [planes[0].dx, planes[0].dy], [vx, vy] = [planes[1].dx, planes[1].dy];
      if (ux < 0) {
        ux = -ux;
        uy = -uy;
      }
      if (vx < 0) {
        vx = -vx;
        vy = -vy;
      }
      const la = Math.hypot(ux, uy) || 1, lb = Math.hypot(vx, vy) || 1;
      ux = ux / la + vx / lb;
      uy = uy / la + vy / lb;
      const l = Math.hypot(ux, uy) || 1;
      ux /= l;
      uy /= l;
      const nx = -uy, ny = ux, r = Math.max(0.6, h * Math.abs(ux) / 2);
      let smin = Infinity, smax = -Infinity;
      for (const q of poly) {
        const s = (q.x - cx) * ux + (q.y - cy) * uy;
        if (s < smin) smin = s;
        if (s > smax) smax = s;
      }
      let s0 = smin + r, s1 = smax - r;
      if (s1 < s0) s0 = s1 = (smin + smax) / 2;
      const fits = (s, dir) => {
        for (let i = 0; i <= 8; i++) {
          const t = (i / 8 - 0.5) * Math.PI, ca = Math.cos(t), sa = Math.sin(t);
          const x = cx + ux * s + (ux * ca * dir + nx * sa) * r, y = cy + uy * s + (uy * ca * dir + ny * sa) * r;
          if (((x - ell.cx) / ell.rx) ** 2 + ((y - ell.cy) / ell.ry) ** 2 > 1.0001) return false;
        }
        return true;
      };
      const mid = (s0 + s1) / 2;
      for (let n = 0; n < 40 && !fits(s1, 1) && s1 > mid; n++) s1 -= 0.5;
      for (let n = 0; n < 40 && !fits(s0, -1) && s0 < mid; n++) s0 += 0.5;
      const A = [cx + ux * s0, cy + uy * s0], B = [cx + ux * s1, cy + uy * s1], f = (v) => v.toFixed(2);
      return `M${f(A[0] + nx * r)} ${f(A[1] + ny * r)}L${f(B[0] + nx * r)} ${f(B[1] + ny * r)}A${f(r)} ${f(r)} 0 0 0 ${f(B[0] - nx * r)} ${f(B[1] - ny * r)}L${f(A[0] - nx * r)} ${f(A[1] - ny * r)}A${f(r)} ${f(r)} 0 0 0 ${f(A[0] + nx * r)} ${f(A[1] + ny * r)}Z`;
    }
    function clip(poly, { a, dx, dy, keep }) {
      const side = (q) => (dx * (q.y - a[1]) - dy * (q.x - a[0])) * keep;
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
        const sc = side(cur), sp = side(prev);
        if (sc >= 0) {
          if (sp < 0) out.push(cross(prev, cur, sp, sc));
          out.push(cur);
        } else if (sp >= 0) out.push(cross(prev, cur, sp, sc));
      }
      return out;
    }
    const cross = (p, q, sp, sq) => {
      const t = sp / (sp - sq);
      return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, corner: true };
    };
    function rounded(poly, R) {
      const n = poly.length, seg = [], cum = [0];
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n];
        seg.push(Math.hypot(b.x - a.x, b.y - a.y));
        cum.push(cum[i] + seg[i]);
      }
      const total = cum[n];
      const corners = [];
      for (let i = 0; i < n; i++) if (poly[i].corner) corners.push(i);
      if (!corners.length) return "M" + poly.map((q) => q.x.toFixed(2) + " " + q.y.toFixed(2)).join("L") + "Z";
      const at = (s) => {
        s = (s % total + total) % total;
        let i = 0;
        while (i < n - 1 && cum[i + 1] < s) i++;
        const t = seg[i] ? (s - cum[i]) / seg[i] : 0, a = poly[i], b = poly[(i + 1) % n];
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, i, s };
      };
      const k = corners.length;
      const fil = corners.map((ci, j) => {
        const prev = corners[(j + k - 1) % k], next = corners[(j + 1) % k];
        const back = k === 1 ? total : (cum[ci] - cum[prev] + total) % total || total;
        const fwd = k === 1 ? total : (cum[next] - cum[ci] + total) % total || total;
        const dA = Math.min(R, back * 0.5), dB = Math.min(R, fwd * 0.5);
        return { c: poly[ci], s: cum[ci], A: at(cum[ci] - dA), B: at(cum[ci] + dB) };
      });
      const f = (v) => v.toFixed(2);
      let d = `M${f(fil[0].B.x)} ${f(fil[0].B.y)}`;
      for (let j = 0; j < k; j++) {
        const from = fil[j], to = fil[(j + 1) % k];
        let gap = ((to.A.s - from.B.s) % total + total) % total;
        if (gap > total - 1e-3) gap = 0;
        const s0 = from.B.s, s1 = s0 + gap;
        for (let i = 0; i < 2 * n; i++) {
          const idx = i % n, s = cum[idx] + (i >= n ? total : 0);
          if (s > s0 + 1e-6 && s < s1 - 1e-6) d += `L${f(poly[idx].x)} ${f(poly[idx].y)}`;
          if (s >= s1) break;
        }
        d += `L${f(to.A.x)} ${f(to.A.y)}Q${f(to.c.x)} ${f(to.c.y)} ${f(to.B.x)} ${f(to.B.y)}`;
      }
      return d + "Z";
    }
    exports.roundInto = roundInto;
    exports.matrixOf = matrixOf;
  });
  __define("src/boopface-3d-layers.js", function(__require2, __import2, exports) {
    const { roundInto, matrixOf } = __require2("src/boopface-eye-shape.js");
    const D = 180;
    const NS = "http://www.w3.org/2000/svg";
    const EYES = [["leftEye", 86, 126], ["rightEye", 154, 126]];
    function showOnly(svg, keep) {
      const hidden = [];
      for (let n = keep; n && n !== svg && n.parentElement; n = n.parentElement)
        for (const s of n.parentElement.children) if (s !== n && !/^(defs|style)$/i.test(s.tagName)) {
          s.style.visibility = "hidden";
          hidden.push(s);
        }
      const used = /* @__PURE__ */ new Set();
      for (const el of [svg, ...svg.querySelectorAll("*")]) for (const a of el.attributes) for (const m of a.value.matchAll(/url\(\s*['"]?#([^'")\s]+)|^#(.+)$/g)) used.add(m[1] || m[2]);
      const needed = (el) => el.id && used.has(el.id) || [...el.querySelectorAll("[id]")].some((n) => used.has(n.id));
      const prune = (el) => {
        if (el.id && used.has(el.id)) return;
        if (!needed(el)) {
          el.remove();
          return;
        }
        for (const c of [...el.children]) prune(c);
      };
      for (const s of hidden) prune(s);
    }
    async function captureSkin(skin, roundness = 50, { color = null, eyeColor = null, eyeStyle = null } = {}) {
      var _a, _b, _c;
      const el = document.createElement("boop-face");
      el.style.cssText = "position:fixed;left:-9999px;top:0;--face-size:240px";
      if (skin) el.setAttribute("skin", skin);
      if (color) el.setAttribute("color", color);
      if (eyeColor) el.setAttribute("eye-color", eyeColor);
      if (eyeStyle) el.setAttribute("eye-style", eyeStyle);
      el.setAttribute("aria-hidden", "true");
      document.body.append(el);
      (_a = el.setHeadRoundness) == null ? void 0 : _a.call(el, roundness);
      const root = el.shadowRoot;
      for (let i = 0; i < 120; i++) {
        if (!skin || root.querySelector("svg defs linearGradient, svg defs radialGradient")) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      for (let i = 0; i < 3; i++) (_b = el._draw) == null ? void 0 : _b.call(el, performance.now());
      for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
      const styles = [...root.querySelectorAll("style")].map((s) => s.textContent).join("\n");
      const svg = root.querySelector("svg").cloneNode(true);
      const vars = [...el.style].filter((p) => p.startsWith("--")).map((p) => [p, el.style.getPropertyValue(p)]);
      el.remove();
      for (const id of ["dragMotion", "headFollow", "headMotion"]) {
        const n = svg.querySelector("#" + id);
        n == null ? void 0 : n.removeAttribute("transform");
        n == null ? void 0 : n.removeAttribute("style");
      }
      for (const [id, x, y] of EYES) (_c = svg.querySelector("#" + id)) == null ? void 0 : _c.setAttribute("transform", `translate(${x} ${y})`);
      const eyeLids = { Top: -96, Bottom: 36 };
      for (const side of ["left", "right"]) for (const [k, y] of Object.entries(eyeLids)) {
        const n = svg.querySelector(`#${side}${k}`);
        n == null ? void 0 : n.setAttribute("y", y);
        n == null ? void 0 : n.setAttribute("height", 60);
        n == null ? void 0 : n.setAttribute("transform", `rotate(0 0 ${k === "Top" ? -36 : 36})`);
      }
      return { styles, svg, vars };
    }
    function uniqueIds(svg, prefix) {
      const ids = new Set([...svg.querySelectorAll("defs [id]")].map((n) => n.id));
      for (const n of svg.querySelectorAll("defs [id]")) n.id = prefix + n.id;
      const fix = (v) => v.replace(/url\(#([^)]+)\)/g, (m, id) => ids.has(id) ? `url(#${prefix}${id})` : m).replace(/^#(.+)$/, (m, id) => ids.has(id) ? "#" + prefix + id : m);
      for (const n of svg.querySelectorAll("*")) for (const a of [...n.attributes]) if (/url\(#|^#/.test(a.value)) n.setAttribute(a.name, fix(a.value));
      return svg;
    }
    function uniqueAllIds(svg, prefix) {
      const ids = new Set([...svg.querySelectorAll("[id]")].map((n) => n.id));
      for (const n of svg.querySelectorAll("[id]")) n.id = prefix + n.id;
      const fix = (v) => v.replace(/url\(#([^)]+)\)/g, (m, id) => ids.has(id) ? `url(#${prefix}${id})` : m).replace(/^#(.+)$/, (m, id) => ids.has(id) ? "#" + prefix + id : m);
      for (const n of svg.querySelectorAll("*")) for (const a of [...n.attributes]) if (/url\(#|^#/.test(a.value)) n.setAttribute(a.name, fix(a.value));
      return svg;
    }
    function radiusTable(outline) {
      return Array.from({ length: 720 }, (_, i) => {
        const a = i * Math.PI / 360, dx = Math.cos(a), dy = Math.sin(a);
        let radius = Infinity;
        for (let j = 0; j < outline.length; j++) {
          const p = outline[j], q = outline[(j + 1) % outline.length], ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-8) continue;
          const t = (p[0] * ey - p[1] * ex) / den, u = (p[0] * dy - p[1] * dx) / den;
          if (t > 0 && u >= 0 && u <= 1) radius = Math.min(radius, t);
        }
        return radius;
      });
    }
    const hex = (c) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(c || "");
      return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
    };
    const css = (c) => "rgb(" + c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(",") + ")";
    function createLayeredAvatar(host, captured, { size = 300, depth = 52, slices = 10, sideColors = ["#08090b"], wrapStrips = 1, squash = false } = {}) {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i;
      const STRIPS = Math.max(1, wrapStrips | 0);
      const squashGain = { value: 1 };
      const squashOn = { value: squash === true ? "narrow" : squash || "off" };
      const u = size / 240, zoom = Math.sqrt(1 - (depth / D) ** 2);
      const root = host.shadowRoot || host.attachShadow({ mode: "open" });
      for (const [k, v] of captured.vars) host.style.setProperty(k, v);
      const pairStyles = captured.styles.split("}").filter((r) => /#(left|right)(Eye|Base|InputBase)\b/.test(r)).map((r) => r.replace(/#(left|right)(Eye|Base|InputBase)\b/g, "#pair-$1$2") + "}").join("\n");
      root.innerHTML = `<style>${captured.styles}
${pairStyles}
    :host{display:block;width:${size}px;height:${size}px}
    .stage{position:relative;width:${size}px;height:${size}px}
    .cut{position:absolute;inset:0}
    .scene{position:absolute;inset:0;perspective:${D * u}px;perspective-origin:50% 50%}
    .probe{position:absolute;width:0;height:0;overflow:hidden}
    /* See-through eyes: the eyes are holes cut through the whole head (below). */
    .stage.through .layer.eyes{opacity:0}
    .head{position:absolute;inset:0;transform-style:preserve-3d;will-change:transform}
    .wall{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
    .layer{position:absolute;left:0;top:0;width:${size}px;height:${size}px;pointer-events:none;will-change:transform;overflow:hidden}
    .layer svg{width:100%;height:100%;overflow:visible}
    /* The copied drawings are frozen: their motion groups must not become GPU
       layers of their own (each one a large hidden texture per avatar). */
    #dragMotion,#headFollow,#headMotion,[id$="dragMotion"],[id$="headFollow"],[id$="headMotion"]{will-change:auto}
  </style><div class="stage" role="img" aria-label="Robot avatar"><div class="cut"><div class="cut"><div class="cut"><div class="cut"><div class="scene"><div class="head" aria-hidden="true"></div></div></div></div></div></div></div><svg class="probe" aria-hidden="true"><path/></svg>`;
      for (const n of captured.svg.querySelectorAll("[mask]")) if (/eye-through/.test(n.getAttribute("mask"))) n.removeAttribute("mask");
      const head = root.querySelector(".head");
      let headD = captured.svg.querySelector("#headShape").getAttribute("d");
      const parseOutline = (d) => (d.match(/-?\d*\.?\d+/g) || []).map(Number).reduce((a, v, i, all) => i % 2 ? a : a.concat([[(v - 120) * 0.94, (all[i + 1] - 120) * 0.94]]), []);
      let outline = parseOutline(headD);
      let radii = radiusTable(outline);
      const radiusAt = (x, y) => {
        const a = (Math.atan2(y, x) * 360 / Math.PI % 720 + 720) % 720, i = Math.floor(a), f = a - i;
        return radii[i] * (1 - f) + radii[(i + 1) % 720] * f;
      };
      const height = (x, y) => {
        const r = radiusAt(x, y);
        return depth * Math.sqrt(Math.max(0, 1 - (x * x + y * y) / (r * r)));
      };
      const SKIP = "";
      const layer = (svg, transform, kind = "", box = null) => {
        const d = document.createElement("div");
        d.className = "layer " + kind;
        if (box) {
          const [x, y, w, h] = box;
          svg.setAttribute("viewBox", box.join(" "));
          Object.assign(d.style, { left: x * u + "px", top: y * u + "px", width: w * u + "px", height: h * u + "px" });
        }
        if (transform) d.style.transform = transform;
        d.append(svg);
        if (!SKIP.includes(kind || "x")) head.append(d);
        return d;
      };
      const scaleAt = (z) => Math.sqrt(Math.max(0, 1 - (z / depth) ** 2));
      const front = depth * depth / D;
      const tones = (Array.isArray(sideColors) ? sideColors : [sideColors]).map(hex).filter(Boolean);
      if (!tones.length) tones.push([8, 9, 11]);
      const wall = document.createElementNS(NS, "svg");
      wall.setAttribute("viewBox", "0 0 240 240");
      wall.setAttribute("class", "wall");
      wall.innerHTML = `<defs><linearGradient id="wall-paint" x1="0" y1="0" x2=".35" y2="1">${tones.map((c, n) => `<stop offset="${tones.length > 1 ? n / (tones.length - 1) : 0}" stop-color="${css(c.map((v) => v * 0.8))}"/>`).join("")}</linearGradient></defs><path fill="url(#wall-paint)"/>`;
      root.querySelector(".scene").prepend(wall);
      const wallPath = wall.querySelector("path");
      const sectionCount = Math.max(2, Math.min(slices, 5)), sections = Array.from({ length: sectionCount }, (_, i) => front - (front + depth * 0.92) * i / (sectionCount - 1));
      let wallOutline = outline, wallCache = null;
      const wallMemo = /* @__PURE__ */ new Map();
      let lastWallD = "";
      const drawWall = (Y, P, hm) => {
        const plain = wallOutline === outline && hm[0] === 1 && hm[1] === 0 && hm[2] === 0 && hm[3] === 1 && hm[4] === 0 && hm[5] === 0;
        const memoKey = plain ? Math.round(Y * 2) + "," + Math.round(P * 2) : "";
        if (plain && wallMemo.has(memoKey)) {
          const d2 = wallMemo.get(memoKey);
          if (d2 !== lastWallD) {
            wallPath.setAttribute("d", d2);
            lastWallD = d2;
          }
          return;
        }
        if (plain) {
          Y = Math.round(Y * 2) / 2;
          P = Math.round(P * 2) / 2;
        }
        if (!wallCache || wallCache.src !== wallOutline) {
          const pts2 = [];
          for (const z of sections) {
            const sc = scaleAt(z);
            for (let i = 0; i < wallOutline.length; i += 2) pts2.push(wallOutline[i][0] * sc, wallOutline[i][1] * sc, z);
          }
          wallCache = { src: wallOutline, pts: new Float64Array(pts2) };
        }
        const r = Math.PI / 180, cY = Math.cos(Y * r), sY = Math.sin(Y * r), cP = Math.cos(P * r), sP = Math.sin(P * r), a = wallCache.pts, pts = [];
        for (let i = 0; i < a.length; i += 3) {
          const x0 = a[i], y0 = a[i + 1], z0 = a[i + 2];
          const x1 = x0 * cY + z0 * sY, z1 = -x0 * sY + z0 * cY, y2 = y0 * cP - z1 * sP, z2 = y0 * sP + z1 * cP;
          const xa = x1 * zoom, ya = y2 * zoom, f = D / (D - z2);
          pts.push([120 + (hm[0] * xa + hm[2] * ya + hm[4]) * f, 120 + (hm[1] * xa + hm[3] * ya + hm[5]) * f]);
        }
        pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
        const half = (list) => {
          const out = [];
          for (const q of list) {
            while (out.length > 1) {
              const A = out[out.length - 2], B = out[out.length - 1];
              if ((B[0] - A[0]) * (q[1] - A[1]) - (B[1] - A[1]) * (q[0] - A[0]) > 0) break;
              out.pop();
            }
            out.push(q);
          }
          return out;
        };
        const hull = [...half(pts).slice(0, -1), ...half(pts.reverse()).slice(0, -1)];
        let d = "M" + hull.map((q) => Math.round(q[0] * 10) / 10 + " " + Math.round(q[1] * 10) / 10).join("L");
        d += "Z";
        if (plain && wallMemo.size < 4e3) wallMemo.set(memoKey, d);
        if (d !== lastWallD) {
          wallPath.setAttribute("d", d);
          lastWallD = d;
        }
      };
      const face = captured.svg.cloneNode(true);
      (_a = face.querySelector('[id$="joined-eye-surface"]')) == null ? void 0 : _a.remove();
      for (const id of ["antennaDot"]) (_b = face.querySelector("#" + id)) == null ? void 0 : _b.style.setProperty("visibility", "hidden");
      {
        const eyesHolder = (_c = face.querySelector("#leftEye")) == null ? void 0 : _c.parentElement;
        for (const id of ["leftEye", "rightEye"]) {
          const n = face.querySelector("#" + id);
          n == null ? void 0 : n.removeAttribute("id");
          n == null ? void 0 : n.replaceChildren();
        }
        eyesHolder == null ? void 0 : eyesHolder.style.setProperty("display", "none");
      }
      layer(face, `translateZ(${front * u}px) scale(${scaleAt(front)})`, "face");
      const GLOSS = ["main", "secondary", "reflection"].map((k) => face.querySelector(`[id$="-texture-${k}"]`)).filter(Boolean).map((node) => ({ node, original: node.getAttribute("transform") || "", center: null }));
      const decals = [], decalShapes = [];
      const onSurface = (sx, sy) => {
        const x = sx / zoom, y = sy / zoom, a = (x * x + y * y) / radiusAt(x, y) ** 2, d2 = depth * depth;
        const A = 1 + d2 * a / (D * D), B = -2 * d2 * a / D, C = d2 * (a - 1), z = (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A), k = 1 - z / D;
        return [x * k, y * k, z];
      };
      const outlinePaths = [...face.querySelectorAll('path[id$="headShape"]'), ...decalShapes];
      let basePoints = outline.map(([x, y]) => [x / 0.94 + 120, y / 0.94 + 120]);
      let bent = false;
      const glossCenter = (h) => {
        try {
          const b = h.node.getBBox(), m = matrixOf(h.node) || new DOMMatrix();
          const q = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(m);
          return b.width && Number.isFinite(q.x) ? [q.x, q.y] : [120, 120];
        } catch {
          return [120, 120];
        }
      };
      let bendNow = { x: 0, y: 0, hx: 120, hy: 120, r: 50 };
      const bendAt = (X, Y) => {
        const w = Math.exp(-((X - bendNow.hx) ** 2 + (Y - bendNow.hy) ** 2) / (2 * bendNow.r * bendNow.r));
        return [bendNow.x * w, bendNow.y * w];
      };
      const bend = (pullX, pullY, hotX, hotY) => {
        const amount = Math.hypot(pullX, pullY);
        bendNow = { x: pullX, y: pullY, hx: hotX, hy: hotY, r: (50 + amount * 0.8) * 0.92 };
        if (amount < 0.015) {
          if (bent) {
            for (const n of outlinePaths) n.setAttribute("d", headD);
            for (const h of GLOSS) h.node.setAttribute("transform", h.original);
            wallOutline = outline;
            bent = false;
          }
          return;
        }
        const radius = (50 + amount * 0.8) * 0.92;
        const d = "M " + basePoints.map(([x, y], i) => {
          const w = Math.exp(-((x - hotX) ** 2 + (y - hotY) ** 2) / (2 * radius * radius));
          return (i ? "L " : "") + (x + pullX * w).toFixed(2) + " " + (y + pullY * w).toFixed(2);
        }).join(" ") + " Z";
        for (const n of outlinePaths) n.setAttribute("d", d);
        bent = true;
        wallOutline = basePoints.map(([x, y]) => {
          const w = Math.exp(-((x - hotX) ** 2 + (y - hotY) ** 2) / (2 * radius * radius));
          return [(x + pullX * w - 120) * 0.94, (y + pullY * w - 120) * 0.94];
        });
        for (const h of GLOSS) {
          h.center ?? (h.center = glossCenter(h));
          const [cx, cy] = h.center, w = Math.exp(-((cx - hotX) ** 2 + (cy - hotY) ** 2) / (2 * radius * radius));
          h.node.setAttribute("transform", `translate(${(pullX * w).toFixed(2)} ${(pullY * w).toFixed(2)}) ${h.original}`);
        }
      };
      const antenna = captured.svg.cloneNode(true);
      const dot = antenna.querySelector("#antennaDot");
      let antennaNode = null, home = { x: 120, y: 12, r: 15 };
      if (dot) {
        showOnly(antenna, dot);
        const [cx, cy, r] = ["cx", "cy", "r"].map((a) => +dot.getAttribute(a)), pad = r + 6;
        home = { x: cx, y: cy, r };
        antennaNode = layer(antenna, "", "antenna", [cx - pad, cy - pad, pad * 2, pad * 2]);
        antennaNode.style.transformOrigin = `${pad * u}px ${pad * u}px`;
      }
      const STRIP_W = 80 / STRIPS, OVERLAP = STRIPS > 1 ? 1.2 : 0;
      const eyeCopy = (id, ex, ey, i, j) => {
        const side = i ? "right" : "left", pre = STRIPS > 1 ? `eye${i}s${j}-` : `eye${i}-`;
        const svg = uniqueIds(captured.svg.cloneNode(true), pre);
        const eye = svg.querySelector("#" + id);
        showOnly(svg, eye);
        eye.parentElement.removeAttribute("clip-path");
        const x0 = ex - 40 + j * STRIP_W - (j ? OVERLAP : 0), x1 = ex - 40 + (j + 1) * STRIP_W + (j < STRIPS - 1 ? OVERLAP : 0);
        const node = layer(svg, "", "eyes", [x0, ey - 48, x1 - x0, 98]);
        node.style.transformOrigin = `${(ex - x0) * u}px ${48 * u}px`;
        const parts = {
          base: svg.querySelector(`#${side}Base`),
          input: svg.querySelector(`#${side}InputBase`),
          top: svg.querySelector(`[id$="${side}Top"]`),
          bottom: svg.querySelector(`[id$="${side}Bottom"]`)
        };
        if (parts.top && parts.base && !parts.top.closest("mask")) {
          const lids = parts.top.parentElement, mask = document.createElementNS(NS, "mask");
          mask.id = `${pre}lids`;
          for (const [k, v] of Object.entries({ maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", x: -180, y: -240, width: 360, height: 480 })) mask.setAttribute(k, v);
          mask.innerHTML = '<rect x="-180" y="-240" width="360" height="480" fill="#fff"/>';
          for (const r of [parts.top, parts.bottom]) r == null ? void 0 : r.style.setProperty("fill", "#000");
          mask.append(lids);
          svg.querySelector("defs").append(mask);
          for (const n of [parts.base, parts.input]) n == null ? void 0 : n.setAttribute("mask", `url(#${pre}lids)`);
        }
        outlinePaths.push(...svg.querySelectorAll('path[id$="headShape"]'));
        return { node, svg, pre, parts, dx: (x0 + x1) / 2 - ex, box: [x0, ey - 48], origin: [(ex - x0) * u, 48 * u] };
      };
      const eyes = EYES.map(([id, ex, ey], i) => {
        const copies = Array.from({ length: STRIPS }, (_, j) => eyeCopy(id, ex, ey, i, j));
        return { copies, ex, ey, side: i ? "right" : "left", off: [0, 0], lin: [1, 0, 0, 1] };
      });
      const pairSvg = uniqueAllIds(captured.svg.cloneNode(true), "pair-");
      let pairModes = null, paintsLikeFlat = false;
      {
        const eyesGroup = pairSvg.querySelector("#pair-leftEye").parentElement, joined = pairSvg.querySelector('[id$="joined-eye-surface"]');
        const motion = pairSvg.querySelector("#pair-headMotion");
        for (const c of [...motion.children]) if (c !== eyesGroup && c !== joined) c.remove();
        (_d = pairSvg.querySelector("#pair-antennaDot")) == null ? void 0 : _d.remove();
        paintsLikeFlat = !!joined;
        joined == null ? void 0 : joined.remove();
        eyesGroup.removeAttribute("clip-path");
        eyesGroup.style.opacity = "0";
        for (const n of eyesGroup.querySelectorAll("#pair-leftEye,#pair-rightEye")) n.style.filter = "none";
        const union = document.createElementNS(NS, "mask");
        union.id = "pair-union";
        union.style.maskType = "alpha";
        for (const [k, v] of Object.entries({ maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", x: -60, y: -60, width: 360, height: 360 })) union.setAttribute(k, v);
        union.innerHTML = ["left", "right"].map((side) => `<g id="pair-m-${side}"><ellipse id="pair-m-${side}Base" fill="#fff"/><rect id="pair-m-${side}InputBase" fill="#fff" opacity="0"/></g>`).join("");
        pairSvg.querySelector("defs").append(union);
        const sheet = document.createElementNS(NS, "g");
        sheet.setAttribute("style", "filter:var(--material-eye-relief,none)");
        sheet.innerHTML = '<rect x="-60" y="-60" width="360" height="360" fill="var(--material-eye,#fff)" mask="url(#pair-union)"/>';
        eyesGroup.after(sheet);
        pairModes = { eyesGroup, sheet, eyes: [...eyesGroup.querySelectorAll("#pair-leftEye,#pair-rightEye")] };
      }
      const pair = { node: layer(pairSvg, "", "eyes", [0, 0, 240, 240]), sides: ["left", "right"].map((side, i) => {
        var _a2;
        const parts = {
          group: pairSvg.querySelector(`#pair-${side}Eye`),
          base: pairSvg.querySelector(`#pair-${side}Base`),
          input: pairSvg.querySelector(`#pair-${side}InputBase`),
          top: pairSvg.querySelector(`[id$="${side}Top"]`),
          bottom: pairSvg.querySelector(`[id$="${side}Bottom"]`)
        };
        if (parts.top && parts.base && !parts.top.closest("mask")) {
          const lids = parts.top.parentElement, mask = document.createElementNS(NS, "mask");
          mask.id = `pair-lids-${i}`;
          for (const [k, v] of Object.entries({ maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", x: -180, y: -240, width: 360, height: 480 })) mask.setAttribute(k, v);
          mask.innerHTML = '<rect x="-180" y="-240" width="360" height="480" fill="#fff"/>';
          for (const r of [parts.top, parts.bottom]) r == null ? void 0 : r.style.setProperty("fill", "#000");
          mask.append(lids);
          pairSvg.querySelector("defs").append(mask);
          for (const n of [parts.base, parts.input]) n == null ? void 0 : n.setAttribute("mask", `url(#pair-lids-${i})`);
        }
        const m = { group: pairSvg.querySelector(`#pair-m-${side}`), base: pairSvg.querySelector(`#pair-m-${side}Base`), input: pairSvg.querySelector(`#pair-m-${side}InputBase`) };
        for (const k of ["base", "input"]) {
          const lid = (_a2 = parts[k]) == null ? void 0 : _a2.getAttribute("mask");
          if (lid && m[k]) m[k].setAttribute("mask", lid);
        }
        return { side, parts, m };
      }) };
      pair.node.style.transformOrigin = `${120 * u}px ${126 * u}px`;
      pair.node.style.display = "none";
      let unionPaint = null;
      {
        const sheetRect = pairSvg.querySelector('rect[mask="url(#pair-union)"]'), sheet = sheetRect == null ? void 0 : sheetRect.parentElement, base = pair.sides[0].parts.base;
        const fillId = base && ((_e = getComputedStyle(base).fill.match(/url\("?#([^")]+)"?\)/)) == null ? void 0 : _e[1]), grad = fillId && (pairSvg.querySelector("#" + CSS.escape(fillId.startsWith("pair-") ? fillId : "pair-" + fillId)) || pairSvg.querySelector("#" + CSS.escape(fillId)));
        const plain = base && getComputedStyle(base).fill;
        if (sheetRect && paintsLikeFlat) for (const [k, v] of [["x", 0], ["y", 0], ["width", 240], ["height", 240]]) sheetRect.setAttribute(k, v);
        else if (sheetRect && plain && !/url\(/.test(plain) && plain !== "none") sheetRect.setAttribute("fill", plain);
        if (sheetRect && !paintsLikeFlat && /Gradient$/.test((grad == null ? void 0 : grad.tagName) || "")) {
          unionPaint = grad.cloneNode(true);
          unionPaint.id = "pair-union-paint";
          unionPaint.setAttribute("gradientUnits", "userSpaceOnUse");
          unionPaint.removeAttribute("gradientTransform");
          pairSvg.querySelector("defs").append(unionPaint);
          sheetRect.setAttribute("fill", "url(#pair-union-paint)");
        }
        const eyeFilter = (_f = pair.sides[0].parts.group) == null ? void 0 : _f.getAttribute("filter"), fid = (_g = eyeFilter == null ? void 0 : eyeFilter.match(/url\(#([^)]+)\)/)) == null ? void 0 : _g[1], f = fid && pairSvg.querySelector("#" + CSS.escape(fid));
        if (sheet && f) {
          const copy = f.cloneNode(true);
          copy.id = "pair-union-sink";
          for (const [k, v] of [["filterUnits", "userSpaceOnUse"], ["x", -60], ["y", -60], ["width", 360], ["height", 360]]) copy.setAttribute(k, v);
          pairSvg.querySelector("defs").append(copy);
          sheet.setAttribute("style", "filter:url(#pair-union-sink)");
        }
        for (const { parts } of pair.sides) {
          parts.filterAttr = (_h = parts.group) == null ? void 0 : _h.getAttribute("filter");
          (_i = parts.group) == null ? void 0 : _i.removeAttribute("filter");
        }
      }
      let joinedNow = null;
      const setJoined = (on) => {
        if (!pairModes || joinedNow === on) return;
        joinedNow = on;
        pairModes.eyesGroup.style.opacity = on ? "0" : "1";
        pairModes.sheet.style.display = on ? "" : "none";
        for (const { parts } of pair.sides) {
          if (!parts.group) continue;
          parts.group.style.filter = on ? "none" : "";
          if (parts.filterAttr) on ? parts.group.removeAttribute("filter") : parts.group.setAttribute("filter", parts.filterAttr);
        }
      };
      const fitUnionPaint = () => {
        if (!unionPaint || pair.node.style.display === "none") return;
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const { m } of pair.sides) {
          const b = m.base.getBBox(), mt = matrixOf(m.group) || new DOMMatrix();
          for (const [x, y] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]) {
            const q = new DOMPoint(x, y).matrixTransform(mt);
            x0 = Math.min(x0, q.x);
            y0 = Math.min(y0, q.y);
            x1 = Math.max(x1, q.x);
            y1 = Math.max(y1, q.y);
          }
        }
        if (unionPaint.tagName === "linearGradient") {
          unionPaint.setAttribute("x1", x1.toFixed(2));
          unionPaint.setAttribute("y1", y0.toFixed(2));
          unionPaint.setAttribute("x2", x0.toFixed(2));
          unionPaint.setAttribute("y2", y1.toFixed(2));
        } else {
          const rel = (k) => {
            var _a2;
            return parseFloat((_a2 = unionPaint.dataset)[k] ?? (_a2[k] = unionPaint.getAttribute(k) ?? (k === "r" ? ".5" : ".5")));
          };
          const w = x1 - x0, h = y1 - y0;
          unionPaint.setAttribute("cx", (x0 + rel("cx") * w).toFixed(2));
          unionPaint.setAttribute("cy", (y0 + rel("cy") * h).toFixed(2));
          unionPaint.setAttribute("r", (rel("r") * Math.max(w, h)).toFixed(2));
          if (unionPaint.hasAttribute("fx")) {
            unionPaint.setAttribute("fx", (x0 + rel("fx") * w).toFixed(2));
            unionPaint.setAttribute("fy", (y0 + rel("fy") * h).toFixed(2));
          }
        }
      };
      outlinePaths.push(...pairSvg.querySelectorAll('path[id$="headShape"]'));
      const SHAPE = { base: ["cx", "cy", "rx", "ry", "opacity", "data-shape"], input: ["x", "y", "width", "height", "opacity", "rx", "ry"], top: ["y", "height", "transform"], bottom: ["y", "height", "transform"] };
      let lastSig = "", roundR = () => 0;
      const roundTargets = [];
      const syncEyes = (brain2) => {
        var _a2, _b2, _c2, _d2;
        const r = brain2 == null ? void 0 : brain2.shadowRoot;
        if (!r) return;
        const look = brain2._look || { x: 0, y: 0 };
        const R = roundR();
        let sig = R + "," + look.x.toFixed(2) + "," + look.y.toFixed(2);
        for (const side of ["left", "right"]) {
          sig += (_a2 = r.getElementById(side + "Eye")) == null ? void 0 : _a2.getAttribute("transform");
          const b = r.getElementById(side + "Base"), t = r.getElementById(side + "Top"), bo = r.getElementById(side + "Bottom"), ib = r.getElementById(side + "InputBase");
          sig += (b == null ? void 0 : b.getAttribute("data-shape")) + (b == null ? void 0 : b.getAttribute("rx")) + (b == null ? void 0 : b.getAttribute("ry")) + (b == null ? void 0 : b.getAttribute("cy")) + (b == null ? void 0 : b.getAttribute("opacity")) + (t == null ? void 0 : t.getAttribute("y")) + (t == null ? void 0 : t.getAttribute("transform")) + (bo == null ? void 0 : bo.getAttribute("y")) + (bo == null ? void 0 : bo.getAttribute("transform")) + (ib == null ? void 0 : ib.getAttribute("opacity")) + (ib == null ? void 0 : ib.getAttribute("width")) + (ib == null ? void 0 : ib.getAttribute("height")) + (ib == null ? void 0 : ib.getAttribute("x")) + (ib == null ? void 0 : ib.getAttribute("y")) + (ib == null ? void 0 : ib.getAttribute("rx")) + (ib == null ? void 0 : ib.getAttribute("ry"));
        }
        if (sig === lastSig) return;
        lastSig = sig;
        lookAdd = [look.x / 36, look.y / 27];
        for (const eye of eyes) {
          const from = { base: r.getElementById(eye.side + "Base"), input: r.getElementById(eye.side + "InputBase"), top: r.getElementById(eye.side + "Top"), bottom: r.getElementById(eye.side + "Bottom") };
          for (const copy of eye.copies) for (const [k, attrs] of Object.entries(SHAPE)) {
            const a = from[k], b = copy.parts[k];
            if (!a || !b) continue;
            for (const name of attrs) {
              const v = a.getAttribute(name);
              if (v !== null && v !== b.getAttribute(name)) b.setAttribute(name, v);
              else if (v === null && name === "data-shape" && b.hasAttribute(name)) b.removeAttribute(name);
            }
          }
          const src = r.getElementById(eye.side + "Eye"), m = matrixOf(src);
          if (m) {
            eye.off = [m.e - eye.ex - look.x, m.f - eye.ey - look.y];
            eye.lin = [m.a, m.b, m.c, m.d];
          }
          if (brain2._randomFx) {
            const fb = from.base, rcx = +((fb == null ? void 0 : fb.getAttribute("cx")) || 0), rcy = +((fb == null ? void 0 : fb.getAttribute("cy")) || 0);
            eye.off = [eye.off[0] + rcx * eye.lin[0] + rcy * eye.lin[2], eye.off[1] + rcx * eye.lin[1] + rcy * eye.lin[3]];
            for (const part of eye.copies.map((c) => c.parts.base)) {
              if ((part == null ? void 0 : part.getAttribute("cx")) !== "0") part == null ? void 0 : part.setAttribute("cx", "0");
              if ((part == null ? void 0 : part.getAttribute("cy")) !== "0") part == null ? void 0 : part.setAttribute("cy", "0");
            }
          }
          const rxA = (_b2 = r.getElementById(eye.side + "Base")) == null ? void 0 : _b2.getAttribute("rx");
          eye.rx = rxA == null ? 27 : +rxA;
          const ryA = (_c2 = r.getElementById(eye.side + "Base")) == null ? void 0 : _c2.getAttribute("ry"), ry = ryA == null ? 29 : +ryA;
          eye.narrowX = Math.max(0, Math.min(1, 1 - 2 * eye.rx / 54, 1 - eye.rx / Math.max(ry, 1) / (27 / 29)));
          if ((brain2._center ?? 0) > 1e-3 || brain2._state === "input") eye.narrowX = 0;
          eye.narrow = Math.max(eye.narrowX, brain2._randomFx ? Math.max(0, Math.min(1, 1 - ry / 29)) : 0);
        }
        for (const { side, parts } of pair.sides) {
          const from = { base: r.getElementById(side + "Base"), input: r.getElementById(side + "InputBase"), top: r.getElementById(side + "Top"), bottom: r.getElementById(side + "Bottom") };
          for (const [k, attrs] of Object.entries(SHAPE)) {
            const a = from[k], b = parts[k];
            if (!a || !b) continue;
            for (const name of attrs) {
              const v = a.getAttribute(name);
              if (v !== null && v !== b.getAttribute(name)) b.setAttribute(name, v);
              else if (v === null && name === "data-shape" && b.hasAttribute(name)) b.removeAttribute(name);
            }
          }
          const t = `translate(${(-look.x).toFixed(2)} ${(-look.y).toFixed(2)}) ${((_d2 = r.getElementById(side + "Eye")) == null ? void 0 : _d2.getAttribute("transform")) || ""}`;
          if (parts.group && parts.group.getAttribute("transform") !== t) parts.group.setAttribute("transform", t);
          const m = pair.sides.find((x) => x.side === side).m;
          if (m.group && m.group.getAttribute("transform") !== t) m.group.setAttribute("transform", t);
          for (const k of ["base", "input"]) {
            const a = from[k], b = m[k];
            if (!a || !b) continue;
            for (const name of SHAPE[k]) {
              const v = a.getAttribute(name);
              if (v !== null && v !== b.getAttribute(name)) b.setAttribute(name, v);
            }
          }
        }
        if (!roundTargets.length) {
          eyes.forEach((eye, i) => eye.copies.forEach((c, j) => roundTargets.push({ svg: c.svg, id: `${c.pre}round`, ...c.parts })));
          for (const { side, parts, m } of pair.sides) roundTargets.push({ svg: pairSvg, id: `pair-round-${side}`, base: parts.base, input: parts.input, top: parts.top, bottom: parts.bottom, also: [m.base], alsoInput: [m.input] });
        }
        for (const t of roundTargets) roundInto(t, R);
      };
      const EYE_TILT = 1;
      const surface = (sx, sy, limit = 0.75) => {
        let z = 0, x = 0, y = 0;
        for (let k = 0; k < 5; k++) {
          x = sx * (D - z) / (D * zoom);
          y = sy * (D - z) / (D * zoom);
          const reach = Math.hypot(x, y) / (limit * radiusAt(x, y));
          if (reach > 1) {
            x /= reach;
            y /= reach;
          }
          z = Math.max(front + 3, front + (height(x, y) - front) * 0.9);
        }
        const e = 0.5, hx = (height(x + e, y) - height(x - e, y)) / (2 * e), hy = (height(x, y + e) - height(x, y - e)) / (2 * e);
        const lift = front + 2 + 34 * Math.hypot(hx, hy) * EYE_TILT;
        if (z < lift) {
          z = lift;
          x = sx * (D - z) / (D * zoom);
          y = sy * (D - z) / (D * zoom);
        }
        return { x, y, z, hx, hy, k: (D - z) / (D * zoom) };
      };
      const eyeMatrix = (eye, c, ox = 0, oy = 0) => {
        const tilt = EYE_TILT * (1 - (eye.narrow || 0));
        const [a, b, cc, d] = eye.lin, k = c.k, hx = c.hx * tilt, hy = c.hy * tilt, n = [-hx, -hy, 1], nl = Math.hypot(...n);
        const x = c.x + k * ox, y = c.y + k * oy, z = c.z + k * (ox * hx + oy * hy);
        return [k * a, k * b, k * (a * hx + b * hy), 0, k * cc, k * d, k * (cc * hx + d * hy), 0, n[0] / nl, n[1] / nl, n[2] / nl, 0, (120 + x - eye.ex) * u, (120 + y - eye.ey) * u, z * u, 1];
      };
      let curY = 0, curP = 0, hullFor = null, hullPts = [];
      const project = (x, y, z) => {
        const r = Math.PI / 180, cY = Math.cos(curY * r), sY = Math.sin(curY * r), cP = Math.cos(curP * r), sP = Math.sin(curP * r);
        const x1 = x * cY + z * sY, z1 = -x * sY + z * cY, y2 = y * cP - z1 * sP, z2 = y * sP + z1 * cP, f = D / (D - z2);
        return { x: x1 * zoom * f, y: y2 * zoom * f };
      };
      let rimFor = "", rimX = [26, 214];
      const headRim = () => {
        var _a2, _b2, _c2, _d2;
        const shape = brain == null ? void 0 : brain._headShape, head2 = brain == null ? void 0 : brain._head, key = ((shape == null ? void 0 : shape.getAttribute("d")) || "") + "|" + ((head2 == null ? void 0 : head2.getAttribute("transform")) || "");
        if (shape && key !== rimFor) {
          rimFor = key;
          try {
            const b = shape.getBBox(), m = (_d2 = (_c2 = (_b2 = (_a2 = head2 == null ? void 0 : head2.transform) == null ? void 0 : _a2.baseVal) == null ? void 0 : _b2.consolidate) == null ? void 0 : _c2.call(_b2)) == null ? void 0 : _d2.matrix;
            if (b.width) rimX = m ? [m.a * b.x + m.e, m.a * (b.x + b.width) + m.e] : [b.x, b.x + b.width];
          } catch {
          }
        }
        return rimX;
      };
      const hugSide = (c, sx, sy, eye) => {
        var _a2;
        const n = eye.narrowX || 0;
        if (n <= 0) return c;
        const sign = Math.sign(sx) || 1, eyeScr = project(c.x, c.y, c.z);
        if (hullFor !== lastWallD) {
          hullFor = lastWallD;
          hullPts = (lastWallD.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        }
        let edge = -Infinity;
        for (let i = 0; i + 1 < hullPts.length; i += 2) {
          const ax = hullPts[i] - 120, ay = hullPts[i + 1] - 120, j = (i + 2) % hullPts.length, bx = hullPts[j] - 120, by = hullPts[j + 1] - 120;
          if ((ay - eyeScr.y) * (by - eyeScr.y) <= 0 && ay !== by) edge = Math.max(edge, sign * (ax + (bx - ax) * (eyeScr.y - ay) / (by - ay)));
        }
        if (!isFinite(edge)) return c;
        const want = edge - eye.rx * (eye.lin[0] || 1) + 0.3;
        let x = c.x;
        for (let k = 0; k < 3; k++) {
          const q = project(x, c.y, c.z), d = want - sign * q.x, slope = Math.max(0.3, Math.abs(project(x + sign, c.y, c.z).x - q.x));
          x += sign * d / slope;
        }
        let w;
        if (((_a2 = brain == null ? void 0 : brain._waitingFx) == null ? void 0 : _a2.variant) === "wrap") {
          const rim = headRim(), ox = eye.ex + eye.off[0], half = eye.rx * Math.abs(eye.lin[0] || 1);
          const gap = sign < 0 ? ox - half - rim[0] : rim[1] - (ox + half);
          w = Math.max(0, Math.min(1, 1 - gap / 10));
        } else w = Math.max(0, Math.min(1, (n - 0.15) / 0.45));
        const s = w * w * (3 - 2 * w);
        return { ...c, x: c.x + (x - c.x) * s, hx: c.hx * (1 - s), hy: c.hy * (1 - s) };
      };
      const placeEyes = (gx, gy) => {
        var _a2;
        const t = eyes.map((e) => [e.ex - 120 + e.off[0] + gx * 90, e.ey - 120 + e.off[1] + gy * 90]);
        const size2 = (1 - (eyes[0].narrow || 0) + (1 - (eyes[1].narrow || 0))) / 2;
        const gone = eyes.some((e) => (e.rx ?? 27) < 1);
        const gap = Math.hypot(t[0][0] - t[1][0], t[0][1] - t[1][1]), rigid = gone ? 0 : Math.max(0, Math.min(1, (56 * size2 - gap) / 20));
        const asOne = !!((_a2 = brain == null ? void 0 : brain._eyesAsOne) == null ? void 0 : _a2.call(brain, 8));
        const mid = [(t[0][0] + t[1][0]) / 2, (t[0][1] + t[1][1]) / 2], anchor = rigid > 0 || asOne ? surface(...mid, 0.7) : null;
        const together = asOne || rigid >= 0.5;
        pair.node.style.display = together ? "" : "none";
        for (const e of eyes) for (const c of e.copies) c.node.style.display = together ? "none" : "";
        if (together) {
          const mo = [(eyes[0].off[0] + eyes[1].off[0]) / 2, (eyes[0].off[1] + eyes[1].off[1]) / 2];
          const pm = eyeMatrix({ ex: 120, ey: 126, lin: [1, 0, 0, 1] }, anchor, -mo[0], -mo[1]);
          pair.node.style.transform = `matrix3d(${pm.map((v) => +v.toFixed(5)).join(",")})`;
          pair.m = pm;
          pair.on = true;
          setJoined(asOne || !!(!(brain == null ? void 0 : brain._eyesAsOne) && (brain == null ? void 0 : brain._loveFx)));
          fitUnionPaint();
          return;
        }
        pair.on = false;
        eyes.forEach((eye, i) => {
          const [a, b, cc, d] = eye.lin;
          const edges = STRIPS > 1 ? Array.from({ length: STRIPS + 1 }, (_, j) => {
            const bx = -40 + j * STRIP_W;
            return { bx, s: surface(t[i][0] + bx * a, t[i][1] + bx * b) };
          }) : null;
          eye.copies.forEach((c, j) => {
            let m;
            if (!edges) m = eyeMatrix(eye, hugSide(surface(...t[i], 0.75 + 0.25 * (eye.narrow || 0) ** 0.6), t[i][0], t[i][1], eye));
            else {
              const A = edges[j], B = edges[j + 1], s = A.s, e = B.s;
              const X = [(e.x - s.x) / STRIP_W, (e.y - s.y) / STRIP_W, (e.z - s.z) / STRIP_W];
              const k = (s.k + e.k) / 2, hx = (s.hx + e.hx) / 2 * EYE_TILT, hy = (s.hy + e.hy) / 2 * EYE_TILT;
              const Yv = [k * cc, k * d, k * (cc * hx + d * hy)], n = [-hx, -hy, 1], nl = Math.hypot(...n);
              const o = [s.x - X[0] * A.bx, s.y - X[1] * A.bx, s.z - X[2] * A.bx];
              m = [X[0], X[1], X[2], 0, Yv[0], Yv[1], Yv[2], 0, n[0] / nl, n[1] / nl, n[2] / nl, 0, (120 + o[0] - eye.ex) * u, (120 + o[1] - eye.ey) * u, o[2] * u, 1];
            }
            if (anchor) {
              const r = eyeMatrix(eye, anchor, t[i][0] - mid[0], t[i][1] - mid[1]);
              m = m.map((v, j2) => v + (r[j2] - v) * rigid);
            }
            c.node.style.transform = `matrix3d(${m.map((v) => +v.toFixed(5)).join(",")})`;
            c.m = m;
          });
        });
      };
      const cuts = [...root.querySelectorAll(".cut")], probe = root.querySelector(".probe path");
      const sampled = /* @__PURE__ */ new Map();
      const sampleD = (d) => {
        let pts = sampled.get(d);
        if (pts) return pts;
        probe.setAttribute("d", d);
        const L = probe.getTotalLength();
        pts = [];
        for (let i = 0; i < 64; i++) {
          const q = probe.getPointAtLength(L * i / 64);
          pts.push([q.x, q.y]);
        }
        if (sampled.size > 300) sampled.clear();
        sampled.set(d, pts);
        return pts;
      };
      const num = (el, a, dflt = 0) => {
        const v = el == null ? void 0 : el.getAttribute(a);
        return v == null || v === "" ? dflt : +v;
      };
      const ring = (cx, cy, rx, ry) => Array.from({ length: 48 }, (_, i) => {
        const t = i / 48 * Math.PI * 2;
        return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
      });
      const roundRect = (x, y, w, h, r) => {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        const p = [];
        for (const [cx, cy, a0] of [[x + w - r, y + r, -90], [x + w - r, y + h - r, 0], [x + r, y + h - r, 90], [x + r, y + r, 180]])
          for (let i = 0; i <= 6; i++) {
            const a = (a0 + 15 * i) * Math.PI / 180;
            p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
          }
        return p;
      };
      const outlines = (r, side) => {
        var _a2, _b2, _c2, _d2;
        const base = r.getElementById(side + "Base"), input = r.getElementById(side + "InputBase");
        let a = null, b = null;
        if (base && num(base, "opacity", 1) > 0.01) {
          const id = (_b2 = (_a2 = base.getAttribute("clip-path")) == null ? void 0 : _a2.match(/#([^)"']+)/)) == null ? void 0 : _b2[1], d = id && ((_d2 = (_c2 = r.getElementById(id)) == null ? void 0 : _c2.querySelector("path")) == null ? void 0 : _d2.getAttribute("d"));
          const rx = num(base, "rx"), ry = num(base, "ry");
          a = d ? sampleD(d) : rx > 0.05 && ry > 0.05 ? ring(num(base, "cx"), num(base, "cy"), rx, ry) : null;
          const m = a ? matrixOf(base) : null;
          if (m) a = a.map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
        }
        if (input && num(input, "opacity", 1) > 0.01 && num(input, "width") > 0.05 && num(input, "height") > 0.05)
          b = roundRect(num(input, "x"), num(input, "y"), num(input, "width"), num(input, "height"), num(input, "rx"));
        return [a, b];
      };
      let cutOn = false;
      const cutHoles = () => {
        const through = /^(transparent|none|through)$/i.test(String((brain == null ? void 0 : brain._eyeColorApplied) || ""));
        if (!through) {
          if (cutOn) {
            cutOn = false;
            stage.classList.remove("through");
            for (const c of cuts) c.style.clipPath = "";
          }
          return;
        }
        if (!cutOn) {
          cutOn = true;
          stage.classList.add("through");
        }
        const r = brain.shadowRoot, c0 = size / 2;
        const H = new DOMMatrix().translate(c0, c0).multiply(new DOMMatrix(head.style.transform || "matrix(1,0,0,1,0,0)")).translate(-c0, -c0);
        const P = new DOMMatrix().translate(c0, c0).multiply(new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / (D * u), 0, 0, 0, 1])).translate(-c0, -c0);
        const PH = P.multiply(H), big = size * 2, f = (v) => Math.round(v * 10) / 10;
        ["left", "right"].forEach((side, i) => {
          const eye = eyes[i], copy = eye.copies[0];
          let box, origin, m, place;
          if (pair.on && pair.m) {
            box = [0, 0];
            origin = [120 * u, 126 * u];
            m = pair.m;
            const gm = matrixOf(pair.sides[i].parts.group) || new DOMMatrix();
            place = ([x, y]) => [gm.a * x + gm.c * y + gm.e, gm.b * x + gm.d * y + gm.f];
          } else {
            box = copy.box;
            origin = copy.origin;
            m = copy.m;
            place = ([x, y]) => [eye.ex + x, eye.ey + y];
          }
          const F = m && PH.multiply(new DOMMatrix().translate(box[0] * u + origin[0], box[1] * u + origin[1]).multiply(new DOMMatrix(m)).translate(-origin[0], -origin[1]));
          outlines(r, side).forEach((pts, k) => {
            let clip = "";
            if (pts && F) {
              let d = "";
              for (const q of pts) {
                const [x, y] = place(q), v = F.transformPoint(new DOMPoint((x - box[0]) * u, (y - box[1]) * u, 0, 1));
                d += (d ? "L" : "M") + f(v.x / v.w) + " " + f(v.y / v.w);
              }
              clip = `path(evenodd, "M${-big} ${-big}H${big}V${big}H${-big}Z${d}Z")`;
            }
            const el = cuts[i * 2 + k];
            if (el._clip !== clip) {
              el._clip = clip;
              el.style.clipPath = clip;
            }
          });
        });
      };
      const stage = root.querySelector(".stage");
      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
      host.style.touchAction = "none";
      host.style.cursor = "pointer";
      let brain = null, lastTime = performance.now(), last = "", touch = 0, center = 0, headAnim = "";
      var lookAdd = [0, 0];
      const attachBrain = (b) => {
        brain = b;
      };
      host.addEventListener("pointerdown", (e) => {
        if (!brain || e.button !== 0) return;
        if (brain._antennaDot && antennaNode) {
          const hr = host.getBoundingClientRect(), b = ballScreen(), cx = hr.left + b.x * u, cy = hr.top + b.y * u;
          const r = { width: (home.r * 2 + 4) * u * b.s, height: (home.r * 2 + 4) * u * b.s };
          const near = Math.hypot(e.clientX - cx, e.clientY - cy) <= Math.max(18, r.width * 0.8);
          brain._antennaDot.getBoundingClientRect = near ? () => new DOMRect(e.clientX - r.width / 2, e.clientY - r.height / 2, r.width, r.height) : () => new DOMRect(cx - r.width / 2, cy - r.height / 2, r.width, r.height);
        }
      });
      const busy = () => {
        var _a2, _b2;
        return !!(brain && (brain._gestureFx || ((_a2 = brain._dragJelly) == null ? void 0 : _a2.active) || ((_b2 = brain._dragJelly) == null ? void 0 : _b2.returning)));
      };
      let shown = { Y: 0, P: 0, hm: [1, 0, 0, 1, 0, 0], ax: 0, ay: 0 }, tugAngle = null;
      const sq = { a: 0, v: 0, Y: 0, P: 0, sY: 0, sP: 0 };
      const LIGHT_ATTRS = ["cx", "cy", "fx", "fy", "r", "x1", "x2", "y1", "y2", "dx", "dy", "gradientTransform", "offset", "stop-color", "stop-opacity", "opacity", "transform"];
      let lightPairs = null, lastLight = "", pairsFor, lightSeen = 0;
      const lightTargets = [[face, ""], ...eyes.flatMap((e) => e.copies.map((c) => [c.svg, c.pre])), [pairSvg, "pair-"]];
      const syncLight = (b) => {
        var _a2;
        const L = b._skinLight;
        if (!L) return;
        if (b._skinShown !== pairsFor) {
          pairsFor = b._skinShown;
          lightPairs = null;
          lastLight = "";
          lightSeen = 0;
        }
        const key = L.x.toFixed(3) + "," + L.y.toFixed(3);
        if (key === lastLight) return;
        lastLight = key;
        if (!lightPairs) {
          lightPairs = [];
          lightSeen = 0;
          const bd = (_a2 = b.shadowRoot) == null ? void 0 : _a2.querySelector("svg defs");
          if (!bd) return;
          for (const src of bd.children) {
            if (!src.id) continue;
            const a = [src, ...src.querySelectorAll("*")];
            for (const [svg, prefix] of lightTargets) {
              const dst = svg.querySelector("defs #" + CSS.escape(prefix + src.id));
              if (!dst) continue;
              const c = [dst, ...dst.querySelectorAll("*")];
              if (a.length === c.length) a.forEach((n, i) => lightPairs.push([n, c[i]]));
            }
          }
        }
        lightSeen++;
        for (const pair2 of lightPairs) for (const name of LIGHT_ATTRS) {
          const v = pair2[0].getAttribute(name);
          if (v !== null && v !== pair2[1].getAttribute(name)) {
            pair2[1].setAttribute(name, v);
            pair2.live = true;
          }
        }
        if (lightSeen === 12) lightPairs = lightPairs.filter((p) => p.live);
      };
      const ballScreen = () => {
        const { Y, P, hm, ax, ay } = shown, r = Math.PI / 180;
        const x0 = home.x + ax - 120, y0 = home.y + ay - 120;
        const x1 = x0 * Math.cos(Y * r), z1 = -x0 * Math.sin(Y * r), y2 = y0 * Math.cos(P * r) - z1 * Math.sin(P * r), z2 = y0 * Math.sin(P * r) + z1 * Math.cos(P * r);
        const xa = x1 * zoom, ya = y2 * zoom, f = D / (D - z2);
        return { x: 120 + (hm[0] * xa + hm[2] * ya + hm[4]) * f, y: 120 + (hm[1] * xa + hm[3] * ya + hm[5]) * f, s: f * zoom };
      };
      return {
        // Call each frame with the running official avatar.
        syncEyes(b) {
          attachBrain(b);
          syncEyes(b);
          syncLight(b);
        },
        // A new head outline (the roundness slider being dragged): the face, the
        // side wall and the eye surface follow at once; the full rebuild (skin
        // highlights traced again) comes once the slider rests.
        setHeadPath(d) {
          if (!d || d === headD) return;
          headD = d;
          outline = parseOutline(d);
          radii = radiusTable(outline);
          basePoints = outline.map(([x, y]) => [x / 0.94 + 120, y / 0.94 + 120]);
          if (!bent) {
            for (const n of outlinePaths) n.setAttribute("d", d);
            wallOutline = outline;
          }
          wallCache = null;
          wallMemo.clear();
          last = "";
        },
        // The official expression motion (bounce, droop, surprise pop, squeeze
        // shake) as a CSS transform string, applied around the head centre.
        setHeadMotion(t) {
          headAnim = t && t !== "none" ? t.startsWith("matrix(") ? t : new DOMMatrix(t).toString() : "";
        },
        // yaw/pitch in degrees, gaze in -1..1. Turning only changes CSS transforms.
        pose({ yaw = 0, pitch = 0, gazeX = 0, gazeY = 0 }) {
          var _a2, _b2, _c2, _d2, _e2, _f2, _g2, _h2;
          const now = performance.now(), dt = Math.min(0.034, (now - lastTime) / 1e3);
          lastTime = now;
          if (antennaNode) {
            const want = ((_a2 = brain == null ? void 0 : brain._antennaDot) == null ? void 0 : _a2.style.display) === "none" ? "none" : "";
            if (antennaNode.style.display !== want) antennaNode.style.display = want;
          }
          gazeX += lookAdd[0];
          gazeY += lookAdd[1];
          const tug = ((_b2 = brain == null ? void 0 : brain._gestureFx) == null ? void 0 : _b2.kind) === "antenna-drag" || tugAngle && ((_c2 = brain == null ? void 0 : brain._gestureFx) == null ? void 0 : _c2.kind) === "antenna-drag";
          if (((_d2 = brain == null ? void 0 : brain._gestureFx) == null ? void 0 : _d2.kind) === "antenna-drag") {
            tugAngle ?? (tugAngle = { yaw: shown.Y, pitch: shown.P });
            yaw = tugAngle.yaw;
            pitch = tugAngle.pitch;
          } else if (tugAngle && !(brain == null ? void 0 : brain._gestureFx)) tugAngle = null;
          const touchTarget = busy() && !tug && !tugAngle ? 1 : 0;
          touch += (touchTarget - touch) * (1 - Math.exp(-dt / 0.12));
          const locked = !!(brain && (brain._expressionLock || now < (brain._headCenteringUntil || 0)));
          center += ((locked ? 1 : 0) - center) * (1 - Math.exp(-dt / 0.09));
          gazeX = (gazeX - lookAdd[0]) * (1 - center) + lookAdd[0];
          gazeY = (gazeY - lookAdd[1]) * (1 - center) + lookAdd[1];
          const dm = brain == null ? void 0 : brain._dragMotion, ds = (dm == null ? void 0 : dm.style.transform) || "", dragT = ds && ds !== "none" ? new DOMMatrix(ds).toString() : "none", dragO = (dm == null ? void 0 : dm.style.transformOrigin) || "";
          const shape = ((_e2 = brain == null ? void 0 : brain._headShape) == null ? void 0 : _e2.getAttribute("d")) || "", dot2 = brain == null ? void 0 : brain._antennaDot;
          const hm = ((_f2 = headAnim.match(/matrix\(([^)]+)\)/)) == null ? void 0 : _f2[1].split(",").map(Number)) || [1, 0, 0, 1, 0, 0];
          let ax = 0, ay = 0;
          if (dot2) {
            const px = +dot2.getAttribute("cx") - 120 - hm[4], py = +dot2.getAttribute("cy") - 120 - hm[5], det = hm[0] * hm[3] - hm[1] * hm[2] || 1;
            ax = (hm[3] * px - hm[2] * py) / det + 120 - home.x;
            ay = (-hm[1] * px + hm[0] * py) / det + 120 - home.y;
          }
          const still = Math.max(touch, center), Y = clamp(yaw, -22, 22) * (1 - still), P = clamp(pitch, -15, 15) * (1 - still);
          const mode = squashOn.value;
          if (mode !== "off" && dt > 0) {
            const vY = (Y - sq.Y) / dt, vP = (P - sq.P) / dt, speed = Math.abs(vY) - Math.abs(vP);
            let target = 0;
            if (mode === "narrow") target = clamp(-6e-4 * speed, -0.06, 0.06);
            else if (mode === "stretch") target = clamp(6e-4 * speed, -0.06, 0.06);
            else {
              const sY2 = Math.abs(vY), sP = Math.abs(vP);
              sq.sY = Math.max(sq.sY, sY2);
              sq.sP = Math.max(sq.sP, sP);
              const peak = Math.max(sq.sY, sq.sP);
              if (peak > 25 && Math.max(sY2, sP) < peak * 0.12) {
                sq.v += (sq.sY >= sq.sP ? 1 : -1) * Math.min(1.2, peak * 0.012) * squashGain.value;
                sq.sY = sq.sP = 0;
              }
            }
            const w = 15, z = 0.38;
            sq.v += (w * w * (target - sq.a) - 2 * z * w * sq.v) * dt;
            sq.a = clamp(sq.a + sq.v * dt, -0.07 * Math.max(1, squashGain.value), 0.07 * Math.max(1, squashGain.value));
            if (Math.abs(sq.a) < 1e-4 && Math.abs(sq.v) < 1e-3 && target === 0) sq.a = sq.v = 0;
          } else sq.a = sq.v = 0;
          sq.Y = Y;
          sq.P = P;
          const key = [yaw, pitch, gazeX, gazeY, touch, center, ax, ay, sq.a, ...eyes.flatMap((e) => [...e.off, ...e.lin])].map((v) => v.toFixed(3)).join() + headAnim + dragT + shape.length + shape.slice(-40);
          if (key === last) {
            cutHoles();
            return;
          }
          last = key;
          const m0 = (_g2 = headAnim.match(/matrix\(([^)]+)\)/)) == null ? void 0 : _g2[1].split(",").map(Number);
          const sX = 1 + sq.a, sY = 1 / sX, m = sq.a ? (([a, b, c, d, e, f]) => [a * sX, b * sX, c * sY, d * sY, e, f])(m0 || [1, 0, 0, 1, 0, 0]) : m0;
          const anim = m ? `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${m[4] * u},${m[5] * u}) ` : "";
          head.style.transform = `${anim}scale3d(${zoom},${zoom},1) rotateX(${P}deg) rotateY(${Y}deg)`;
          const dmM = (_h2 = dragT.match(/matrix\(([^)]+)\)/)) == null ? void 0 : _h2[1].split(",").map(Number);
          if (dmM) {
            stage.style.transformOrigin = dragO;
            stage.style.transform = `matrix(${dmM[0]},${dmM[1]},${dmM[2]},${dmM[3]},${dmM[4] * u},${dmM[5] * u})`;
          } else stage.style.transform = "";
          const fx = brain == null ? void 0 : brain._gestureFx, jj = brain == null ? void 0 : brain._dragJelly;
          const stiff = (p) => {
            const m2 = Math.min(Math.abs(p), 18.75);
            return Math.sign(p) * (m2 - m2 ** 5 / (5 * 18.75 ** 4));
          };
          if ((fx == null ? void 0 : fx.kind) === "antenna-drag") bend(stiff(fx.hx), stiff(fx.hy), fx.home.x, clamp(fx.home.y, 20, 220));
          else if (jj && (jj.active || jj.returning)) bend(jj.pullX, jj.pullY, jj.hotX, jj.hotY);
          else bend(0, 0, 120, 120);
          drawWall(Y, P, m || [1, 0, 0, 1, 0, 0]);
          const r = Math.PI / 180, gx = gazeX * 0.4 - Y * r * 0.65, gy = gazeY * 0.3 + P * r * 0.65;
          curY = Y;
          curP = P;
          placeEyes(gx, gy);
          cutHoles();
          const hs = m || hm;
          shown = { Y, P, hm: hs, ax, ay };
          if (antennaNode) antennaNode.style.transform = `translate3d(${ax * u}px,${ay * u}px,0) rotateY(${-Y}deg) rotateX(${-P}deg) scale(${1 / Math.hypot(hs[0], hs[1])},${1 / Math.hypot(hs[2], hs[3])})`;
        },
        // A rebuilt head (new colour, skin or size) takes over the old one's turn,
        // springs and squash, so the swap shows no jump or settle bounce.
        snapshot() {
          return { touch, center, sq: { ...sq }, shown: { ...shown }, headAnim, tugAngle, lastTime };
        },
        restore(s) {
          if (!s) return;
          touch = s.touch;
          center = s.center;
          Object.assign(sq, s.sq);
          shown = { ...s.shown };
          headAnim = s.headAnim;
          tugAngle = s.tugAngle;
          lastTime = s.lastTime;
        },
        // Squash can be switched on and off live.
        setSquashGain(g) {
          squashGain.value = Math.max(0, +g || 0);
        },
        // Rounded eyes: a function giving the corner size (0 = the sharp original).
        setRoundEyes(fn) {
          roundR = fn;
          lastSig = "";
        },
        setSquash(mode) {
          squashOn.value = mode === true ? "narrow" : mode || "off";
          last = "";
        }
      };
    }
    exports.captureSkin = captureSkin;
    exports.createLayeredAvatar = createLayeredAvatar;
  });
  __define("src/boopface-3d.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const { newExpressionPose } = __require2("src/boopface-new-expressions.js");
    const { bodyMotionPose } = __require2("src/boopface-body-motion.js");
    const { petPose } = __require2("src/boopface-petting.js");
    const SQUASH_GAIN = 0.3;
    function skinOf(face) {
      const name = typeof face.getSkin === "function" && face._skinName !== void 0 ? face.getSkin() : face.getAttribute("skin");
      return name && name !== "none" ? String(name) : "";
    }
    function wantedView(face) {
      return String(face.getAttribute("view") || face._viewWanted || "2d").trim().toLowerCase() === "3d" ? "3d" : "2d";
    }
    function paintKey(face) {
      return [
        skinOf(face),
        face.getAttribute("color") || "",
        face.getAttribute("eye-color") || "",
        face.getAttribute("eye-style") || "",
        Math.round(face._headRoundness ?? 50),
        Math.round(face.getBoundingClientRect().width || 0)
      ].join("|");
    }
    async function wallColors(face) {
      var _a;
      const skin = skinOf(face);
      if (skin) {
        try {
          const { SKIN_CATALOG } = await __import2("src/skins/catalog.js");
          const base = (_a = SKIN_CATALOG[skin]) == null ? void 0 : _a.base;
          if (base == null ? void 0 : base.length) return base;
        } catch {
        }
      }
      return [face.getAttribute("color") || "#08090b"];
    }
    function headOf(b) {
      var _a;
      const hmEl = b._headMotion, t = ((_a = hmEl.getAnimations) == null ? void 0 : _a.call(hmEl).length) ? getComputedStyle(hmEl).transform : hmEl.style.transform;
      const hm = t && t !== "none" ? new DOMMatrix(t) : new DOMMatrix(), f = b._headFollowPose || { rot: 0, x: 0, y: 0 }, a = f.rot * Math.PI / 180;
      if (!f.rot && !f.x && !f.y) return t;
      return hm.multiply(new DOMMatrix([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), f.x, f.y])).toString();
    }
    function view3d(face) {
      let v = face._view3dState;
      if (v) return v;
      const root = face.shadowRoot;
      const host = document.createElement("div");
      host.className = "view-3d";
      host.setAttribute("aria-hidden", "true");
      const style = document.createElement("style");
      style.textContent = ':host{position:relative}.view-3d{position:absolute;inset:0}:host([data-view="3d"]) svg{visibility:hidden}';
      root.append(style, host);
      v = face._view3dState = { host, avatar: null, key: "", building: null, pose: { yaw: 0, pitch: 0 }, t: performance.now() };
      return v;
    }
    let layers = null;
    const loadLayers = () => layers || (layers = __import2("src/boopface-3d-layers.js"));
    async function build(face, v, key) {
      var _a, _b;
      const token = (v.token || 0) + 1;
      v.token = token;
      const { captureSkin, createLayeredAvatar } = await loadLayers();
      if (token !== v.token || !face.isConnected) return;
      const size = Math.round(face.getBoundingClientRect().width) || 112;
      const captured = await captureSkin(skinOf(face) || null, face._headRoundness ?? 50, {
        color: face.getAttribute("color"),
        eyeColor: face.getAttribute("eye-color"),
        eyeStyle: face.getAttribute("eye-style")
      });
      if (token !== v.token || !face.isConnected) return;
      const sideColors = await wallColors(face);
      if (token !== v.token || !face.isConnected) return;
      const host = document.createElement("div");
      host.className = "view-3d";
      host.setAttribute("aria-hidden", "true");
      host.style.visibility = "hidden";
      v.host.after(host);
      const avatar = createLayeredAvatar(host, captured, { size, sideColors, squash: "settle" });
      avatar.setSquashGain(SQUASH_GAIN);
      avatar.setRoundEyes(() => String(face.getAttribute("eye-style") || "").toLowerCase() === "sharp" ? 0 : 4);
      avatar.restore((_a = v.avatar) == null ? void 0 : _a.snapshot());
      avatar.syncEyes(face);
      avatar.setHeadMotion(headOf(face));
      avatar.pose(v.lastPose || { yaw: v.pose.yaw, pitch: v.pose.pitch, gazeX: 0, gazeY: 0 });
      const old = v.host;
      v.host = host;
      v.avatar = avatar;
      v.size = size;
      host.style.visibility = "";
      old.remove();
      v.key = key;
      face._motionHost = host;
      face.dataset.view = "3d";
      (_b = face._resumeFrames) == null ? void 0 : _b.call(face);
    }
    function leave3d(face) {
      const v = face._view3dState;
      if (!v) return;
      v.token = (v.token || 0) + 1;
      v.host.replaceChildren();
      v.host.shadowRoot && (v.host.shadowRoot.innerHTML = "");
      v.avatar = null;
      v.key = "";
      face._view3d = false;
      face._motionHost = null;
      delete face.dataset.view;
    }
    BoopFace.prototype.setView = function(value = "2d") {
      var _a;
      this._viewWanted = String(value).toLowerCase() === "3d" ? "3d" : "2d";
      if (this.hasAttribute("view")) this.setAttribute("view", this._viewWanted);
      (_a = this._resumeFrames) == null ? void 0 : _a.call(this);
      return this;
    };
    Object.defineProperty(BoopFace.prototype, "view", { get() {
      return wantedView(this);
    }, configurable: true });
    const SKIN_MODULE = () => typeof BoopFace.prototype._skinKeepsEyes === "function";
    function firstPaint(face, now) {
      var _a;
      if (face._firstShown) return;
      const skin = face.getAttribute("skin"), wantSkin = SKIN_MODULE() && skin && skin !== "none";
      const skinOk = !wantSkin || face._skinName !== void 0 && (face._skinShown ?? null) === (face._skinName ?? null);
      const viewOk = wantedView(face) !== "3d" || face.dataset.view === "3d";
      face._firstAt ?? (face._firstAt = now);
      if (skinOk && viewOk || now - face._firstAt > 4e3) {
        face._firstShown = true;
        if (face.hasAttribute("data-preparing")) face.removeAttribute("data-preparing");
        return;
      }
      if (!face._firstStyle) {
        face._firstStyle = document.createElement("style");
        face._firstStyle.textContent = "svg,.view-3d{transition:opacity .25s ease-out}:host([data-preparing]) svg,:host([data-preparing]) .view-3d{opacity:0;transition:none}";
        (_a = face.shadowRoot) == null ? void 0 : _a.append(face._firstStyle);
      }
      if (!face.hasAttribute("data-preparing")) face.setAttribute("data-preparing", "");
    }
    const baseConnected = BoopFace.prototype.connectedCallback;
    BoopFace.prototype.connectedCallback = function() {
      baseConnected == null ? void 0 : baseConnected.call(this);
      if (this.shadowRoot) firstPaint(this, performance.now());
    };
    registerAvatarExtension({
      name: "view-3d",
      draw(now) {
        var _a, _b, _c;
        firstPaint(this, now);
        if (wantedView(this) !== "3d") {
          if (this._view3d || ((_a = this._view3dState) == null ? void 0 : _a.avatar)) leave3d(this);
          return;
        }
        this._view3d = true;
        const v = view3d(this), key = paintKey(this);
        const onlyRound = !!v.key && key.split("|").every((part, i) => i === 4 || part === v.key.split("|")[i]);
        if (key !== v.key && onlyRound && v.avatar) {
          if (!v.inflight && !v.timer) v.timer = setTimeout(() => {
            v.timer = 0;
            v.inflight = true;
            v.building = null;
            build(this, v, paintKey(this)).finally(() => {
              var _a2;
              v.inflight = false;
              (_a2 = this._resumeFrames) == null ? void 0 : _a2.call(this);
            });
          }, 40);
        } else if (key !== v.key && v.building !== key && !v.inflight) {
          v.building = key;
          clearTimeout(v.timer);
          v.timer = 0;
          const sizeOnly = !!v.key && key.split("|").every((part, i) => i === 5 || part === v.key.split("|")[i]);
          v.timer = setTimeout(() => {
            v.timer = 0;
            v.inflight = true;
            build(this, v, key).finally(() => {
              var _a2;
              v.inflight = false;
              if (v.building === key) v.building = null;
              (_a2 = this._resumeFrames) == null ? void 0 : _a2.call(this);
            });
          }, v.avatar && sizeOnly ? 150 : 0);
        }
        if (!v.avatar) return;
        if (this._baseHeadPathD) (_c = (_b = v.avatar).setHeadPath) == null ? void 0 : _c.call(_b, this._baseHeadPathD);
        const width = this.getBoundingClientRect().width, fit = v.size && width ? width / v.size : 1;
        const scale = Math.abs(fit - 1) > 1e-3 ? `scale(${fit.toFixed(4)})` : "";
        if (v.host.style.transform !== scale) {
          v.host.style.transformOrigin = "0 0";
          v.host.style.transform = scale;
        }
        const dt = Math.min(50, now - v.t);
        v.t = now;
        const look = this._look || { x: 0, y: 0 }, tx = look.x / 36, ty = look.y / 27, k = 1 - Math.exp(-dt / 200);
        v.pose.yaw += (tx * 18 - v.pose.yaw) * k;
        v.pose.pitch += (-ty * 18 * 0.65 - v.pose.pitch) * k;
        const base = { yaw: v.pose.yaw, pitch: v.pose.pitch, gazeX: 0, gazeY: 0 };
        const p = newExpressionPose(this, base);
        v.avatar.syncEyes(this);
        v.avatar.setHeadMotion(headOf(this));
        const petted = petPose(this, p), body = bodyMotionPose(this, petted);
        if (body !== base) {
          const lock = this._expressionLock, hc = this._headCenteringUntil;
          this._expressionLock = false;
          this._headCenteringUntil = 0;
          try {
            v.avatar.pose(body);
          } finally {
            this._expressionLock = lock;
            this._headCenteringUntil = hc;
          }
        } else v.avatar.pose(base);
        v.lastPose = body;
      }
    });
  });
  __define("src/boopface-runtime.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const setA = (el, name, value) => {
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    };
    const proto = BoopFace.prototype;
    const basePlay = proto.play;
    const baseNoteActivity = proto.noteActivity;
    const baseSleep = proto.sleep;
    const baseWake = proto.wake;
    const baseResetToIdle = proto._resetToIdle;
    const baseStartMorph = proto._startMorph;
    const baseAnimateHead = proto._animateHead;
    const baseUpdateBlink = proto._updateBlink;
    const baseUpdateLook = proto._updateLook;
    const baseUpdateHeadFollow = proto._updateHeadFollow;
    const baseUpdateDragJelly = proto._updateDragJelly;
    const baseOnPointerMove = proto._onPointerMove;
    const baseOnDragMove = proto._onDragMove;
    const baseOnDragStart = proto._onDragStart;
    const baseOnDragEnd = proto._onDragEnd;
    const baseResumeFrames = proto._resumeFrames;
    const baseCanPauseFrames = proto._canPauseFrames;
    const baseInput = proto.input;
    const baseStartWaiting = proto.startWaiting;
    const baseStopWaiting = proto.stopWaiting;
    const baseStartListening = proto.startListening;
    const baseStartSpeaking = proto.startSpeaking;
    const baseDraw = proto._draw;
    const DEFAULT_SIZE = 112;
    const ACTION_ALIASES = Object.freeze({
      idle: "idle",
      bow: "bow",
      shake: "shake",
      observe: "observe",
      think: "think",
      ponder: "ponder",
      "shape-wait": "shape-wait",
      bounce: "bounce",
      "smug-bounce": "smug-bounce",
      dizzy: "dizzy",
      wink: "wink",
      smug: "smug",
      bored: "bored",
      waiting: "waiting",
      "waiting-spin": "waiting",
      wait: "waiting",
      "waiting-wrap": "waiting",
      "waiting-wave": "waiting",
      input: "input",
      "waiting-bloom": "waiting",
      "waiting-cross": "waiting",
      listening: "listening",
      speaking: "speaking",
      affirm: "affirm",
      send: "affirm",
      success: "success",
      failure: "failure",
      failed: "failure",
      fail: "failure",
      wary: "wary",
      warning: "wary",
      inspect: "inspect",
      verify: "inspect",
      review: "inspect",
      angry: "angry",
      blocked: "angry",
      "policy-blocked": "angry",
      refuse: "refuse",
      error: "refuse",
      "system-error": "refuse",
      "connection-error": "refuse",
      surprise: "surprise",
      love: "love",
      random: "random",
      slot: "random",
      sleep: "sleep",
      wake: "wake"
    });
    const DEPRECATED_ACTIONS = Object.freeze({
      wait: "waiting-spin",
      send: "affirm",
      failed: "failure",
      fail: "failure",
      warning: "wary",
      verify: "inspect",
      review: "inspect",
      blocked: "angry",
      "policy-blocked": "angry",
      error: "refuse",
      "system-error": "refuse",
      "connection-error": "refuse",
      slot: "random"
    });
    const ACTION_IMPLEMENTATIONS = Object.freeze({
      "waiting-spin": "waiting",
      affirm: "send",
      wary: "warning",
      refuse: "error"
    });
    const warnedDeprecations = /* @__PURE__ */ new Set();
    function warnDeprecatedAction(raw) {
      const replacement = DEPRECATED_ACTIONS[raw];
      if (!replacement || warnedDeprecations.has(raw)) return;
      warnedDeprecations.add(raw);
      console.warn(`boopface: action "${raw}" is deprecated, use "${replacement}". Old names stop working in 1.0.`);
    }
    function normalizeAction(name) {
      const raw = String(name || "").trim().toLowerCase();
      const canonical = Object.hasOwn(ACTION_ALIASES, raw) ? ACTION_ALIASES[raw] : null;
      if (canonical) warnDeprecatedAction(raw);
      return { raw, canonical, implementation: ACTION_IMPLEMENTATIONS[raw] ?? raw };
    }
    function wakePolicy(instance) {
      const value = String(instance.getAttribute("wake-on") || "activity").trim().toLowerCase();
      return value === "manual" || value === "interaction" ? value : "activity";
    }
    function requestedMotion(instance) {
      const value = String(instance.getAttribute("motion") || "auto").trim().toLowerCase();
      return value === "reduce" || value === "full" ? value : "auto";
    }
    function reducedMotion(instance) {
      var _a;
      const requested = requestedMotion(instance);
      if (requested === "reduce") return true;
      if (requested === "full") return false;
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      }
      return ((_a = instance._runtimeMotionQuery) == null ? void 0 : _a.matches) === true;
    }
    function emitActionState(instance, record, phase, silent = false) {
      if (!record || phase !== "start" && record.terminal) return;
      if (phase !== "start") record.terminal = true;
      if (silent) return;
      instance.dispatchEvent(new CustomEvent("action-state", {
        detail: { action: record.action, phase, source: record.source },
        bubbles: true,
        composed: true
      }));
    }
    function cancelActiveAction(instance, { silent = false } = {}) {
      const record = instance._activeActionState;
      if (!record || record.terminal) return;
      if (instance._activeActionState === record) instance._activeActionState = null;
      emitActionState(instance, record, "cancel", silent);
    }
    function beginAction(instance, action, source, continuous = false) {
      clearAutoSleep(instance);
      cancelActiveAction(instance);
      const record = {
        id: (instance._actionStateSequence || 0) + 1,
        action,
        source,
        continuous,
        terminal: false
      };
      instance._actionStateSequence = record.id;
      instance._activeActionState = record;
      emitActionState(instance, record, "start");
      return record;
    }
    function finishAction(instance, record, phase = "end") {
      if (!record || record.terminal) return;
      if (instance._activeActionState !== record) return;
      instance._activeActionState = null;
      emitActionState(instance, record, phase);
      scheduleAutoSleep(instance);
    }
    function trackFiniteAction(instance, record, result) {
      if (record.continuous) return;
      if (result && typeof result.then === "function") {
        Promise.resolve(result).then(
          () => finishAction(instance, record, "end"),
          () => finishAction(instance, record, "cancel")
        );
      } else {
        finishAction(instance, record, "end");
      }
    }
    function applySize(instance) {
      instance._syncSizeAttribute();
      instance._runtimeSizeApplied = instance.hasAttribute("size");
    }
    function hasVisibleLayout(instance) {
      var _a;
      if (!instance.isConnected) return false;
      const rects = (_a = instance.getClientRects) == null ? void 0 : _a.call(instance);
      if (!rects || rects.length === 0) return false;
      const rect = instance.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function cancelHeadAnimations(instance) {
      var _a, _b;
      const animations = ((_b = (_a = instance._headMotion) == null ? void 0 : _a.getAnimations) == null ? void 0 : _b.call(_a)) || [];
      for (const animation of animations) animation.cancel();
      if (instance._headMotion) instance._headMotion.style.transform = "";
    }
    function cancelContinuousMotion(instance) {
      cancelHeadAnimations(instance);
      instance._blinkAnim = null;
      instance._blink = 1;
      instance._boredRoutine = null;
      instance._boredLookSpeed = null;
      if (instance._wanderTarget) instance._wanderTarget.x = instance._wanderTarget.y = 0;
      if (instance._wander) instance._wander.x = instance._wander.y = 0;
      if (instance._look) instance._look.x = instance._look.y = 0;
    }
    function dragAtRest(drag) {
      if (!drag || drag.active || drag.returning || drag.pendingReaction) return false;
      return Math.abs(drag.x) < 1e-4 && Math.abs(drag.y) < 1e-4 && Math.abs(drag.vx) < 1e-4 && Math.abs(drag.vy) < 1e-4 && Math.abs(drag.stretch) < 1e-4 && Math.abs(drag.shear) < 1e-4 && Math.abs(drag.pullX) < 1e-4 && Math.abs(drag.pullY) < 1e-4;
    }
    function clearIdleDragVisuals(instance) {
      if (!dragAtRest(instance._dragJelly)) return;
      const motion = instance._dragMotion;
      if (motion && (motion.style.transform || motion.style.transformOrigin)) {
        motion.style.transform = "";
        motion.style.transformOrigin = "";
      }
      if (instance._headShape && instance._baseHeadPathD) {
        setA(instance._headShape, "d", instance._baseHeadPathD);
      }
    }
    function clearAutoSleep(instance) {
      if (!instance._runtimeAutoSleepTimer) return;
      clearTimeout(instance._runtimeAutoSleepTimer);
      instance._runtimeAutoSleepTimer = 0;
    }
    function autoSleepBlocked(instance) {
      const record = instance._activeActionState;
      return Boolean(
        !instance.isConnected || instance._runtimeDisconnecting || instance._sleeping || record && !record.terminal && record.source !== "interaction" || instance._waitingRequested || instance._waitingFx || instance._inputWanted || instance._state === "input" || instance._expressionLock || instance._gestureFx
      );
    }
    function scheduleAutoSleep(instance) {
      clearAutoSleep(instance);
      const delayMs = Number(instance._autoSleepMs);
      if (!Number.isFinite(delayMs) || delayMs <= 0 || autoSleepBlocked(instance)) return;
      const remaining = Math.max(0, instance._lastActivity + delayMs - performance.now());
      instance._runtimeAutoSleepTimer = setTimeout(() => {
        instance._runtimeAutoSleepTimer = 0;
        if (autoSleepBlocked(instance)) return;
        const currentDelay = Number(instance._autoSleepMs);
        if (!Number.isFinite(currentDelay) || currentDelay <= 0) return;
        const nextRemaining = instance._lastActivity + currentDelay - performance.now();
        if (nextRemaining > 1) {
          scheduleAutoSleep(instance);
          return;
        }
        const previousSource = instance._runtimeActionSource;
        instance._runtimeActionSource = "automatic";
        try {
          instance.sleep();
        } finally {
          instance._runtimeActionSource = previousSource;
        }
      }, remaining);
    }
    function requestVisualCommit(instance) {
      var _a;
      if (!instance.isConnected || instance._runtimeDisconnecting) return;
      instance._runtimeVisualDirty = true;
      (_a = instance._resumeFrames) == null ? void 0 : _a.call(instance);
    }
    function syncMotionPreference(instance) {
      const reduced = reducedMotion(instance);
      if (instance._runtimeLastReducedMotion === reduced) return reduced;
      instance._runtimeLastReducedMotion = reduced;
      instance._runtimeVisualDirty = true;
      if (reduced) cancelContinuousMotion(instance);
      return reduced;
    }
    function clearDragGeometry(instance, { preserveClick = false, releaseCapture = true } = {}) {
      const drag = instance._dragJelly;
      if (!drag) return;
      const pointerId = drag.pointerId;
      const suppressClick = preserveClick && drag.moved;
      drag.active = false;
      drag.returning = false;
      drag.snapped = false;
      drag.pointerId = null;
      drag.pendingReaction = null;
      drag.targetX = drag.targetY = drag.x = drag.y = drag.vx = drag.vy = 0;
      drag.targetStretch = drag.stretch = drag.stretchVel = 0;
      drag.targetShear = drag.shear = drag.shearVel = 0;
      drag.targetPullX = drag.targetPullY = drag.pullX = drag.pullY = drag.pullVX = drag.pullVY = 0;
      drag.angle = 0;
      drag.maxDist = 0;
      drag.ux = drag.uy = 0;
      drag.anchorX = drag.anchorY = 50;
      instance._pendingDragEvent = null;
      if (releaseCapture && pointerId != null) {
        try {
          instance.releasePointerCapture(pointerId);
        } catch (_) {
        }
      }
      if (instance._dragMotion) {
        instance._dragMotion.style.transform = "";
        instance._dragMotion.style.transformOrigin = "";
      }
      if (instance._headShape && instance._baseHeadPathD) {
        instance._headShape.setAttribute("d", instance._baseHeadPathD);
      }
      instance._suppressClick = suppressClick;
    }
    function programActionOwnsExpression(instance) {
      const record = instance._activeActionState;
      if (record && !record.terminal && record.source !== "interaction") return true;
      return Boolean(
        instance._waitingRequested || instance._waitingFx || instance._inputWanted || instance._inspectFx || instance._loveFx || instance._randomFx || instance._failureFx || instance._warningFx || instance._systemErrorShake || instance._sleeping || instance._expressionLock && instance._state !== "idle"
      );
    }
    function startDragReaction(instance, reaction) {
      if (!reaction || programActionOwnsExpression(instance)) return;
      const result = reaction === "dizzy" ? instance.play("dizzy") : reaction === "angry" ? instance.angry({ fromDrag: true }) : instance.success({ fromDrag: true });
      const record = beginAction(instance, "reaction", "interaction", false);
      trackFiniteAction(instance, record, result);
    }
    function finishDragReturn(instance, reaction) {
      clearDragGeometry(instance, { preserveClick: true, releaseCapture: false });
      startDragReaction(instance, reaction);
    }
    function applyDragTransform(instance) {
      var _a;
      const drag = instance._dragJelly;
      if (!drag) return;
      (_a = instance._applyHeadDeform) == null ? void 0 : _a.call(instance);
      if (!instance._dragMotion) return;
      const sx = 1 + drag.stretch;
      const sy = 1 - drag.stretch * 0.3;
      const shearDeg = drag.shear * 180 / Math.PI;
      instance._dragMotion.style.transformOrigin = `${drag.anchorX.toFixed(2)}% ${drag.anchorY.toFixed(2)}%`;
      instance._dragMotion.style.transform = `translate(${drag.x.toFixed(2)}px, ${drag.y.toFixed(2)}px) rotate(${drag.angle.toFixed(4)}rad) scale(${sx.toFixed(4)}, ${sy.toFixed(4)}) skewY(${shearDeg.toFixed(3)}deg) rotate(${(-drag.angle).toFixed(4)}rad)`;
    }
    function flushPointerWork(instance) {
      var _a;
      const pointer = instance._pendingPointerEvent;
      instance._pendingPointerEvent = null;
      if (pointer) {
        baseOnPointerMove.call(instance, pointer);
        instance._runtimePointerFlushCount = (instance._runtimePointerFlushCount || 0) + 1;
      }
      const drag = instance._pendingDragEvent;
      instance._pendingDragEvent = null;
      if (drag && ((_a = instance._dragJelly) == null ? void 0 : _a.active) && drag.pointerId === instance._dragJelly.pointerId) {
        baseOnDragMove.call(instance, drag);
        instance._runtimeDragFlushCount = (instance._runtimeDragFlushCount || 0) + 1;
      }
    }
    function setRuntimeVisible(instance, visible) {
      var _a, _b, _c, _d;
      const next = visible === true;
      if (instance._runtimeVisible === next) return;
      instance._runtimeVisible = next;
      if (!next) {
        (_a = instance._cancelGesture) == null ? void 0 : _a.call(instance);
        if (instance._raf) cancelAnimationFrame(instance._raf);
        instance._raf = 0;
        instance._framePaused = true;
        instance._pendingPointerEvent = null;
        if (((_b = instance._dragJelly) == null ? void 0 : _b.active) || ((_c = instance._dragJelly) == null ? void 0 : _c.returning)) {
          clearDragGeometry(instance, { preserveClick: true });
        }
        cancelHeadAnimations(instance);
        if (instance._antennaSpring) {
          instance._antennaSpring.vx = 0;
          instance._antennaSpring.vy = 0;
          instance._antennaSpring.initialized = false;
        }
        return;
      }
      (_d = instance._resumeFrames) == null ? void 0 : _d.call(instance);
    }
    function handleMotionChange(instance) {
      var _a;
      const reduced = syncMotionPreference(instance);
      if (reduced) {
        cancelContinuousMotion(instance);
        instance._pose = { ...instance._toPose };
        instance._fromPose = { ...instance._toPose };
        instance._morphDuration = 0;
        if ((_a = instance._dragJelly) == null ? void 0 : _a.returning) finishDragReturn(instance, instance._dragJelly.pendingReaction);
      }
      requestVisualCommit(instance);
      scheduleAutoSleep(instance);
    }
    function ensureRuntime(instance) {
      var _a, _b;
      if (instance._runtimePolicyReady || !instance.isConnected || instance._runtimeDisconnecting) return;
      instance._runtimePolicyReady = true;
      if (!instance.style.touchAction) instance.style.touchAction = "pinch-zoom";
      applySize(instance);
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        const query = window.matchMedia("(prefers-reduced-motion: reduce)");
        const listener = () => handleMotionChange(instance);
        instance._runtimeMotionQuery = query;
        instance._runtimeMotionListener = listener;
        if (query.addEventListener) query.addEventListener("change", listener);
        else (_a = query.addListener) == null ? void 0 : _a.call(query, listener);
      }
      if (typeof MutationObserver !== "undefined") {
        instance._runtimeAttributeObserver = new MutationObserver((records) => {
          var _a2, _b2;
          let motionChanged = false;
          let autoSleepChanged = false;
          for (const record of records) {
            if (record.attributeName === "size") applySize(instance);
            if (record.attributeName === "motion") motionChanged = true;
            if (record.attributeName === "auto-sleep") autoSleepChanged = true;
            if (record.attributeName === "skin") (_a2 = instance._applySkinAttribute) == null ? void 0 : _a2.call(instance);
            if (["view", "eye-color", "eye-style", "color"].includes(record.attributeName)) (_b2 = instance._resumeFrames) == null ? void 0 : _b2.call(instance);
          }
          if (motionChanged) handleMotionChange(instance);
          if (autoSleepChanged) scheduleAutoSleep(instance);
        });
        instance._runtimeAttributeObserver.observe(instance, {
          attributes: true,
          attributeFilter: ["size", "motion", "wake-on", "auto-sleep", "skin", "view", "eye-color", "eye-style", "color"]
        });
      }
      if (instance.hasAttribute("skin") && instance.getAttribute("skin") !== instance._skinAttributeApplied) (_b = instance._applySkinAttribute) == null ? void 0 : _b.call(instance);
      if (typeof IntersectionObserver !== "undefined") {
        instance._runtimeIntersectionObserver = new IntersectionObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          instance._runtimeIntersecting = entry.isIntersecting;
          setRuntimeVisible(instance, entry.isIntersecting && hasVisibleLayout(instance));
        });
        instance._runtimeIntersectionObserver.observe(instance);
      }
      if (typeof ResizeObserver !== "undefined") {
        instance._runtimeResizeObserver = new ResizeObserver(() => {
          const inView = instance._runtimeIntersecting !== false;
          setRuntimeVisible(instance, inView && hasVisibleLayout(instance));
        });
        instance._runtimeResizeObserver.observe(instance);
      }
      instance._runtimeVisible = hasVisibleLayout(instance);
      instance._runtimeLostCapture = (event) => {
        var _a2, _b2, _c;
        if (((_a2 = instance._gestureFx) == null ? void 0 : _a2.held) && event.pointerId === instance._gestureFx.pointerId) {
          (_b2 = instance._cancelGesture) == null ? void 0 : _b2.call(instance);
        }
        if (((_c = instance._dragJelly) == null ? void 0 : _c.active) && event.pointerId === instance._dragJelly.pointerId) {
          clearDragGeometry(instance, { preserveClick: false, releaseCapture: false });
        }
      };
      instance.addEventListener("lostpointercapture", instance._runtimeLostCapture);
      if (!instance._runtimeLoopWrapped && typeof instance._loop === "function") {
        const loop = instance._loop;
        instance._loop = (ts) => {
          flushPointerWork(instance);
          return loop(ts);
        };
        instance._runtimeLoopWrapped = true;
      }
      scheduleAutoSleep(instance);
    }
    function teardownRuntime(instance) {
      var _a, _b, _c, _d, _e;
      clearAutoSleep(instance);
      cancelContinuousMotion(instance);
      (_a = instance._runtimeIntersectionObserver) == null ? void 0 : _a.disconnect();
      (_b = instance._runtimeResizeObserver) == null ? void 0 : _b.disconnect();
      (_c = instance._runtimeAttributeObserver) == null ? void 0 : _c.disconnect();
      if (instance._runtimeMotionQuery && instance._runtimeMotionListener) {
        if (instance._runtimeMotionQuery.removeEventListener) {
          instance._runtimeMotionQuery.removeEventListener("change", instance._runtimeMotionListener);
        } else {
          (_e = (_d = instance._runtimeMotionQuery).removeListener) == null ? void 0 : _e.call(_d, instance._runtimeMotionListener);
        }
      }
      if (instance._runtimeLostCapture) {
        instance.removeEventListener("lostpointercapture", instance._runtimeLostCapture);
      }
      instance._runtimeIntersectionObserver = null;
      instance._runtimeResizeObserver = null;
      instance._runtimeAttributeObserver = null;
      instance._runtimeMotionQuery = null;
      instance._runtimeMotionListener = null;
      instance._runtimeLostCapture = null;
      instance._runtimePolicyReady = false;
      instance._runtimeVisible = false;
      instance._runtimeLastReducedMotion = void 0;
      instance._runtimeVisualDirty = false;
      instance._pendingPointerEvent = null;
      instance._pendingDragEvent = null;
    }
    function eventTargetsAvatar(event, instance) {
      var _a, _b;
      const path = (_a = event == null ? void 0 : event.composedPath) == null ? void 0 : _a.call(event);
      if (Array.isArray(path)) return path.includes(instance);
      return (event == null ? void 0 : event.target) === instance || ((_b = instance.contains) == null ? void 0 : _b.call(instance, event == null ? void 0 : event.target));
    }
    proto._isReducedMotion = function() {
      return reducedMotion(this);
    };
    proto.noteActivity = function(wake = true) {
      ensureRuntime(this);
      const shouldWake = wake !== false && (this._sleeping || this._state === "sleep");
      const result = baseNoteActivity.call(this, false);
      scheduleAutoSleep(this);
      if (shouldWake) this.wake();
      return result;
    };
    proto._noteEnvironmentActivity = function(event) {
      ensureRuntime(this);
      const shouldConsiderWake = this._sleeping || this._state === "sleep";
      const result = baseNoteActivity.call(this, false);
      scheduleAutoSleep(this);
      if (!shouldConsiderWake) return result;
      const policy = wakePolicy(this);
      const shouldWake = policy === "activity" || policy === "interaction" && eventTargetsAvatar(event, this);
      if (!shouldWake) return result;
      const previousSource = this._runtimeActionSource;
      this._runtimeActionSource = "automatic";
      try {
        return this.wake();
      } finally {
        this._runtimeActionSource = previousSource;
      }
    };
    proto._resetToIdle = function(notify = true) {
      const previous = this._runtimeResetNotify;
      this._runtimeResetNotify = notify;
      try {
        return baseResetToIdle.call(this, notify);
      } finally {
        this._runtimeResetNotify = previous;
        scheduleAutoSleep(this);
      }
    };
    proto._startMorph = function(target, duration, ease) {
      const reduced = reducedMotion(this);
      const result = baseStartMorph.call(this, target, reduced ? 0 : duration, ease);
      if (reduced) requestVisualCommit(this);
      return result;
    };
    proto._animateHead = function(frames, duration) {
      if (reducedMotion(this)) {
        cancelHeadAnimations(this);
        return void 0;
      }
      return baseAnimateHead.call(this, frames, duration);
    };
    proto._updateBlink = function(now) {
      if (!reducedMotion(this)) return baseUpdateBlink.call(this, now);
      this._blinkAnim = null;
      this._blink = 1;
    };
    proto._updateLook = function(now, dt) {
      if (!reducedMotion(this)) return baseUpdateLook.call(this, now, dt);
      this._boredRoutine = null;
      this._boredLookSpeed = null;
      this._wanderTarget.x = this._wanderTarget.y = 0;
      this._wander.x = this._wander.y = 0;
      this._look.x = this._look.y = 0;
    };
    proto._updateHeadFollow = function(now, dt) {
      if (!reducedMotion(this)) return baseUpdateHeadFollow.call(this, now, dt);
      this._headFollowPose.x = this._headFollowPose.y = this._headFollowPose.rot = 0;
      this._headFollowVel.x = this._headFollowVel.y = this._headFollowVel.rot = 0;
      if (this._headFollow) setA(this._headFollow, "transform", "");
    };
    proto._updateDragJelly = function(dt) {
      const drag = this._dragJelly;
      if (!reducedMotion(this)) {
        const result = baseUpdateDragJelly.call(this, dt);
        clearIdleDragVisuals(this);
        return result;
      }
      if (!drag) return;
      if (drag.active) {
        drag.x = drag.targetX;
        drag.y = drag.targetY;
        drag.stretch = drag.targetStretch;
        drag.shear = drag.targetShear;
        drag.pullX = drag.targetPullX;
        drag.pullY = drag.targetPullY;
        applyDragTransform(this);
      } else if (drag.returning) {
        finishDragReturn(this, drag.pendingReaction);
      }
      clearIdleDragVisuals(this);
    };
    proto._onPointerMove = function(event) {
      var _a;
      ensureRuntime(this);
      if (this._runtimeVisible === false) return;
      if (this._pointerFollowEnabled === false) return;
      this._pendingPointerEvent = {
        clientX: event.clientX,
        clientY: event.clientY
      };
      if (this._sleeping && this._framePaused) return;
      (_a = this._resumeFrames) == null ? void 0 : _a.call(this);
    };
    proto._onDragMove = function(event) {
      var _a, _b;
      ensureRuntime(this);
      if (this._gestureFx) {
        this._moveGesture(event);
        return;
      }
      if (!((_a = this._dragJelly) == null ? void 0 : _a.active) || event.pointerId !== this._dragJelly.pointerId) return;
      this._pendingDragEvent = {
        clientX: event.clientX,
        clientY: event.clientY,
        pointerId: event.pointerId
      };
      (_b = this._resumeFrames) == null ? void 0 : _b.call(this);
    };
    proto._onDragStart = function(event) {
      var _a, _b, _c;
      ensureRuntime(this);
      if ((_a = this._dragJelly) == null ? void 0 : _a.active) return;
      if (event.pointerType === "touch" && event.isPrimary === false) return;
      if ((_b = this._gestureFx) == null ? void 0 : _b.held) return;
      if ((_c = this._startGesture) == null ? void 0 : _c.call(this, event)) return;
      return baseOnDragStart.call(this, event);
    };
    proto._startHeadDragFromGesture = function(event, start) {
      baseOnDragStart.call(this, {
        button: 0,
        clientX: start.startX,
        clientY: start.startY,
        pointerId: event.pointerId,
        pointerType: start.pointerType
      });
      baseOnDragMove.call(this, event);
    };
    proto._beginGestureAction = function(kind) {
      beginAction(this, kind, "interaction", true);
    };
    proto._endGestureAction = function(phase, react = false, silent = false) {
      const record = this._activeActionState;
      if (record && (record.action === "squeeze" || record.action === "antenna-drag")) {
        if (silent) cancelActiveAction(this, { silent: true });
        else finishAction(this, record, phase);
      }
      if (react) startDragReaction(this, "dizzy");
    };
    proto._onDragEnd = function(event) {
      if (this._gestureFx) {
        this._endGesture(event);
        return;
      }
      const drag = this._dragJelly;
      if (!(drag == null ? void 0 : drag.active) || event.pointerId !== drag.pointerId) return;
      flushPointerWork(this);
      if (event.type === "pointercancel") {
        clearDragGeometry(this, { preserveClick: false });
        return;
      }
      baseOnDragEnd.call(this, event);
      if (reducedMotion(this) && drag.returning) finishDragReturn(this, drag.pendingReaction);
    };
    proto._finishDragReturn = function(reaction) {
      finishDragReturn(this, reaction);
    };
    proto._resumeFrames = function() {
      if (!this.isConnected || this._runtimeDisconnecting) return;
      ensureRuntime(this);
      if (this._runtimeVisible === false) return;
      if (syncMotionPreference(this)) this._runtimeVisualDirty = true;
      return baseResumeFrames.call(this);
    };
    proto._draw = function(now) {
      syncMotionPreference(this);
      const result = baseDraw.call(this, now);
      this._runtimeVisualDirty = false;
      return result;
    };
    proto._canPauseFrames = function(now) {
      if (this._runtimeVisible === false) return true;
      const reduced = syncMotionPreference(this);
      if (!reduced) return baseCanPauseFrames.call(this, now);
      if (this._pendingPointerEvent || this._pendingDragEvent || this._runtimeVisualDirty) return false;
      return true;
    };
    function playNoOp(instance, canonical) {
      if (canonical === "wake") return !instance._sleeping && instance._state !== "sleep";
      if (canonical === "sleep") return instance._sleeping === true;
      if (canonical === "input") return instance._inputWanted || instance._state === "input";
      return false;
    }
    function leaveSleepForAction(instance) {
      if (!instance._sleeping && instance._state !== "sleep") return;
      instance._sleeping = false;
      instance.setState("idle", { duration: reducedMotion(instance) ? 0 : 120 });
    }
    function prepareReplacement(instance, canonical) {
      var _a, _b;
      (_a = instance._cancelGesture) == null ? void 0 : _a.call(instance);
      clearAutoSleep(instance);
      cancelActiveAction(instance);
      clearDragGeometry(instance, { preserveClick: true });
      (_b = instance._cancelPendingWaits) == null ? void 0 : _b.call(instance);
      if (canonical !== "sleep" && canonical !== "wake" && canonical !== "idle") {
        leaveSleepForAction(instance);
      }
    }
    proto.play = function(name) {
      ensureRuntime(this);
      const { canonical, implementation } = normalizeAction(name);
      if (!canonical) throw new Error(`Unknown BoopFace action: ${name}`);
      if (playNoOp(this, canonical)) return this;
      if (canonical === "idle") return basePlay.call(this, implementation);
      prepareReplacement(this, canonical);
      let result;
      this._runtimeInPlay = true;
      try {
        result = basePlay.call(this, implementation);
      } finally {
        this._runtimeInPlay = false;
      }
      const record = beginAction(this, canonical, "api", canonical === "input");
      trackFiniteAction(this, record, result);
      if (reducedMotion(this)) queueMicrotask(() => cancelHeadAnimations(this));
      return result;
    };
    proto.input = function(active = true) {
      var _a;
      if (this._runtimeInPlay) return baseInput.call(this, active);
      ensureRuntime(this);
      if (active) {
        if (this._inputWanted || this._state === "input") return this;
        prepareReplacement(this, "input");
        const result2 = baseInput.call(this, true);
        beginAction(this, "input", "api", true);
        return result2;
      }
      const record = ((_a = this._activeActionState) == null ? void 0 : _a.action) === "input" ? this._activeActionState : null;
      const result = baseInput.call(this, false);
      if (record) finishAction(this, record, "end");
      return result;
    };
    proto.startWaiting = async function(options = {}) {
      var _a, _b;
      ensureRuntime(this);
      clearAutoSleep(this);
      const result = await baseStartWaiting.call(this, options);
      const bloom = ((_a = this._voiceFx) == null ? void 0 : _a.mode) === "thinking" && this._voiceFx.continuous;
      if (this._waitingRequested && this._waitingFx || bloom && ((_b = this._activeActionState) == null ? void 0 : _b.action) !== "waiting") {
        beginAction(this, "waiting", "api", true);
      }
      return result;
    };
    for (const [method, base, action] of [["startListening", baseStartListening, "listening"], ["startSpeaking", baseStartSpeaking, "speaking"]]) {
      if (typeof base !== "function") continue;
      proto[method] = async function(options = {}) {
        var _a, _b;
        ensureRuntime(this);
        clearAutoSleep(this);
        const result = await base.call(this, options);
        if (((_a = this._voiceFx) == null ? void 0 : _a.mode) === action && this._voiceFx.continuous && ((_b = this._activeActionState) == null ? void 0 : _b.action) !== action) {
          beginAction(this, action, "api", true);
        }
        return result;
      };
    }
    proto.stopWaiting = function() {
      var _a;
      ensureRuntime(this);
      const record = ((_a = this._activeActionState) == null ? void 0 : _a.action) === "waiting" ? this._activeActionState : null;
      this._runtimeEndingWaiting = Boolean(record);
      let result;
      try {
        result = baseStopWaiting.call(this);
      } finally {
        this._runtimeEndingWaiting = false;
      }
      if (record) finishAction(this, record, "end");
      return result;
    };
    proto.sleep = function() {
      if (this._runtimeInPlay) return baseSleep.call(this);
      ensureRuntime(this);
      if (this._sleeping) return this;
      prepareReplacement(this, "sleep");
      const source = this._runtimeActionSource || "api";
      const result = baseSleep.call(this);
      const record = beginAction(this, "sleep", source, false);
      trackFiniteAction(this, record, result);
      return result;
    };
    proto.wake = function() {
      if (this._runtimeInPlay) return baseWake.call(this);
      ensureRuntime(this);
      if (!this._sleeping && this._state !== "sleep") return this;
      prepareReplacement(this, "wake");
      const source = this._runtimeActionSource || "api";
      const result = baseWake.call(this);
      const record = beginAction(this, "wake", source, false);
      trackFiniteAction(this, record, result);
      return result;
    };
    proto._autoSleep = function() {
    };
    proto._scheduleAutoSleep = function() {
      scheduleAutoSleep(this);
    };
    proto._teardownRuntime = function() {
      teardownRuntime(this);
    };
    function setMask(top, bottom, topY, bottomY, topAngle = 0, bottomAngle = 0) {
      if (top) {
        setA(top, "y", (topY - 90).toFixed(2));
        setA(top, "height", "90");
        setA(top, "transform", `rotate(${topAngle.toFixed(2)} 0 ${topY.toFixed(2)})`);
      }
      if (bottom) {
        setA(bottom, "y", bottomY.toFixed(2));
        setA(bottom, "height", "90");
        setA(bottom, "transform", `rotate(${bottomAngle.toFixed(2)} 0 ${bottomY.toFixed(2)})`);
      }
    }
    function setEye(eye, x, y = 126, sx = 1, sy = 1) {
      if (eye) setA(eye, "transform", `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})`);
    }
    function drawReducedState(instance) {
      if (!reducedMotion(instance)) return;
      if (instance._state === "input") {
        if (instance._leftInputBase) setA(instance._leftInputBase, "opacity", "1");
        if (instance._rightInputBase) setA(instance._rightInputBase, "opacity", "1");
      }
      if (instance._antennaDot) instance._antennaDot.style.opacity = "1";
      if (instance._waitingFx) {
        setEye(instance._leftEye, 100, 126, 0.92, 1);
        setEye(instance._rightEye, 140, 126, 0.92, 1);
        return;
      }
      if (instance._inspectFx) {
        setEye(instance._leftEye, 86);
        setEye(instance._rightEye, 154);
        setMask(instance._leftTop, instance._leftBottom, -8, 8);
        setMask(instance._rightTop, instance._rightBottom, -8, 8);
        return;
      }
      if (instance._warningFx) {
        setEye(instance._leftEye, 100, 126, 1.16, 1.1);
        setEye(instance._rightEye, 172, 132, 0.84, 0.96);
        setMask(instance._leftTop, instance._leftBottom, -18, 35, 8, 0);
        setMask(instance._rightTop, instance._rightBottom, -20, 36, -7, 0);
        return;
      }
      if (instance._systemErrorShake) {
        setMask(instance._leftTop, instance._leftBottom, -5, 36, -15, 0);
        setMask(instance._rightTop, instance._rightBottom, -5, 36, 15, 0);
      }
    }
    for (const property of ["_waitingFx", "_voiceFx", "_inspectFx", "_loveFx", "_randomFx", "_failureFx", "_warningFx", "_systemErrorShake"]) {
      const slot = Symbol(property);
      Object.defineProperty(proto, property, {
        configurable: true,
        get() {
          return this[slot];
        },
        set(value) {
          this[slot] = value;
          this._runtimeVisualDirty = true;
          if (this.isConnected && !this._runtimeDisconnecting && syncMotionPreference(this)) {
            requestVisualCommit(this);
            queueMicrotask(() => {
              if (this.isConnected && !this._runtimeDisconnecting && syncMotionPreference(this)) {
                cancelContinuousMotion(this);
              }
            });
          }
        }
      });
    }
    registerAvatarExtension({
      name: "runtime-policy",
      reset() {
        const silent = this._runtimeResetNotify === false;
        if (!this._runtimeEndingWaiting) cancelActiveAction(this, { silent });
        clearDragGeometry(this, { preserveClick: !silent });
        this._pendingPointerEvent = null;
      },
      draw() {
        ensureRuntime(this);
        drawReducedState(this);
      }
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.ACTION_ALIASES = ACTION_ALIASES;
    exports.DEFAULT_SIZE = DEFAULT_SIZE;
  });
  __define("src/boopface-eye-color.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const NS = "http://www.w3.org/2000/svg";
    const EYES = "#leftBase,#rightBase,#leftInputBase,#rightInputBase";
    function el(tag, attrs, parent) {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      parent == null ? void 0 : parent.append(node);
      return node;
    }
    function parts(instance) {
      if (instance._eyeColorParts) return instance._eyeColorParts;
      const root = instance.shadowRoot, defs = root == null ? void 0 : root.querySelector("defs"), head = root == null ? void 0 : root.getElementById("headMotion");
      if (!defs || !head) return null;
      const filter = el("filter", { id: "eye-through-silhouette", "color-interpolation-filters": "sRGB" }, defs);
      el("feColorMatrix", { type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" }, filter);
      const mask = el("mask", { id: "eye-through", maskUnits: "userSpaceOnUse", x: "-120", y: "-120", width: "480", height: "480", style: "mask-type:luminance" }, defs);
      el("rect", { x: "-120", y: "-120", width: "480", height: "480", fill: "#fff" }, mask);
      const holes = el("g", { filter: "url(#eye-through-silhouette)" }, mask);
      for (const side of ["left", "right"]) el("use", { href: `#${side}Eye` }, holes);
      const style = document.createElement("style");
      root.append(style);
      instance._eyeColorParts = { head, style };
      return instance._eyeColorParts;
    }
    const THROUGH = /^(transparent|none|through)$/i;
    function wanted(instance) {
      var _a;
      const raw = String(instance.getAttribute("eye-color") || "").trim();
      return raw && !THROUGH.test(raw) && ((_a = instance._skinKeepsEyes) == null ? void 0 : _a.call(instance)) ? "" : raw;
    }
    function apply(instance) {
      var _a, _b;
      const p = parts(instance);
      if (!p) return;
      const asked = String(instance.getAttribute("eye-color") || "").trim(), raw = wanted(instance);
      if (asked && !raw && !instance._eyeColorWarned) {
        instance._eyeColorWarned = true;
        console.warn(`boopface: skin ${(_a = instance.getSkin) == null ? void 0 : _a.call(instance)} keeps its own eye colour; eye-color is ignored while it is on ("transparent" still works).`);
      }
      const through = THROUGH.test(raw);
      if (through) {
        p.head.setAttribute("mask", "url(#eye-through)");
        p.style.textContent = `#leftEye,#rightEye{filter:none!important}${EYES}{fill:#fff!important;fill-opacity:1!important;stroke:none!important}#leftTop,#rightTop,#leftBottom,#rightBottom{visibility:hidden!important}`;
      } else {
        p.head.removeAttribute("mask");
        p.style.textContent = raw && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]+)$/i.test(raw) ? `svg{--material-eye:${raw}!important;--material-eye-right:${raw}!important}${EYES}{fill:${raw}!important}` : "";
      }
      instance._eyeColorApplied = raw;
      instance._eyeColorAsked = asked;
      (_b = instance._resumeFrames) == null ? void 0 : _b.call(instance);
    }
    BoopFace.prototype.setEyeColor = function(value) {
      if (value == null || value === "") this.removeAttribute("eye-color");
      else this.setAttribute("eye-color", String(value));
      return this;
    };
    registerAvatarExtension({
      name: "eye-color",
      draw() {
        if (this._eyeColorApplied !== wanted(this) || this._eyeColorAsked !== String(this.getAttribute("eye-color") || "").trim()) apply(this);
      }
    });
  });
  __define("src/boopface-round-eyes.js", function(__require2, __import2, exports) {
    const { registerAvatarExtension } = __require2("src/boopface-extension-host.js");
    const { roundInto } = __require2("src/boopface-eye-shape.js");
    const ROUND = 4;
    function targets(instance) {
      if (instance._roundEyeTargets) return instance._roundEyeTargets;
      const root = instance.shadowRoot, svg = root == null ? void 0 : root.querySelector("svg");
      if (!svg) return null;
      instance._roundEyeTargets = ["left", "right"].map((side) => ({
        svg,
        id: `round-eye-${side}`,
        base: root.getElementById(`${side}Base`),
        input: root.getElementById(`${side}InputBase`),
        top: root.getElementById(`${side}Top`),
        bottom: root.getElementById(`${side}Bottom`)
      }));
      return instance._roundEyeTargets;
    }
    const attrs = (el, names) => names.map((n) => el == null ? void 0 : el.getAttribute(n)).join(",");
    registerAvatarExtension({
      name: "round-eyes",
      // Runs after every other draw step, so whatever an expression wrote to the
      // eyes this frame is already in place.
      draw() {
        const list = targets(this);
        if (!list) return;
        const sharp = String(this.getAttribute("eye-style") || "").trim().toLowerCase() === "sharp";
        const through = /^(transparent|none|through)$/i.test(String(this.getAttribute("eye-color") || "").trim());
        const R = sharp ? through ? 0.01 : 0 : ROUND;
        if (R > 0) for (const t of list) {
          const el = t.input, rx = el && ((+el.getAttribute("width") || 0) / 2).toFixed(2);
          if (el && el.getAttribute("rx") !== rx) el.setAttribute("rx", rx);
        }
        let sig = String(R);
        for (const t of list) sig += attrs(t.base, ["cx", "cy", "rx", "ry", "transform", "data-shape"]) + attrs(t.top, ["y", "height", "transform"]) + attrs(t.bottom, ["y", "height", "transform"]);
        if (sig === this._roundEyeSig) return;
        this._roundEyeSig = sig;
        for (const t of list) roundInto(t, R);
      }
    });
  });
  __define("src/skins/paints.js", function(__require2, __import2, exports) {
    const SKIN_PAINTS = { "101": { "paint": [{ "id": "material-blackglaze-antenna", "path": [], "attributes": { "r": "0.88" } }, { "id": "material-blackglaze-antenna", "path": [0], "attributes": { "stop-color": "#c0c9d3" } }, { "id": "material-blackglaze-antenna", "path": [1], "attributes": { "stop-color": "#27323f" } }, { "id": "material-blackglaze-antenna", "path": [2], "attributes": { "stop-color": "#76818f" } }, { "id": "material-blackglaze-texture", "path": [0], "attributes": { "transform": "translate(34 35.400000000000006) scale(0.95 0.83)" } }] }, "303": { "paint": [{ "id": "skin-eye-glass", "path": [], "attributes": { "y1": "0.147", "y2": "0.853" } }, { "id": "skin-eye-sink", "path": [1], "attributes": { "dx": "4.244", "dy": "4.242" } }, { "id": "skin-eye-sink-offset", "path": [], "attributes": { "dx": "4.244", "dy": "4.242" } }] }, "308": { "paint": [{ "id": "skin-eye-glass", "path": [], "attributes": { "x1": "0.148", "y1": "0.145", "x2": "0.852", "y2": "0.855" } }, { "id": "skin-eye-sink", "path": [1], "attributes": { "dx": "4.224", "dy": "4.261" } }, { "id": "skin-eye-sink-offset", "path": [], "attributes": { "dx": "4.224", "dy": "4.261" } }, { "id": "skin-antenna", "path": [], "attributes": { "cx": "0.351" } }] }, "309": { "paint": [{ "id": "skin-volume", "path": [], "attributes": { "cy": "0.315" } }, { "id": "skin-eye-glass", "path": [], "attributes": { "x1": "0.122", "y1": "0.173", "x2": "0.878", "y2": "0.827" } }, { "id": "skin-eye-sink", "path": [1], "attributes": { "dx": "4.541", "dy": "3.921" } }, { "id": "skin-eye-sink-offset", "path": [], "attributes": { "dx": "4.541", "dy": "3.921" } }, { "id": "skin-antenna", "path": [], "attributes": { "cx": "0.349", "cy": "0.226" } }] }, "312": { "paint": [{ "id": "skin-sheen-band", "path": [0], "attributes": { "stop-color": "#ebf8ed" } }, { "id": "skin-sheen-band", "path": [2], "attributes": { "stop-color": "#b4e5bd" } }, { "id": "skin-sheen-band", "path": [4], "attributes": { "stop-color": "#ebf8ed" } }, { "id": "skin-base", "path": [1], "attributes": { "stop-color": "#61c875" } }, { "id": "skin-base", "path": [2], "attributes": { "stop-color": "#42bd5a" } }, { "id": "skin-base", "path": [3], "attributes": { "stop-color": "#42bd5a" } }, { "id": "skin-eye-glass", "path": [], "attributes": { "x2": "0.8539999999999999", "y2": "0.8539999999999999" } }] }, "503": { "paint": [{ "id": "skin-sheen-band", "path": [2], "attributes": { "stop-color": "#80f28d" } }, { "id": "skin-base", "path": [1], "attributes": { "stop-color": "#24b237" } }, { "id": "skin-sheen-glint", "path": [7], "attributes": { "stop-opacity": "0.7648" } }, { "id": "skin-eye-glass", "path": [], "attributes": { "x2": "0.8539999999999999", "y2": "0.8539999999999999" } }] }, "509": { "paint": [{ "id": "skin-shine", "path": [], "attributes": { "cy": "0.116" } }, { "id": "skin-edge", "path": [], "attributes": { "cy": "0.809" } }, { "id": "skin-eye-glass", "path": [], "attributes": { "x1": "0.144", "y1": "0.149", "x2": "0.856", "y2": "0.851" } }, { "id": "skin-eye-sink", "path": [1], "attributes": { "dx": "3.556", "dy": "3.515" } }, { "id": "skin-eye-sink-offset", "path": [], "attributes": { "dx": "3.556", "dy": "3.515" } }, { "id": "skin-antenna", "path": [], "attributes": { "cy": "0.216" } }], "properties": {} }, "606": { "paint": [{ "id": "skin-base", "path": [1], "attributes": { "stop-color": "#fbac23" } }, { "id": "skin-base", "path": [3], "attributes": { "stop-color": "#fcae27" } }, { "id": "skin-eye-glass", "path": [], "attributes": { "x2": "0.8539999999999999", "y2": "0.8539999999999999" } }] }, "609": { "paint": [{ "id": "skin-eye-glass", "path": [], "attributes": { "y1": "0.147", "y2": "0.853" } }, { "id": "skin-eye-sink", "path": [1], "attributes": { "dx": "5.659", "dy": "5.655" } }, { "id": "skin-eye-sink-offset", "path": [], "attributes": { "dx": "5.659", "dy": "5.655" } }, { "id": "skin-eye-hl", "path": [], "attributes": { "cx": "-4.999", "cy": "5.505" } }, { "id": "skin-eye-spark", "path": [], "attributes": { "cx": "7.999", "cy": "8.995" } }], "properties": {} }, "703": { "paint": [{ "id": "skin-shine", "path": [], "attributes": { "cx": "0.367", "cy": "0.138" } }, { "id": "skin-volume", "path": [], "attributes": { "cx": "0.447", "cy": "0.321" } }, { "id": "skin-rim", "path": [], "attributes": { "x1": "0.278", "x2": "0.722" } }, { "id": "skin-edge", "path": [], "attributes": { "cx": "0.687", "cy": "0.794" } }, { "id": "skin-antenna", "path": [], "attributes": { "cx": "0.367", "cy": "0.238" } }] }, "803": { "paint": [{ "selector": 'ellipse[fill="url(#material-clearweighted-texture-transmitted)"]', "attributes": { "opacity": "0.55" } }] }, "901": { "paint": [{ "id": "material-golddrop-shine", "path": [3], "attributes": { "stop-color": "#ffffff" } }, { "id": "material-golddrop-volume", "path": [1], "attributes": { "stop-color": "#251e0a" } }, { "id": "material-golddrop-volume", "path": [2], "attributes": { "stop-color": "#251e0a" } }, { "id": "material-golddrop-volume", "path": [3], "attributes": { "stop-color": "#251e0a" } }] }, "902": { "paint": [{ "id": "material-deepmetalgold-volume", "path": [1], "attributes": { "stop-color": "#181000" } }, { "id": "material-deepmetalgold-volume", "path": [2], "attributes": { "stop-color": "#181000" } }, { "id": "material-deepmetalgold-volume", "path": [3], "attributes": { "stop-color": "#181000" } }, { "id": "material-deepmetalgold-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#764e00" } }, { "id": "material-deepmetalgold-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#976400" } }, { "id": "material-deepmetalgold-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#c3902a" } }, { "id": "material-deepmetalgold-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#dbae55" } }, { "id": "material-deepmetalgold-texture-underside", "path": [0], "attributes": { "stop-color": "#845700" } }, { "id": "material-deepmetalgold-texture-underside", "path": [1], "attributes": { "stop-color": "#a26d07" } }, { "id": "material-deepmetalgold-texture-underside", "path": [2], "attributes": { "stop-color": "#cf9e3d" } }, { "id": "material-deepmetalgold-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fef9ef" } }, { "id": "material-deepmetalgold-texture-studio-white", "path": [3], "attributes": { "stop-color": "#fbf0da" } }, { "id": "material-deepmetalgold-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fefaf2" } }, { "id": "material-deepmetalgold-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fcf4e4" } }, { "id": "material-deepmetalgold-texture-rim-light", "path": [2], "attributes": { "stop-color": "#f7e4be" } }, { "id": "material-deepmetalgold-texture-rim-light", "path": [3], "attributes": { "stop-color": "#f7e4be" } }, { "id": "material-deepmetalgold-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#f5dfb4" } }, { "id": "material-deepmetalgold-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#f5dfb4" } }, { "id": "material-deepmetalgold-texture-warm-room", "path": [0], "attributes": { "stop-color": "#eecf91" } }, { "id": "material-deepmetalgold-texture-warm-room", "path": [1], "attributes": { "stop-color": "#eecf91" } }] }, "903": { "paint": [{ "id": "material-deepmetalrose-volume", "path": [1], "attributes": { "stop-color": "#200d0b" } }, { "id": "material-deepmetalrose-volume", "path": [2], "attributes": { "stop-color": "#200d0b" } }, { "id": "material-deepmetalrose-volume", "path": [3], "attributes": { "stop-color": "#200d0b" } }, { "id": "material-deepmetalrose-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#88433b" } }, { "id": "material-deepmetalrose-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#a5584f" } }, { "id": "material-deepmetalrose-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#d1837a" } }, { "id": "material-deepmetalrose-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#e7a39b" } }, { "id": "material-deepmetalrose-texture-underside", "path": [0], "attributes": { "stop-color": "#954b43" } }, { "id": "material-deepmetalrose-texture-underside", "path": [1], "attributes": { "stop-color": "#b06158" } }, { "id": "material-deepmetalrose-texture-underside", "path": [2], "attributes": { "stop-color": "#dc928a" } }, { "id": "material-deepmetalrose-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fff8f7" } }, { "id": "material-deepmetalrose-texture-studio-white", "path": [3], "attributes": { "stop-color": "#feedec" } }, { "id": "material-deepmetalrose-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fff9f8" } }, { "id": "material-deepmetalrose-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fff2f1" } }, { "id": "material-deepmetalrose-texture-rim-light", "path": [2], "attributes": { "stop-color": "#fcdfdc" } }, { "id": "material-deepmetalrose-texture-rim-light", "path": [3], "attributes": { "stop-color": "#fcdfdc" } }, { "id": "material-deepmetalrose-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#fbdad6" } }, { "id": "material-deepmetalrose-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#fbdad6" } }, { "id": "material-deepmetalrose-texture-warm-room", "path": [0], "attributes": { "stop-color": "#f7c7c2" } }, { "id": "material-deepmetalrose-texture-warm-room", "path": [1], "attributes": { "stop-color": "#f7c7c2" } }] }, "904": { "paint": [{ "id": "material-copperdeep-volume", "path": [1], "attributes": { "stop-color": "#23140c" } }, { "id": "material-copperdeep-volume", "path": [2], "attributes": { "stop-color": "#23140c" } }, { "id": "material-copperdeep-volume", "path": [3], "attributes": { "stop-color": "#23140c" } }] }, "905": { "paint": [{ "id": "material-deepmetalcopper-volume", "path": [1], "attributes": { "stop-color": "#230d00" } }, { "id": "material-deepmetalcopper-volume", "path": [2], "attributes": { "stop-color": "#230d00" } }, { "id": "material-deepmetalcopper-volume", "path": [3], "attributes": { "stop-color": "#230d00" } }, { "id": "material-deepmetalcopper-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#934415" } }, { "id": "material-deepmetalcopper-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#b15925" } }, { "id": "material-deepmetalcopper-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#de844f" } }, { "id": "material-deepmetalcopper-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#f2a376" } }, { "id": "material-deepmetalcopper-texture-underside", "path": [0], "attributes": { "stop-color": "#a04c1b" } }, { "id": "material-deepmetalcopper-texture-underside", "path": [1], "attributes": { "stop-color": "#bc622c" } }, { "id": "material-deepmetalcopper-texture-underside", "path": [2], "attributes": { "stop-color": "#e89360" } }, { "id": "material-deepmetalcopper-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fff8f4" } }, { "id": "material-deepmetalcopper-texture-studio-white", "path": [3], "attributes": { "stop-color": "#ffeee4" } }, { "id": "material-deepmetalcopper-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fff9f6" } }, { "id": "material-deepmetalcopper-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fff3eb" } }, { "id": "material-deepmetalcopper-texture-rim-light", "path": [2], "attributes": { "stop-color": "#ffe0ce" } }, { "id": "material-deepmetalcopper-texture-rim-light", "path": [3], "attributes": { "stop-color": "#ffe0ce" } }, { "id": "material-deepmetalcopper-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#ffdbc6" } }, { "id": "material-deepmetalcopper-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#ffdbc6" } }, { "id": "material-deepmetalcopper-texture-warm-room", "path": [0], "attributes": { "stop-color": "#fec8a8" } }, { "id": "material-deepmetalcopper-texture-warm-room", "path": [1], "attributes": { "stop-color": "#fec8a8" } }] }, "906": { "paint": [{ "id": "material-iphonecosmicorange-volume", "path": [1], "attributes": { "stop-color": "#290e00" } }, { "id": "material-iphonecosmicorange-volume", "path": [2], "attributes": { "stop-color": "#290e00" } }, { "id": "material-iphonecosmicorange-volume", "path": [3], "attributes": { "stop-color": "#290e00" } }, { "id": "material-iphonecosmicorange-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#b44104" } }, { "id": "material-iphonecosmicorange-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#d45512" } }, { "id": "material-iphonecosmicorange-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#fe813e" } }, { "id": "material-iphonecosmicorange-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#ffa373" } }, { "id": "material-iphonecosmicorange-texture-underside", "path": [0], "attributes": { "stop-color": "#c24909" } }, { "id": "material-iphonecosmicorange-texture-underside", "path": [1], "attributes": { "stop-color": "#df5e1a" } }, { "id": "material-iphonecosmicorange-texture-underside", "path": [2], "attributes": { "stop-color": "#ff9157" } }, { "id": "material-iphonecosmicorange-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fff8f4" } }, { "id": "material-iphonecosmicorange-texture-studio-white", "path": [3], "attributes": { "stop-color": "#ffefe6" } }, { "id": "material-iphonecosmicorange-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fff9f7" } }, { "id": "material-iphonecosmicorange-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fff3ed" } }, { "id": "material-iphonecosmicorange-texture-rim-light", "path": [2], "attributes": { "stop-color": "#ffe1d1" } }, { "id": "material-iphonecosmicorange-texture-rim-light", "path": [3], "attributes": { "stop-color": "#ffe1d1" } }, { "id": "material-iphonecosmicorange-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#ffdcca" } }, { "id": "material-iphonecosmicorange-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#ffdcca" } }, { "id": "material-iphonecosmicorange-texture-warm-room", "path": [0], "attributes": { "stop-color": "#ffc9ad" } }, { "id": "material-iphonecosmicorange-texture-warm-room", "path": [1], "attributes": { "stop-color": "#ffc9ad" } }] }, "907": { "paint": [{ "id": "material-deepmetalbronze-volume", "path": [1], "attributes": { "stop-color": "#131200" } }, { "id": "material-deepmetalbronze-volume", "path": [2], "attributes": { "stop-color": "#131200" } }, { "id": "material-deepmetalbronze-volume", "path": [3], "attributes": { "stop-color": "#131200" } }, { "id": "material-deepmetalbronze-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#5d5600" } }, { "id": "material-deepmetalbronze-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#766d0b" } }, { "id": "material-deepmetalbronze-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#a19935" } }, { "id": "material-deepmetalbronze-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#bdb55f" } }, { "id": "material-deepmetalbronze-texture-underside", "path": [0], "attributes": { "stop-color": "#685f02" } }, { "id": "material-deepmetalbronze-texture-underside", "path": [1], "attributes": { "stop-color": "#7f7612" } }, { "id": "material-deepmetalbronze-texture-underside", "path": [2], "attributes": { "stop-color": "#afa647" } }, { "id": "material-deepmetalbronze-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fafaf0" } }, { "id": "material-deepmetalbronze-texture-studio-white", "path": [3], "attributes": { "stop-color": "#f4f2dd" } }, { "id": "material-deepmetalbronze-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fbfbf3" } }, { "id": "material-deepmetalbronze-texture-rim-light", "path": [1], "attributes": { "stop-color": "#f7f6e6" } }, { "id": "material-deepmetalbronze-texture-rim-light", "path": [2], "attributes": { "stop-color": "#ebe7c2" } }, { "id": "material-deepmetalbronze-texture-rim-light", "path": [3], "attributes": { "stop-color": "#ebe7c2" } }, { "id": "material-deepmetalbronze-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#e7e3b9" } }, { "id": "material-deepmetalbronze-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#e7e3b9" } }, { "id": "material-deepmetalbronze-texture-warm-room", "path": [0], "attributes": { "stop-color": "#dad498" } }, { "id": "material-deepmetalbronze-texture-warm-room", "path": [1], "attributes": { "stop-color": "#dad498" } }] }, "908": { "paint": [{ "id": "material-deepmetaltitanium-volume", "path": [1], "attributes": { "stop-color": "#0c1118" } }, { "id": "material-deepmetaltitanium-volume", "path": [2], "attributes": { "stop-color": "#0c1118" } }, { "id": "material-deepmetaltitanium-volume", "path": [3], "attributes": { "stop-color": "#0c1118" } }, { "id": "material-deepmetaltitanium-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#41536b" } }, { "id": "material-deepmetaltitanium-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#566a84" } }, { "id": "material-deepmetaltitanium-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#8196b0" } }, { "id": "material-deepmetaltitanium-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#a1b3ca" } }, { "id": "material-deepmetaltitanium-texture-underside", "path": [0], "attributes": { "stop-color": "#495d75" } }, { "id": "material-deepmetaltitanium-texture-underside", "path": [1], "attributes": { "stop-color": "#5f748e" } }, { "id": "material-deepmetaltitanium-texture-underside", "path": [2], "attributes": { "stop-color": "#90a4bd" } }, { "id": "material-deepmetaltitanium-texture-studio-white", "path": [2], "attributes": { "stop-color": "#f7f9fc" } }, { "id": "material-deepmetaltitanium-texture-studio-white", "path": [3], "attributes": { "stop-color": "#edf1f7" } }, { "id": "material-deepmetaltitanium-texture-rim-light", "path": [0], "attributes": { "stop-color": "#f9fafc" } }, { "id": "material-deepmetaltitanium-texture-rim-light", "path": [1], "attributes": { "stop-color": "#f2f5f9" } }, { "id": "material-deepmetaltitanium-texture-rim-light", "path": [2], "attributes": { "stop-color": "#dfe6f0" } }, { "id": "material-deepmetaltitanium-texture-rim-light", "path": [3], "attributes": { "stop-color": "#dfe6f0" } }, { "id": "material-deepmetaltitanium-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#d9e2ed" } }, { "id": "material-deepmetaltitanium-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#d9e2ed" } }, { "id": "material-deepmetaltitanium-texture-warm-room", "path": [0], "attributes": { "stop-color": "#c6d3e3" } }, { "id": "material-deepmetaltitanium-texture-warm-room", "path": [1], "attributes": { "stop-color": "#c6d3e3" } }] }, "909": { "paint": [{ "id": "material-deepmetalplatinum-volume", "path": [1], "attributes": { "stop-color": "#3b3e44" } }, { "id": "material-deepmetalplatinum-volume", "path": [2], "attributes": { "stop-color": "#3b3e44" } }, { "id": "material-deepmetalplatinum-volume", "path": [3], "attributes": { "stop-color": "#3b3e44" } }, { "id": "material-deepmetalplatinum-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#888d94" } }, { "id": "material-deepmetalplatinum-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#9ca0a7" } }, { "id": "material-deepmetalplatinum-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#bcc0c5" } }, { "id": "material-deepmetalplatinum-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#d0d3d7" } }, { "id": "material-deepmetalplatinum-texture-underside", "path": [0], "attributes": { "stop-color": "#90959c" } }, { "id": "material-deepmetalplatinum-texture-underside", "path": [1], "attributes": { "stop-color": "#a3a8ae" } }, { "id": "material-deepmetalplatinum-texture-underside", "path": [2], "attributes": { "stop-color": "#c6c9ce" } }, { "id": "material-deepmetalplatinum-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fcfcfc" } }, { "id": "material-deepmetalplatinum-texture-studio-white", "path": [3], "attributes": { "stop-color": "#f7f8f8" } }, { "id": "material-deepmetalplatinum-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fcfdfd" } }, { "id": "material-deepmetalplatinum-texture-rim-light", "path": [1], "attributes": { "stop-color": "#f9fafa" } }, { "id": "material-deepmetalplatinum-texture-rim-light", "path": [2], "attributes": { "stop-color": "#f0f1f3" } }, { "id": "material-deepmetalplatinum-texture-rim-light", "path": [3], "attributes": { "stop-color": "#f0f1f3" } }, { "id": "material-deepmetalplatinum-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#eeeff1" } }, { "id": "material-deepmetalplatinum-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#eeeff1" } }, { "id": "material-deepmetalplatinum-texture-warm-room", "path": [0], "attributes": { "stop-color": "#e4e6e9" } }, { "id": "material-deepmetalplatinum-texture-warm-room", "path": [1], "attributes": { "stop-color": "#e4e6e9" } }] }, "910": { "paint": [{ "id": "material-deepmetalchampagne-volume", "path": [1], "attributes": { "stop-color": "#2f230c" } }, { "id": "material-deepmetalchampagne-volume", "path": [2], "attributes": { "stop-color": "#2f230c" } }, { "id": "material-deepmetalchampagne-volume", "path": [3], "attributes": { "stop-color": "#2f230c" } }, { "id": "material-deepmetalchampagne-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#866e40" } }, { "id": "material-deepmetalchampagne-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#9c8455" } }, { "id": "material-deepmetalchampagne-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#bfaa81" } }, { "id": "material-deepmetalchampagne-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#d4c3a1" } }, { "id": "material-deepmetalchampagne-texture-underside", "path": [0], "attributes": { "stop-color": "#8f7748" } }, { "id": "material-deepmetalchampagne-texture-underside", "path": [1], "attributes": { "stop-color": "#a48c5e" } }, { "id": "material-deepmetalchampagne-texture-underside", "path": [2], "attributes": { "stop-color": "#c9b690" } }, { "id": "material-deepmetalchampagne-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fcfbf8" } }, { "id": "material-deepmetalchampagne-texture-studio-white", "path": [3], "attributes": { "stop-color": "#f8f4ed" } }, { "id": "material-deepmetalchampagne-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fdfbf9" } }, { "id": "material-deepmetalchampagne-texture-rim-light", "path": [1], "attributes": { "stop-color": "#faf7f2" } }, { "id": "material-deepmetalchampagne-texture-rim-light", "path": [2], "attributes": { "stop-color": "#f2ecdf" } }, { "id": "material-deepmetalchampagne-texture-rim-light", "path": [3], "attributes": { "stop-color": "#f2ecdf" } }, { "id": "material-deepmetalchampagne-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#f0e9da" } }, { "id": "material-deepmetalchampagne-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#f0e9da" } }, { "id": "material-deepmetalchampagne-texture-warm-room", "path": [0], "attributes": { "stop-color": "#e7dcc7" } }, { "id": "material-deepmetalchampagne-texture-warm-room", "path": [1], "attributes": { "stop-color": "#e7dcc7" } }] }, "911": { "paint": [{ "id": "material-deepmetaliceblue-volume", "path": [1], "attributes": { "stop-color": "#06202e" } }, { "id": "material-deepmetaliceblue-volume", "path": [2], "attributes": { "stop-color": "#06202e" } }, { "id": "material-deepmetaliceblue-volume", "path": [3], "attributes": { "stop-color": "#06202e" } }, { "id": "material-deepmetaliceblue-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#2e6f92" } }, { "id": "material-deepmetaliceblue-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#4186aa" } }, { "id": "material-deepmetaliceblue-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#6eaecf" } }, { "id": "material-deepmetaliceblue-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#91c6e2" } }, { "id": "material-deepmetaliceblue-texture-underside", "path": [0], "attributes": { "stop-color": "#35799c" } }, { "id": "material-deepmetaliceblue-texture-underside", "path": [1], "attributes": { "stop-color": "#4a8fb3" } }, { "id": "material-deepmetaliceblue-texture-underside", "path": [2], "attributes": { "stop-color": "#7eb9d8" } }, { "id": "material-deepmetaliceblue-texture-studio-white", "path": [2], "attributes": { "stop-color": "#f6fbfe" } }, { "id": "material-deepmetaliceblue-texture-studio-white", "path": [3], "attributes": { "stop-color": "#e9f5fc" } }, { "id": "material-deepmetaliceblue-texture-rim-light", "path": [0], "attributes": { "stop-color": "#f8fcfe" } }, { "id": "material-deepmetaliceblue-texture-rim-light", "path": [1], "attributes": { "stop-color": "#eff8fd" } }, { "id": "material-deepmetaliceblue-texture-rim-light", "path": [2], "attributes": { "stop-color": "#d8edf8" } }, { "id": "material-deepmetaliceblue-texture-rim-light", "path": [3], "attributes": { "stop-color": "#d8edf8" } }, { "id": "material-deepmetaliceblue-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#d2eaf7" } }, { "id": "material-deepmetaliceblue-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#d2eaf7" } }, { "id": "material-deepmetaliceblue-texture-warm-room", "path": [0], "attributes": { "stop-color": "#bcdff1" } }, { "id": "material-deepmetaliceblue-texture-warm-room", "path": [1], "attributes": { "stop-color": "#bcdff1" } }] }, "912": { "paint": [{ "id": "material-iphoneultramarine-volume", "path": [1], "attributes": { "stop-color": "#090e24" } }, { "id": "material-iphoneultramarine-volume", "path": [2], "attributes": { "stop-color": "#090e24" } }, { "id": "material-iphoneultramarine-volume", "path": [3], "attributes": { "stop-color": "#090e24" } }, { "id": "material-iphoneultramarine-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#3749a3" } }, { "id": "material-iphoneultramarine-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#4b5fc5" } }, { "id": "material-iphoneultramarine-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#768bf6" } }, { "id": "material-iphoneultramarine-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#9aaaff" } }, { "id": "material-iphoneultramarine-texture-underside", "path": [0], "attributes": { "stop-color": "#3f52b2" } }, { "id": "material-iphoneultramarine-texture-underside", "path": [1], "attributes": { "stop-color": "#5468d2" } }, { "id": "material-iphoneultramarine-texture-underside", "path": [2], "attributes": { "stop-color": "#869aff" } }, { "id": "material-iphoneultramarine-texture-studio-white", "path": [2], "attributes": { "stop-color": "#f7f9ff" } }, { "id": "material-iphoneultramarine-texture-studio-white", "path": [3], "attributes": { "stop-color": "#edf0ff" } }, { "id": "material-iphoneultramarine-texture-rim-light", "path": [0], "attributes": { "stop-color": "#f9faff" } }, { "id": "material-iphoneultramarine-texture-rim-light", "path": [1], "attributes": { "stop-color": "#f2f4ff" } }, { "id": "material-iphoneultramarine-texture-rim-light", "path": [2], "attributes": { "stop-color": "#dee3ff" } }, { "id": "material-iphoneultramarine-texture-rim-light", "path": [3], "attributes": { "stop-color": "#dee3ff" } }, { "id": "material-iphoneultramarine-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#d8deff" } }, { "id": "material-iphoneultramarine-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#d8deff" } }, { "id": "material-iphoneultramarine-texture-warm-room", "path": [0], "attributes": { "stop-color": "#c3cdff" } }, { "id": "material-iphoneultramarine-texture-warm-room", "path": [1], "attributes": { "stop-color": "#c3cdff" } }] }, "913": { "paint": [{ "id": "material-deepmetalviolet-volume", "path": [1], "attributes": { "stop-color": "#160720" } }, { "id": "material-deepmetalviolet-volume", "path": [2], "attributes": { "stop-color": "#160720" } }, { "id": "material-deepmetalviolet-volume", "path": [3], "attributes": { "stop-color": "#160720" } }, { "id": "material-deepmetalviolet-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#7231a0" } }, { "id": "material-deepmetalviolet-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#8f44c4" } }, { "id": "material-deepmetalviolet-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#bf6ff8" } }, { "id": "material-deepmetalviolet-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#d394ff" } }, { "id": "material-deepmetalviolet-texture-underside", "path": [0], "attributes": { "stop-color": "#7e38af" } }, { "id": "material-deepmetalviolet-texture-underside", "path": [1], "attributes": { "stop-color": "#9a4cd1" } }, { "id": "material-deepmetalviolet-texture-underside", "path": [2], "attributes": { "stop-color": "#ca7fff" } }, { "id": "material-deepmetalviolet-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fcf7ff" } }, { "id": "material-deepmetalviolet-texture-studio-white", "path": [3], "attributes": { "stop-color": "#f7ebff" } }, { "id": "material-deepmetalviolet-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fcf8ff" } }, { "id": "material-deepmetalviolet-texture-rim-light", "path": [1], "attributes": { "stop-color": "#f9f1ff" } }, { "id": "material-deepmetalviolet-texture-rim-light", "path": [2], "attributes": { "stop-color": "#f0dbff" } }, { "id": "material-deepmetalviolet-texture-rim-light", "path": [3], "attributes": { "stop-color": "#f0dbff" } }, { "id": "material-deepmetalviolet-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#eed5ff" } }, { "id": "material-deepmetalviolet-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#eed5ff" } }, { "id": "material-deepmetalviolet-texture-warm-room", "path": [0], "attributes": { "stop-color": "#e5c0ff" } }, { "id": "material-deepmetalviolet-texture-warm-room", "path": [1], "attributes": { "stop-color": "#e5c0ff" } }] }, "914": { "paint": [{ "id": "material-iphoneburgundy-volume", "path": [1], "attributes": { "stop-color": "#040102" } }, { "id": "material-iphoneburgundy-volume", "path": [2], "attributes": { "stop-color": "#040102" } }, { "id": "material-iphoneburgundy-volume", "path": [3], "attributes": { "stop-color": "#040102" } }, { "id": "material-iphoneburgundy-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#3e1523" } }, { "id": "material-iphoneburgundy-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#5d2236" } }, { "id": "material-iphoneburgundy-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#a04765" } }, { "id": "material-iphoneburgundy-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#cb6b8b" } }, { "id": "material-iphoneburgundy-texture-underside", "path": [0], "attributes": { "stop-color": "#4a1a2a" } }, { "id": "material-iphoneburgundy-texture-underside", "path": [1], "attributes": { "stop-color": "#6b293f" } }, { "id": "material-iphoneburgundy-texture-underside", "path": [2], "attributes": { "stop-color": "#b55776" } }, { "id": "material-iphoneburgundy-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fff1f6" } }, { "id": "material-iphoneburgundy-texture-studio-white", "path": [3], "attributes": { "stop-color": "#ffdee9" } }, { "id": "material-iphoneburgundy-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fff4f7" } }, { "id": "material-iphoneburgundy-texture-rim-light", "path": [1], "attributes": { "stop-color": "#ffe7ef" } }, { "id": "material-iphoneburgundy-texture-rim-light", "path": [2], "attributes": { "stop-color": "#fcc4d7" } }, { "id": "material-iphoneburgundy-texture-rim-light", "path": [3], "attributes": { "stop-color": "#fcc4d7" } }, { "id": "material-iphoneburgundy-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#fabbd0" } }, { "id": "material-iphoneburgundy-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#fabbd0" } }, { "id": "material-iphoneburgundy-texture-warm-room", "path": [0], "attributes": { "stop-color": "#ef9db9" } }, { "id": "material-iphoneburgundy-texture-warm-room", "path": [1], "attributes": { "stop-color": "#ef9db9" } }] }, "915": { "paint": [{ "id": "material-iphoneteal-volume", "path": [1], "attributes": { "stop-color": "#021817" } }, { "id": "material-iphoneteal-volume", "path": [2], "attributes": { "stop-color": "#021817" } }, { "id": "material-iphoneteal-volume", "path": [3], "attributes": { "stop-color": "#021817" } }, { "id": "material-iphoneteal-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#206562" } }, { "id": "material-iphoneteal-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#317d7a" } }, { "id": "material-iphoneteal-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#5da7a4" } }, { "id": "material-iphoneteal-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#82c2bf" } }, { "id": "material-iphoneteal-texture-underside", "path": [0], "attributes": { "stop-color": "#276f6c" } }, { "id": "material-iphoneteal-texture-underside", "path": [1], "attributes": { "stop-color": "#3a8683" } }, { "id": "material-iphoneteal-texture-underside", "path": [2], "attributes": { "stop-color": "#6eb4b1" } }, { "id": "material-iphoneteal-texture-studio-white", "path": [2], "attributes": { "stop-color": "#f4fbfb" } }, { "id": "material-iphoneteal-texture-studio-white", "path": [3], "attributes": { "stop-color": "#e6f5f4" } }, { "id": "material-iphoneteal-texture-rim-light", "path": [0], "attributes": { "stop-color": "#f6fcfb" } }, { "id": "material-iphoneteal-texture-rim-light", "path": [1], "attributes": { "stop-color": "#ecf8f7" } }, { "id": "material-iphoneteal-texture-rim-light", "path": [2], "attributes": { "stop-color": "#d2eceb" } }, { "id": "material-iphoneteal-texture-rim-light", "path": [3], "attributes": { "stop-color": "#d2eceb" } }, { "id": "material-iphoneteal-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#cae9e8" } }, { "id": "material-iphoneteal-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#cae9e8" } }, { "id": "material-iphoneteal-texture-warm-room", "path": [0], "attributes": { "stop-color": "#b1dddb" } }, { "id": "material-iphoneteal-texture-warm-room", "path": [1], "attributes": { "stop-color": "#b1dddb" } }] }, "916": { "paint": [{ "id": "material-deepmetalforest-volume", "path": [1], "attributes": { "stop-color": "#010202" } }, { "id": "material-deepmetalforest-volume", "path": [2], "attributes": { "stop-color": "#010202" } }, { "id": "material-deepmetalforest-volume", "path": [3], "attributes": { "stop-color": "#010202" } }, { "id": "material-deepmetalforest-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#12251e" } }, { "id": "material-deepmetalforest-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#1e392f" } }, { "id": "material-deepmetalforest-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#416859" } }, { "id": "material-deepmetalforest-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#648e7e" } }, { "id": "material-deepmetalforest-texture-underside", "path": [0], "attributes": { "stop-color": "#172d24" } }, { "id": "material-deepmetalforest-texture-underside", "path": [1], "attributes": { "stop-color": "#244237" } }, { "id": "material-deepmetalforest-texture-underside", "path": [2], "attributes": { "stop-color": "#507a6a" } }, { "id": "material-deepmetalforest-texture-studio-white", "path": [2], "attributes": { "stop-color": "#eff6f4" } }, { "id": "material-deepmetalforest-texture-studio-white", "path": [3], "attributes": { "stop-color": "#dbeae4" } }, { "id": "material-deepmetalforest-texture-rim-light", "path": [0], "attributes": { "stop-color": "#f2f8f6" } }, { "id": "material-deepmetalforest-texture-rim-light", "path": [1], "attributes": { "stop-color": "#e4efeb" } }, { "id": "material-deepmetalforest-texture-rim-light", "path": [2], "attributes": { "stop-color": "#c0d8cf" } }, { "id": "material-deepmetalforest-texture-rim-light", "path": [3], "attributes": { "stop-color": "#c0d8cf" } }, { "id": "material-deepmetalforest-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#b7d2c8" } }, { "id": "material-deepmetalforest-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#b7d2c8" } }, { "id": "material-deepmetalforest-texture-warm-room", "path": [0], "attributes": { "stop-color": "#98bbad" } }, { "id": "material-deepmetalforest-texture-warm-room", "path": [1], "attributes": { "stop-color": "#98bbad" } }] }, "917": { "paint": [{ "id": "material-iphonenatural-volume", "path": [1], "attributes": { "stop-color": "#27241e" } }, { "id": "material-iphonenatural-volume", "path": [2], "attributes": { "stop-color": "#27241e" } }, { "id": "material-iphonenatural-volume", "path": [3], "attributes": { "stop-color": "#27241e" } }, { "id": "material-iphonenatural-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#756f65" } }, { "id": "material-iphonenatural-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#8b857a" } }, { "id": "material-iphonenatural-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#b1aba2" } }, { "id": "material-iphonenatural-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#c8c4bc" } }, { "id": "material-iphonenatural-texture-underside", "path": [0], "attributes": { "stop-color": "#7e786d" } }, { "id": "material-iphonenatural-texture-underside", "path": [1], "attributes": { "stop-color": "#938e83" } }, { "id": "material-iphonenatural-texture-underside", "path": [2], "attributes": { "stop-color": "#bcb7ae" } }, { "id": "material-iphonenatural-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fbfbfa" } }, { "id": "material-iphonenatural-texture-studio-white", "path": [3], "attributes": { "stop-color": "#f6f5f3" } }, { "id": "material-iphonenatural-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fcfcfb" } }, { "id": "material-iphonenatural-texture-rim-light", "path": [1], "attributes": { "stop-color": "#f8f8f6" } }, { "id": "material-iphonenatural-texture-rim-light", "path": [2], "attributes": { "stop-color": "#eeece9" } }, { "id": "material-iphonenatural-texture-rim-light", "path": [3], "attributes": { "stop-color": "#eeece9" } }, { "id": "material-iphonenatural-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#ebe9e5" } }, { "id": "material-iphonenatural-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#ebe9e5" } }, { "id": "material-iphonenatural-texture-warm-room", "path": [0], "attributes": { "stop-color": "#e0ddd8" } }, { "id": "material-iphonenatural-texture-warm-room", "path": [1], "attributes": { "stop-color": "#e0ddd8" } }] }, "918": { "paint": [{ "id": "material-iphonedeepurple-volume", "path": [1], "attributes": { "stop-color": "#030203" } }, { "id": "material-iphonedeepurple-volume", "path": [2], "attributes": { "stop-color": "#030203" } }, { "id": "material-iphonedeepurple-volume", "path": [3], "attributes": { "stop-color": "#030203" } }, { "id": "material-iphonedeepurple-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#28202c" } }, { "id": "material-iphonedeepurple-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#3d3143" } }, { "id": "material-iphonedeepurple-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#6d5c76" } }, { "id": "material-iphonedeepurple-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#93819c" } }, { "id": "material-iphonedeepurple-texture-underside", "path": [0], "attributes": { "stop-color": "#302635" } }, { "id": "material-iphonedeepurple-texture-underside", "path": [1], "attributes": { "stop-color": "#46394d" } }, { "id": "material-iphonedeepurple-texture-underside", "path": [2], "attributes": { "stop-color": "#7e6d87" } }, { "id": "material-iphonedeepurple-texture-studio-white", "path": [2], "attributes": { "stop-color": "#f7f4f8" } }, { "id": "material-iphonedeepurple-texture-studio-white", "path": [3], "attributes": { "stop-color": "#ebe5ee" } }, { "id": "material-iphonedeepurple-texture-rim-light", "path": [0], "attributes": { "stop-color": "#f8f6f9" } }, { "id": "material-iphonedeepurple-texture-rim-light", "path": [1], "attributes": { "stop-color": "#f0ecf3" } }, { "id": "material-iphonedeepurple-texture-rim-light", "path": [2], "attributes": { "stop-color": "#dbd1e0" } }, { "id": "material-iphonedeepurple-texture-rim-light", "path": [3], "attributes": { "stop-color": "#dbd1e0" } }, { "id": "material-iphonedeepurple-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#d5c9da" } }, { "id": "material-iphonedeepurple-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#d5c9da" } }, { "id": "material-iphonedeepurple-texture-warm-room", "path": [0], "attributes": { "stop-color": "#beafc6" } }, { "id": "material-iphonedeepurple-texture-warm-room", "path": [1], "attributes": { "stop-color": "#beafc6" } }] }, "919": { "paint": [{ "id": "material-iphonepink-volume", "path": [1], "attributes": { "stop-color": "#623f46" } }, { "id": "material-iphonepink-volume", "path": [2], "attributes": { "stop-color": "#623f46" } }, { "id": "material-iphonepink-volume", "path": [3], "attributes": { "stop-color": "#623f46" } }, { "id": "material-iphonepink-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#b58b94" } }, { "id": "material-iphonepink-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#c59ea6" } }, { "id": "material-iphonepink-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#dcbec4" } }, { "id": "material-iphonepink-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#e8d1d6" } }, { "id": "material-iphonepink-texture-underside", "path": [0], "attributes": { "stop-color": "#bc939c" } }, { "id": "material-iphonepink-texture-underside", "path": [1], "attributes": { "stop-color": "#cba6ad" } }, { "id": "material-iphonepink-texture-underside", "path": [2], "attributes": { "stop-color": "#e2c7cd" } }, { "id": "material-iphonepink-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fefcfc" } }, { "id": "material-iphonepink-texture-studio-white", "path": [3], "attributes": { "stop-color": "#fcf7f8" } }, { "id": "material-iphonepink-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fefcfd" } }, { "id": "material-iphonepink-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fdf9fa" } }, { "id": "material-iphonepink-texture-rim-light", "path": [2], "attributes": { "stop-color": "#f9f1f2" } }, { "id": "material-iphonepink-texture-rim-light", "path": [3], "attributes": { "stop-color": "#f9f1f2" } }, { "id": "material-iphonepink-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#f8eef0" } }, { "id": "material-iphonepink-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#f8eef0" } }, { "id": "material-iphonepink-texture-warm-room", "path": [0], "attributes": { "stop-color": "#f3e5e8" } }, { "id": "material-iphonepink-texture-warm-room", "path": [1], "attributes": { "stop-color": "#f3e5e8" } }] }, "920": { "paint": [{ "id": "material-iphonesage-volume", "path": [1], "attributes": { "stop-color": "#22281a" } }, { "id": "material-iphonesage-volume", "path": [2], "attributes": { "stop-color": "#22281a" } }, { "id": "material-iphonesage-volume", "path": [3], "attributes": { "stop-color": "#22281a" } }, { "id": "material-iphonesage-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#6a775b" } }, { "id": "material-iphonesage-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#808d70" } }, { "id": "material-iphonesage-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#a7b299" } }, { "id": "material-iphonesage-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#c0c9b4" } }, { "id": "material-iphonesage-texture-underside", "path": [0], "attributes": { "stop-color": "#738063" } }, { "id": "material-iphonesage-texture-underside", "path": [1], "attributes": { "stop-color": "#889579" } }, { "id": "material-iphonesage-texture-underside", "path": [2], "attributes": { "stop-color": "#b2bda6" } }, { "id": "material-iphonesage-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fafbf9" } }, { "id": "material-iphonesage-texture-studio-white", "path": [3], "attributes": { "stop-color": "#f4f6f1" } }, { "id": "material-iphonesage-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fbfcfa" } }, { "id": "material-iphonesage-texture-rim-light", "path": [1], "attributes": { "stop-color": "#f7f8f5" } }, { "id": "material-iphonesage-texture-rim-light", "path": [2], "attributes": { "stop-color": "#ebeee6" } }, { "id": "material-iphonesage-texture-rim-light", "path": [3], "attributes": { "stop-color": "#ebeee6" } }, { "id": "material-iphonesage-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#e7ebe2" } }, { "id": "material-iphonesage-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#e7ebe2" } }, { "id": "material-iphonesage-texture-warm-room", "path": [0], "attributes": { "stop-color": "#dae0d3" } }, { "id": "material-iphonesage-texture-warm-room", "path": [1], "attributes": { "stop-color": "#dae0d3" } }] }, "921": { "paint": [{ "id": "material-iphonelavender-volume", "path": [1], "attributes": { "stop-color": "#312a40" } }, { "id": "material-iphonelavender-volume", "path": [2], "attributes": { "stop-color": "#312a40" } }, { "id": "material-iphonelavender-volume", "path": [3], "attributes": { "stop-color": "#312a40" } }, { "id": "material-iphonelavender-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#81759c" } }, { "id": "material-iphonelavender-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#968ab1" } }, { "id": "material-iphonelavender-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#b9afcf" } }, { "id": "material-iphonelavender-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#cec6e0" } }, { "id": "material-iphonelavender-texture-underside", "path": [0], "attributes": { "stop-color": "#8a7ea5" } }, { "id": "material-iphonelavender-texture-underside", "path": [1], "attributes": { "stop-color": "#9e92b8" } }, { "id": "material-iphonelavender-texture-underside", "path": [2], "attributes": { "stop-color": "#c3bad8" } }, { "id": "material-iphonelavender-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fcfbfd" } }, { "id": "material-iphonelavender-texture-studio-white", "path": [3], "attributes": { "stop-color": "#f7f5fb" } }, { "id": "material-iphonelavender-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fcfcfe" } }, { "id": "material-iphonelavender-texture-rim-light", "path": [1], "attributes": { "stop-color": "#f9f8fc" } }, { "id": "material-iphonelavender-texture-rim-light", "path": [2], "attributes": { "stop-color": "#f0edf7" } }, { "id": "material-iphonelavender-texture-rim-light", "path": [3], "attributes": { "stop-color": "#f0edf7" } }, { "id": "material-iphonelavender-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#edeaf5" } }, { "id": "material-iphonelavender-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#edeaf5" } }, { "id": "material-iphonelavender-texture-warm-room", "path": [0], "attributes": { "stop-color": "#e3deef" } }, { "id": "material-iphonelavender-texture-warm-room", "path": [1], "attributes": { "stop-color": "#e3deef" } }] }, "922": { "paint": [{ "id": "material-satinplatinum-volume", "path": [1], "attributes": { "stop-color": "#303337" } }, { "id": "material-satinplatinum-volume", "path": [2], "attributes": { "stop-color": "#303337" } }, { "id": "material-satinplatinum-volume", "path": [3], "attributes": { "stop-color": "#303337" } }, { "id": "material-satinplatinum-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#5f666d" } }, { "id": "material-satinplatinum-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#717982" } }, { "id": "material-satinplatinum-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#99a0a6" } }, { "id": "material-satinplatinum-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#b5babf" } }, { "id": "material-satinplatinum-texture-underside", "path": [0], "attributes": { "stop-color": "#666e75" } }, { "id": "material-satinplatinum-texture-underside", "path": [1], "attributes": { "stop-color": "#79828a" } }, { "id": "material-satinplatinum-texture-underside", "path": [2], "attributes": { "stop-color": "#a6abb1" } }, { "id": "material-satinplatinum-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fdfbf6" } }, { "id": "material-satinplatinum-texture-studio-white", "path": [3], "attributes": { "stop-color": "#faf6ea" } }, { "id": "material-satinplatinum-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fdfcf8" } }, { "id": "material-satinplatinum-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fbf8f1" } }, { "id": "material-satinplatinum-texture-rim-light", "path": [2], "attributes": { "stop-color": "#e7e8ea" } }, { "id": "material-satinplatinum-texture-rim-light", "path": [3], "attributes": { "stop-color": "#e7e8ea" } }, { "id": "material-satinplatinum-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#e2e4e6" } }, { "id": "material-satinplatinum-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#e2e4e6" } }, { "id": "material-satinplatinum-texture-warm-room", "path": [0], "attributes": { "stop-color": "#cdd0d4" } }, { "id": "material-satinplatinum-texture-warm-room", "path": [1], "attributes": { "stop-color": "#cdd0d4" } }] }, "923": { "paint": [{ "id": "material-satinrose-volume", "path": [1], "attributes": { "stop-color": "#301b16" } }, { "id": "material-satinrose-volume", "path": [2], "attributes": { "stop-color": "#301b16" } }, { "id": "material-satinrose-volume", "path": [3], "attributes": { "stop-color": "#301b16" } }, { "id": "material-satinrose-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#7c4538" } }, { "id": "material-satinrose-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#995545" } }, { "id": "material-satinrose-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#bf8071" } }, { "id": "material-satinrose-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#d1a398" } }, { "id": "material-satinrose-texture-underside", "path": [0], "attributes": { "stop-color": "#884c3d" } }, { "id": "material-satinrose-texture-underside", "path": [1], "attributes": { "stop-color": "#a55c4a" } }, { "id": "material-satinrose-texture-underside", "path": [2], "attributes": { "stop-color": "#c79082" } }, { "id": "material-satinrose-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fdfbf6" } }, { "id": "material-satinrose-texture-studio-white", "path": [3], "attributes": { "stop-color": "#faf6ea" } }, { "id": "material-satinrose-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fdfcf8" } }, { "id": "material-satinrose-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fbf8f1" } }, { "id": "material-satinrose-texture-rim-light", "path": [2], "attributes": { "stop-color": "#f0e1dd" } }, { "id": "material-satinrose-texture-rim-light", "path": [3], "attributes": { "stop-color": "#f0e1dd" } }, { "id": "material-satinrose-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#eddbd6" } }, { "id": "material-satinrose-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#eddbd6" } }, { "id": "material-satinrose-texture-warm-room", "path": [0], "attributes": { "stop-color": "#e0c1ba" } }, { "id": "material-satinrose-texture-warm-room", "path": [1], "attributes": { "stop-color": "#e0c1ba" } }] }, "924": { "paint": [{ "id": "material-satinredcopper-volume", "path": [1], "attributes": { "stop-color": "#1f1109" } }, { "id": "material-satinredcopper-volume", "path": [2], "attributes": { "stop-color": "#1f1109" } }, { "id": "material-satinredcopper-volume", "path": [3], "attributes": { "stop-color": "#1f1109" } }, { "id": "material-satinredcopper-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#703e20" } }, { "id": "material-satinredcopper-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#90502a" } }, { "id": "material-satinredcopper-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#ca7747" } }, { "id": "material-satinredcopper-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#d89b78" } }, { "id": "material-satinredcopper-texture-underside", "path": [0], "attributes": { "stop-color": "#7d4524" } }, { "id": "material-satinredcopper-texture-underside", "path": [1], "attributes": { "stop-color": "#9f572e" } }, { "id": "material-satinredcopper-texture-underside", "path": [2], "attributes": { "stop-color": "#d0875d" } }, { "id": "material-satinredcopper-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fdfbf6" } }, { "id": "material-satinredcopper-texture-studio-white", "path": [3], "attributes": { "stop-color": "#faf6ea" } }, { "id": "material-satinredcopper-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fdfcf8" } }, { "id": "material-satinredcopper-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fbf8f1" } }, { "id": "material-satinredcopper-texture-rim-light", "path": [2], "attributes": { "stop-color": "#f2ddd1" } }, { "id": "material-satinredcopper-texture-rim-light", "path": [3], "attributes": { "stop-color": "#f2ddd1" } }, { "id": "material-satinredcopper-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#efd6c8" } }, { "id": "material-satinredcopper-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#efd6c8" } }, { "id": "material-satinredcopper-texture-warm-room", "path": [0], "attributes": { "stop-color": "#e4bba2" } }, { "id": "material-satinredcopper-texture-warm-room", "path": [1], "attributes": { "stop-color": "#e4bba2" } }] }, "925": { "paint": [{ "id": "material-satinbronze-volume", "path": [1], "attributes": { "stop-color": "#151209" } }, { "id": "material-satinbronze-volume", "path": [2], "attributes": { "stop-color": "#151209" } }, { "id": "material-satinbronze-volume", "path": [3], "attributes": { "stop-color": "#151209" } }, { "id": "material-satinbronze-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#514725" } }, { "id": "material-satinbronze-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#6c5e31" } }, { "id": "material-satinbronze-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#a8924b" } }, { "id": "material-satinbronze-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#c1af75" } }, { "id": "material-satinbronze-texture-underside", "path": [0], "attributes": { "stop-color": "#5c5029" } }, { "id": "material-satinbronze-texture-underside", "path": [1], "attributes": { "stop-color": "#796936" } }, { "id": "material-satinbronze-texture-underside", "path": [2], "attributes": { "stop-color": "#b5a05b" } }, { "id": "material-satinbronze-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fdfbf6" } }, { "id": "material-satinbronze-texture-studio-white", "path": [3], "attributes": { "stop-color": "#faf6ea" } }, { "id": "material-satinbronze-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fdfcf8" } }, { "id": "material-satinbronze-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fbf8f1" } }, { "id": "material-satinbronze-texture-rim-light", "path": [2], "attributes": { "stop-color": "#e9e3ce" } }, { "id": "material-satinbronze-texture-rim-light", "path": [3], "attributes": { "stop-color": "#e9e3ce" } }, { "id": "material-satinbronze-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#e5dec5" } }, { "id": "material-satinbronze-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#e5dec5" } }, { "id": "material-satinbronze-texture-warm-room", "path": [0], "attributes": { "stop-color": "#d4c79f" } }, { "id": "material-satinbronze-texture-warm-room", "path": [1], "attributes": { "stop-color": "#d4c79f" } }] }, "926": { "paint": [{ "id": "material-satingunmetal-volume", "path": [1], "attributes": { "stop-color": "#040505" } }, { "id": "material-satingunmetal-volume", "path": [2], "attributes": { "stop-color": "#040505" } }, { "id": "material-satingunmetal-volume", "path": [3], "attributes": { "stop-color": "#040505" } }, { "id": "material-satingunmetal-texture-studio-dark", "path": [0], "attributes": { "stop-color": "#1c2025" } }, { "id": "material-satingunmetal-texture-studio-dark", "path": [1], "attributes": { "stop-color": "#2a3138" } }, { "id": "material-satingunmetal-texture-studio-dark", "path": [2], "attributes": { "stop-color": "#4f5c68" } }, { "id": "material-satingunmetal-texture-studio-dark", "path": [3], "attributes": { "stop-color": "#6f8192" } }, { "id": "material-satingunmetal-texture-underside", "path": [0], "attributes": { "stop-color": "#21272c" } }, { "id": "material-satingunmetal-texture-underside", "path": [1], "attributes": { "stop-color": "#313941" } }, { "id": "material-satingunmetal-texture-underside", "path": [2], "attributes": { "stop-color": "#5c6c7b" } }, { "id": "material-satingunmetal-texture-studio-white", "path": [2], "attributes": { "stop-color": "#fdfbf6" } }, { "id": "material-satingunmetal-texture-studio-white", "path": [3], "attributes": { "stop-color": "#faf6ea" } }, { "id": "material-satingunmetal-texture-rim-light", "path": [0], "attributes": { "stop-color": "#fdfcf8" } }, { "id": "material-satingunmetal-texture-rim-light", "path": [1], "attributes": { "stop-color": "#fbf8f1" } }, { "id": "material-satingunmetal-texture-rim-light", "path": [2], "attributes": { "stop-color": "#cad0d7" } }, { "id": "material-satingunmetal-texture-rim-light", "path": [3], "attributes": { "stop-color": "#cad0d7" } }, { "id": "material-satingunmetal-texture-floor-bounce", "path": [1], "attributes": { "stop-color": "#c0c8d0" } }, { "id": "material-satingunmetal-texture-floor-bounce", "path": [2], "attributes": { "stop-color": "#c0c8d0" } }, { "id": "material-satingunmetal-texture-warm-room", "path": [0], "attributes": { "stop-color": "#98a5b2" } }, { "id": "material-satingunmetal-texture-warm-room", "path": [1], "attributes": { "stop-color": "#98a5b2" } }] }, "1106": { "paint": [{ "selector": 'use[stroke="url(#material-cork-rim)"]', "attributes": { "opacity": "0.21" } }] }, "1505": { "paint": [{ "id": "material-kiwi-antenna", "path": [0], "attributes": { "stop-color": "#dddbc7" } }, { "id": "material-kiwi-antenna", "path": [1], "attributes": { "stop-color": "#878036" } }, { "id": "material-kiwi-antenna", "path": [2], "attributes": { "stop-color": "#4a461e" } }] }, "1508": { "paint": [{ "id": "material-dragonfruit-antenna", "path": [0], "attributes": { "stop-color": "#d4e8d1" } }, { "id": "material-dragonfruit-antenna", "path": [1], "attributes": { "stop-color": "#66ad5c" } }, { "id": "material-dragonfruit-antenna", "path": [2], "attributes": { "stop-color": "#385f33" } }, { "id": "material-dragonfruit-texture", "path": [216], "attributes": { "fill": "#ffffff" } }] }, "1606": { "paint": [{ "id": "material-galaxy-antenna", "path": [0], "attributes": { "stop-color": "#d6cbf5" } }, { "id": "material-galaxy-antenna", "path": [1], "attributes": { "stop-color": "#6e46dd" } }, { "id": "material-galaxy-antenna", "path": [2], "attributes": { "stop-color": "#3d277a" } }, { "id": "material-galaxy-texture", "path": [1], "attributes": { "cx": "174" } }, { "id": "material-galaxy-texture-cloud", "path": [0], "attributes": { "stop-opacity": "0.74" } }, { "id": "material-galaxy-texture-cloud", "path": [1], "attributes": { "stop-opacity": "0.4996" } }, { "id": "material-galaxy-texture-cloud", "path": [2], "attributes": { "stop-opacity": "0.2229" } }, { "id": "material-galaxy-texture-blue", "path": [0], "attributes": { "stop-opacity": "0.74" } }, { "id": "material-galaxy-texture-blue", "path": [1], "attributes": { "stop-opacity": "0.3807" } }, { "id": "material-galaxy-texture-starlight", "path": [0], "attributes": { "stop-opacity": "0.77" } }, { "id": "material-galaxy-texture-starlight", "path": [1], "attributes": { "stop-opacity": "0.2587" } }] }, "401": { "paint": [], "properties": {} }, "402": { "paint": [], "properties": {} }, "403": { "paint": [], "properties": {} }, "404": { "paint": [], "properties": {} }, "405": { "paint": [], "properties": {} }, "406": { "paint": [], "properties": {} }, "607": { "paint": [], "properties": {} }, "608": { "paint": [], "properties": {} }, "610": { "paint": [], "properties": {} }, "611": { "paint": [], "properties": {} }, "612": { "paint": [], "properties": {} } };
    exports.SKIN_PAINTS = SKIN_PAINTS;
  });
  __define("src/boopface-skin-patterns.js", function(__require2, __import2, exports) {
    const rng = (seed) => {
      let state = seed % 2147483647 || 1;
      return () => (state = state * 16807 % 2147483647) / 2147483647;
    };
    const n = (value) => Number(value.toFixed(2));
    const pick = (random, list) => list[Math.floor(random() * list.length) % list.length];
    function wrap(size, x, y, r, draw) {
      let out = "";
      for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
        if (x + dx + r < 0 || x + dx - r > size || y + dy + r < 0 || y + dy - r > size) continue;
        out += draw(x + dx, y + dy);
      }
      return out;
    }
    function rotate([x, y, z], [yaw, pitch, roll]) {
      let c = Math.cos(yaw), s = Math.sin(yaw);
      [x, z] = [x * c + z * s, -x * s + z * c];
      c = Math.cos(pitch);
      s = Math.sin(pitch);
      [y, z] = [y * c - z * s, y * s + z * c];
      c = Math.cos(roll);
      s = Math.sin(roll);
      [x, y] = [x * c - y * s, x * s + y * c];
      return [x, y, z];
    }
    const PATTERNS = {
      tartan({ colors: [a, b, c], size = 56 }) {
        const bands = [[0, 18, a, 0.55], [26, 3, b, 0.8], [38, 2, c, 0.8], [44, 6, a, 0.35]];
        let body = "";
        for (const [x, w, color, o] of bands) {
          body += `<rect x="${x}" width="${w}" height="${size}" fill="${color}" opacity="${o}"/><rect y="${x}" width="${size}" height="${w}" fill="${color}" opacity="${o}"/>`;
        }
        return { size: [size, size], body };
      },
      dots({ colors: [c], r = 5, size = 26, opacity = 1 }) {
        const q = size / 4;
        return { size: [size, size], body: `<circle cx="${q}" cy="${q}" r="${r}" fill="${c}" opacity="${opacity}"/><circle cx="${q * 3}" cy="${q * 3}" r="${r}" fill="${c}" opacity="${opacity}"/>` };
      },
      terrazzo({ colors, count = 44, size = 120, seed = 5 }) {
        const random = rng(seed);
        let body = "";
        for (let i = 0; i < count; i++) {
          const x = random() * size, y = random() * size, k = 2.5 + random() * 6, sides = 3 + Math.floor(random() * 3), color = pick(random, colors), turn = random() * Math.PI;
          let d = "";
          for (let j = 0; j < sides; j++) {
            const a = turn + j / sides * Math.PI * 2, rr = k * (0.6 + random() * 0.5);
            d += `${j ? "L" : "M"}${n(Math.cos(a) * rr)} ${n(Math.sin(a) * rr)}`;
          }
          body += wrap(size, x, y, k, (px, py) => `<path d="${d}Z" fill="${color}" transform="translate(${n(px)} ${n(py)})"/>`);
        }
        return { size: [size, size], body };
      },
      marble({ colors: [a, b], seed = 21 }) {
        const random = rng(seed);
        let body = "";
        for (let i = 0; i < 7; i++) {
          const color = i % 3 === 2 ? b : a;
          let x = -20, y = random() * 240, d = `M${n(x)} ${n(y)}`;
          while (x < 260) {
            const nx = x + 30 + random() * 40, ny = y + (random() - 0.5) * 70;
            d += `Q${n(x + 15 + random() * 20)} ${n(y + (random() - 0.5) * 60)} ${n(nx)} ${n(ny)}`;
            x = nx;
            y = ny;
          }
          body += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(0.6 + random() * 1.8)}" opacity="${n(0.35 + random() * 0.35)}"/>`;
          body += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(5 + random() * 6)}" opacity=".07"/>`;
        }
        return { size: [240, 240], body };
      },
      pixel({ colors, cell = 10, size = 80, seed = 31, opacity = 0.9 }) {
        const random = rng(seed);
        let body = "";
        for (let y = 0; y < size; y += cell) for (let x = 0; x < size; x += cell) {
          if (random() < 0.45) continue;
          body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${pick(random, colors)}" opacity="${opacity}"/>`;
        }
        return { size: [size, size], body };
      },
      confetti({ colors, count = 38, size = 120, seed = 37 }) {
        const random = rng(seed);
        let body = "";
        for (let i = 0; i < count; i++) {
          const x = random() * size, y = random() * size, color = pick(random, colors), turn = random() * 180, strip = random() < 0.5;
          body += wrap(size, x, y, 6, (px, py) => strip ? `<rect x="${n(px - 1.6)}" y="${n(py - 4)}" width="3.2" height="8" rx="1" fill="${color}" transform="rotate(${n(turn)} ${n(px)} ${n(py)})"/>` : `<circle cx="${n(px)}" cy="${n(py)}" r="2.2" fill="${color}"/>`);
        }
        return { size: [size, size], body };
      },
      halftone({ colors: [c], step = 12, opacity = 0.7 }) {
        let body = "";
        for (let y = 6; y < 240; y += step) for (let x = 6 + y / step % 2 * step / 2; x < 240; x += step) {
          body += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(0.6 + 4.4 * (y / 240))}" fill="${c}" opacity="${opacity}"/>`;
        }
        return { size: [240, 240], body };
      },
      scatter({ colors, shapes, count = 12, size = 120, k = [6, 10], seed = 47 }) {
        const random = rng(seed);
        let body = "";
        for (let i = 0; i < count; i++) {
          const x = random() * size, y = random() * size, r = k[0] + random() * (k[1] - k[0]), turn = (random() - 0.5) * 70;
          const shape = pick(random, shapes), color = colors[i % colors.length], accent = colors[(i + 1) % colors.length];
          const art = SHAPES[shape](r, color, accent);
          body += wrap(size, x, y, r * 1.3, (px, py) => `<g transform="translate(${n(px)} ${n(py)}) rotate(${n(turn)})">${art}</g>`);
        }
        return { size: [size, size], body };
      },
      grooves({ colors: [line, shadow], radius = 138, angles = [0.5, -0.45, 0.2] }) {
        let body = "";
        for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
          for (const lat of [-0.42, 0, 0.42]) {
            const pts = [];
            for (let k = 0; k <= 72; k++) {
              const a = k / 72 * Math.PI * 2, r = Math.cos(lat), h = Math.sin(lat);
              const p = axis[0] ? [h, r * Math.cos(a), r * Math.sin(a)] : axis[1] ? [r * Math.cos(a), h, r * Math.sin(a)] : [r * Math.cos(a), r * Math.sin(a), h];
              pts.push(rotate(p, angles));
            }
            let d = "";
            pts.forEach(([x, y, z], i) => {
              d += `${i && z > 0 && pts[i - 1][2] > 0 ? "L" : "M"}${n(120 + x * radius)} ${n(120 + y * radius)}`;
            });
            body += `<path d="${d}" fill="none" stroke="${shadow}" stroke-width="3" opacity=".6" transform="translate(.8 1)"/><path d="${d}" fill="none" stroke="${line}" stroke-width="1.6"/>`;
          }
        }
        return { size: [240, 240], body };
      },
      // Balls: each is drawn once across the whole head instead of repeating.
      basketball({ colors: [seam, grain] }) {
        return {
          size: [240, 240],
          defs: (tex) => `<pattern id="${tex}" patternUnits="userSpaceOnUse" width="6" height="6"><circle cx="3" cy="3" r=".9" fill="${grain}" opacity=".32"/></pattern>`,
          body: (tex) => `<rect width="240" height="240" fill="url(#${tex})"/><path d="M120 0V240M0 120H240M52 18Q100 120 52 222M188 18Q140 120 188 222" fill="none" stroke="#ffd2a6" stroke-width="2.4" stroke-linecap="round" opacity=".55" transform="translate(1.2 1.6)"/><path d="M120 0V240M0 120H240M52 18Q100 120 52 222M188 18Q140 120 188 222" fill="none" stroke="${seam}" stroke-width="3.4" stroke-linecap="round"/>`
        };
      },
      tennis({ colors: [seam, fuzz] }) {
        return {
          size: [240, 240],
          defs: (tex) => `<pattern id="${tex}" patternUnits="userSpaceOnUse" width="7" height="7"><circle cx="1.5" cy="2" r=".7" fill="${fuzz}" opacity=".35"/><circle cx="5" cy="5.5" r=".6" fill="#ffffff" opacity=".3"/></pattern>`,
          body: (tex) => `<rect width="240" height="240" fill="url(#${tex})"/><path d="M14 62C92 34 92 206 14 178M226 62C148 34 148 206 226 178" fill="none" stroke="#f7ffd0" stroke-width="6.5" stroke-linecap="round" opacity=".45" transform="translate(1 1.6)"/><path d="M14 62C92 34 92 206 14 178M226 62C148 34 148 206 226 178" fill="none" stroke="#4a6000" stroke-width="6.5" stroke-linecap="round" opacity=".38" transform="translate(-1 -1.6)"/><path d="M14 62C92 34 92 206 14 178M226 62C148 34 148 206 226 178" fill="none" stroke="${seam}" stroke-width="5" stroke-linecap="round"/>`
        };
      },
      baseball({ colors: [seam, stitch] }) {
        const arc = (x0, cx) => {
          let stitches = "";
          for (let t = 0.06; t < 0.96; t += 0.055) {
            const x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x0, y = (1 - t) ** 2 * 26 + 2 * (1 - t) * t * 120 + t * t * 214;
            const dx = 2 * (1 - t) * (cx - x0) + 2 * t * (x0 - cx), dy = 2 * (1 - t) * 94 + 2 * t * 94, len = Math.hypot(dx, dy);
            const nx = -dy / len * 5, ny = dx / len * 5, tx = dx / len * 2.2, ty = dy / len * 2.2;
            stitches += `M${n(x - nx - tx)} ${n(y - ny - ty)}L${n(x)} ${n(y)}L${n(x + nx - tx)} ${n(y + ny - ty)}`;
          }
          return `<path d="M${x0} 26Q${cx} 120 ${x0} 214" fill="none" stroke="${seam}" stroke-width="1.3"/><path d="${stitches}" fill="none" stroke="${stitch}" stroke-width="2" stroke-linecap="round"/>`;
        };
        return { size: [240, 240], body: arc(44, 104) + arc(196, 136) };
      },
      cricket({ colors: [seam, stitch] }) {
        const y = (x, lift) => 84 - Math.sin(x / 240 * Math.PI) * 26 + lift;
        const curve = (lift) => {
          let d = "";
          for (let x = -4; x <= 244; x += 8) d += `${x < 0 ? "M" : "L"}${x} ${n(y(x, lift))}`;
          return d;
        };
        let rows = "";
        for (const lift of [-11, -7, -3, 3, 7, 11]) {
          for (let x = 2; x < 240; x += 6) rows += `M${x} ${n(y(x, lift))}l2.6 -1.2`;
        }
        return { size: [240, 240], body: `<path d="${curve(0)}" fill="none" stroke="${seam}" stroke-width="15" stroke-linecap="round" opacity=".55"/><path d="${curve(0)}" fill="none" stroke="${seam}" stroke-width="2"/><path d="${rows}" fill="none" stroke="${stitch}" stroke-width="1.5" stroke-linecap="round"/>` };
      },
      golf({ colors: [shade, shine], r = 5.6 }) {
        const w = 15, h = w * Math.sqrt(3);
        const dimple = (x, y) => `<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="${shade}" opacity=".55"/><circle cx="${n(x + 0.9)}" cy="${n(y + 1)}" r="${n(r * 0.55)}" fill="${shine}" opacity=".8"/>`;
        return { size: [w, n(h)], body: dimple(0, 0) + dimple(w, 0) + dimple(w / 2, h / 2) + dimple(0, h) + dimple(w, h) };
      },
      football({ colors: [lace, grain, seam] }) {
        let stitches = "";
        for (let x = 90; x <= 150; x += 10) stitches += `M${x} 44V60`;
        return {
          size: [240, 240],
          defs: (tex) => `<pattern id="${tex}" patternUnits="userSpaceOnUse" width="5" height="5"><circle cx="2.5" cy="2.5" r=".8" fill="${grain}" opacity=".35"/></pattern>`,
          body: (tex) => `<rect width="240" height="240" fill="url(#${tex})"/><path d="M-10 40Q120 62 250 40M-10 210Q120 188 250 210" fill="none" stroke="${seam}" stroke-width="1.4" opacity=".7"/><g transform="translate(1 1.6)" opacity=".35"><path d="M84 52H156" stroke="#1a0800" stroke-width="2"/><path d="${stitches}" stroke="#1a0800" stroke-width="3.6" stroke-linecap="round"/></g><path d="M84 52H156" stroke="${lace}" stroke-width="2"/><path d="${stitches}" stroke="${lace}" stroke-width="3.4" stroke-linecap="round"/><path d="M34 20Q46 120 34 220M46 20Q58 120 46 220M206 20Q194 120 206 220M194 20Q182 120 194 220" fill="none" stroke="${lace}" stroke-width="5"/>`
        };
      }
    };
    const SHAPES = {
      leaf: (k, c, accent) => `<path d="M0 ${n(-k)}Q${n(0.65 * k)} 0 0 ${n(k)}Q${n(-0.65 * k)} 0 0 ${n(-k)}Z" fill="${c}"/><path d="M0 ${n(-0.8 * k)}V${n(0.9 * k)}" stroke="${accent}" stroke-width="${n(0.08 * k)}"/>`,
      blossom: (k, c, accent) => `${[0, 72, 144, 216, 288].map((a) => `<ellipse cy="${n(-0.5 * k)}" rx="${n(0.3 * k)}" ry="${n(0.45 * k)}" fill="${c}" transform="rotate(${a})"/>`).join("")}<circle r="${n(0.2 * k)}" fill="${accent}"/>`
    };
    const tiles = /* @__PURE__ */ new Map();
    function patternMarkup(id, spec) {
      const make = PATTERNS[spec.kind];
      if (!make) return "";
      const key = JSON.stringify(spec);
      if (!tiles.has(key)) tiles.set(key, make(spec));
      const { size: [w, h], transform, body, defs } = tiles.get(key);
      const tex = `${id}-texture`;
      const inner = typeof body === "function" ? body(tex) : body;
      return `${defs ? defs(tex) : ""}<pattern id="${id}" patternUnits="userSpaceOnUse" width="${w}" height="${h}"${transform ? ` patternTransform="${transform}"` : ""}>${inner}</pattern>`;
    }
    exports.PATTERNS = PATTERNS;
    exports.patternMarkup = patternMarkup;
  });
  __define("src/skins/eyelids.js", function(__require2, __import2, exports) {
    const NS = "http://www.w3.org/2000/svg";
    function svg(tag, attributes = {}, parent) {
      const element = document.createElementNS(NS, tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
      parent == null ? void 0 : parent.append(element);
      return element;
    }
    function maskEyelids(instance) {
      var _a, _b;
      const root = instance.shadowRoot;
      const defs = root.querySelector("defs");
      for (const side of ["left", "right"]) {
        const eye = root.getElementById(`${side}Eye`);
        const lids = (_a = root.getElementById(`${side}Top`)) == null ? void 0 : _a.parentElement;
        if (!eye || !lids || ((_b = lids.parentElement) == null ? void 0 : _b.tagName) === "mask") continue;
        const mask = svg("mask", {
          id: `skin-${side}-lids`,
          maskUnits: "userSpaceOnUse",
          maskContentUnits: "userSpaceOnUse",
          x: -180,
          y: -240,
          width: 360,
          height: 480
        }, defs);
        svg("rect", { x: -180, y: -240, width: 360, height: 480, fill: "#fff" }, mask);
        for (const lid of lids.children) lid.style.fill = "#000";
        mask.append(lids);
        const paint = svg("g", { mask: `url(#skin-${side}-lids)` });
        paint.append(...eye.children);
        eye.append(paint);
      }
    }
    exports.maskEyelids = maskEyelids;
  });
  __define("src/skins/native.js", function(__require2, __import2, exports) {
    const BoopFace = __require2("src/boopface-extension-host.js").default;
    const { patternMarkup } = __require2("src/boopface-skin-patterns.js");
    const { maskEyelids } = __require2("src/skins/eyelids.js");
    const NS = "http://www.w3.org/2000/svg";
    const runtimeWindow = typeof window !== "undefined" ? window : null;
    const baseApplyColor = BoopFace.prototype._applyColor;
    const SKINS = { "glow-blue": { "base": ["#90b9fe", "#619bff", "#4287ff", "#5295ff"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#90b9fe", "#619bff", "#5295ff"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaHighlight": 1, "antennaHighlightSize": 0.36, "antennaMid": "#70acff", "antennaDark": "#9fc7fe" } }, "glow-red": { "base": ["#fe9590", "#ff6961", "#ff4c42", "#ff5752"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#fe9590", "#ff6961", "#ff5752"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaHighlight": 1, "antennaHighlightSize": 0.36, "antennaMid": "#ff7070", "antennaDark": "#fe9f9f" } }, "custom-1793262923292": { "base": ["#b9ff94", "#92ec55", "#72d232", "#57c200"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#b9ff94", "#92ec55", "#57c200"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaMid": "#b4ff42", "antennaDark": "#b5e44e", "antennaHighlight": 1, "antennaHighlightSize": 0.47 } }, "glow-purple": { "base": ["#ca90fe", "#b561ff", "#a742ff", "#ab52ff"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ca90fe", "#b561ff", "#ab52ff"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaHighlight": 1, "antennaHighlightSize": 0.36, "antennaMid": "#b570ff", "antennaDark": "#cd9ffe" } }, "glow-pink": { "base": ["#fe90c8", "#ff61b0", "#ff42a0", "#ff52ac"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#fe90c8", "#ff61b0", "#ff52ac"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaHighlight": 1, "antennaHighlightSize": 0.36, "antennaMid": "#ff70bf", "antennaDark": "#fe9fd3" } }, "glow-orange": { "base": ["#febb89", "#ffa159", "#ff8f39", "#ff9449"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#febb89", "#ffa159", "#ff9449"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaHighlight": 1, "antennaHighlightSize": 0.36, "antennaMid": "#ffa268", "antennaDark": "#febf98" } }, "custom-1793262553386": { "base": ["#90d4fe", "#80d9ff", "#4dc9ff", "#38a9ff"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#90d4fe", "#80d9ff", "#38a9ff"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaMid": "#94d6ff", "antennaDark": "#7adeff", "antennaHighlight": 1, "antennaHighlightSize": 0.47 } }, "custom-1793262790531": { "base": ["#b9cad4", "#9bb8c5", "#8198a2", "#8a959e"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#b9cad4", "#9bb8c5", "#8a959e"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaMid": "#aec3d0", "antennaDark": "#a1b0b5", "antennaHighlight": 1, "antennaHighlightSize": 0.47 } }, "custom-1793263007260": { "base": ["#ff94fb", "#ff1f1f", "#fe5881", "#c20000"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ff94fb", "#ff1f1f", "#c20000"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaMid": "#fe9a9a", "antennaDark": "#ffadca", "antennaHighlight": 1, "antennaHighlightSize": 0.47 } }, "custom-1793263221394": { "base": ["#47c8ff", "#27ecbb", "#30cfb4", "#0f4bff"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#47c8ff", "#27ecbb", "#0f4bff"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaMid": "#42d9ff", "antennaDark": "#c2f3ff", "antennaHighlight": 1, "antennaHighlightSize": 0.62 } }, "custom-1793263313834": { "base": ["#ffe014", "#ffd642", "#ffbd2e", "#ffd35c"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ffe014", "#ffd642", "#ffd35c"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaMid": "#ffe042", "antennaDark": "#fffac2", "antennaHighlight": 1, "antennaHighlightSize": 0.62 } }, "glow-green": { "base": ["#90d89e", "#61c876", "#42bd5b", "#52c267"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#90d89e", "#61c876", "#52c267"], "fixedTune": { "depth": 0.6, "faceGlow": 0.8, "faceX": 0.43, "faceY": 0.05, "faceSize": 0.69, "bandWidth": 46, "bandLight": 0.41, "bandOpacity": 0.77, "bandMiddle": 1, "lineOpacity": 0, "glintWidth": 3.2, "glintLower": 0.85, "eyeTint": 0.42, "shadowBlur": 4, "shadowOpacity": 0.89, "shadowDarkness": 0.3, "gradient": "radial", "centerX": 0.32, "centerY": 0.08, "radius": 0.81, "stopMid": 0.333, "stopEdge": 0.667, "bandBlur": 12, "glintInset": 0.955, "glintBlur": 2.7, "glintAngle": 94, "glintDash": 0, "upperEnd": 0, "topGloss": 1, "topReach": 0.25, "topBlur": 6.5, "eyeLitPart": 0.25, "antennaHighlight": 1, "antennaHighlightSize": 0.36, "antennaMid": "#70cd7e", "antennaDark": "#9fdda8" } }, "gem-blue": { "base": ["#2e7bff", "#337aff", "#0056f5", "#023bca"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#2e7bff", "#337aff", "#023bca"], "fixedTune": { "faceGlow": 0.67, "bandWidth": 20, "lineOpacity": 0.41, "glintUpper": 1, "glintLower": 0.43, "eyeTint": 0.2, "shadowOpacity": 0.8, "shadowDarkness": 0.34, "glintMiddle": 0, "rimOpacity": 0, "topGloss": 0, "sideThickness": 0, "shadowAngle": 117, "antennaHighlight": 1, "antennaHighlightSize": 0.5, "antennaRimOpacity": 1, "eyeHighlight": 1, "eyeHighlightSize": 26.5, "eyeHighlightSoft": 0.98, "eyeHighlightX": -1, "eyeHighlightY": -9, "eyeHighlightFollow": 11.5, "eyeSpark": 0, "colors": ["#2e7bff", "#337aff", "#0056f5", "#023bca"] } }, "gem-red": { "base": ["#ff312e", "#ff3a33", "#f50700", "#ca1502"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ff312e", "#ff3a33", "#ca1502"], "fixedTune": { "faceGlow": 0.67, "bandWidth": 20, "lineOpacity": 0.41, "glintUpper": 1, "glintLower": 0.43, "eyeTint": 0.2, "shadowOpacity": 0.8, "shadowDarkness": 0.34, "glintMiddle": 0, "rimOpacity": 0, "topGloss": 0, "sideThickness": 0, "shadowAngle": 117, "antennaHighlight": 1, "antennaHighlightSize": 0.5, "antennaRimOpacity": 1, "eyeHighlight": 1, "eyeHighlightSize": 26.5, "eyeHighlightSoft": 0.98, "eyeHighlightX": -1, "eyeHighlightY": -9, "eyeHighlightFollow": 11.5, "eyeSpark": 0, "colors": ["#ff312e", "#ff3a33", "#f50700", "#ca1502"] } }, "gem-green": { "base": ["#14ce29", "#15d42e", "#0f9620", "#0d7621"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#14ce29", "#15d42e", "#0d7621"], "fixedTune": { "faceGlow": 0.67, "bandWidth": 20, "lineOpacity": 0.41, "glintUpper": 1, "glintLower": 0.43, "eyeTint": 0.2, "shadowOpacity": 0.8, "shadowDarkness": 0.34, "glintMiddle": 0, "rimOpacity": 0, "topGloss": 0, "sideThickness": 0, "shadowAngle": 117, "antennaHighlight": 1, "antennaHighlightSize": 0.5, "antennaRimOpacity": 1, "eyeHighlight": 1, "eyeHighlightSize": 26.5, "eyeHighlightSoft": 0.98, "eyeHighlightX": -1, "eyeHighlightY": -9, "eyeHighlightFollow": 11.5, "eyeSpark": 0, "colors": ["#14ce29", "#15d42e", "#0f9620", "#0d7621"] } }, "gem-purple": { "base": ["#992eff", "#a033ff", "#8200f5", "#7902ca"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#992eff", "#a033ff", "#7902ca"], "fixedTune": { "faceGlow": 0.67, "bandWidth": 20, "lineOpacity": 0.41, "glintUpper": 1, "glintLower": 0.43, "eyeTint": 0.2, "shadowOpacity": 0.8, "shadowDarkness": 0.34, "glintMiddle": 0, "rimOpacity": 0, "topGloss": 0, "sideThickness": 0, "shadowAngle": 117, "antennaHighlight": 1, "antennaHighlightSize": 0.5, "antennaRimOpacity": 1, "eyeHighlight": 1, "eyeHighlightSize": 26.5, "eyeHighlightSoft": 0.98, "eyeHighlightX": -1, "eyeHighlightY": -9, "eyeHighlightFollow": 11.5, "eyeSpark": 0, "colors": ["#992eff", "#a033ff", "#8200f5", "#7902ca"] } }, "gem-pink": { "base": ["#ff2e94", "#ff3392", "#f50073", "#ca0253"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ff2e94", "#ff3392", "#ca0253"], "fixedTune": { "faceGlow": 0.67, "bandWidth": 20, "lineOpacity": 0.41, "glintUpper": 1, "glintLower": 0.43, "eyeTint": 0.2, "shadowOpacity": 0.8, "shadowDarkness": 0.34, "glintMiddle": 0, "rimOpacity": 0, "topGloss": 0, "sideThickness": 0, "shadowAngle": 117, "antennaHighlight": 1, "antennaHighlightSize": 0.5, "antennaRimOpacity": 1, "eyeHighlight": 1, "eyeHighlightSize": 26.5, "eyeHighlightSoft": 0.98, "eyeHighlightX": -1, "eyeHighlightY": -9, "eyeHighlightFollow": 11.5, "eyeSpark": 0, "colors": ["#ff2e94", "#ff3392", "#f50073", "#ca0253"] } }, "gem-orange": { "base": ["#ff7f25", "#ff862a", "#eb6500", "#c16102"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ff7f25", "#ff862a", "#c16102"], "fixedTune": { "faceGlow": 0.67, "bandWidth": 20, "lineOpacity": 0.41, "glintUpper": 1, "glintLower": 0.43, "eyeTint": 0.2, "shadowOpacity": 0.8, "shadowDarkness": 0.34, "glintMiddle": 0, "rimOpacity": 0, "topGloss": 0, "sideThickness": 0, "shadowAngle": 117, "antennaHighlight": 1, "antennaHighlightSize": 0.5, "antennaRimOpacity": 1, "eyeHighlight": 1, "eyeHighlightSize": 26.5, "eyeHighlightSoft": 0.98, "eyeHighlightX": -1, "eyeHighlightY": -9, "eyeHighlightFollow": 11.5, "eyeSpark": 0, "colors": ["#ff7f25", "#ff862a", "#eb6500", "#c16102"] } }, "gleam-blue": { "base": ["#5a9dff", "#2f7cf6", "#286fea", "#1c5ed8"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#5a9dff", "#2f7cf6", "#1c5ed8"], "fixedTune": { "depth": 0.12, "faceGlow": 0, "bandWidth": 26, "bandLight": 0.4, "bandOpacity": 0.6, "bandMiddle": 0.24, "lineOpacity": 1, "glintWidth": 3.6, "glintLower": 0.85, "eyeTint": 0.6, "shadowDistance": 8, "shadowBlur": 6, "gradient": "radial", "centerX": 0.5, "centerY": -0.28, "radius": 0.92, "stopMid": 0.84, "stopEdge": 0.85, "bandBlur": 1.1, "lineInset": 0.87, "lineWidth": 1.9, "lineAngle": 218, "glintInset": 0.95, "glintBlur": 0.5, "glintAngle": 44, "glintDash": 0, "upperEnd": 0.2, "lowerStart": 0.73, "topGloss": 0.75, "topReach": 0.58, "topBlur": 12, "eyeLitPart": 0.38 } }, "gleam-red": { "base": ["#ff5c5a", "#f6362f", "#ea3328", "#d8291c"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ff5c5a", "#f6362f", "#d8291c"], "fixedTune": { "depth": 0.12, "faceGlow": 0, "bandWidth": 26, "bandLight": 0.4, "bandOpacity": 0.6, "bandMiddle": 0.24, "lineOpacity": 1, "glintWidth": 3.6, "glintLower": 0.85, "eyeTint": 0.6, "shadowDistance": 8, "shadowBlur": 6, "gradient": "radial", "centerX": 0.5, "centerY": -0.28, "radius": 0.92, "stopMid": 0.84, "stopEdge": 0.85, "bandBlur": 1.1, "lineInset": 0.87, "lineWidth": 1.9, "lineAngle": 218, "glintInset": 0.95, "glintBlur": 0.5, "glintAngle": 44, "glintDash": 0, "upperEnd": 0.2, "lowerStart": 0.73, "topGloss": 0.75, "topReach": 0.58, "topBlur": 12, "eyeLitPart": 0.38 } }, "gleam-green": { "base": ["#2cea41", "#1bbf31", "#20a434", "#1e8630"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#2cea41", "#1bbf31", "#1e8630"], "fixedTune": { "depth": 0.12, "faceGlow": 0, "bandWidth": 26, "bandLight": 0.4, "bandOpacity": 0.6, "bandMiddle": 0.24, "lineOpacity": 1, "glintWidth": 3.6, "glintLower": 0.85, "eyeTint": 0.6, "shadowDistance": 8, "shadowBlur": 6, "gradient": "radial", "centerX": 0.5, "centerY": -0.28, "radius": 0.92, "stopMid": 0.84, "stopEdge": 0.85, "bandBlur": 1.1, "lineInset": 0.87, "lineWidth": 1.9, "lineAngle": 218, "glintInset": 0.95, "glintBlur": 0.5, "glintAngle": 44, "glintDash": 0, "upperEnd": 0.2, "lowerStart": 0.73, "topGloss": 0.75, "topReach": 0.58, "topBlur": 12, "eyeLitPart": 0.38 } }, "gleam-yellow": { "base": ["#ffe35a", "#f6d82f", "#ead128", "#d8c31c"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ffe35a", "#f6d82f", "#d8c31c"], "fixedTune": { "depth": 0.12, "faceGlow": 0, "bandWidth": 26, "bandLight": 0.4, "bandOpacity": 0.6, "bandMiddle": 0.24, "lineOpacity": 1, "glintWidth": 3.6, "glintLower": 0.85, "eyeTint": 0.6, "shadowDistance": 8, "shadowBlur": 6, "gradient": "radial", "centerX": 0.5, "centerY": -0.28, "radius": 0.92, "stopMid": 0.84, "stopEdge": 0.85, "bandBlur": 1.1, "lineInset": 0.87, "lineWidth": 1.9, "lineAngle": 218, "glintInset": 0.95, "glintBlur": 0.5, "glintAngle": 44, "glintDash": 0, "upperEnd": 0.2, "lowerStart": 0.73, "topGloss": 0.75, "topReach": 0.58, "topBlur": 12, "eyeLitPart": 0.38 } }, "gleam-purple": { "base": ["#af5aff", "#992ff6", "#9428ea", "#871cd8"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#af5aff", "#992ff6", "#871cd8"], "fixedTune": { "depth": 0.12, "faceGlow": 0, "bandWidth": 26, "bandLight": 0.4, "bandOpacity": 0.6, "bandMiddle": 0.24, "lineOpacity": 1, "glintWidth": 3.6, "glintLower": 0.85, "eyeTint": 0.6, "shadowDistance": 8, "shadowBlur": 6, "gradient": "radial", "centerX": 0.5, "centerY": -0.28, "radius": 0.92, "stopMid": 0.84, "stopEdge": 0.85, "bandBlur": 1.1, "lineInset": 0.87, "lineWidth": 1.9, "lineAngle": 218, "glintInset": 0.95, "glintBlur": 0.5, "glintAngle": 44, "glintDash": 0, "upperEnd": 0.2, "lowerStart": 0.73, "topGloss": 0.75, "topReach": 0.58, "topBlur": 12, "eyeLitPart": 0.38 } }, "gleam-pink": { "base": ["#ff5ab0", "#f62f92", "#ea2885", "#d81c73"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ff5ab0", "#f62f92", "#d81c73"], "fixedTune": { "depth": 0.12, "faceGlow": 0, "bandWidth": 26, "bandLight": 0.4, "bandOpacity": 0.6, "bandMiddle": 0.24, "lineOpacity": 1, "glintWidth": 3.6, "glintLower": 0.85, "eyeTint": 0.6, "shadowDistance": 8, "shadowBlur": 6, "gradient": "radial", "centerX": 0.5, "centerY": -0.28, "radius": 0.92, "stopMid": 0.84, "stopEdge": 0.85, "bandBlur": 1.1, "lineInset": 0.87, "lineWidth": 1.9, "lineAngle": 218, "glintInset": 0.95, "glintBlur": 0.5, "glintAngle": 44, "glintDash": 0, "upperEnd": 0.2, "lowerStart": 0.73, "topGloss": 0.75, "topReach": 0.58, "topBlur": 12, "eyeLitPart": 0.38 } }, "clear-blue": { "base": ["#75acff", "#428eff", "#337aff", "#001442"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#75acff", "#428eff", "#001442"], "fixedTune": { "depth": 0.4, "faceGlow": 0.8, "faceX": 0.24, "faceY": 0.01, "faceSize": 0.94, "bandWidth": 18, "bandOpacity": 0.64, "bandMiddle": 0, "lineOpacity": 0.81, "glintWidth": 3.2, "glintUpper": 0.95, "glintLower": 0.85, "eyeTint": 0.38, "shadowDistance": 5, "shadowBlur": 1.9, "gradient": "radial", "centerX": 0.32, "centerY": 0.17, "radius": 0.95, "stopMid": 0.333, "stopEdge": 0.67, "depthStart": 0.66, "bandBlur": 2.6, "lineInset": 0.865, "lineWidth": 8, "lineBlur": 4.4, "lineAngle": 243, "glintInset": 0.955, "glintBlur": 2.6, "glintAngle": 89, "glintDash": 0, "eyeLitPart": 0.38 } }, "clear-red": { "base": ["#ff7a75", "#ff4842", "#ff4533", "#420900"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ff7a75", "#ff4842", "#420900"], "fixedTune": { "depth": 0.4, "faceGlow": 0.8, "faceX": 0.24, "faceY": 0.01, "faceSize": 0.94, "bandWidth": 18, "bandOpacity": 0.64, "bandMiddle": 0, "lineOpacity": 0.81, "glintWidth": 3.2, "glintUpper": 0.95, "glintLower": 0.85, "eyeTint": 0.38, "shadowDistance": 5, "shadowBlur": 1.9, "gradient": "radial", "centerX": 0.32, "centerY": 0.17, "radius": 0.95, "stopMid": 0.333, "stopEdge": 0.67, "depthStart": 0.66, "bandBlur": 2.6, "lineInset": 0.865, "lineWidth": 8, "lineBlur": 4.4, "lineAngle": 243, "glintInset": 0.955, "glintBlur": 2.6, "glintAngle": 89, "glintDash": 0, "eyeLitPart": 0.38 } }, "clear-green": { "base": ["#48ed5f", "#16e332", "#15d439", "#010d04"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#48ed5f", "#16e332", "#010d04"], "fixedTune": { "depth": 0.4, "faceGlow": 0.8, "faceX": 0.24, "faceY": 0.01, "faceSize": 0.94, "bandWidth": 18, "bandOpacity": 0.64, "bandMiddle": 0, "lineOpacity": 0.81, "glintWidth": 3.2, "glintUpper": 0.95, "glintLower": 0.85, "eyeTint": 0.38, "shadowDistance": 5, "shadowBlur": 1.9, "shadowOpacity": 0.8, "gradient": "radial", "centerX": 0.32, "centerY": 0.17, "radius": 0.95, "stopMid": 0.333, "stopEdge": 0.67, "depthStart": 0.66, "bandBlur": 2.6, "lineInset": 0.865, "lineWidth": 8, "lineBlur": 4.4, "lineAngle": 243, "glintInset": 0.955, "glintBlur": 2.6, "glintAngle": 89, "glintDash": 0, "glintMiddle": 0, "rimOpacity": 0, "topGloss": 0, "sideThickness": 0, "eyeLitPart": 0.38, "shadowSpread": 0, "colors": ["#48ed5f", "#16e332", "#15d439", "#010d04"] } }, "clear-purple": { "base": ["#bf75ff", "#a742ff", "#ab33ff", "#2a0042"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#bf75ff", "#a742ff", "#2a0042"], "fixedTune": { "depth": 0.4, "faceGlow": 0.8, "faceX": 0.24, "faceY": 0.01, "faceSize": 0.94, "bandWidth": 18, "bandOpacity": 0.64, "bandMiddle": 0, "lineOpacity": 0.81, "glintWidth": 3.2, "glintUpper": 0.95, "glintLower": 0.85, "eyeTint": 0.38, "shadowDistance": 5, "shadowBlur": 1.9, "gradient": "radial", "centerX": 0.32, "centerY": 0.17, "radius": 0.95, "stopMid": 0.333, "stopEdge": 0.67, "depthStart": 0.66, "bandBlur": 2.6, "lineInset": 0.865, "lineWidth": 8, "lineBlur": 4.4, "lineAngle": 243, "glintInset": 0.955, "glintBlur": 2.6, "glintAngle": 89, "glintDash": 0, "eyeLitPart": 0.38 } }, "clear-pink": { "base": ["#ff75b5", "#ff429a", "#ff3387", "#420018"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ff75b5", "#ff429a", "#420018"], "fixedTune": { "depth": 0.4, "faceGlow": 0.8, "faceX": 0.24, "faceY": 0.01, "faceSize": 0.94, "bandWidth": 18, "bandOpacity": 0.64, "bandMiddle": 0, "lineOpacity": 0.81, "glintWidth": 3.2, "glintUpper": 0.95, "glintLower": 0.85, "eyeTint": 0.38, "shadowDistance": 5, "shadowBlur": 1.9, "gradient": "radial", "centerX": 0.32, "centerY": 0.17, "radius": 0.95, "stopMid": 0.333, "stopEdge": 0.67, "depthStart": 0.66, "bandBlur": 2.6, "lineInset": 0.865, "lineWidth": 8, "lineBlur": 4.4, "lineAngle": 243, "glintInset": 0.955, "glintBlur": 2.6, "glintAngle": 89, "glintDash": 0, "eyeLitPart": 0.38 } }, "clear-orange": { "base": ["#ffad6d", "#ff8f39", "#ff922a", "#3c2000"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ffad6d", "#ff8f39", "#3c2000"], "fixedTune": { "depth": 0.4, "faceGlow": 0.8, "faceX": 0.24, "faceY": 0.01, "faceSize": 0.94, "bandWidth": 18, "bandOpacity": 0.64, "bandMiddle": 0, "lineOpacity": 0.81, "glintWidth": 3.2, "glintUpper": 0.95, "glintLower": 0.85, "eyeTint": 0.38, "shadowDistance": 5, "shadowBlur": 1.9, "gradient": "radial", "centerX": 0.32, "centerY": 0.17, "radius": 0.95, "stopMid": 0.333, "stopEdge": 0.67, "depthStart": 0.66, "bandBlur": 2.6, "lineInset": 0.865, "lineWidth": 8, "lineBlur": 4.4, "lineAngle": 243, "glintInset": 0.955, "glintBlur": 2.6, "glintAngle": 89, "glintDash": 0, "eyeLitPart": 0.38 } }, "slab-blue": { "base": ["#3cabec", "#2a67d0", "#1e3cb4", "#12228a"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#3cabec", "#2a67d0", "#12228a"], "fixedTune": { "depth": 0.79, "faceGlow": 0.18, "faceX": 0.24, "faceY": 0, "faceSize": 0.83, "bandWidth": 66, "bandOpacity": 0.42, "bandMiddle": 0.46, "lineOpacity": 1, "glintWidth": 10.5, "glintLower": 0.46, "eyeTint": 0.32, "shadowDistance": 5.5, "shadowBlur": 0, "shadowOpacity": 0.78, "angle": 45, "stopMid": 0.51, "stopEdge": 1, "depthStart": 0.29, "bandBlur": 9.8, "lineInset": 0.98, "lineWidth": 5.5, "lineAngle": 22, "lineOffsetX": -2.1, "lineOffsetY": 0.4, "line1Pos": 0.28, "line1Opacity": 0.82, "line2Pos": 0.44, "line2Opacity": 0.69, "line3Pos": 0.7, "line3Opacity": 0.6, "line4Pos": 0.44, "line4Opacity": 0.47, "line5Pos": 0.32, "line5Opacity": 0.71, "glintInset": 0.8, "glintAngle": 87, "glintDash": 0, "upperEnd": 0.24, "topGloss": 0.78, "topReach": 0.5, "topBlur": 5.2, "sideThickness": 16.5, "sideOpacity": 0.69, "sideLine": 1, "sideLineWidth": 3.2, "sideLineScaleX": 0.94, "sideLineScaleY": 1.045, "sideLineX": 0.5, "sideLineY": -4.5, "sideLineFrom": 0.72, "sideLineFade": 0.13, "eyeLitPart": 0.3, "sideColor": "#5ccbff", "sideLineColor": "#cceeff" } }, "slab-red": { "base": ["#ec3c64", "#d0302a", "#b43c1e", "#8a3212"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ec3c64", "#d0302a", "#8a3212"], "fixedTune": { "depth": 0.79, "faceGlow": 0.18, "faceX": 0.24, "faceY": 0, "faceSize": 0.83, "bandWidth": 66, "bandOpacity": 0.42, "bandMiddle": 0.46, "lineOpacity": 1, "glintWidth": 10.5, "glintLower": 0.46, "eyeTint": 0.32, "shadowDistance": 5.5, "shadowBlur": 0, "shadowOpacity": 0.78, "angle": 45, "stopMid": 0.51, "stopEdge": 1, "depthStart": 0.29, "bandBlur": 9.8, "lineInset": 0.98, "lineWidth": 5.5, "lineAngle": 22, "lineOffsetX": -2.1, "lineOffsetY": 0.4, "line1Pos": 0.28, "line1Opacity": 0.82, "line2Pos": 0.44, "line2Opacity": 0.69, "line3Pos": 0.7, "line3Opacity": 0.6, "line4Pos": 0.44, "line4Opacity": 0.47, "line5Pos": 0.32, "line5Opacity": 0.71, "glintInset": 0.8, "glintAngle": 87, "glintDash": 0, "upperEnd": 0.24, "topGloss": 0.78, "topReach": 0.5, "topBlur": 5.2, "sideThickness": 16.5, "sideOpacity": 0.69, "sideLine": 1, "sideLineWidth": 3.2, "sideLineScaleX": 0.94, "sideLineScaleY": 1.045, "sideLineX": 0.5, "sideLineY": -4.5, "sideLineFrom": 0.72, "sideLineFade": 0.13, "eyeLitPart": 0.3, "sideColor": "#ff5c8a", "sideLineColor": "#ffccda" } }, "slab-green": { "base": ["#a6ec3c", "#62d02a", "#38b41e", "#1e8a12"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#a6ec3c", "#62d02a", "#1e8a12"], "fixedTune": { "depth": 0.79, "faceGlow": 0.18, "faceX": 0.24, "faceY": 0, "faceSize": 0.83, "bandWidth": 66, "bandOpacity": 0.42, "bandMiddle": 0.46, "lineOpacity": 1, "glintWidth": 10.5, "glintLower": 0.46, "eyeTint": 0.32, "shadowDistance": 5.5, "shadowBlur": 0, "shadowOpacity": 0.78, "angle": 45, "stopMid": 0.51, "stopEdge": 1, "depthStart": 0.29, "bandBlur": 9.8, "lineInset": 0.98, "lineWidth": 5.5, "lineAngle": 22, "lineOffsetX": -2.1, "lineOffsetY": 0.4, "line1Pos": 0.28, "line1Opacity": 0.82, "line2Pos": 0.44, "line2Opacity": 0.69, "line3Pos": 0.7, "line3Opacity": 0.6, "line4Pos": 0.44, "line4Opacity": 0.47, "line5Pos": 0.32, "line5Opacity": 0.71, "glintInset": 0.8, "glintAngle": 87, "glintDash": 0, "upperEnd": 0.24, "topGloss": 0.78, "topReach": 0.5, "topBlur": 5.2, "sideThickness": 16.5, "sideOpacity": 0.69, "sideLine": 1, "sideLineWidth": 3.2, "sideLineScaleX": 0.94, "sideLineScaleY": 1.045, "sideLineX": 0.5, "sideLineY": -4.5, "sideLineFrom": 0.72, "sideLineFade": 0.13, "eyeLitPart": 0.3, "sideColor": "#c6ff5c", "sideLineColor": "#edffcc" } }, "slab-purple": { "base": ["#6b3cec", "#832ad0", "#871eb4", "#6e128a"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#6b3cec", "#832ad0", "#6e128a"], "fixedTune": { "depth": 0.79, "faceGlow": 0.18, "faceX": 0.24, "faceY": 0, "faceSize": 0.83, "bandWidth": 66, "bandOpacity": 0.42, "bandMiddle": 0.46, "lineOpacity": 1, "glintWidth": 10.5, "glintLower": 0.46, "eyeTint": 0.32, "shadowDistance": 5.5, "shadowBlur": 0, "shadowOpacity": 0.78, "angle": 45, "stopMid": 0.51, "stopEdge": 1, "depthStart": 0.29, "bandBlur": 9.8, "lineInset": 0.98, "lineWidth": 5.5, "lineAngle": 22, "lineOffsetX": -2.1, "lineOffsetY": 0.4, "line1Pos": 0.28, "line1Opacity": 0.82, "line2Pos": 0.44, "line2Opacity": 0.69, "line3Pos": 0.7, "line3Opacity": 0.6, "line4Pos": 0.44, "line4Opacity": 0.47, "line5Pos": 0.32, "line5Opacity": 0.71, "glintInset": 0.8, "glintAngle": 87, "glintDash": 0, "upperEnd": 0.24, "topGloss": 0.78, "topReach": 0.5, "topBlur": 5.2, "sideThickness": 16.5, "sideOpacity": 0.69, "sideLine": 1, "sideLineWidth": 3.2, "sideLineScaleX": 0.94, "sideLineScaleY": 1.045, "sideLineX": 0.5, "sideLineY": -4.5, "sideLineFrom": 0.72, "sideLineFade": 0.13, "eyeLitPart": 0.3, "sideColor": "#805cff", "sideLineColor": "#d7ccff" } }, "slab-pink": { "base": ["#ec3cc3", "#d02a7d", "#b41e50", "#8a1232"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#ec3cc3", "#d02a7d", "#8a1232"], "fixedTune": { "depth": 0.79, "faceGlow": 0.18, "faceX": 0.24, "faceY": 0, "faceSize": 0.83, "bandWidth": 66, "bandOpacity": 0.42, "bandMiddle": 0.46, "lineOpacity": 1, "glintWidth": 10.5, "glintLower": 0.46, "eyeTint": 0.32, "shadowDistance": 5.5, "shadowBlur": 0, "shadowOpacity": 0.78, "angle": 45, "stopMid": 0.51, "stopEdge": 1, "depthStart": 0.29, "bandBlur": 9.8, "lineInset": 0.98, "lineWidth": 5.5, "lineAngle": 22, "lineOffsetX": -2.1, "lineOffsetY": 0.4, "line1Pos": 0.28, "line1Opacity": 0.82, "line2Pos": 0.44, "line2Opacity": 0.69, "line3Pos": 0.7, "line3Opacity": 0.6, "line4Pos": 0.44, "line4Opacity": 0.47, "line5Pos": 0.32, "line5Opacity": 0.71, "glintInset": 0.8, "glintAngle": 87, "glintDash": 0, "upperEnd": 0.24, "topGloss": 0.78, "topReach": 0.5, "topBlur": 5.2, "sideThickness": 16.5, "sideOpacity": 0.69, "sideLine": 1, "sideLineWidth": 3.2, "sideLineScaleX": 0.94, "sideLineScaleY": 1.045, "sideLineX": 0.5, "sideLineY": -4.5, "sideLineFrom": 0.72, "sideLineFade": 0.13, "eyeLitPart": 0.3, "sideColor": "#ff5ce1", "sideLineColor": "#ffccf5" } }, "slab-orange": { "base": ["#f1856f", "#de9259", "#dc962e", "#b68218"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#f1856f", "#de9259", "#b68218"], "fixedTune": { "depth": 0.79, "faceGlow": 0.18, "faceX": 0.24, "faceY": 0, "faceSize": 0.83, "bandWidth": 66, "bandOpacity": 0.42, "bandMiddle": 0.46, "lineOpacity": 1, "glintWidth": 10.5, "glintLower": 0.46, "eyeTint": 0.32, "shadowDistance": 5.5, "shadowBlur": 0, "shadowOpacity": 0.78, "angle": 45, "stopMid": 0.51, "stopEdge": 1, "depthStart": 0.29, "bandBlur": 9.8, "lineInset": 0.98, "lineWidth": 5.5, "lineAngle": 22, "lineOffsetX": -2.1, "lineOffsetY": 0.4, "line1Pos": 0.28, "line1Opacity": 0.82, "line2Pos": 0.44, "line2Opacity": 0.69, "line3Pos": 0.7, "line3Opacity": 0.6, "line4Pos": 0.44, "line4Opacity": 0.47, "line5Pos": 0.32, "line5Opacity": 0.71, "glintInset": 0.8, "glintAngle": 87, "glintDash": 0, "upperEnd": 0.24, "topGloss": 0.78, "topReach": 0.5, "topBlur": 5.2, "sideThickness": 16.5, "sideOpacity": 0.69, "sideLine": 1, "sideLineWidth": 3.2, "sideLineScaleX": 0.94, "sideLineScaleY": 1.045, "sideLineX": 0.5, "sideLineY": -4.5, "sideLineFrom": 0.72, "sideLineFade": 0.13, "eyeLitPart": 0.3, "sideColor": "#ff9c8e", "sideLineColor": "#fff2f1" } }, "prism-indigo": { "base": ["#3f81f0", "#4034c9", "#bb30e8", "#ff1f8b"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#3f81f0", "#4034c9", "#ff1f8b"], "fixedTune": { "faceGlow": 0, "bandWidth": 0, "lineOpacity": 1, "glintUpper": 1, "glintLower": 0.61, "eyeTint": 0.44, "shadowDistance": 8, "shadowBlur": 0, "shadowOpacity": 1, "shadowDarkness": 0, "angle": 0, "depthStart": 0.54, "lineInset": 0.93, "lineWidth": 1.9, "lineAngle": 293, "lineOffsetY": -10, "line1Pos": 0.44, "line1Opacity": 1, "line2Pos": 0.28, "line3Pos": 1, "line4Opacity": 0.49, "line5Pos": 0.57, "glintInset": 0.8, "glintAngle": 90, "glintOffsetY": -4.4, "glintDash": 0, "upperEnd": 0.22, "lowerStart": 1, "glintMiddle": 0.29, "middleEnd": 0.43, "rimOpacity": 0, "topGloss": 0.81, "topReach": 0.54, "topBlur": 10.1, "sideThickness": 15, "sideTone": -0.24, "sideOpacity": 1, "sideLine": 1, "sideLineTone": 0.88, "sideLineWidth": 2.7, "sideLineScaleX": 0.925, "sideLineScaleY": 0.935, "sideLineFrom": 0.77, "sideLineFade": 0.28, "eyeLitPart": 0.25, "shadowSpread": 0.1, "antennaHighlight": 1, "antennaHighlightSize": 0.65, "antennaHighlightX": 0.25, "antennaHighlightY": 0.26, "eyeHighlight": 0.76, "eyeHighlightSize": 27, "eyeHighlightSoft": 0.98, "eyeHighlightX": -5, "eyeHighlightY": 5.5, "eyeHighlightFollow": 12.5, "eyeSpark": 0, "colors": ["#3f81f0", "#4034c9", "#bb30e8", "#ff1f8b"], "shadowColor": "#341a9e", "antennaMid": "#748cd8", "antennaDark": "#fba7f2", "line2Color": "#ffffff", "line3Color": "#ffffff" } }, "prism-red": { "base": ["#f03f8a", "#c93934", "#e8b230", "#97ff1f"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#f03f8a", "#c93934", "#97ff1f"], "fixedTune": { "faceGlow": 0, "bandWidth": 0, "lineOpacity": 1, "glintUpper": 1, "glintLower": 0.61, "eyeTint": 0.44, "shadowDistance": 8, "shadowBlur": 0, "shadowOpacity": 1, "shadowDarkness": 0, "angle": 0, "depthStart": 0.54, "lineInset": 0.93, "lineWidth": 1.9, "lineAngle": 293, "lineOffsetY": -10, "line1Pos": 0.44, "line1Opacity": 1, "line2Pos": 0.28, "line3Pos": 1, "line4Opacity": 0.49, "line5Pos": 0.57, "glintInset": 0.8, "glintAngle": 90, "glintOffsetY": -4.4, "glintDash": 0, "upperEnd": 0.22, "lowerStart": 1, "glintMiddle": 0.29, "middleEnd": 0.43, "rimOpacity": 0, "topGloss": 0.81, "topReach": 0.54, "topBlur": 10.1, "sideThickness": 15, "sideTone": -0.24, "sideOpacity": 1, "sideLine": 1, "sideLineTone": 0.88, "sideLineWidth": 2.7, "sideLineScaleX": 0.925, "sideLineScaleY": 0.935, "sideLineFrom": 0.77, "sideLineFade": 0.28, "eyeLitPart": 0.25, "shadowSpread": 0.1, "antennaHighlight": 1, "antennaHighlightSize": 0.65, "antennaHighlightX": 0.25, "antennaHighlightY": 0.26, "eyeHighlight": 0.76, "eyeHighlightSize": 27, "eyeHighlightSoft": 0.98, "eyeHighlightX": -5, "eyeHighlightY": 5.5, "eyeHighlightFollow": 12.5, "eyeSpark": 0, "colors": ["#f03f8a", "#c93934", "#e8b230", "#97ff1f"], "shadowColor": "#9e2d1a", "antennaMid": "#d87491", "antennaDark": "#f6fba7", "line2Color": "#ffffff", "line3Color": "#ffffff" } }, "prism-lime": { "base": ["#cfe537", "#6ab237", "#29dc57", "#18eff3"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#cfe537", "#6ab237", "#18eff3"], "fixedTune": { "faceGlow": 0, "bandWidth": 0, "lineOpacity": 1, "glintUpper": 1, "glintLower": 0.61, "eyeTint": 0.44, "shadowDistance": 8, "shadowBlur": 0, "shadowOpacity": 1, "shadowDarkness": 0, "angle": 0, "depthStart": 0.54, "lineInset": 0.93, "lineWidth": 1.9, "lineAngle": 293, "lineOffsetY": -10, "line1Pos": 0.44, "line1Opacity": 1, "line2Pos": 0.28, "line3Pos": 1, "line4Opacity": 0.49, "line5Pos": 0.57, "glintInset": 0.8, "glintAngle": 90, "glintOffsetY": -4.4, "glintDash": 0, "upperEnd": 0.22, "lowerStart": 1, "glintMiddle": 0.29, "middleEnd": 0.43, "rimOpacity": 0, "topGloss": 0.81, "topReach": 0.54, "topBlur": 10.1, "sideThickness": 15, "sideTone": -0.24, "sideOpacity": 1, "sideLine": 1, "sideLineTone": 0.88, "sideLineWidth": 2.7, "sideLineScaleX": 0.925, "sideLineScaleY": 0.935, "sideLineFrom": 0.77, "sideLineFade": 0.28, "eyeLitPart": 0.25, "shadowSpread": 0.1, "antennaHighlight": 1, "antennaHighlightSize": 0.65, "antennaHighlightX": 0.25, "antennaHighlightY": 0.26, "eyeHighlight": 0.76, "eyeHighlightSize": 27, "eyeHighlightSoft": 0.98, "eyeHighlightX": -5, "eyeHighlightY": 5.5, "eyeHighlightFollow": 12.5, "eyeSpark": 0, "colors": ["#cfe537", "#6ab237", "#29dc57", "#18eff3"], "shadowColor": "#3e891d", "antennaMid": "#b5cf6c", "antennaDark": "#9ff6d4", "line2Color": "#ffffff", "line3Color": "#ffffff" } }, "prism-rose": { "base": ["#f03fbc", "#c93459", "#e87e30", "#d6ff1f"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#f03fbc", "#c93459", "#d6ff1f"], "fixedTune": { "faceGlow": 0, "bandWidth": 0, "lineOpacity": 1, "glintUpper": 1, "glintLower": 0.61, "eyeTint": 0.44, "shadowDistance": 8, "shadowBlur": 0, "shadowOpacity": 1, "shadowDarkness": 0, "angle": 0, "depthStart": 0.54, "lineInset": 0.93, "lineWidth": 1.9, "lineAngle": 293, "lineOffsetY": -10, "line1Pos": 0.44, "line1Opacity": 1, "line2Pos": 0.28, "line3Pos": 1, "line4Opacity": 0.49, "line5Pos": 0.57, "glintInset": 0.8, "glintAngle": 90, "glintOffsetY": -4.4, "glintDash": 0, "upperEnd": 0.22, "lowerStart": 1, "glintMiddle": 0.29, "middleEnd": 0.43, "rimOpacity": 0, "topGloss": 0.81, "topReach": 0.54, "topBlur": 10.1, "sideThickness": 15, "sideTone": -0.24, "sideOpacity": 1, "sideLine": 1, "sideLineTone": 0.88, "sideLineWidth": 2.7, "sideLineScaleX": 0.925, "sideLineScaleY": 0.935, "sideLineFrom": 0.77, "sideLineFade": 0.28, "eyeLitPart": 0.25, "shadowSpread": 0.1, "antennaHighlight": 1, "antennaHighlightSize": 0.65, "antennaHighlightX": 0.25, "antennaHighlightY": 0.26, "eyeHighlight": 0.76, "eyeHighlightSize": 27, "eyeHighlightSoft": 0.98, "eyeHighlightX": -5, "eyeHighlightY": 5.5, "eyeHighlightFollow": 12.5, "eyeSpark": 0, "colors": ["#f03fbc", "#c93459", "#e87e30", "#d6ff1f"], "shadowColor": "#9e1a2c", "antennaMid": "#d874ad", "antennaDark": "#fbe8a7", "line2Color": "#ffffff", "line3Color": "#ffffff" } }, "prism-sky": { "base": ["#3ff0da", "#3497c9", "#3130e8", "#cb1fff"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#3ff0da", "#3497c9", "#cb1fff"], "fixedTune": { "faceGlow": 0, "bandWidth": 0, "lineOpacity": 1, "glintUpper": 1, "glintLower": 0.61, "eyeTint": 0.44, "shadowDistance": 8, "shadowBlur": 0, "shadowOpacity": 1, "shadowDarkness": 0, "angle": 0, "depthStart": 0.54, "lineInset": 0.93, "lineWidth": 1.9, "lineAngle": 293, "lineOffsetY": -10, "line1Pos": 0.44, "line1Opacity": 1, "line2Pos": 0.28, "line3Pos": 1, "line4Opacity": 0.49, "line5Pos": 0.57, "glintInset": 0.8, "glintAngle": 90, "glintOffsetY": -4.4, "glintDash": 0, "upperEnd": 0.22, "lowerStart": 1, "glintMiddle": 0.29, "middleEnd": 0.43, "rimOpacity": 0, "topGloss": 0.81, "topReach": 0.54, "topBlur": 10.1, "sideThickness": 15, "sideTone": -0.24, "sideOpacity": 1, "sideLine": 1, "sideLineTone": 0.88, "sideLineWidth": 2.7, "sideLineScaleX": 0.925, "sideLineScaleY": 0.935, "sideLineFrom": 0.77, "sideLineFade": 0.28, "eyeLitPart": 0.25, "shadowSpread": 0.1, "antennaHighlight": 1, "antennaHighlightSize": 0.65, "antennaHighlightX": 0.25, "antennaHighlightY": 0.26, "eyeHighlight": 0.76, "eyeHighlightSize": 27, "eyeHighlightSoft": 0.98, "eyeHighlightX": -5, "eyeHighlightY": 5.5, "eyeHighlightFollow": 12.5, "eyeSpark": 0, "colors": ["#3ff0da", "#3497c9", "#3130e8", "#cb1fff"], "shadowColor": "#1a639e", "antennaMid": "#74d7d8", "antennaDark": "#c5a7fb", "line2Color": "#ffffff", "line3Color": "#ffffff" } }, "prism-purple": { "base": ["#9a3ff0", "#c534c9", "#e83071", "#ff7a1f"], "sheen": "slab", "acrylic": true, "faithful": true, "plain": true, "eye": "#ffffff", "rim": "#ffffff", "shine": 0, "shade": 0, "antenna": ["#9a3ff0", "#c534c9", "#ff7a1f"], "fixedTune": { "faceGlow": 0, "bandWidth": 0, "lineOpacity": 1, "glintUpper": 1, "glintLower": 0.61, "eyeTint": 0.44, "shadowDistance": 8, "shadowBlur": 0, "shadowOpacity": 1, "shadowDarkness": 0, "angle": 0, "depthStart": 0.54, "lineInset": 0.93, "lineWidth": 1.9, "lineAngle": 293, "lineOffsetY": -10, "line1Pos": 0.44, "line1Opacity": 1, "line2Pos": 0.28, "line3Pos": 1, "line4Opacity": 0.49, "line5Pos": 0.57, "glintInset": 0.8, "glintAngle": 90, "glintOffsetY": -4.4, "glintDash": 0, "upperEnd": 0.22, "lowerStart": 1, "glintMiddle": 0.29, "middleEnd": 0.43, "rimOpacity": 0, "topGloss": 0.81, "topReach": 0.54, "topBlur": 10.1, "sideThickness": 15, "sideTone": -0.24, "sideOpacity": 1, "sideLine": 1, "sideLineTone": 0.88, "sideLineWidth": 2.7, "sideLineScaleX": 0.925, "sideLineScaleY": 0.935, "sideLineFrom": 0.77, "sideLineFade": 0.28, "eyeLitPart": 0.25, "shadowSpread": 0.1, "antennaHighlight": 1, "antennaHighlightSize": 0.65, "antennaHighlightX": 0.25, "antennaHighlightY": 0.26, "eyeHighlight": 0.76, "eyeHighlightSize": 27, "eyeHighlightSoft": 0.98, "eyeHighlightX": -5, "eyeHighlightY": 5.5, "eyeHighlightFollow": 12.5, "eyeSpark": 0, "colors": ["#9a3ff0", "#c534c9", "#e83071", "#ff7a1f"], "shadowColor": "#9e1a93", "antennaMid": "#b574d8", "antennaDark": "#fba7a7", "line2Color": "#ffffff", "line3Color": "#ffffff" } }, "ocean": { "base": ["#7ff0e4", "#3cc3e0", "#2b7fd4", "#3b3fb0"], "eye": "#132a4a", "rim": "#e8fffd", "shine": 0.8, "shade": 0.3, "antenna": ["#e8fffd", "#3cc3e0", "#3b3fb0"], "linear": true }, "forest": { "base": ["#d9f99d", "#7bd389", "#2f9e7a", "#1e5f6b"], "eye": "#12302a", "rim": "#f4ffe8", "shine": 0.75, "shade": 0.3, "antenna": ["#f4ffe8", "#7bd389", "#1e5f6b"], "linear": true }, "gradient-yellow": { "base": ["#f0bf7f", "#e0c73c", "#b6d42b", "#65b03b"], "eye": "#3c4a13", "rim": "#fff5e8", "shine": 0.8, "shade": 0.3, "antenna": ["#fff5e8", "#e0c73c", "#65b03b"], "linear": true }, "gradient-purple": { "base": ["#a29aeb", "#c592f1", "#eb95cf", "#e7c49b"], "eye": "#522d51", "rim": "#fff6f4", "shine": 0.82, "shade": 0.3, "antenna": ["#efedff", "#e99bec", "#a5567e"], "linear": true }, "candy": { "base": ["#fbd651", "#fe4d9d", "#a724ff", "#3da1ff"], "eye": "#310042", "rim": "#fff4fb", "shine": 0.85, "shade": 0.26, "antenna": ["#fff4fb", "#ff9cc8", "#7f6bd6"], "linear": true }, "aurora": { "base": ["#9aebea", "#92c9f1", "#a795eb", "#e79bc7"], "eye": "#2d3052", "rim": "#fff4fe", "shine": 0.82, "shade": 0.3, "antenna": ["#edffff", "#9ba7ec", "#7456a5"], "linear": true }, "pearl": { "base": ["#ffffff", "#eaf2ff", "#f4e9ff", "#e2f6ee"], "eye": "#3b3a4a", "rim": "#ffffff", "shine": 0.92, "shade": 0.16, "antenna": ["#ffffff", "#ece6fb", "#b9b4cf"], "linear": true }, "sakura": { "base": ["#ffffff", "#fdeaf0", "#f3c7d4", "#d697ab"], "eye": "#4b2f3b", "rim": "#ffffff", "shine": 0.9, "shade": 0.2, "antenna": ["#ffffff", "#f7d3de", "#cf8ea3"] }, "lavender": { "base": ["#ffffff", "#ece6ff", "#cbbcf2", "#9c88d6"], "eye": "#33294d", "rim": "#ffffff", "shine": 0.9, "shade": 0.2, "antenna": ["#ffffff", "#ddd3fb", "#9c88d6"] }, "lemon": { "base": ["#fffef0", "#fff2a8", "#f5d757", "#c9a21d"], "eye": "#3d3510", "rim": "#fffbe0", "shine": 0.9, "shade": 0.22, "antenna": ["#ffffff", "#fbe58a", "#c9a21d"] }, "sky": { "base": ["#ffffff", "#dff1ff", "#a9d6f7", "#5ea4d8"], "eye": "#1d3a52", "rim": "#ffffff", "shine": 0.9, "shade": 0.22, "antenna": ["#ffffff", "#c7e6fb", "#5ea4d8"] }, "mint": { "base": ["#f5fffb", "#cdf3e5", "#93dcc3", "#52ad90"], "eye": "#1f3f36", "rim": "#f2fffa", "shine": 0.85, "shade": 0.24, "antenna": ["#ffffff", "#b5ead6", "#4fa88b"] }, "obsidian": { "base": ["#7b8796", "#313a47", "#101722", "#05080e"], "eye": "#f0f7ff", "rim": "#c1d5f4", "shine": 0.57, "shade": 0.68, "antenna": ["#c3cfdf", "#384452", "#080e19"] }, "midnight": { "base": ["#7f98d4", "#2c4381", "#111e4a", "#060b22"], "eye": "#eaf2ff", "rim": "#a9c2ff", "shine": 0.55, "shade": 0.62, "antenna": ["#c9d7ff", "#33498a", "#070d26"] }, "jade": { "base": ["#7fb5a3", "#2f6d5b", "#123e33", "#06201a"], "eye": "#ecfff7", "rim": "#aee8d3", "shine": 0.5, "shade": 0.6, "antenna": ["#c8f0e2", "#2f6d5b", "#05201a"] }, "amber": { "base": ["#ffe2a6", "#f2a73c", "#c46812", "#6b3005"], "eye": "#fff7e8", "rim": "#ffdba0", "shine": 0.6, "shade": 0.5, "antenna": ["#fff0cc", "#e08c22", "#6b3005"] }, "ruby": { "base": ["#ff8a9a", "#d0243f", "#7a0d22", "#3a0410"], "eye": "#fff0f2", "rim": "#ffb3bf", "shine": 0.7, "shade": 0.6, "antenna": ["#ffd0d8", "#d0243f", "#3a0410"] }, "sapphire": { "base": ["#8fc0ff", "#2a6fd6", "#103f8c", "#071d44"], "eye": "#eef6ff", "rim": "#bcd8ff", "shine": 0.7, "shade": 0.6, "antenna": ["#d4e7ff", "#2a6fd6", "#071d44"] }, "emerald": { "base": ["#8ff0c0", "#1fae74", "#0b6a45", "#033321"], "eye": "#effff7", "rim": "#b8f7d9", "shine": 0.7, "shade": 0.55, "antenna": ["#d2fbe6", "#1fae74", "#033321"] }, "soccer-grooves": { "base": ["#4a4d55", "#24262b", "#131417", "#060607"], "ball": true, "eye": "#ffffff", "rim": "#e8eef8", "shine": 0.7, "shade": 0.5, "antenna": ["#4a4d55", "#24262b", "#060607"], "pattern": { "kind": "grooves", "colors": ["#c6ff2e", "#000000"] } }, "basketball": { "base": ["#ffb066", "#f07a1e", "#c95a0e", "#7a3305"], "ball": true, "eye": "#fff3e6", "ring": "#2a1408", "rim": "#ffffff", "shine": 0.55, "shade": 0.45, "antenna": ["#ffb066", "#f07a1e", "#7a3305"], "pattern": { "kind": "basketball", "colors": ["#2a1408", "#7a3305"] } }, "football": { "base": ["#c07a4a", "#8f4a22", "#6a3112", "#3a1606"], "ball": true, "eye": "#fff3e6", "ring": "#2a1004", "rim": "#e8eef8", "shine": 0.5, "shade": 0.5, "antenna": ["#c07a4a", "#8f4a22", "#3a1606"], "pattern": { "kind": "football", "colors": ["#ffffff", "#3a1606", "#2a1004"] } }, "tennis": { "base": ["#f4ff8a", "#d7f43a", "#aacb10", "#66800a"], "ball": true, "eye": "#2f3a08", "rim": "#ffffff", "shine": 0.6, "shade": 0.3, "antenna": ["#f4ff8a", "#d7f43a", "#66800a"], "pattern": { "kind": "tennis", "colors": ["#ffffff", "#6a8a00"] } }, "baseball": { "base": ["#fffdf7", "#f6f1e6", "#e2d9c7", "#b5a98f"], "ball": true, "eye": "#2a2a2e", "rim": "#ffffff", "shine": 0.8, "shade": 0.28, "antenna": ["#fffdf7", "#f6f1e6", "#b5a98f"], "pattern": { "kind": "baseball", "colors": ["#c9a9a0", "#d6333a"] } }, "softball": { "base": ["#fbff9a", "#eef55a", "#cfd61f", "#8a8f0a"], "ball": true, "eye": "#3a3a10", "rim": "#ffffff", "shine": 0.75, "shade": 0.3, "antenna": ["#fbff9a", "#eef55a", "#8a8f0a"], "pattern": { "kind": "baseball", "colors": ["#b8a640", "#d6333a"] } }, "cricket": { "base": ["#e05a4f", "#b52a22", "#851812", "#470806"], "ball": true, "eye": "#fff3ee", "rim": "#e8eef8", "shine": 0.6, "shade": 0.5, "antenna": ["#e05a4f", "#b52a22", "#470806"], "pattern": { "kind": "cricket", "colors": ["#5a0c08", "#f6ead6"] } }, "golf": { "base": ["#ffffff", "#f6f6f4", "#e2e2de", "#acaca6"], "ball": true, "eye": "#2a2f36", "rim": "#ffffff", "shine": 0.95, "shade": 0.25, "antenna": ["#ffffff", "#f6f6f4", "#acaca6"], "pattern": { "kind": "golf", "colors": ["#c3c9d2", "#ffffff"] } }, "tartan": { "base": ["#d04848", "#a82d30", "#7d1c20", "#4a0e12"], "eye": "#fff6e8", "ring": "#2a0b0e", "rim": "#e8eef8", "shine": 0.5, "shade": 0.55, "antenna": ["#d04848", "#a82d30", "#4a0e12"], "pattern": { "kind": "tartan", "colors": ["#1b2a4a", "#f2d36b", "#0f3d2a"] } }, "marble": { "base": ["#ffffff", "#f6f6f4", "#e6e6e2", "#bcbcb6"], "eye": "#2a2a2e", "rim": "#ffffff", "shine": 0.8, "shade": 0.28, "antenna": ["#ffffff", "#f6f6f4", "#bcbcb6"], "pattern": { "kind": "marble", "colors": ["#8d8d93", "#c7a76b"] } }, "black-marble": { "base": ["#4a4a4f", "#25252a", "#141417", "#050506"], "eye": "#f7f2e6", "rim": "#e8eef8", "shine": 0.5, "shade": 0.55, "antenna": ["#4a4a4f", "#25252a", "#050506"], "pattern": { "kind": "marble", "colors": ["#d9b46a", "#f2f2f2"], "seed": 33 } }, "leaves": { "base": ["#f0fbe6", "#cfeeb2", "#97d37b", "#4f9a45"], "eye": "#173a17", "rim": "#ffffff", "shine": 0.8, "shade": 0.28, "antenna": ["#f0fbe6", "#cfeeb2", "#4f9a45"], "pattern": { "kind": "scatter", "shapes": ["leaf"], "colors": ["#3e8a3a", "#7cc46a"], "count": 18, "k": [6, 10] } }, "blossoms": { "base": ["#fffafd", "#ffeaf2", "#ffd0e0", "#f0a3c0"], "eye": "#4b2032", "rim": "#ffffff", "shine": 0.8, "shade": 0.28, "antenna": ["#fffafd", "#ffeaf2", "#f0a3c0"], "pattern": { "kind": "scatter", "shapes": ["blossom"], "colors": ["#ff9fbf", "#ffe1ec"], "count": 12, "k": [6, 9] } }, "neon": { "base": ["#5b3df5", "#2a1673", "#120a3a", "#06041a"], "eye": "#7ff9ff", "rim": "#7ff9ff", "shine": 0.45, "shade": 0.6, "antenna": ["#c9fbff", "#5b3df5", "#06041a"] }, "polka": { "base": ["#ff9db2", "#ff5d84", "#e03a64", "#9b1c3e"], "eye": "#ffffff", "ring": "#7a1430", "rim": "#ffffff", "shine": 0.8, "shade": 0.28, "antenna": ["#ff9db2", "#ff5d84", "#9b1c3e"], "pattern": { "kind": "dots", "colors": ["#ffffff"], "r": 6, "size": 30, "opacity": 0.9 } }, "confetti": { "base": ["#ffffff", "#fbfaf7", "#efece6", "#c9c4bb"], "eye": "#2a2a35", "rim": "#ffffff", "shine": 0.8, "shade": 0.28, "antenna": ["#ffffff", "#fbfaf7", "#c9c4bb"], "pattern": { "kind": "confetti", "colors": ["#ff5d8a", "#3da9fc", "#ffd23f", "#2cb67d", "#7f5af0"] } }, "halftone": { "base": ["#ffe6ee", "#ffb3c7", "#ff7aa0", "#d6406c"], "eye": "#4a1428", "rim": "#ffffff", "shine": 0.8, "shade": 0.28, "antenna": ["#ffe6ee", "#ffb3c7", "#d6406c"], "pattern": { "kind": "halftone", "colors": ["#ffffff"] } }, "terrazzo": { "base": ["#ffffff", "#fbfaf7", "#efece6", "#c9c4bb"], "eye": "#2d2a26", "rim": "#ffffff", "shine": 0.8, "shade": 0.28, "antenna": ["#ffffff", "#fbfaf7", "#c9c4bb"], "pattern": { "kind": "terrazzo", "colors": ["#e46a4f", "#2e7d6b", "#f2b33d", "#3d5aa8", "#9aa0a6"] } }, "pixel": { "base": ["#3a3a4a", "#24242f", "#16161d", "#0a0a10"], "eye": "#ffffff", "ring": "#16161a", "rim": "#e8eef8", "shine": 0.5, "shade": 0.55, "antenna": ["#3a3a4a", "#24242f", "#0a0a10"], "pattern": { "kind": "pixel", "colors": ["#7f5af0", "#2cb67d", "#ff8906", "#f25f4c", "#3da9fc"] } } };
    const SHEENS = Object.freeze({
      gloss: { top: 0.78, reach: 0.36, bottom: 0.3 },
      slab: { top: 0.26, reach: 0.3, bottom: 0, slab: true }
    });
    const ACRYLIC_DEFAULTS = Object.freeze({
      colors: null,
      // [top, middle, edge, shadow] to override the skin's own colours
      vertical: false,
      // colour runs top to bottom instead of corner to corner
      depth: 0.8,
      // darkening toward the edge
      faceGlow: 0.67,
      // soft light on the face
      faceX: 0.25,
      faceY: 0.03,
      faceSize: 0.66,
      bandWidth: 20,
      // width of the bevel band along the edge
      bandLight: 0,
      // how much lighter the bevel is than the colour
      bandOpacity: 1,
      // bevel strength at the top and bottom
      bandMiddle: 0.98,
      // bevel strength along the sides
      edgeBlur: 0.6,
      // softness of the bevel and glints
      lineOpacity: 0.41,
      // inner bevel line
      glintWidth: 12,
      // white glint lines
      glintUpper: 1,
      // glint on the upper right
      glintLower: 0.21,
      // glint along the bottom
      eyeTint: 0.37,
      // colour picked up by the eyes' shaded side
      eyeSoftness: 0,
      // blur of the eyes seen through the acrylic
      shadowDistance: 6,
      shadowBlur: 0.6,
      shadowOpacity: 0.8,
      shadowDarkness: 0.25,
      // 0 = middle colour, 1 = the shadow colour
      // Finer controls, applied by applyAcrylicTuning() after the skin is painted.
      gradient: "linear",
      // 'auto' keeps the skin's own; 'radial' or 'linear'
      angle: 80,
      // linear direction in degrees, 90 = top to bottom
      centerX: 0.75,
      centerY: 0.46,
      radius: 1.11,
      stopMid: 0.71,
      stopEdge: 0.96,
      depthStart: 0.59,
      // where the edge darkening begins, 0..1 from the middle
      bandColor: "",
      // bevel colour; empty = a lighter version of the top colour
      bandBlur: 6.2,
      lineInset: 0.855,
      lineWidth: 4.4,
      lineBlur: 0,
      lineAngle: 250,
      lineOffsetX: 0,
      lineOffsetY: 0,
      // Five colour stops along the inner line; an empty colour is a light tint of
      // the skin, never a dark one.
      line1Pos: 0.64,
      line1Color: "#ffffff",
      line1Opacity: 0.29,
      line2Pos: 0.36,
      line2Color: "",
      line2Opacity: 0,
      line3Pos: 0.43,
      line3Color: "",
      line3Opacity: 0.67,
      line4Pos: 0.51,
      line4Color: "",
      line4Opacity: 0.95,
      line5Pos: 0.68,
      line5Color: "",
      line5Opacity: 0,
      lineFollow: false,
      // turn the line's bright end toward the light
      glintInset: 0.82,
      glintBlur: 0,
      glintColor: "#ffffff",
      glintAngle: 40,
      glintFollow: 0,
      glintOffsetX: 0,
      glintOffsetY: 0,
      glintDash: 30.5,
      glintGap: 14.5,
      upperStart: 0,
      upperEnd: 0.19,
      lowerStart: 0.81,
      lowerEnd: 1,
      glintMiddle: 0,
      middleStart: 1,
      middleEnd: 0.02,
      rimOpacity: 0,
      rimWidth: 0,
      rimColor: "#ffffff",
      topGloss: 0,
      topReach: 0.32,
      topBlur: 3.4,
      // sideTone: positive lightens the side wall, negative darkens it.
      sideThickness: 0,
      sideTone: 0.45,
      sideOpacity: 0.75,
      sideColor: "",
      // sideLineTone: 1 = white, 0 = the skin colour, -1 = the darkest tone.
      sideLine: 0.85,
      sideLineTone: 1,
      sideLineColor: "",
      sideLineWidth: 2.4,
      // The edge line is a copy of the head outline: scale and move it freely,
      // choose where along the edge it shows, and fade its ends.
      sideLineScaleX: 1,
      sideLineScaleY: 1,
      sideLineX: 0,
      sideLineY: 0,
      sideLineFrom: 0.7,
      sideLineTo: 1,
      sideLineFade: 0.12,
      sideLineSideFade: 0,
      sideLineBlur: 0,
      sideLineDash: 0,
      sideLineGap: 0,
      sideLineCap: "round",
      eyeColor: "#ffffff",
      eyeOpacity: 1,
      eyeLitPart: 0.34,
      eyeRimWidth: 0,
      eyeRimOpacity: 1,
      shadowColor: "",
      shadowSpread: 0.3,
      shadowFollow: true,
      shadowAngle: 135,
      // Antenna sphere.
      antennaLight: "",
      antennaMid: "",
      antennaDark: "",
      // empty = from the skin colours
      antennaHighlight: 0.9,
      antennaHighlightSize: 0.22,
      // white spot on the sphere
      antennaHighlightX: 0.3,
      antennaHighlightY: 0.25,
      antennaFollow: true,
      antennaOpacity: 1,
      antennaSize: 1,
      antennaRimColor: "#ffffff",
      antennaRimWidth: 0,
      antennaRimOpacity: 0.6,
      // Highlight on the eyes, in each eye's own units (the eye is about 54 wide).
      // Eyes stay plain unless a look adds its own highlight.
      eyeHighlight: 0,
      eyeHighlightSize: 7,
      eyeHighlightSoft: 0.75,
      eyeHighlightX: -9,
      eyeHighlightY: -10,
      eyeHighlightFollow: 6,
      eyeSpark: 0,
      eyeSparkSize: 3.5,
      eyeSparkX: 8,
      eyeSparkY: 9
    });
    function tunedAcrylic(look, own) {
      const tune = { ...ACRYLIC_DEFAULTS, ...own };
      const base = Array.isArray(tune.colors) && tune.colors.length === 4 ? tune.colors : look.base;
      return { ...look, base, antenna: [base[0], base[1], base[3]], linear: tune.vertical ? "vertical" : look.linear, shade: tune.depth, tune };
    }
    function applyAcrylicTuning(skin, look) {
      var _a, _b, _c;
      const t = look.tune, base = look.base, p = skin.sheenParts, defs = skin.defs;
      const white = "#ffffff";
      const replace = (id, tag, attrs, stops) => {
        var _a2;
        (_a2 = defs.querySelector(`#${id}`)) == null ? void 0 : _a2.remove();
        return gradient(defs, tag, id, attrs, stops.sort((a, b) => a[0] - b[0]).map(([o, c, a]) => [Math.min(1, Math.max(0, o)), c, a]));
      };
      const softly = (node, id, std) => {
        var _a2;
        (_a2 = defs.querySelector(`#${id}`)) == null ? void 0 : _a2.remove();
        if (!(std > 0)) {
          node.removeAttribute("filter");
          return;
        }
        defs.insertAdjacentHTML("beforeend", `<filter id="${id}" filterUnits="userSpaceOnUse" x="-30" y="-30" width="300" height="300"><feGaussianBlur stdDeviation="${std}"/></filter>`);
        node.setAttribute("filter", `url(#${id})`);
      };
      const show = (node, on) => {
        node.style.display = on ? "" : "none";
      };
      const inset = (k) => `translate(${120 * (1 - k)} ${120 * (1 - k)}) scale(${k}) ${skin.headTransform}`;
      if (t.gradient !== "auto") {
        const stops = [[0, base[0]], [t.stopMid, base[1]], [t.stopEdge, base[2]], [1, base[2]]];
        if (t.gradient === "linear") {
          const a = t.angle * Math.PI / 180, dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
          skin.parts.base = replace("skin-base", "linearGradient", { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy }, stops);
        } else {
          skin.parts.base = replace("skin-base", "radialGradient", { cx: t.centerX, cy: t.centerY, r: t.radius }, stops);
        }
        skin.tunedBase = true;
      }
      skin.parts.volume = replace(
        "skin-volume",
        "radialGradient",
        { cx: ".43", cy: ".30", r: ".76" },
        [[0, base[3], 0], [t.depthStart, base[3], 0], [1, base[3], t.depth]]
      );
      show(skin.layers.children[1], t.depth > 0);
      show(p.face, t.faceGlow > 0);
      const [band, line, glint] = p.bevel.children;
      const bandColor = t.bandColor || mixHex(base[0], white, t.bandLight);
      const bandTop = t.bandColor || mixHex(base[0], white, Math.min(1, t.bandLight * 2));
      replace(
        "skin-sheen-band",
        "linearGradient",
        { x1: "0", y1: "0", x2: "0", y2: "1" },
        [[0, bandTop, t.bandOpacity * 1.2], [0.06, bandColor, t.bandOpacity], [0.5, bandColor, t.bandMiddle], [0.94, bandColor, t.bandOpacity], [1, bandTop, t.bandOpacity * 1.3]]
      );
      p.bevel.removeAttribute("filter");
      band.setAttribute("stroke-width", String(t.bandWidth));
      softly(band, "skin-band-blur", t.bandBlur);
      show(band, t.bandWidth > 0 && (t.bandOpacity > 0 || t.bandMiddle > 0));
      const axis = (degrees) => {
        const a = degrees * Math.PI / 180, k = Math.SQRT1_2;
        return { x1: 0.5 - Math.cos(a) * k, y1: 0.5 - Math.sin(a) * k, x2: 0.5 + Math.cos(a) * k, y2: 0.5 + Math.sin(a) * k };
      };
      const tint = mixHex(base[0], white, 0.5);
      skin.lineGradient = replace(
        "skin-sheen-line",
        "linearGradient",
        axis(t.lineAngle),
        [1, 2, 3, 4, 5].map((i) => [t[`line${i}Pos`], t[`line${i}Color`] || tint, t[`line${i}Opacity`]])
      );
      skin.lineFollow = t.lineFollow;
      line.style.display = t.lineOpacity > 0 ? "" : "none";
      line.setAttribute("transform", `translate(${t.lineOffsetX} ${t.lineOffsetY}) ${inset(t.lineInset)}`);
      line.setAttribute("stroke-width", String(t.lineWidth));
      line.setAttribute("opacity", String(t.lineOpacity));
      softly(line, "skin-line-blur", t.lineBlur);
      if (t.lineWidth <= 0 || [1, 2, 3, 4, 5].every((i) => !(t[`line${i}Opacity`] > 0))) show(line, false);
      const g = t.glintColor;
      const stretch = (start, end, bright) => bright > 0 && end > start ? [[start, g, 0], [Math.min(end, start + 0.06), g, bright], [Math.max(start + 0.06, end - 0.06), g, bright * 0.9], [end, g, 0]] : [];
      replace("skin-sheen-glint", "linearGradient", axis(t.glintAngle), [
        [0, g, 0],
        ...stretch(t.upperStart, t.upperEnd, t.glintUpper),
        ...stretch(t.middleStart, t.middleEnd, t.glintMiddle),
        ...stretch(t.lowerStart, t.lowerEnd, t.glintLower),
        [1, g, 0]
      ]);
      skin.glintTransform = `translate(${t.glintOffsetX} ${t.glintOffsetY}) ${inset(t.glintInset)}`;
      skin.glintFollow = t.glintFollow;
      glint.setAttribute("transform", skin.glintTransform);
      glint.setAttribute("stroke-width", String(t.glintWidth));
      softly(glint, "skin-glint-blur", t.glintBlur);
      show(glint, t.glintWidth > 0 && (t.glintUpper > 0 || t.glintMiddle > 0 || t.glintLower > 0));
      if (t.glintDash > 0) glint.setAttribute("stroke-dasharray", `${t.glintDash} ${t.glintGap}`);
      else glint.removeAttribute("stroke-dasharray");
      const rim = skin.layers.children[3];
      rim.style.display = t.rimOpacity > 0 ? "" : "none";
      rim.setAttribute("stroke", t.rimColor);
      rim.setAttribute("stroke-width", String(t.rimWidth));
      rim.setAttribute("opacity", String(t.rimOpacity));
      p.top.style.display = t.topGloss > 0 ? "" : "none";
      replace(
        "skin-sheen-top",
        "linearGradient",
        { x1: "0", y1: "0", x2: "0", y2: "1" },
        [[0, white, t.topGloss], [t.topReach * 0.5, white, t.topGloss * 0.45], [t.topReach, white, 0], [1, white, 0]]
      );
      softly(p.top, "skin-top-blur", t.topBlur);
      p.side.style.display = t.sideThickness > 0 ? "" : "none";
      const lifted = `translate(0 ${-t.sideThickness}) ${skin.headTransform}`;
      skin.sideMaskShape.setAttribute("transform", lifted);
      const sx = t.sideLineScaleX, sy = t.sideLineScaleY;
      skin.sideLine.setAttribute("transform", `translate(${t.sideLineX} ${t.sideLineY - t.sideThickness}) translate(${120 * (1 - sx)} ${120 * (1 - sy)}) scale(${sx} ${sy}) ${skin.headTransform}`);
      skin.sideLine.setAttribute("stroke-width", String(t.sideLineWidth / Math.sqrt(sx * sy)));
      skin.sideLine.setAttribute("stroke-linecap", t.sideLineCap);
      if (t.sideLineDash > 0) skin.sideLine.setAttribute("stroke-dasharray", `${t.sideLineDash} ${t.sideLineGap}`);
      else skin.sideLine.removeAttribute("stroke-dasharray");
      softly(skin.sideLine, "skin-sideline-blur", t.sideLineBlur);
      show(skin.sideLine, t.sideLine > 0 && t.sideLineWidth > 0);
      const black = "#000000";
      const tone = t.sideTone ?? t.sideLight ?? 0.45;
      const shade = (color, k) => tone >= 0 ? mixHex(color, white, tone * k) : mixHex(color, black, -tone * k);
      const wall = t.sideColor ? [t.sideColor, t.sideColor, t.sideColor] : [shade(base[0], 1), shade(base[2], 1), shade(base[3], 0.8)];
      replace(
        "skin-side-fill",
        "linearGradient",
        { x1: "0", y1: "0", x2: "1", y2: "0" },
        [[0, wall[0], t.sideOpacity], [0.5, wall[1], t.sideOpacity * 0.93], [1, wall[2], Math.min(1, t.sideOpacity * 1.07)]]
      );
      const lt = t.sideLineTone;
      const lineColor = t.sideLineColor || (lt >= 0 ? mixHex(base[1], white, lt) : mixHex(base[1], mixHex(base[3], black, 0.4), -lt));
      const from = Math.min(t.sideLineFrom, t.sideLineTo), to = Math.max(t.sideLineFrom, t.sideLineTo);
      const fade = Math.min(t.sideLineFade, (to - from) / 2);
      replace(
        "skin-side-line",
        "linearGradient",
        { x1: "0", y1: "0", x2: "0", y2: "1" },
        [[0, lineColor, 0], [from, lineColor, 0], [from + fade, lineColor, t.sideLine], [to - fade, lineColor, t.sideLine], [to, lineColor, 0], [1, lineColor, 0]]
      );
      (_a = defs.querySelector("#skin-sideline-mask")) == null ? void 0 : _a.remove();
      (_b = defs.querySelector("#skin-sideline-mask-grad")) == null ? void 0 : _b.remove();
      skin.sideLine.removeAttribute("mask");
      skin.parts.eyeGlass = replace(
        "skin-eye-glass",
        "linearGradient",
        { x1: "1", y1: "0", x2: "0", y2: "1" },
        [[0, t.eyeColor], [t.eyeLitPart, t.eyeColor], [1, mixHex(t.eyeColor, base[1], t.eyeTint)]]
      );
      skin.style.textContent += `
    #leftBase,#rightBase,#leftInputBase,#rightInputBase{fill-opacity:${t.eyeOpacity};${t.eyeRimWidth > 0 ? `stroke:rgba(255,255,255,${t.eyeRimOpacity});stroke-width:${t.eyeRimWidth}px;` : ""}}`;
      skin.eyePaint.opacity = t.eyeOpacity;
      skin.eyePaint.outline = t.eyeRimWidth > 0 ? { color: "#ffffff", width: t.eyeRimWidth, opacity: t.eyeRimOpacity } : null;
      (_c = defs.querySelector("#skin-eye-sink")) == null ? void 0 : _c.remove();
      const shadowColor = t.shadowColor || mixHex(base[2], base[3], t.shadowDarkness);
      defs.insertAdjacentHTML("beforeend", `<filter id="skin-eye-sink" filterUnits="userSpaceOnUse" x="-90" y="-90" width="180" height="180"><feMorphology in="SourceAlpha" operator="dilate" radius="${t.shadowSpread}" result="m"/><feOffset id="skin-eye-sink-offset" in="m" dx="0" dy="0" result="o"/><feGaussianBlur in="o" stdDeviation="${t.shadowBlur}" result="b"/><feFlood flood-color="${shadowColor}" flood-opacity="${t.shadowOpacity}"/><feComposite in2="b" operator="in" result="s"/><feGaussianBlur in="SourceGraphic" stdDeviation="${t.eyeSoftness}" result="g"/><feMerge><feMergeNode in="s"/><feMergeNode in="g"/></feMerge></filter>`);
      skin.parts.eyeSink = defs.querySelector("#skin-eye-sink-offset");
      skin.fixedShadowAngle = t.shadowFollow ? null : t.shadowAngle;
      skin.shadowDistance = t.shadowDistance;
      const showHighlight = t.eyeHighlight > 0 || t.eyeSpark > 0;
      for (const layer of skin.eyeHighlights) layer.style.display = showHighlight ? "" : "none";
      if (showHighlight) {
        const highlight = replace(
          "skin-eye-hl",
          "radialGradient",
          { gradientUnits: "userSpaceOnUse", cx: t.eyeHighlightX, cy: t.eyeHighlightY, r: t.eyeHighlightSize },
          [[0, white, t.eyeHighlight], [t.eyeHighlightSoft, white, t.eyeHighlight], [1, white, 0]]
        );
        const spark = replace(
          "skin-eye-spark",
          "radialGradient",
          { gradientUnits: "userSpaceOnUse", cx: t.eyeSparkX, cy: t.eyeSparkY, r: t.eyeSparkSize },
          [[0, white, t.eyeSpark], [0.4, white, t.eyeSpark], [1, white, 0]]
        );
        skin.eyeHighlight = { highlight, spark, t };
      }
      const sphere = [t.antennaLight || base[0], t.antennaMid || base[1], t.antennaDark || base[3]];
      skin.parts.antenna = replace(
        "skin-antenna",
        "radialGradient",
        { cx: t.antennaHighlightX, cy: t.antennaHighlightY, r: ".85" },
        [[0, white, t.antennaHighlight], [t.antennaHighlightSize * 0.5, mixHex(sphere[0], white, t.antennaHighlight * 0.6), 1], [t.antennaHighlightSize, sphere[0], 1], [0.5, sphere[1], 1], [1, sphere[2], 1]]
      );
      skin.antennaFixed = !t.antennaFollow;
      skin.style.textContent += `
    #antennaDot{fill:url(#skin-antenna);fill-opacity:${t.antennaOpacity};${t.antennaRimWidth > 0 ? `stroke:${t.antennaRimColor};stroke-width:${t.antennaRimWidth}px;stroke-opacity:${t.antennaRimOpacity};` : "stroke:none;"}${t.antennaSize !== 1 ? `transform-box:fill-box;transform-origin:center;scale:${t.antennaSize};` : ""}}`;
    }
    function mixHex(a, b, t) {
      const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
      return "#" + [0, 1, 2].map((i) => Math.round(channel(a, i) * (1 - t) + channel(b, i) * t).toString(16).padStart(2, "0")).join("");
    }
    function saturation(hex) {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const max = Math.max(...c), min = Math.min(...c);
      return max === 0 ? 0 : (max - min) / max;
    }
    const REST_LIGHT = Object.freeze({ x: -0.5, y: -0.5 });
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    function svg(tag, attributes = {}, parent) {
      const element = document.createElementNS(NS, tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
      parent == null ? void 0 : parent.append(element);
      return element;
    }
    function gradient(parent, tag, id, attributes, stops) {
      const element = svg(tag, { id, ...attributes }, parent);
      for (const [offset, color, opacity = 1] of stops) {
        svg("stop", { offset, "stop-color": color, "stop-opacity": opacity }, element);
      }
      return element;
    }
    function build(instance) {
      const root = instance.shadowRoot;
      const head = root == null ? void 0 : root.getElementById("head");
      const drag = root == null ? void 0 : root.getElementById("dragMotion");
      if (!head || !drag) return null;
      maskEyelids(instance);
      const defs = svg("g", { id: "skinDefs" });
      root.querySelector("defs").append(defs);
      const layers = svg("g", { "pointer-events": "none", "aria-hidden": "true" });
      const shape = { href: "#headShape", transform: head.getAttribute("transform") };
      const pattern = svg("use", { ...shape, fill: "url(#skin-pattern)", "pointer-events": "none" });
      head.after(pattern, layers);
      for (const paint of ["shine", "volume", "edge"]) svg("use", { ...shape, fill: `url(#skin-${paint})` }, layers);
      svg("use", { ...shape, fill: "none", stroke: "url(#skin-rim)", "stroke-width": 1.25 }, layers);
      const ball = svg("g", {}, layers);
      for (const paint of ["ball-shade", "ball-hot"]) svg("use", { ...shape, fill: `url(#skin-${paint})` }, ball);
      const sheen = svg("g", { "clip-path": "url(#headClip)" }, layers);
      const inset = (scale) => `translate(${120 * (1 - scale)} ${120 * (1 - scale)}) scale(${scale}) ${shape.transform}`;
      const glow = svg("use", { href: "#headShape", transform: shape.transform, fill: "url(#skin-sheen-glow)" }, sheen);
      const face = svg("use", { href: "#headShape", transform: shape.transform, fill: "url(#skin-sheen-face)" }, sheen);
      const bevel = svg("g", {}, sheen);
      svg("use", { href: "#headShape", transform: shape.transform, fill: "none", stroke: "url(#skin-sheen-band)", "stroke-width": 26 }, bevel);
      const bevelLine = svg("use", { href: "#headShape", transform: inset(0.865), fill: "none", stroke: "url(#skin-sheen-line)", "stroke-width": 1.6 }, bevel);
      svg("use", { href: "#headShape", transform: inset(0.955), fill: "none", stroke: "url(#skin-sheen-glint)", "stroke-width": 3.2, "stroke-linecap": "round" }, bevel);
      const lifted = `translate(0 -13) ${shape.transform}`;
      const sideMask = svg("mask", { id: "skin-side-mask", maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", x: -20, y: -20, width: 280, height: 280 }, root.querySelector("defs"));
      svg("rect", { x: -20, y: -20, width: 280, height: 280, fill: "#fff" }, sideMask);
      const sideMaskShape = svg("use", { href: "#headShape", transform: lifted, fill: "#000" }, sideMask);
      const side = svg("g", {}, sheen);
      svg("use", { href: "#headShape", transform: shape.transform, fill: "url(#skin-side-fill)", mask: "url(#skin-side-mask)" }, side);
      const sideLine = svg("use", { href: "#headShape", transform: lifted, fill: "none", stroke: "url(#skin-side-line)", "stroke-width": 2.4 }, side);
      const moving = svg("g", {}, sheen);
      const sheenParts = {
        glow,
        face,
        bevel,
        bevelLine,
        side,
        moving,
        top: svg("use", { href: "#headShape", transform: inset(0.9), fill: "url(#skin-sheen-top)" }, moving),
        bottom: svg("use", { href: "#headShape", transform: inset(0.93), fill: "url(#skin-sheen-bottom)" }, moving)
      };
      const style = document.createElement("style");
      root.append(style);
      const eyeGroups = ["left", "right"].map((side2) => root.getElementById(`${side2}Eye`)).filter(Boolean);
      const eyeHighlights = ["left", "right"].map((side2) => {
        const paint = root.querySelector(`[mask="url(#skin-${side2}-lids)"]`);
        const mask = svg("mask", { id: `skin-${side2}-eye-shape`, maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", x: -90, y: -90, width: 180, height: 180, style: "mask-type:alpha" }, root.querySelector("defs"));
        svg("use", { href: `#${side2}Base` }, mask);
        const layer = svg("g", { mask: `url(#skin-${side2}-eye-shape)`, "pointer-events": "none" }, paint);
        svg("rect", { x: -90, y: -90, width: 180, height: 180, fill: "url(#skin-eye-hl)" }, layer);
        svg("rect", { x: -90, y: -90, width: 180, height: 180, fill: "url(#skin-eye-spark)" }, layer);
        layer.style.display = "none";
        return layer;
      });
      const pristine = [pattern, layers, sideMask, ...eyeHighlights].flatMap((node) => [node, ...node.querySelectorAll("*")]).map((node) => [node, [...node.attributes].map(({ name, value }) => [name, value])]);
      return { instance, defs, layers, pattern, ball, sheen, sheenParts, sideMaskShape, sideLine, headTransform: shape.transform, eyeGroups, eyeHighlights, style, pristine, name: null, parts: null, light: { ...REST_LIGHT }, shown: {}, nodes: {}, offsets: {} };
    }
    function restorePristine(skin) {
      for (const [node, attributes] of skin.pristine) {
        for (const name of node.getAttributeNames()) if (!attributes.some(([n]) => n === name)) node.removeAttribute(name);
        for (const [name, value] of attributes) if (node.getAttribute(name) !== value) node.setAttribute(name, value);
      }
    }
    function paintSkin(skin, name) {
      const look = SKINS[name].faithful ? tunedAcrylic(SKINS[name], SKINS[name].fixedTune) : SKINS[name];
      const tune = look.tune;
      joinEyes(skin, false);
      restorePristine(skin);
      skin.defs.replaceChildren();
      const dark = look.ball || look.sheen ? look.base[3] : "#091126";
      const reflect = look.ball ? look.base[0] : look.rim;
      skin.parts = {
        base: gradient(
          skin.defs,
          look.linear ? "linearGradient" : "radialGradient",
          "skin-base",
          look.linear === "vertical" ? { x1: "0", y1: "0", x2: "0", y2: "1" } : look.linear ? { x1: ".05", y1: ".05", x2: ".85", y2: ".98" } : { cx: ".32", cy: ".17", r: ".95" },
          // Faithful acrylic keeps its colour clear right to the edge; the darkest
          // tone is only used for the eye shadow, so the bevel never turns muddy.
          (look.faithful ? [...look.base.slice(0, 3), look.base[2]] : look.base).map((color, index) => [index / 3, color])
        ),
        // A glossy skin narrows the shine into a small, bright specular spot; it is
        // still a fill of the head, so it bends and squashes with it.
        shine: look.spec ? gradient(
          skin.defs,
          "radialGradient",
          "skin-shine",
          { cx: ".30", cy: ".12", r: String(look.spec) },
          [[0, "#fff", 1], [0.22, "#fff", 0.9], [0.5, "#fff", 0.28], [0.78, "#fff", 0.05], [1, "#fff", 0]]
        ) : gradient(
          skin.defs,
          "radialGradient",
          "skin-shine",
          { cx: ".30", cy: ".12", r: ".70" },
          [[0, "#fff", look.shine], [0.23, "#fff", look.shine * 0.3], [0.65, "#fff", 0.035], [1, "#fff", 0]]
        ),
        volume: gradient(
          skin.defs,
          "radialGradient",
          "skin-volume",
          { cx: ".43", cy: ".30", r: ".76" },
          [[0, dark, 0], [0.58, dark, 0], [0.82, dark, look.shade * 0.27], [1, dark, look.shade]]
        ),
        rim: gradient(
          skin.defs,
          "linearGradient",
          "skin-rim",
          { x1: "0", y1: "0", x2: "1", y2: "1" },
          [[0, "#fff", 0.95], [0.28, look.rim, 0.6], [0.52, look.rim, 0.06], [0.82, look.rim, 0.13], [1, look.rim, 0.65]]
        ),
        edge: gradient(
          skin.defs,
          "radialGradient",
          "skin-edge",
          { cx: ".88", cy: ".83", r: ".5" },
          [[0, reflect, look.spec ? 0.7 : 0.5], [0.45, reflect, look.spec ? 0.24 : 0.16], [1, reflect, 0]]
        ),
        antenna: gradient(
          skin.defs,
          "radialGradient",
          "skin-antenna",
          { cx: ".28", cy: ".20", r: ".85" },
          [[0, look.antenna[0]], [0.43, look.antenna[1]], [1, look.antenna[2]]]
        )
      };
      if (look.ball) {
        gradient(
          skin.defs,
          "radialGradient",
          "skin-ball-shade",
          { cx: ".46", cy: ".4", r: ".74" },
          [[0, dark, 0], [0.55, dark, 0], [0.84, dark, 0.2], [1, dark, 0.5]]
        );
        skin.parts.hot = gradient(
          skin.defs,
          "radialGradient",
          "skin-ball-hot",
          { cx: ".32", cy: ".22", r: ".2" },
          [[0, "#ffffff", 0.62], [0.45, "#ffffff", 0.22], [1, "#ffffff", 0]]
        );
      }
      skin.ball.style.display = look.ball ? "" : "none";
      const [shineLayer, , edgeLayer, rimLayer] = skin.layers.children;
      for (const node of [shineLayer, edgeLayer, rimLayer]) node.style.display = look.plain ? "none" : "";
      if (look.plain && skin.parts.hot) skin.ball.lastElementChild.style.display = "none";
      else if (skin.ball.lastElementChild) skin.ball.lastElementChild.style.display = "";
      const sheen = look.sheen ? SHEENS[look.sheen] : null;
      if (sheen) {
        const tinted = saturation(look.base[1]) > 0.35;
        const light = tinted ? mixHex("#ffffff", look.base[0], 0.28) : "#ffffff";
        const topAlpha = look.wet ? 0.62 : look.bright ? 0.5 : sheen.top;
        const bounce = tinted ? mixHex("#ffffff", look.base[0], 0.5) : "#ffffff";
        gradient(
          skin.defs,
          "linearGradient",
          "skin-sheen-top",
          { x1: "0", y1: "0", x2: "0", y2: "1" },
          [[0, light, topAlpha], [sheen.reach * 0.6, light, topAlpha * 0.45], [sheen.reach * 0.93, light, topAlpha * 0.2], [sheen.reach, light, 0], [1, light, 0]]
        );
        gradient(
          skin.defs,
          "linearGradient",
          "skin-sheen-bottom",
          { x1: "0", y1: "0", x2: "0", y2: "1" },
          [[0, bounce, 0], [0.8, bounce, 0], [0.94, bounce, sheen.bottom * 0.6], [1, bounce, sheen.bottom]]
        );
        if (sheen.slab) {
          const edge = look.metal ? "#ffffff" : mixHex("#ffffff", look.base[0], 0.45);
          gradient(skin.defs, "linearGradient", "skin-sheen-band", { x1: "0", y1: "0", x2: "0", y2: "1" }, look.metal ? [[0, "#ffffff", 0.95], [0.07, "#ffffff", 0.7], [0.16, "#ffffff", 0.12], [0.5, "#ffffff", 0], [0.8, look.base[3], 0.2], [0.9, look.base[3], 0.75], [0.955, look.base[3], 0.5], [0.985, "#ffffff", 0.9], [1, "#ffffff", 0.95]] : [[0, edge, 0.55], [0.3, edge, 0.22], [0.7, edge, 0.16], [1, edge, 0.48]]);
          if (look.acrylic) {
            const lit = mixHex("#ffffff", look.base[0], 0.4);
            gradient(
              skin.defs,
              "linearGradient",
              "skin-sheen-band",
              { x1: "0", y1: "0", x2: "0", y2: "1" },
              look.faithful ? [[0, mixHex(look.base[0], "#ffffff", tune.bandLight * 2), tune.bandOpacity * 1.2], [0.06, mixHex(look.base[0], "#ffffff", tune.bandLight), tune.bandOpacity], [0.5, mixHex(look.base[0], "#ffffff", tune.bandLight * 0.8), tune.bandMiddle], [0.94, mixHex(look.base[0], "#ffffff", tune.bandLight), tune.bandOpacity], [1, mixHex(look.base[0], "#ffffff", tune.bandLight * 2), tune.bandOpacity * 1.3]] : look.wet ? [[0, mixHex(look.base[0], "#ffffff", 0.6), 0.75], [0.15, mixHex(look.base[0], "#ffffff", 0.45), 0.55], [0.5, mixHex(look.base[1], "#ffffff", 0.4), 0.45], [0.85, mixHex(look.base[2], "#ffffff", 0.45), 0.55], [1, mixHex(look.base[3], "#ffffff", 0.6), 0.8]] : look.bright ? [[0, "#ffffff", 0.75], [0.1, lit, 0.5], [0.3, lit, 0.22], [0.7, lit, 0.26], [0.9, "#ffffff", 0.75], [1, "#ffffff", 0.95]] : [[0, lit, 0.55], [0.12, lit, 0.25], [0.5, lit, 0.08], [0.8, lit, 0.16], [0.93, lit, 0.7], [1, lit, 0.9]]
            );
            if (look.faithful) {
              gradient(
                skin.defs,
                "radialGradient",
                "skin-sheen-face",
                { cx: String(tune.faceX), cy: String(tune.faceY), r: String(tune.faceSize) },
                [[0, "#ffffff", tune.faceGlow], [1, "#ffffff", 0]]
              );
            } else {
              gradient(
                skin.defs,
                "radialGradient",
                "skin-sheen-face",
                { cx: ".5", cy: ".48", r: ".6" },
                [[0, look.base[3], 0.14], [0.7, look.base[3], 0.05], [1, look.base[3], 0]]
              );
            }
            skin.parts.eyeGlass = gradient(
              skin.defs,
              "linearGradient",
              "skin-eye-glass",
              { x1: "1", y1: "0", x2: "0", y2: "1" },
              look.wet ? [[0, "#ffffff"], [0.3, mixHex("#ffffff", look.base[1], 0.1)], [0.75, mixHex("#ffffff", look.base[1], 0.32)], [1, mixHex("#ffffff", look.base[1], 0.5)]] : look.faithful ? [[0, "#ffffff"], [0.55, "#ffffff"], [1, mixHex("#ffffff", look.base[1], tune.eyeTint)]] : [[0, "#ffffff"], [0.38, "#ffffff"], [0.72, mixHex("#ffffff", look.base[1], 0.25)], [1, mixHex("#ffffff", look.base[1], 0.6)]]
            );
            skin.defs.insertAdjacentHTML("beforeend", `<filter id="skin-soft-edge" filterUnits="userSpaceOnUse" x="-20" y="-20" width="280" height="280"><feGaussianBlur stdDeviation="${look.wet ? 6 : look.faithful ? tune.edgeBlur : look.bright ? 1.1 : 2.6}"/></filter>`);
            skin.defs.insertAdjacentHTML("beforeend", '<filter id="skin-soft-top" filterUnits="userSpaceOnUse" x="-20" y="-20" width="280" height="280"><feGaussianBlur stdDeviation="4"/></filter>');
            skin.defs.insertAdjacentHTML("beforeend", `<filter id="skin-eye-sink" filterUnits="userSpaceOnUse" x="-90" y="-90" width="180" height="180"><feOffset id="skin-eye-sink-offset" in="SourceAlpha" dx="-6" dy="8" result="o"/><feGaussianBlur in="o" stdDeviation="${look.faithful ? tune.shadowBlur : look.wet ? 3 : 6}" result="b"/><feFlood flood-color="${look.faithful ? mixHex(look.base[2], look.base[3], tune.shadowDarkness) : look.base[3]}" flood-opacity="${look.faithful ? tune.shadowOpacity : look.wet ? 0.45 : 0.8}"/><feComposite in2="b" operator="in" result="s"/><feGaussianBlur in="SourceGraphic" stdDeviation="${look.faithful ? tune.eyeSoftness : 0}" result="g"/><feMerge><feMergeNode in="s"/><feMergeNode in="g"/></feMerge></filter>`);
            skin.parts.eyeSink = skin.defs.querySelector("#skin-eye-sink-offset");
          }
          gradient(
            skin.defs,
            "linearGradient",
            "skin-sheen-line",
            { x1: "0", y1: "0", x2: "0", y2: "1" },
            [[0, "#ffffff", 0.55], [0.5, look.faithful ? look.base[2] : look.base[3], 0.25], [1, look.faithful ? mixHex(look.base[0], "#ffffff", 0.5) : "#ffffff", 0.35]]
          );
          gradient(skin.defs, "linearGradient", "skin-sheen-glint", look.wet ? { x1: "0", y1: "0", x2: "1", y2: "1" } : look.faithful ? { x1: "1", y1: "0", x2: "0", y2: "1" } : { x1: "0", y1: "0", x2: "1", y2: "1" }, look.wet ? [[0, "#ffffff", 1], [0.3, "#ffffff", 0.95], [0.44, "#ffffff", 0.5], [0.52, "#ffffff", 0], [0.8, "#ffffff", 0], [0.9, "#ffffff", 0.7], [1, "#ffffff", 0.95]] : look.faithful ? [[0, "#ffffff", 0], [0.05, "#ffffff", tune.glintUpper], [0.3, "#ffffff", tune.glintUpper * 0.9], [0.4, "#ffffff", 0], [0.55, "#ffffff", 0], [0.65, "#ffffff", tune.glintLower], [0.85, "#ffffff", tune.glintLower * 0.85], [0.95, "#ffffff", 0], [1, "#ffffff", 0]] : [[0, "#ffffff", 0], [0.08, "#ffffff", 0.95], [0.3, "#ffffff", 0.9], [0.42, "#ffffff", 0], [0.6, "#ffffff", 0], [0.72, "#ffffff", 0.85], [0.82, "#ffffff", 0], [1, "#ffffff", 0]]);
        }
        const p = skin.sheenParts;
        p.bottom.style.display = sheen.bottom ? "" : "none";
        p.bevel.style.display = sheen.slab ? "" : "none";
        p.bevelLine.style.display = look.acrylic && !look.faithful ? "none" : "";
        p.top.style.display = look.faithful ? "none" : "";
        const [band] = p.bevel.children;
        band.removeAttribute("filter");
        band.setAttribute("stroke-width", String(look.faithful ? tune.bandWidth : 26));
        p.bevel.children[2].setAttribute("stroke-width", String(look.faithful ? tune.glintWidth : 3.2));
        p.bevelLine.setAttribute("opacity", String(look.faithful ? tune.lineOpacity : 1));
        p.top.removeAttribute("filter");
        if (look.acrylic) p.bevel.setAttribute("filter", "url(#skin-soft-edge)");
        else p.bevel.removeAttribute("filter");
        p.glow.style.display = sheen.slab && look.glow ? "" : "none";
        p.face.style.display = sheen.slab && (look.metal || look.acrylic && !look.bright) ? "" : "none";
        p.side.style.display = "none";
      }
      skin.sheen.style.display = sheen ? "" : "none";
      skin.shadowDistance = look.faithful ? tune.shadowDistance : 8;
      if (look.pattern) skin.defs.insertAdjacentHTML("beforeend", patternMarkup("skin-pattern", look.pattern));
      skin.pattern.style.display = look.pattern ? "" : "none";
      skin.shown = {};
      skin.nodes = {};
      skin.offsets = {};
      const ring = look.ring ? `stroke:${look.ring};stroke-width:3px;` : "";
      for (const group of skin.eyeGroups) {
        if (look.acrylic) group.setAttribute("filter", "url(#skin-eye-sink)");
        else group.removeAttribute("filter");
      }
      skin.tunedBase = false;
      skin.fixedShadowAngle = null;
      skin.glintFollow = 0;
      skin.lineFollow = false;
      skin.antennaFixed = false;
      skin.eyeHighlight = null;
      for (const layer of skin.eyeHighlights) layer.style.display = "none";
      skin.eyePaint = {
        gradient: look.acrylic,
        color: look.eye,
        opacity: look.wet ? 0.8 : 1,
        outline: look.ring ? { color: look.ring, width: 3, opacity: 1 } : look.wet ? { color: "#ffffff", width: 1.6, opacity: 0.95 } : null
      };
      skin.style.textContent = `
    #leftBase,#rightBase,#leftInputBase,#rightInputBase{fill:${look.acrylic ? "url(#skin-eye-glass)" : look.eye};${ring}${look.wet ? "fill-opacity:.8;stroke:rgba(255,255,255,.95);stroke-width:1.6px;" : ""}}
    #antennaDot{fill:url(#skin-antenna);${look.plain ? "" : `stroke:${look.rim};stroke-width:.7px`}}`;
      if (look.faithful) applyAcrylicTuning(skin, look);
    }
    function set(skin, node, key, attribute, value) {
      const id = `${key}.${attribute}`;
      skin.nodes[id] = node;
      const text = (value + (skin.offsets[id] || 0)).toFixed(3);
      if (skin.shown[id] === text) return;
      skin.shown[id] = text;
      node.setAttribute(attribute, text);
    }
    function applyLight(skin, x, y) {
      const { parts } = skin;
      const cx = 0.5 + x * 0.3;
      const cy = 0.3 + y * 0.17;
      if (!SKINS[skin.name].linear && !skin.tunedBase) {
        set(skin, parts.base, "base", "cx", cx);
        set(skin, parts.base, "base", "cy", cy);
      }
      set(skin, parts.shine, "shine", "cx", cx);
      set(skin, parts.shine, "shine", "cy", cy - 0.1);
      set(skin, parts.volume, "volume", "cx", 0.5 + x * 0.12);
      set(skin, parts.volume, "volume", "cy", 0.35 + y * 0.08);
      set(skin, parts.edge, "edge", "cx", 0.5 - x * 0.42);
      set(skin, parts.edge, "edge", "cy", 0.75 - y * 0.12);
      set(skin, parts.rim, "rim", "x1", 0.5 + x * 0.5);
      set(skin, parts.rim, "rim", "x2", 0.5 - x * 0.5);
      if (!skin.antennaFixed) {
        set(skin, parts.antenna, "antenna", "cx", cx);
        set(skin, parts.antenna, "antenna", "cy", Math.max(0.1, cy));
      }
      if (parts.eyeGlass) {
        const len = Math.hypot(x, y) || 1;
        const fixed = skin.fixedShadowAngle;
        const ux = fixed == null ? x / len : -Math.cos(fixed * Math.PI / 180);
        const uy = fixed == null ? y / len : -Math.sin(fixed * Math.PI / 180);
        set(skin, parts.eyeGlass, "eyeGlass", "x1", 0.5 + ux * 0.5);
        set(skin, parts.eyeGlass, "eyeGlass", "y1", 0.5 + uy * 0.5);
        set(skin, parts.eyeGlass, "eyeGlass", "x2", 0.5 - ux * 0.5);
        set(skin, parts.eyeGlass, "eyeGlass", "y2", 0.5 - uy * 0.5);
        if (parts.eyeSink) {
          set(skin, parts.eyeSink, "eyeSink", "dx", -ux * (skin.shadowDistance ?? 8));
          set(skin, parts.eyeSink, "eyeSink", "dy", -uy * (skin.shadowDistance ?? 8));
        }
      }
      if (skin.eyeHighlight) {
        const { highlight, spark, t } = skin.eyeHighlight;
        const dx = (x - REST_LIGHT.x) * t.eyeHighlightFollow, dy = (y - REST_LIGHT.y) * t.eyeHighlightFollow;
        set(skin, highlight, "eyeHl", "cx", t.eyeHighlightX + dx);
        set(skin, highlight, "eyeHl", "cy", t.eyeHighlightY + dy);
        set(skin, spark, "eyeSpark", "cx", t.eyeSparkX - dx);
        set(skin, spark, "eyeSpark", "cy", t.eyeSparkY - dy);
      }
      if (SKINS[skin.name].sheen) {
        const t = `translate(${((x - REST_LIGHT.x) * 7).toFixed(2)} ${((y - REST_LIGHT.y) * 4).toFixed(2)})`;
        if (skin.shown.sheen !== t) {
          skin.shown.sheen = t;
          skin.sheenParts.moving.setAttribute("transform", t);
        }
      }
      if (parts.hot) {
        set(skin, parts.hot, "hot", "cx", cx);
        set(skin, parts.hot, "hot", "cy", cy - 0.1);
      }
    }
    function showNative(instance, name) {
      if (!name && !instance._nativeSkin) return null;
      if (!instance._nativeSkin) instance._nativeSkin = build(instance);
      const skin = instance._nativeSkin;
      if (!skin || skin.name === name) return skin;
      skin.name = name;
      const head = instance._head;
      if (name) {
        paintSkin(skin, name);
        head.setAttribute("fill", "url(#skin-base)");
        skin.layers.style.display = "";
        applyLight(skin, skin.light.x, skin.light.y);
      } else {
        joinEyes(skin, false);
        skin.style.textContent = "";
        for (const group of skin.eyeGroups) group.removeAttribute("filter");
        for (const layer of skin.eyeHighlights) layer.style.display = "none";
        skin.eyeHighlight = null;
        skin.layers.style.display = "none";
        skin.pattern.style.display = "none";
        baseApplyColor.call(instance, instance.getAttribute("color"));
      }
      return skin;
    }
    function eyeBox(eye, parent) {
      const box = eye.getBBox();
      const m = parent.getCTM().inverse().multiply(eye.getCTM());
      const xs = [], ys = [];
      for (const [x, y] of [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]) {
        xs.push(m.a * x + m.c * y + m.e);
        ys.push(m.b * x + m.d * y + m.f);
      }
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
    function joinedSurface(skin) {
      if (skin.joined) return skin.joined;
      const root = skin.instance.shadowRoot;
      const defs = root.querySelector("defs");
      const parent = skin.eyeGroups[0].parentElement;
      const mask = svg("mask", { id: "skin-joined-eyes", maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", x: 0, y: 0, width: 240, height: 240, style: "mask-type:alpha" }, defs);
      for (const side of ["left", "right"]) svg("use", { href: `#${side}Eye` }, mask);
      const outline = svg("filter", { id: "skin-joined-outline", x: "-20%", y: "-20%", width: "140%", height: "140%" }, defs);
      const dilate = svg("feMorphology", { in: "SourceAlpha", operator: "dilate", radius: 1, result: "grown" }, outline);
      const flood = svg("feFlood", {}, outline);
      svg("feComposite", { in2: "grown", operator: "in" }, outline);
      const gradientNode = svg("linearGradient", { id: "skin-eye-joined", gradientUnits: "userSpaceOnUse" }, defs);
      const group = svg("g", { "pointer-events": "none", "aria-hidden": "true", "clip-path": parent.getAttribute("clip-path") || "none" });
      parent.after(group);
      const ring = svg("g", { filter: "url(#skin-joined-outline)" }, group);
      for (const side of ["left", "right"]) svg("use", { href: `#${side}Eye` }, ring);
      const surface = svg("g", {}, group);
      const paint = svg("rect", { x: 0, y: 0, width: 240, height: 240, mask: "url(#skin-joined-eyes)" }, surface);
      group.style.display = "none";
      skin.joined = { parent, group, ring, surface, paint, gradient: gradientNode, dilate, flood, on: false, opacity: parent.style.opacity };
      return skin.joined;
    }
    function joinEyes(skin, on) {
      var _a, _b;
      const joined = on ? joinedSurface(skin) : skin.joined;
      if (!joined || joined.on === on) return;
      joined.on = on;
      joined.parent.style.opacity = on ? "0" : joined.opacity;
      joined.group.style.display = on ? "" : "none";
      for (const group of skin.eyeGroups) {
        if (on) {
          skin.eyeFilter = group.getAttribute("filter");
          group.removeAttribute("filter");
        } else if (skin.eyeFilter) group.setAttribute("filter", skin.eyeFilter);
      }
      if (!on) {
        skin.eyeFilter = null;
        return;
      }
      const paint = skin.eyePaint || { color: "#ffffff", opacity: 1, outline: null };
      const root = skin.instance.shadowRoot;
      (_a = root.getElementById("skin-eye-sink-joined")) == null ? void 0 : _a.remove();
      joined.offset = null;
      const source = skin.eyeFilter && root.getElementById("skin-eye-sink");
      if (source) {
        const copy = source.cloneNode(true);
        copy.id = "skin-eye-sink-joined";
        for (const [name, value] of [["x", 0], ["y", 0], ["width", 240], ["height", 240]]) copy.setAttribute(name, value);
        joined.offset = copy.querySelector("#skin-eye-sink-offset");
        (_b = joined.offset) == null ? void 0 : _b.removeAttribute("id");
        source.after(copy);
        joined.surface.setAttribute("filter", "url(#skin-eye-sink-joined)");
      } else joined.surface.removeAttribute("filter");
      if (paint.gradient) {
        const source2 = skin.instance.shadowRoot.getElementById("skin-eye-glass");
        joined.gradient.replaceChildren(...[...(source2 == null ? void 0 : source2.children) || []].map((stop) => stop.cloneNode()));
        joined.paint.setAttribute("fill", "url(#skin-eye-joined)");
      } else joined.paint.setAttribute("fill", paint.color);
      joined.paint.setAttribute("fill-opacity", String(paint.opacity));
      joined.ring.style.display = paint.outline ? "" : "none";
      if (paint.outline) {
        joined.dilate.setAttribute("radius", String(paint.outline.width / 2));
        joined.flood.setAttribute("flood-color", paint.outline.color);
        joined.flood.setAttribute("flood-opacity", String(paint.outline.opacity));
      }
    }
    function separateNativeEyes(instance) {
      if (instance._nativeSkin) joinEyes(instance._nativeSkin, false);
    }
    function joinNativeEyes(instance) {
      var _a;
      const skin = instance._nativeSkin;
      if (!(skin == null ? void 0 : skin.name)) return;
      const [left, right] = skin.eyeGroups;
      if (!left || !right || !(instance._eyesAsOne ? instance._eyesAsOne() : instance._loveFx)) {
        joinEyes(skin, false);
        return;
      }
      const parent = left.parentElement;
      const a = eyeBox(left, parent), b = eyeBox(right, parent);
      const overlap = a.x1 > b.x0 && b.x1 > a.x0 && a.y1 > b.y0 && b.y1 > a.y0;
      joinEyes(skin, overlap);
      if (!overlap) return;
      const x0 = Math.min(a.x0, b.x0), y0 = Math.min(a.y0, b.y0), x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
      const offset = skin.joined.offset, live = (_a = skin.parts) == null ? void 0 : _a.eyeSink;
      if (offset && live) for (const name of ["dx", "dy"]) offset.setAttribute(name, live.getAttribute(name));
      const g = skin.joined.gradient;
      g.setAttribute("x1", x1.toFixed(2));
      g.setAttribute("y1", y0.toFixed(2));
      g.setAttribute("x2", x0.toFixed(2));
      g.setAttribute("y2", y1.toFixed(2));
    }
    function lightNative(instance, x, y) {
      const skin = instance._nativeSkin;
      if (!(skin == null ? void 0 : skin.name)) return;
      skin.light.x = x;
      skin.light.y = y;
      applyLight(skin, x, y);
    }
    exports.showNative = showNative;
    exports.separateNativeEyes = separateNativeEyes;
    exports.joinNativeEyes = joinNativeEyes;
    exports.lightNative = lightNative;
    exports.NATIVE_SKINS = SKINS;
  });
  __define("src/skins/material-data.js", function(__require2, __import2, exports) {
    const MATERIALS = {
      "blackglaze": { "rim": "#dce5ee", "antenna": ["#d9e3ed", "#4a596a", "#101923"], "pattern": "blackglaze", "simpleLayers": true, "darkColor": "#090d14", "raisedEyes": true, "eyeShadow": "#090d14" },
      "blueglaze": { "rim": "#b5daef", "antenna": ["#e9faff", "#58abe9", "#2b52b3"], "pattern": "blueglaze", "simpleLayers": true, "darkColor": "#253bb9", "raisedEyes": true },
      "jadeglaze": { "rim": "#ddfff0", "antenna": ["#effff6", "#50c99f", "#126b57"], "pattern": "jadeglaze", "simpleLayers": true, "darkColor": "#086953", "raisedEyes": true, "eyeShadow": "#086953" },
      "berryglaze": { "rim": "#fff0f7", "antenna": ["#fff1f8", "#ed8cba", "#a53169"], "pattern": "berryglaze", "simpleLayers": true, "darkColor": "#9e285f", "raisedEyes": true, "eyeShadow": "#9e285f" },
      "amberglaze": { "rim": "#fff3dc", "antenna": ["#fff7dc", "#f2b85e", "#ad5e27"], "pattern": "amberglaze", "simpleLayers": true, "darkColor": "#ae531b", "raisedEyes": true, "eyeShadow": "#ae531b" },
      "irisglaze": { "rim": "#f4edff", "antenna": ["#f7efff", "#b18bed", "#6440ac"], "pattern": "irisglaze", "simpleLayers": true, "darkColor": "#5831a8", "raisedEyes": true, "eyeShadow": "#5831a8" },
      "iceglaze": { "rim": "#d8e5f3", "antenna": ["#ffffff", "#c3dbef", "#7d9fc2"], "pattern": "iceglaze", "simpleLayers": true, "darkColor": "#94afd0", "raisedEyes": true },
      "mintice": { "rim": "#f5fff9", "antenna": ["#ffffff", "#c4e6d7", "#7fae9c"], "pattern": "mintice", "simpleLayers": true, "darkColor": "#8bbcae", "raisedEyes": true, "eyeShadow": "#8bbcae" },
      "blushice": { "rim": "#fff8fc", "antenna": ["#ffffff", "#e8c9d9", "#b28b9f"], "pattern": "blushice", "simpleLayers": true, "darkColor": "#c093ab", "raisedEyes": true, "eyeShadow": "#c093ab" },
      "champagneice": { "rim": "#fffaf0", "antenna": ["#ffffff", "#e7d8b9", "#b4a078"], "pattern": "champagneice", "simpleLayers": true, "darkColor": "#c2ac81", "raisedEyes": true, "eyeShadow": "#c2ac81" },
      "lavenderice": { "rim": "#fbf8ff", "antenna": ["#ffffff", "#d8ceeb", "#9f91bd"], "pattern": "lavenderice", "simpleLayers": true, "darkColor": "#a89ac9", "raisedEyes": true, "eyeShadow": "#a89ac9" },
      "whiteice": { "rim": "#ffffff", "antenna": ["#ffffff", "#e7f2f7", "#abbfc9"], "pattern": "whiteice", "simpleLayers": true, "darkColor": "#c0cdd6", "raisedEyes": true, "eyeShadow": "#c0cdd6" },
      "clearwhite": { "base": ["#ffffff", "#eff5f7", "#d8e4ea", "#b3c5d0"], "eye": "#283c49", "rim": "#e9eff2", "shine": 0.1, "shade": 0.18, "antenna": ["#ffffff", "#e0ebf0", "#9bb2c1"], "pattern": "clearsilver", "translucent": true, "glassTint": "#e4f0f7", "glassRim": "#edf7ff" },
      "clearsilver": { "base": ["#fcfaf6", "#d3dbdf", "#98a6ae", "#66767f"], "eye": "#283c49", "rim": "#e9eff2", "shine": 0.1, "shade": 0.18, "antenna": ["#f5fbff", "#b9cbd4", "#607b8b"], "pattern": "clearsilver", "translucent": true, "glassTint": "#e4f0f7", "glassRim": "#edf7ff" },
      "clearweighted": { "base": ["#fcfaf6", "#d3dbdf", "#98a6ae", "#66767f"], "eye": "#283c49", "rim": "#e9eff2", "shine": 0.1, "shade": 0.18, "antenna": ["#f5fbff", "#b9cbd4", "#607b8b"], "pattern": "clearweighted", "translucent": true, "glassTint": "#e4f0f7", "glassRim": "#edf7ff" },
      "clearhard": { "base": ["#fcfaf6", "#d3dbdf", "#98a6ae", "#66767f"], "eye": "#283c49", "rim": "#e9eff2", "shine": 0.035, "shade": 0.18, "antenna": ["#f5fbff", "#b9cbd4", "#607b8b"], "pattern": "clearhard", "translucent": true, "glassTint": "#e4f0f7", "glassRim": "#edf7ff" },
      "clearsmoke": { "base": ["#dce5e9", "#abbac3", "#778e9d", "#485f70"], "eye": "#283c49", "rim": "#e9eff2", "shine": 0.1, "shade": 0.18, "antenna": ["#e8f2f8", "#9ab1c0", "#4e697c"], "pattern": "clearsilver", "translucent": true, "glassTint": "#e4f0f7", "glassRim": "#edf7ff" },
      "clearink": { "base": ["#bacbd6", "#7e97a8", "#4b687e", "#2a4257"], "eye": "#283c49", "rim": "#e9eff2", "shine": 0.1, "shade": 0.18, "antenna": ["#cedfe9", "#7895aa", "#314f65"], "pattern": "clearsilver", "translucent": true, "glassTint": "#e4f0f7", "glassRim": "#edf7ff" },
      "golddrop": { "base": ["#fcfbf6", "#f0e4c5", "#dcc37d", "#c69f35"], "eye": "#594818", "rim": "#f8f2e3", "shine": 0.12, "shade": 0.26, "antenna": ["#fefefc", "#e7d5a3", "#b3902f"], "pattern": "silverdrop" },
      "deepmetalgold": { "base": ["#f6e1b8", "#d4a446", "#a57009", "#704a00"], "eye": "#f2f7fa", "rim": "#efd093", "shine": 0.1, "shade": 0.29, "antenna": ["#fbefd7", "#cd9b3a", "#7b5100"], "pattern": "silverdrop" },
      "deepmetalrose": { "base": ["#fcdcd9", "#e19991", "#b3645b", "#833f38"], "eye": "#f2f7fa", "rim": "#f7c8c3", "shine": 0.1, "shade": 0.29, "antenna": ["#feecea", "#db9087", "#8d463e"], "pattern": "silverdrop" },
      "copperdeep": { "base": ["#f0ded4", "#d29c7e", "#ac663d", "#734428"], "eye": "#faf5f2", "rim": "#e8ccbc", "shine": 0.1, "shade": 0.29, "antenna": ["#f7eee8", "#cd9371", "#7c492c"], "pattern": "silverdrop" },
      "deepmetalcopper": { "base": ["#ffddc9", "#ec9969", "#c0652f", "#8d4012"], "eye": "#f2f7fa", "rim": "#fec9a9", "shine": 0.1, "shade": 0.29, "antenna": ["#ffede2", "#e7905d", "#984617"], "pattern": "silverdrop" },
      "iphonecosmicorange": { "base": ["#ffdecc", "#ff9962", "#e3611c", "#ae3d01"], "eye": "#f2f7fa", "rim": "#ffcaae", "shine": 0.1, "shade": 0.29, "antenna": ["#ffede4", "#ff8e52", "#b94405"], "pattern": "silverdrop" },
      "deepmetalbronze": { "base": ["#e8e5bc", "#b5ac51", "#827a14", "#585100"], "eye": "#f2f7fa", "rim": "#dad59a", "shine": 0.1, "shade": 0.29, "antenna": ["#f3f1da", "#aca444", "#615900"], "pattern": "silverdrop" },
      "deepmetaltitanium": { "base": ["#dbe4ee", "#97aac2", "#627791", "#3d4f66"], "eye": "#f2f7fa", "rim": "#c7d3e3", "shine": 0.1, "shade": 0.29, "antenna": ["#ebf0f6", "#8ea1bb", "#44576e"], "pattern": "silverdrop" },
      "deepmetalplatinum": { "base": ["#eff0f2", "#cacdd2", "#a5aab0", "#848990"], "eye": "#43515c", "rim": "#e5e7e9", "shine": 0.1, "shade": 0.29, "antenna": ["#f6f7f8", "#c4c8cd", "#8b9097"], "pattern": "silverdrop" },
      "deepmetalchampagne": { "base": ["#f1eadc", "#cebb97", "#a78f61", "#816a3c"], "eye": "#795b36", "rim": "#e8ddc7", "shine": 0.1, "shade": 0.29, "antenna": ["#f8f4ec", "#c8b48d", "#897143"], "pattern": "silverdrop" },
      "deepmetaliceblue": { "base": ["#d4ecf8", "#86bfdc", "#4d92b6", "#2a6b8d"], "eye": "#275772", "rim": "#bddff2", "shine": 0.1, "shade": 0.29, "antenna": ["#e8f5fb", "#7bb8d7", "#307395"], "pattern": "silverdrop" },
      "iphoneultramarine": { "base": ["#dae0ff", "#8ea0ff", "#576bd6", "#34459c"], "eye": "#f2f7fa", "rim": "#c4ceff", "shine": 0.1, "shade": 0.29, "antenna": ["#ebeeff", "#8397fe", "#3a4ca8"], "pattern": "silverdrop" },
      "deepmetalviolet": { "base": ["#efd8ff", "#ce88ff", "#9e4fd5", "#6c2e98"], "eye": "#f2f7fa", "rim": "#e5c1ff", "shine": 0.1, "shade": 0.29, "antenna": ["#f6eaff", "#c97cff", "#7633a5"], "pattern": "silverdrop" },
      "iphoneburgundy": { "base": ["#fbbfd3", "#be5f7e", "#702b42", "#38131f"], "eye": "#f2f7fa", "rim": "#f09fba", "shine": 0.1, "shade": 0.29, "antenna": ["#ffdbe7", "#b25473", "#421725"], "pattern": "silverdrop" },
      "iphoneteal": { "base": ["#cdeae9", "#76bab7", "#3d8986", "#1d605e"], "eye": "#f2f7fa", "rim": "#b2dddc", "shine": 0.1, "shade": 0.29, "antenna": ["#e3f4f3", "#6bb2af", "#226865"], "pattern": "silverdrop" },
      "deepmetalforest": { "base": ["#bad4ca", "#588272", "#26453a", "#10221b"], "eye": "#f2f7fa", "rim": "#99bcaf", "shine": 0.1, "shade": 0.29, "antenna": ["#d8e8e2", "#4e7767", "#142820"], "pattern": "silverdrop" },
      "iphonenatural": { "base": ["#eceae7", "#c1bcb4", "#969085", "#716b60"], "eye": "#59534b", "rim": "#e0ddd8", "shine": 0.1, "shade": 0.29, "antenna": ["#f5f4f2", "#bab5ac", "#787268"], "pattern": "silverdrop" },
      "iphonedeepurple": { "base": ["#d7ccdc", "#86748f", "#4a3c50", "#251d28"], "eye": "#f2f7fa", "rim": "#bfb1c7", "shine": 0.1, "shade": 0.29, "antenna": ["#e9e3ed", "#7b6a84", "#2b222f"], "pattern": "silverdrop" },
      "iphonepink": { "base": ["#f8eff1", "#e5ccd1", "#cda8b0", "#b28890"], "eye": "#804d61", "rim": "#f3e6e8", "shine": 0.1, "shade": 0.29, "antenna": ["#fbf7f8", "#e1c6cc", "#b88e97"], "pattern": "silverdrop" },
      "iphonesage": { "base": ["#e8ece4", "#b8c2ac", "#8b987b", "#667357"], "eye": "#4b6041", "rim": "#dbe1d4", "shine": 0.1, "shade": 0.29, "antenna": ["#f3f5f0", "#b1bba4", "#6d7a5e"], "pattern": "silverdrop" },
      "iphonelavender": { "base": ["#eeebf6", "#c8bfdb", "#a095ba", "#7d7198"], "eye": "#61517d", "rim": "#e4dfef", "shine": 0.1, "shade": 0.29, "antenna": ["#f6f4fa", "#c2b8d6", "#84789f"], "pattern": "silverdrop" },
      "satinplatinum": { "base": ["#bcc0c4", "#7e868e", "#5b6269", "#44494e"], "eye": "#fcfaf3", "rim": "#bec2c6", "shine": 0.08, "shade": 0.32, "antenna": ["#dbdddf", "#838b93", "#50565c"], "pattern": "silverdrop" },
      "satinrose": { "base": ["#d5aca1", "#ac604d", "#774235", "#512d24"], "eye": "#fcfaf3", "rim": "#d6aea4", "shine": 0.08, "shade": 0.32, "antenna": ["#e8d2cd", "#b16552", "#64382d"], "pattern": "silverdrop" },
      "satinredcopper": { "base": ["#dba483", "#a65c30", "#6a3a1f", "#412413"], "eye": "#fcfaf3", "rim": "#dca687", "shine": 0.08, "shade": 0.32, "antenna": ["#ebcdbb", "#af6033", "#552f19"], "pattern": "silverdrop" },
      "satinbronze": { "base": ["#c6b680", "#7f6f39", "#4d4322", "#2d2714"], "eye": "#fcfaf3", "rim": "#c7b783", "shine": 0.08, "shade": 0.32, "antenna": ["#dfd6b8", "#87753c", "#3c341b"], "pattern": "silverdrop" },
      "satingunmetal": { "base": ["#7a8a9b", "#353e46", "#1a1e22", "#0c0e10"], "eye": "#fcfaf3", "rim": "#7d8d9d", "shine": 0.08, "shade": 0.32, "antenna": ["#b2bcc5", "#3a434c", "#121518"], "pattern": "silverdrop" },
      "silverbright": { "base": ["#ffffff", "#f0f3f3", "#d5dee2", "#a5b5bf"], "eye": "#283c49", "rim": "#e9eff2", "shine": 0.16, "shade": 0.17, "antenna": ["#ffffff", "#e1e9ed", "#95a8b3"], "pattern": "silverdrop" },
      "silverdrop": { "base": ["#fcfaf6", "#d5dde0", "#a3afb6", "#71818a"], "eye": "#283c49", "rim": "#e9eff2", "shine": 0.12, "shade": 0.26, "antenna": ["#fbfdff", "#bcc8ce", "#63757f"], "pattern": "silverdrop" },
      "silverdeep": { "base": ["#dce4e8", "#9baab4", "#657784", "#3d505e"], "eye": "#f2f7fa", "rim": "#c7d4dd", "shine": 0.1, "shade": 0.29, "antenna": ["#e9f1f6", "#8fa2af", "#425866"], "pattern": "silverdrop" },
      "silvergraphite": { "base": ["#aabac5", "#647987", "#3b505f", "#213440"], "eye": "#f3f8fc", "rim": "#a8bccb", "shine": 0.08, "shade": 0.32, "antenna": ["#ccdbe5", "#667f90", "#2b4252"], "pattern": "silverdrop" },
      "obsidian": { "base": ["#7b8796", "#313a47", "#101722", "#05080e"], "eye": "#f0f7ff", "rim": "#c1d5f4", "shine": 0.57, "shade": 0.68, "antenna": ["#c3cfdf", "#384452", "#080e19"] },
      "porcelain": { "base": ["#ffffff", "#f5f4ec", "#d9dad3", "#a3aaab"], "eye": "#343b3c", "rim": "#ffffff", "shine": 0.95, "shade": 0.18, "antenna": ["#ffffff", "#e7e9df", "#a6afb0"] },
      "clay": { "base": ["#e6b59a", "#d9997d", "#c58065", "#ad674e"], "eye": "#573c34", "rim": "#edc6ae", "shine": 0.12, "shade": 0.22, "antenna": ["#e8bca1", "#cb8b6f", "#a96650"], "pattern": "grain", "matte": true },
      "terrazzo": { "base": ["#fff9ed", "#f1e7d7", "#e1d3c1", "#cab9a8"], "eye": "#635146", "rim": "#fff7e8", "shine": 0.18, "shade": 0.22, "matte": true, "pattern": "terrazzo", "antenna": ["#fff5e3", "#e4ceb2", "#b5987f"] },
      "ceramicblue": { "base": ["#fffaf0", "#eee5d3", "#d5c5aa", "#b5a58b"], "eye": "#615246", "rim": "#fff9e6", "shine": 0.7, "shade": 0.25, "antenna": ["#fff9e6", "#eee5d3", "#b5a58b"], "pattern": "ceramicblue" },
      "woodmaple": { "base": ["#f7e8ca", "#e4c999", "#c9a575", "#a87d50"], "eye": "#62492d", "rim": "#f3e0b8", "shine": 0.075, "shade": 0.12, "antenna": ["#fff1d2", "#d7b585", "#997146"], "pattern": "woodmaple", "matte": true },
      "woodoak": { "base": ["#efd3a0", "#cea065", "#ad7844", "#82532e"], "eye": "#503522", "rim": "#e7c594", "shine": 0.085, "shade": 0.16, "antenna": ["#f6dfb4", "#c99b60", "#84552f"], "pattern": "woodoak", "matte": true },
      "woodwalnut": { "base": ["#b58d67", "#865b3c", "#5e3b28", "#38251c"], "eye": "#f5e7cc", "rim": "#c9a27c", "shine": 0.11, "shade": 0.2, "antenna": ["#d9b28b", "#8b6143", "#432d21"], "pattern": "woodwalnut", "matte": true },
      "woodrose": { "base": ["#cf9376", "#a65d42", "#773d2c", "#48251e"], "eye": "#f8e8d2", "rim": "#d9a48a", "shine": 0.15, "shade": 0.19, "antenna": ["#e2b39a", "#aa674b", "#582d23"], "pattern": "woodrose", "matte": true },
      "woodebony": { "base": ["#696052", "#42382d", "#2a221c", "#171411"], "eye": "#f2e7d2", "rim": "#8c7a60", "shine": 0.12, "shade": 0.23, "antenna": ["#b0a08a", "#554636", "#241c17"], "pattern": "woodebony", "matte": true },
      "cork": { "base": ["#e8cb99", "#cfad76", "#b99159", "#9c7646"], "eye": "#604831", "rim": "#efdab6", "shine": 0.1, "shade": 0.25, "antenna": ["#efdab6", "#cfad76", "#9c7646"], "pattern": "cork" },
      "basketball": { "base": ["#ffbd63", "#ed8836", "#d26320", "#93421c"], "eye": "#fff4d9", "rim": "#ffd29a", "shine": 0.16, "shade": 0.32, "antenna": ["#ffd29a", "#ed8836", "#93421c"], "pattern": "basketball", "matte": true },
      "baseball": { "base": ["#fffdf4", "#f3eee0", "#e2dccb", "#bfb7a4"], "eye": "#364e65", "rim": "#fffdf0", "shine": 0.2, "shade": 0.24, "antenna": ["#fffdf0", "#f3eee0", "#bfb7a4"], "pattern": "baseball", "matte": true },
      "aurora": { "base": ["#9aebea", "#92c9f1", "#a795eb", "#e79bc7"], "eye": "#2d3052", "rim": "#fff4fe", "shine": 0.82, "shade": 0.3, "antenna": ["#edffff", "#9ba7ec", "#7456a5"] },
      "pearl": { "base": ["#fff8eb", "#ecd8e6", "#c6ddd8", "#b5afcf"], "eye": "#615e79", "rim": "#fff6e8", "shine": 0.82, "shade": 0.25, "antenna": ["#fff6e8", "#ecd8e6", "#b5afcf"], "pattern": "pearl" },
      "hologram": { "base": ["#88e9df", "#c5b6f5", "#f6b8d0", "#f5ebad", "#9adce0"], "eye": "#393e75", "rim": "#f5ffff", "shine": 0.7, "shade": 0.25, "antenna": ["#f5ffff", "#c5b6f5", "#9adce0"], "pattern": "hologram", "linear": true },
      "ice": { "base": ["#f0ffff", "#b6e9f2", "#71b9d4", "#437baf"], "eye": "#214f7d", "rim": "#efffff", "shine": 0.8, "shade": 0.25, "antenna": ["#efffff", "#b6e9f2", "#437baf"], "pattern": "ice", "translucent": true },
      "soap": { "base": ["#f9eafa", "#bfe6ed", "#ded1f0", "#bad9e6"], "eye": "#635077", "rim": "#fff4fa", "shine": 0.92, "shade": 0.13, "antenna": ["#fff4fa", "#bfe6ed", "#bad9e6"], "pattern": "soap", "translucent": true },
      "denim": { "base": ["#558aaf", "#18517c", "#003f66", "#07233b"], "eye": "#d6e8ff", "rim": "#022b4b", "shine": 0.04, "shade": 0.22, "matte": true, "pattern": "denim", "stitched": true, "stitch": { "color": "#e4a358", "width": 6.6, "dash": "16.5 15.5", "inset": 0.82, "opacity": 1 }, "antenna": ["#ffecb8", "#7e5d30", "#503816"] },
      "leather": { "base": ["#c79665", "#ab784c", "#8f5d38", "#6a432b"], "eye": "#ffedd0", "rim": "#e8c095", "shine": 0.16, "shade": 0.25, "antenna": ["#e8c095", "#ab784c", "#6a432b"], "pattern": "leather", "stitched": true, "matte": true },
      "knit": { "base": ["#d5a4b6", "#b5809b", "#925d7c", "#70465f"], "eye": "#fff2da", "rim": "#ebc9d2", "shine": 0.06, "shade": 0.22, "antenna": ["#ebc9d2", "#b67e95", "#79435f"], "pattern": "second-knit", "matte": true },
      "lace": { "base": ["#4d526f", "#353a57", "#252b46", "#1c2138"], "eye": "#fff0d6", "rim": "#d6d5df", "shine": 0.15, "shade": 0.25, "antenna": ["#d6d5df", "#353a57", "#1c2138"], "pattern": "lace", "matte": true },
      "tartan": { "base": ["#ffbcc7", "#ef899e", "#d86383", "#b34364"], "eye": "#fff0cb", "rim": "#ffe5df", "shine": 0.08, "shade": 0.25, "antenna": ["#ffe5df", "#ef899e", "#b34364"], "matte": true, "pattern": "tartan" },
      "argyle": { "base": ["#e4d6ef", "#bcabd5", "#9a88bc", "#776397"], "eye": "#4e4168", "rim": "#fff0fe", "shine": 0.1, "shade": 0.25, "antenna": ["#fff0fe", "#bcabd5", "#776397"], "matte": true, "pattern": "argyle" },
      "sashiko": { "base": ["#546b8b", "#394f71", "#273b5b", "#1a2a43"], "eye": "#fff1cf", "rim": "#bccfe1", "shine": 0.1, "shade": 0.25, "antenna": ["#bccfe1", "#394f71", "#1a2a43"], "matte": true, "pattern": "sashiko" },
      "quilt": { "base": ["#ffe7db", "#f3bfb9", "#df969f", "#bd738c"], "eye": "#754e62", "rim": "#fff5e6", "shine": 0.1, "shade": 0.25, "antenna": ["#fff5e6", "#f3bfb9", "#bd738c"], "matte": true, "pattern": "quilt" },
      "corduroy": { "base": ["#ffd5a0", "#f5b267", "#de8941", "#b5672d"], "eye": "#68402e", "rim": "#ffedc2", "shine": 0.08, "shade": 0.25, "antenna": ["#ffedc2", "#f5b267", "#b5672d"], "matte": true, "pattern": "corduroy" },
      "linen": { "base": ["#fffaf0", "#eee5d3", "#d5c5aa", "#b5a58b"], "eye": "#615246", "rim": "#fff9e6", "shine": 0.05, "shade": 0.25, "antenna": ["#fff9e6", "#eee5d3", "#b5a58b"], "matte": true, "pattern": "linen" },
      "bamboo": { "base": ["#e7d49b", "#ceb574", "#b79b5b", "#937a40"], "eye": "#574f2b", "rim": "#f4e5b5", "shine": 0.13, "shade": 0.25, "antenna": ["#f4e5b5", "#ceb574", "#937a40"], "pattern": "bamboo", "matte": true },
      "candy": { "base": ["#ffd5df", "#f4a2bf", "#e782a7", "#c85d89"], "eye": "#7a3058", "rim": "#fff1f6", "shine": 0.7, "shade": 0.23, "antenna": ["#fff8fb", "#f3a0c3", "#be507f"], "pattern": "stripes" },
      "cow": { "base": ["#fffdf5", "#f4f0e6", "#deded5", "#bfc8c6"], "eye": "#373d4b", "rim": "#fff7ed", "shine": 0.62, "shade": 0.16, "pattern": "revised-cow", "antenna": ["#fbd8e3", "#e8a5bc", "#bb718f"] },
      "watermelon": { "base": ["#ffaca3", "#ea5353", "#ec4141", "#fe2a2a"], "eye": "#4d0012", "rim": "#d9edbc", "shine": 0.04, "shade": 0, "pattern": "seeds", "edgeColor": "#59970c", "antenna": ["#c6df3a", "#7eb011", "#538a24"] },
      "strawberry": { "base": ["#ffbcc7", "#ef899e", "#d86383", "#b34364"], "eye": "#613449", "rim": "#ffe5df", "shine": 0.6, "shade": 0.25, "antenna": ["#ffe5df", "#ef899e", "#b34364"], "pattern": "strawberry" },
      "kiwi": { "base": ["#e2efb0", "#bdd574", "#94b94e", "#627f35"], "eye": "#304c29", "rim": "#edf6bf", "shine": 0.34, "shade": 0.19, "antenna": ["#edf6bf", "#a9c568", "#597538"], "pattern": "second-kiwi", "edgeColor": "#8a7845" },
      "lemon": { "base": ["#fff3ac", "#f6d657", "#eab62c", "#c58c22"], "eye": "#70501e", "rim": "#fff9cb", "shine": 0.52, "shade": 0.16, "antenna": ["#fff9cb", "#efcf61", "#b97b25"], "pattern": "second-lemon", "edgeColor": "#e6c84b" },
      "orangepeel": { "base": ["#ffd5a0", "#f5b267", "#de8941", "#b5672d"], "eye": "#68402e", "rim": "#ffedc2", "shine": 0.4, "shade": 0.25, "antenna": ["#ffedc2", "#f5b267", "#b5672d"], "pattern": "orangepeel" },
      "dragonfruit": { "base": ["#fffefa", "#f6f4ec", "#e6e4df", "#c4cccb"], "eye": "#4b3b57", "rim": "#fff9e6", "shine": 0.42, "shade": 0.15, "antenna": ["#fff9e6", "#eee5d3", "#b5a58b"], "edgeColor": "#d4588c", "pattern": "revised-dragonfruit" },
      "chocolate": { "base": ["#b38a69", "#8a6046", "#6a4334", "#493027"], "eye": "#fff0cb", "rim": "#d5b58e", "shine": 0.5, "shade": 0.25, "antenna": ["#d5b58e", "#8a6046", "#493027"], "pattern": "chocolate" },
      "waffle": { "base": ["#ffd5a0", "#f5b267", "#de8941", "#b5672d"], "eye": "#68402e", "rim": "#ffedc2", "shine": 0.18, "shade": 0.25, "antenna": ["#ffedc2", "#f5b267", "#b5672d"], "matte": true, "pattern": "waffle" },
      "cookie": { "base": ["#fff2a4", "#efcf61", "#d9a438", "#b97b25"], "eye": "#665024", "rim": "#fff9cb", "shine": 0.12, "shade": 0.25, "antenna": ["#fff9cb", "#efcf61", "#b97b25"], "matte": true, "pattern": "cookie" },
      "donut": { "base": ["#ffbcc7", "#ef899e", "#d86383", "#b34364"], "eye": "#613449", "rim": "#ffe5df", "shine": 0.68, "shade": 0.25, "antenna": ["#ffe5df", "#ef899e", "#b34364"], "pattern": "donut" },
      "cactus": { "base": ["#d4e6a0", "#a9c568", "#7f9d47", "#597538"], "eye": "#354b30", "rim": "#edf6bf", "shine": 0.22, "shade": 0.25, "antenna": ["#edf6bf", "#a9c568", "#597538"], "pattern": "cactus" },
      "galaxy": { "base": ["#6545ad", "#45277f", "#193b70", "#101b3a"], "eye": "#fff6da", "rim": "#c1b0f5", "shine": 0.21, "shade": 0.32, "pattern": "galaxy", "antenna": ["#f0dfff", "#ad84ed", "#57338e"] },
      "matcharib": { "base": ["#d1ef9b", "#96c953", "#6ba737", "#3e6e29"], "eye": "#fff9de", "rim": "#d6ecb0", "shine": 0.08, "shade": 0.28, "antenna": ["#d5eeac", "#96c85c", "#548039"], "pattern": "matcharib", "matte": true },
      "cloud": { "base": ["#b5e0f2", "#86bfe0", "#5f9bc9", "#3e73a4"], "eye": "#264c76", "rim": "#e9f7ff", "shine": 0.2, "shade": 0.18, "antenna": ["#e9f7ff", "#78a6ce", "#355c89"], "pattern": "second-cloud" },
      "wave": { "base": ["#5b7fa5", "#3f648e", "#2b4c77", "#20395d"], "eye": "#fff1d4", "rim": "#c6dded", "shine": 0.46, "shade": 0.25, "antenna": ["#c6dded", "#3f648e", "#20395d"], "pattern": "wave" },
      "raindrop": { "base": ["#dbd9d0", "#b9bbb4", "#919a97", "#6b7b7c"], "eye": "#334b52", "rim": "#f4f0de", "shine": 0.7, "shade": 0.25, "antenna": ["#f4f0de", "#b9bbb4", "#6b7b7c"], "pattern": "raindrop" },
      "snowflake": { "base": ["#546b8b", "#394f71", "#273b5b", "#1a2a43"], "eye": "#fff1cf", "rim": "#bccfe1", "shine": 0.15, "shade": 0.25, "antenna": ["#bccfe1", "#394f71", "#1a2a43"], "matte": true, "pattern": "snowflake" },
      "polka": { "base": ["#af9beb", "#8c72d9", "#7860c4", "#5a469e"], "eye": "#fff9e8", "rim": "#e2d5ff", "shine": 0.34, "shade": 0.28, "antenna": ["#fff2ae", "#f2d77d", "#b9963b"], "pattern": "dots" },
      "carbon": { "base": ["#4a5557", "#2c3639", "#1b2428", "#10191e"], "eye": "#e1f3e9", "rim": "#aabfbe", "shine": 0.29, "shade": 0.36, "pattern": "carbon", "antenna": ["#d2e2de", "#647b7a", "#263d42"] },
      "blueprint": { "base": ["#6a9ed4", "#477ebc", "#2d609f", "#244a85"], "eye": "#effbff", "rim": "#c3e6ff", "shine": 0.16, "shade": 0.24, "matte": true, "pattern": "blueprint", "antenna": ["#d4f1ff", "#79a9d5", "#366496"] },
      "origami": { "base": ["#f5e5d3", "#e6c7b0", "#b9c7c1", "#a0a8bb"], "eye": "#4a535a", "rim": "#fff0e2", "shine": 0.07, "shade": 0.25, "antenna": ["#fff0e2", "#e6c7b0", "#a0a8bb"], "pattern": "origami", "matte": true },
      "circuit": { "base": ["#3c6c61", "#235347", "#163b34", "#102b29"], "eye": "#e8ffbd", "rim": "#abd5a7", "shine": 0.3, "shade": 0.25, "antenna": ["#abd5a7", "#235347", "#102b29"], "pattern": "circuit" },
      "camo": { "base": ["#b0b594", "#8e9e75", "#71835e", "#4c6247"], "eye": "#fff2ca", "rim": "#d7dfb7", "shine": 0.06, "shade": 0.22, "antenna": ["#d7dfb7", "#7c8c5c", "#405237"], "pattern": "revised-camo", "matte": true },
      "topo": { "base": ["#7dbbb6", "#519a98", "#347b80", "#235d68"], "eye": "#efffe4", "rim": "#bcebd6", "shine": 0.15, "shade": 0.25, "antenna": ["#bcebd6", "#519a98", "#235d68"], "pattern": "topo", "matte": true },
      "artdeco": { "base": ["#546b8b", "#394f71", "#273b5b", "#1a2a43"], "eye": "#fff1cf", "rim": "#bccfe1", "shine": 0.4, "shade": 0.25, "antenna": ["#bccfe1", "#394f71", "#1a2a43"], "pattern": "artdeco" },
      "memphis": { "base": ["#e4d6ef", "#bcabd5", "#9a88bc", "#776397"], "eye": "#4e4168", "rim": "#fff0fe", "shine": 0.18, "shade": 0.25, "antenna": ["#fff0fe", "#bcabd5", "#776397"], "matte": true, "pattern": "memphis" },
      "chevron": { "base": ["#f3e8cd", "#e4d5b3", "#c8b48f", "#9e8e70"], "eye": "#3d5052", "rim": "#fff9e6", "shine": 0.07, "shade": 0.2, "antenna": ["#fff9e6", "#eee5d3", "#b5a58b"], "matte": true, "pattern": "second-chevron" },
      "hexbolt": { "base": ["#dbd9d0", "#b9bbb4", "#919a97", "#6b7b7c"], "eye": "#334b52", "rim": "#f4f0de", "shine": 0.55, "shade": 0.25, "antenna": ["#f4f0de", "#b9bbb4", "#6b7b7c"], "pattern": "hexbolt" },
      "rivet": { "base": ["#546b8b", "#394f71", "#273b5b", "#1a2a43"], "eye": "#fff1cf", "rim": "#bccfe1", "shine": 0.6, "shade": 0.25, "antenna": ["#bccfe1", "#394f71", "#1a2a43"], "pattern": "rivet" }
    };
    exports.MATERIALS = MATERIALS;
  });
  __define("src/skins/more-materials.js", function(__require2, __import2, exports) {
    const EXTRA = /* @__PURE__ */ new Set(["cork", "pearl", "hologram", "ice", "soap", "leather", "lace", "bamboo", "wave", "origami", "circuit", "topo"]);
    function extraTexture(defs, id, kind, el, gradient) {
      if (!EXTRA.has(kind)) return null;
      const size = { pearl: 240, hologram: 120, ice: 240, soap: 240, copper: 100, leather: 24, cork: 64, knit: 18, bamboo: 32, origami: 120, stained: 80, circuit: 80, koi: 200, sakura: 72, lace: 64, checker: 48, tiger: 120, camo: 120, topo: 160, wave: 48, moon: 160 }[kind];
      const p = el("pattern", { id, width: size, height: size, patternUnits: "userSpaceOnUse" }, defs);
      const path = (d, stroke, width = 1, opacity = 1, fill = "none", parent = p) => el("path", { d, stroke, "stroke-width": width, opacity, fill, "stroke-linejoin": "round", "stroke-linecap": "round" }, parent);
      const circle = (cx, cy, r, fill, opacity = 1, parent = p) => el("circle", { cx, cy, r, fill, opacity }, parent);
      if (kind === "pearl") {
        for (let i = 0; i < 20; i++) path(`M-20 ${i * 15}Q90 ${i * 15 - 100} 260 ${i * 15 - 22}`, i % 2 ? "#d5c1e2" : "#fff9e4", 2, 0.35);
      } else if (kind === "hologram") {
        const colors = ["#fff7bc", "#96ffe6", "#d9bcff", "#ffb8de"];
        for (let i = 0; i < 4; i++) path(`M${i * 30 - 60} 0l60 120h18L${i * 30 - 42} 0Z`, "none", 0, 0.28, colors[i]);
        for (const [x, y] of [[25, 26], [91, 83]]) path(`M${x - 6} ${y}h12m-6-6v12`, "#fff", 1, 0.85);
      } else if (kind === "ice") {
        const facets = ["M0 0L110 30 42 119Z", "M110 30L240 0 195 143Z", "M42 119L195 143 121 240Z", "M195 143L240 0 240 240Z"];
        facets.forEach((d, i) => path(d, "#f3ffff", 0.8, 0.18 + i * 0.035, i % 2 ? "#efffff" : "#5b9fc2"));
        path("M110 30L99 80 131 107 121 162M42 119L63 167 50 210", "#f4ffff", 1.1, 0.7);
        for (let i = 0; i < 22; i++) circle(i * 43.7 % 240, i * i * 19.3 % 240, 0.8 + i % 3 * 0.5, "#fff", 0.35);
      } else if (kind === "soap") {
        ["#efb4e5", "#94ddd9", "#faf0b4", "#b9b1e9"].forEach((c, i) => {
          path(`M${25 + i * 3} ${155 - i * 5}C${-5 + i * 3} 80 40 ${20 + i * 4} ${133 + i * 3} ${20 + i * 4}`, c, 3, 0.55);
          path(`M${210 - i * 3} 82Q${253 - i * 4} 190 ${120 - i * 2} ${213 - i * 3}`, c, 2, 0.5);
        });
        for (const [x, y, r] of [[58, 173, 9], [181, 43, 5], [193, 168, 13]]) el("circle", { cx: x, cy: y, r, fill: "none", stroke: "#fff", "stroke-width": 1.4, opacity: 0.5 }, p);
      } else if (kind === "leather") {
        path("M0 3L7 1 12 6 22 3 24 9M0 16L8 11 16 15 24 12M7 1L8 11 4 24M16 15L19 24", "#402719", 0.6, 0.22);
        path("M1 4L7 3 11 7M9 12L15 16 23 13", "#f0d6ad", 0.5, 0.25);
      } else if (kind === "cork") {
        for (let i = 0; i < 65; i++) {
          const x = i * 23.7 % 64, y = i * i * 11.3 % 64, r = 1 + i % 3;
          el("rect", { x, y, width: r * 1.7, height: r, rx: 0.5, fill: ["#76542e", "#fff0c6", "#aa743a"][i % 3], opacity: 0.3, transform: `rotate(${i * 31} ${x} ${y})` }, p);
        }
      } else if (kind === "bamboo") {
        for (let i = -2; i < 4; i++) {
          path(`M${i * 16} -16l64 64`, "#796335", 6, 0.3);
          path(`M${i * 16 + 2} -16l64 64`, "#f1dfad", 3, 0.65);
          path(`M${i * 16} 48l64-64`, "#c6a76c", 6, 0.8);
          path(`M${i * 16 + 2} 48l64-64`, "#f9eac0", 1, 0.55);
        }
      } else if (kind === "origami" || kind === "stained") {
        const s = size, m = s * 0.43;
        const shapes = [`M0 0H${s}L${m} ${m}Z`, `M${s} 0V${s}L${m} ${m}Z`, `M${s} ${s}H0L${m} ${m}Z`, `M0 ${s}V0L${m} ${m}Z`];
        const colors = kind === "stained" ? ["#c29a57", "#508e8d", "#9279a7", "#698bb0"] : ["#fff5dc", "#8ca6ae", "#b5b7d5", "#eab69d"];
        shapes.forEach((d, i) => path(d, kind === "stained" ? "#303951" : "#fff7ef", kind === "stained" ? 2.7 : 0.7, kind === "stained" ? 0.85 : 0.6, colors[i]));
      } else if (kind === "circuit") {
        for (const d of ["M0 12H22L38 28H80", "M8 80V53L24 37V0", "M44 80V57L63 38H80", "M52 0V12L68 28"]) path(d, "#d1bc73", 1.3, 0.7);
        for (const [x, y] of [[38, 28], [24, 37], [44, 57], [68, 28]]) {
          circle(x, y, 3, "#dac98c", 0.9);
          circle(x, y, 1.3, "#285348");
        }
        el("rect", { x: 47, y: 7, width: 14, height: 10, rx: 2, fill: "#102f2c", stroke: "#819d76", "stroke-width": 0.7 }, p);
      } else if (kind === "lace") {
        for (const [x, y] of [[0, 0], [32, 32], [64, 0], [0, 64], [64, 64]]) {
          const g = el("g", { transform: `translate(${x} ${y})` }, p);
          for (let i = 0; i < 8; i++) el("ellipse", { cx: 0, cy: 10, rx: 4, ry: 10, fill: "none", stroke: "#eee1ce", "stroke-width": 0.7, opacity: 0.65, transform: `rotate(${i * 45})` }, g);
          circle(0, 0, 2, "#eee1ce", 0.7, g);
          for (let i = 0; i < 12; i++) circle(Math.cos(i * Math.PI / 6) * 24, Math.sin(i * Math.PI / 6) * 24, 0.7, "#eee1ce", 0.6, g);
        }
      } else if (kind === "topo") {
        for (let i = 0; i < 11; i++) {
          const r = 9 + i * 7;
          path(`M${80 - r} 80C${80 - r * 1.3} ${80 - r} ${80 + r * 0.6} ${80 - r * 1.4} ${80 + r} ${80 - r * 0.4}S${80 + r * 0.4} ${80 + r * 1.4} ${80 - r * 0.4} ${80 + r}S${80 - r} 95 ${80 - r} 80Z`, "#d8edc9", i % 3 === 0 ? 1.2 : 0.6, 0.48);
        }
      } else if (kind === "wave") {
        for (const [x, y] of [[0, 24], [48, 24], [24, 48], [0, 72], [48, 72]]) for (const r of [6, 12, 18, 24]) path(`M${x - r} ${y}a${r} ${r} 0 0 1 ${r * 2} 0`, "#e7e7cf", 1, 0.55);
      }
      return p;
    }
    exports.extraTexture = extraTexture;
  });
  __define("src/skins/collection-materials.js", function(__require2, __import2, exports) {
    const COLLECTION = /* @__PURE__ */ new Set(["ceramicblue", "tartan", "argyle", "sashiko", "quilt", "corduroy", "linen", "strawberry", "orangepeel", "chocolate", "waffle", "cookie", "donut", "cactus", "raindrop", "snowflake", "artdeco", "memphis", "hexbolt", "rivet"]);
    function collectionTexture(defs, id, kind, el, gradient) {
      if (!COLLECTION.has(kind)) return null;
      const sizes = { kiwi: 240, lemon: 120, peach: 240, chocolate: 48, waffle: 32, latte: 240, malachite: 160, agate: 160, sandstone: 160, ocean: 120, cloud: 120, tartan: 80, houndstooth: 32, sashiko: 48, corduroy: 12, linen: 24, hexbolt: 48, disco: 80, kintsugi: 160, opart: 160 };
      const s = sizes[kind] || 80;
      const p = el("pattern", { id, width: s, height: kind === "hexbolt" ? 42 : s, patternUnits: "userSpaceOnUse" }, defs);
      const path = (d, fill = "none", stroke = "none", width = 1, opacity = 1, parent = p) => el("path", { d, fill, stroke, "stroke-width": width, opacity, "stroke-linecap": "round", "stroke-linejoin": "round" }, parent);
      const circle = (x, y, r, fill, opacity = 1, parent = p) => el("circle", { cx: x, cy: y, r, fill, opacity }, parent);
      const rect = (x, y, w, h, fill, opacity = 1, rx = 0) => el("rect", { x, y, width: w, height: h, fill, opacity, rx }, p);
      const ellipse = (x, y, rx, ry, fill, angle = 0, opacity = 1, parent = p) => el("ellipse", { cx: x, cy: y, rx, ry, fill, opacity, transform: `rotate(${angle} ${x} ${y})` }, parent);
      const specks = (count, colors, radius = 0.6) => {
        for (let i = 0; i < count; i++) circle((i * 31.71 + 7) % s, (i * i * 13.37 + 11) % s, radius + i % 3 * 0.3, colors[i % colors.length], 0.3);
      };
      if (kind === "strawberry") {
        for (const [x, y] of [[16, 18], [55, 58], [58, 13], [13, 57]]) {
          ellipse(x, y, 2.1, 4, "#9d4d57", -18, 0.55);
          ellipse(x - 1, y - 1, 1.3, 2.5, "#ffe7a3", -18, 0.95);
        }
      } else if (kind === "orangepeel") {
        for (let i = 0; i < 85; i++) {
          const x = i * 21.3 % s, y = i * i * 17.7 % s;
          circle(x, y, 1.4, "#b97129", 0.3);
          path(`M${x - 1} ${y + 1}h1.5`, "none", "#fff0b9", 0.7, 0.5);
        }
      } else if (kind === "chocolate") {
        rect(1, 1, 46, 46, "#432a20", 0.5, 5);
        rect(5, 5, 38, 38, "#a57652", 0.5, 4);
        path("M7 40V7H40", "none", "#d4a97d", 1.5, 0.5);
        path("M41 8V41H8", "none", "#3d241c", 2, 0.65);
        path("M13 16L24 11 35 16V31L24 36 13 31Z", "none", "#603b2d", 1, 0.3);
      } else if (kind === "waffle") {
        rect(4, 4, 24, 24, "#a4642e", 0.5, 3);
        rect(7, 7, 18, 18, "#cc8d42", 0.7, 2);
        path("M4 28V4H28", "none", "#ffe2a1", 3, 0.75);
        path("M28 4V28H4", "none", "#9f602d", 2, 0.55);
      } else if (kind === "cookie") {
        specks(45, ["#9f702e", "#fff3bb"]);
        for (let i = 0; i < 8; i++) {
          const x = (i * 29 + 8) % s, y = (i * i * 17 + 6) % s;
          path(`M${x} ${y}l6-2 4 5-3 5-7-2Z`, "#604030", "none", 0, 0.9);
          path(`M${x + 1} ${y}l4-1`, "none", "#ac7b56", 1, 0.6);
        }
      } else if (kind === "donut") {
        const colors = ["#fff3b2", "#8dd4ce", "#f6f0ec", "#8e82c1", "#b64b69"];
        for (let i = 0; i < 18; i++) {
          const x = i * 31.7 % s, y = i * i * 17.1 % s, a = i * 2.3;
          path(`M${x} ${y}l${Math.cos(a) * 5} ${Math.sin(a) * 5}`, "none", colors[i % 5], 2.5, 0.95);
        }
      } else if (kind === "cactus") {
        for (const x of [9, 36, 63]) {
          path(`M${x} 0q-5 20 0 40t0 40`, "none", "#547435", 5, 0.3);
          path(`M${x + 4} 0q-5 20 0 40t0 40`, "none", "#edf2b6", 1.5, 0.6);
          for (const y of [14, 54]) path(`M${x - 3} ${y - 3}l6 6m-6 0 6-6m-3-1v8`, "none", "#fff5cc", 1, 0.85);
        }
      } else if (kind === "raindrop") {
        gradient(defs, "radialGradient", `${id}-drop`, { cx: ".65", cy: ".7" }, [[0, "#f4ffff", 0.65], [0.6, "#7d9ba6", 0.05], [1, "#213d51", 0.4]]);
        for (const [x, y, r] of [[18, 20, 8], [55, 58, 11], [65, 12, 4], [16, 65, 4]]) {
          ellipse(x, y, r * 0.75, r, `url(#${id}-drop)`, -15);
          path(`M${x - r * 0.4} ${y - r * 0.4}l1-2`, "none", "#fff", 1.4, 0.8);
        }
      } else if (kind === "snowflake") {
        for (const [x, y, r] of [[20, 20, 16], [60, 60, 10]]) for (let i = 0; i < 6; i++) {
          const g = el("g", { transform: `translate(${x} ${y}) rotate(${i * 60})` }, p);
          path(`M0 0V${-r}M0 ${-r * 0.5}l${-r * 0.25} ${-r * 0.25}M0 ${-r * 0.5}l${r * 0.25} ${-r * 0.25}`, "none", "#e5f4f8", 1, 0.8, g);
        }
        specks(12, ["#fff"], 0.5);
      } else if (kind === "tartan") {
        rect(0, 0, s, s, "#782f42", 0.65);
        for (const n of [13, 53]) {
          rect(n, 0, 15, s, "#224f48", 0.65);
          rect(0, n, s, 15, "#224f48", 0.65);
        }
        for (const n of [8, 33, 48, 73]) path(`M${n} 0v80M0 ${n}h80`, "none", "#ead39d", 0.8, 0.7);
      } else if (kind === "argyle") {
        path("M20 0L40 40 20 80 0 40Z", "#6d5b8e", "none", 0, 0.7);
        path("M60 0L80 40 60 80 40 40Z", "#ead6de", "none", 0, 0.75);
        path("M0 0L40 80 80 0M0 80L40 0 80 80", "none", "#fff2d9", 1, 0.75);
      } else if (kind === "sashiko") {
        for (const [x, y] of [[0, 0], [48, 0], [24, 24], [0, 48], [48, 48]]) el("circle", { cx: x, cy: y, r: 24, fill: "none", stroke: "#f4ecdc", "stroke-width": 1, "stroke-dasharray": "3 2", opacity: 0.8 }, p);
      } else if (kind === "quilt") {
        for (const [x, y, c] of [[0, 0, "#a6b5b5"], [40, 0, "#e3c393"], [0, 40, "#d18f94"], [40, 40, "#9298b9"]]) {
          rect(x, y, 40, 40, c, 0.8);
          el("rect", { x: x + 3, y: y + 3, width: 34, height: 34, fill: "none", stroke: "#fff4de", "stroke-width": 1, "stroke-dasharray": "2 2", opacity: 0.8 }, p);
          for (const n of [12, 28]) circle(x + n, y + n, 1.5, "#fff5dd", 0.7);
        }
      } else if (kind === "corduroy") {
        rect(0, 0, 3, 12, "#73482e", 0.35);
        rect(4, 0, 3, 12, "#ffe1aa", 0.4);
        for (let y = 0; y < 12; y += 2) path(`M4 ${y}h5`, "none", "#fff0c6", 0.5, 0.28);
      } else if (kind === "linen") {
        for (let i = 1; i < 24; i += 3) {
          path(`M${i} 0v24`, "none", i % 2 ? "#8b806a" : "#fff8e6", 0.65, 0.38);
          path(`M0 ${i}h24`, "none", i % 2 ? "#fff8e6" : "#8b806a", 0.65, 0.35);
        }
        specks(8, ["#716a59"], 0.4);
      } else if (kind === "artdeco") {
        for (const [x, y] of [[0, 80], [80, 80], [40, 40]]) for (let i = 0; i <= 8; i++) {
          const a = Math.PI + i * Math.PI / 8;
          path(`M${x} ${y}L${x + Math.cos(a) * 40} ${y + Math.sin(a) * 40}`, "none", "#dfc185", 0.9, 0.8);
        }
        path("M0 80A40 40 0 0 1 80 80M0 40A40 40 0 0 1 80 40", "none", "#e5c589", 1.5, 0.8);
      } else if (kind === "memphis") {
        path("M4 18q6-10 12 0t12 0", "none", "#795c9b", 3, 0.9);
        path("M48 10l16 4-10 13Z", "#f2cd79");
        circle(19, 59, 7, "#88bcb3");
        path("M46 57l5-5 5 10 5-10 5 5", "none", "#b36284", 2.5, 0.9);
        for (const [x, y] of [[38, 35], [71, 41], [6, 35]]) circle(x, y, 1.5, "#46526d");
      } else if (kind === "hexbolt") {
        for (const [x, y] of [[0, 0], [24, 0], [48, 0], [12, 21], [36, 21], [0, 42], [24, 42], [48, 42]]) {
          path(`M${x} ${y - 14}l12 7v14l-12 7-12-7v-14Z`, "#748786", "#354e53", 1.5, 0.7);
          path(`M${x - 9} ${y - 5}l9-5 9 5`, "none", "#e3e9d9", 1, 0.6);
        }
      } else if (kind === "rivet") {
        path("M0 0H80V80H0Z", "none", "#132235", 3, 0.65);
        path("M3 77V3H77", "none", "#9cb0c0", 1, 0.55);
        for (const [x, y] of [[9, 9], [71, 9], [9, 71], [71, 71]]) {
          circle(x, y, 3.5, "#172b3d", 0.8);
          circle(x - 1, y - 1, 2.5, "#afbec5", 0.85);
          path(`M${x - 2} ${y - 2}h2`, "none", "#f2f6ee", 0.8, 0.9);
        }
      } else if (kind === "ceramicblue") {
        for (const [x, y] of [[20, 22], [61, 61]]) {
          const g = el("g", { transform: `translate(${x} ${y})` }, p);
          for (let i = 0; i < 6; i++) el("ellipse", { cx: 0, cy: -6, rx: 3, ry: 7, fill: "#4c7097", opacity: 0.8, transform: `rotate(${i * 60})` }, g);
          circle(0, 0, 2, "#e5ebdf", 1, g);
          path("M5 14Q22 28 18 40M10 22q10-13 15-3q-3 8-15 3", "none", "#416d94", 1.2, 0.9, g);
        }
      }
      return p;
    }
    exports.collectionTexture = collectionTexture;
  });
  __define("src/skins/revised-materials.js", function(__require2, __import2, exports) {
    const REVISED = /* @__PURE__ */ new Set(["cow", "dragonfruit", "camo"]);
    function revisionTexture(defs, id, kind, el, gradient) {
      if (!kind.startsWith("revised-")) return null;
      const name = kind.slice(8);
      if (!REVISED.has(name)) return null;
      const p = el("pattern", { id, width: 240, height: 240, patternUnits: "userSpaceOnUse" }, defs);
      const path = (d, fill = "none", stroke = "none", width = 1, opacity = 1, parent = p) => el("path", { d, fill, stroke, "stroke-width": width, opacity, "stroke-linecap": "round", "stroke-linejoin": "round" }, parent);
      const circle = (cx, cy, r, fill, opacity = 1, parent = p) => el("circle", { cx, cy, r, fill, opacity }, parent);
      const ellipse = (cx, cy, rx, ry, fill, opacity = 1, parent = p) => el("ellipse", { cx, cy, rx, ry, fill, opacity }, parent);
      const rect = (x, y, width, height, fill, opacity = 1, rx = 0, parent = p) => el("rect", { x, y, width, height, fill, opacity, rx }, parent);
      const noise = (n, colors, opacity = 0.18) => {
        for (let i = 0; i < n; i++) circle((i * 73.731 + 13) % 240, (i * i * 29.379 + 19) % 240, 0.25 + i % 3 * 0.18, colors[i % colors.length], opacity);
      };
      const wash = (key, color, opacity, cx, cy, rx, ry) => {
        gradient(defs, "radialGradient", `${id}-${key}`, {}, [[0, color, opacity], [0.5, color, opacity * 0.6], [1, color, 0]]);
        ellipse(cx, cy, rx, ry, `url(#${id}-${key})`);
      };
      if (name === "cow") {
        for (const d of ["M-10 2H88C99 15 73 28 70 44S37 43 31 65 5 97-10 71Z", "M176-5C161 17 176 35 195 39S204 76 237 86V-5Z", "M-8 162C12 148 33 170 42 177S65 169 77 187 47 219 62 247H-8Z", "M176 208C177 190 204 174 222 181S251 202 237 240H193Z"]) path(d, "#30343c");
        ellipse(160, 44, 8, 5, "#30343c");
      } else if (name === "camo") {
        for (const [d, c] of [
          ["M-5-5H126C113 11 87 16 81 37S43 46 44 67 2 82-5 63Z", "#c1b690"],
          ["M138-5H245V96C218 90 227 60 200 65S158 43 172 27 155 17 138-5Z", "#506b4c"],
          ["M-5 119C24 103 38 124 43 145S81 147 72 177 109 212 92 245H-5Z", "#466149"],
          ["M137 183C138 157 163 166 180 157S195 124 225 133L245 128V245H156C176 225 133 212 137 183Z", "#c0b38e"],
          ["M180 235Q198 203 220 206T245 189V245Z", "#384e3b"]
        ]) path(d, c, "none", 0, 0.9);
        noise(170, ["#e6dcc3", "#2a4533"], 0.1);
      } else if (name === "dragonfruit") {
        el("use", { href: "#headShape", fill: "none", stroke: "#f2a0c0", "stroke-width": 11, opacity: 0.8 }, p);
        for (let i = 0; i < 105; i++) {
          const x = 25 + i * 71.71 % 190, y = 25 + i * i * 37.17 % 190;
          if (y > 92 && y < 159 && x > 51 && x < 184) continue;
          el("ellipse", { cx: x, cy: y, rx: 0.9, ry: 1.7, fill: "#424044", opacity: 0.8, transform: `rotate(${i * 59} ${x} ${y})` }, p);
        }
        noise(140, ["#fff", "#bac2bc"], 0.13);
      }
      return p;
    }
    exports.revisionTexture = revisionTexture;
  });
  __define("src/skins/second-pass-materials.js", function(__require2, __import2, exports) {
    const SECOND = /* @__PURE__ */ new Set(["knit", "kiwi", "lemon", "cloud", "chevron"]);
    function secondPassTexture(defs, id, kind, el, gradient) {
      if (!kind.startsWith("second-")) return null;
      const name = kind.slice(7);
      if (!SECOND.has(name)) return null;
      const p = el("pattern", { id, width: 240, height: 240, patternUnits: "userSpaceOnUse" }, defs);
      const path = (d, fill = "none", stroke = "none", width = 1, opacity = 1, parent = p) => el("path", { d, fill, stroke, "stroke-width": width, opacity, "stroke-linejoin": "round", "stroke-linecap": "round" }, parent);
      const circle = (cx, cy, r, fill, opacity = 1, parent = p) => el("circle", { cx, cy, r, fill, opacity }, parent);
      const rect = (x, y, width, height, fill, rx = 0, opacity = 1, parent = p) => el("rect", { x, y, width, height, rx, fill, opacity }, parent);
      const ellipse = (cx, cy, rx, ry, fill, opacity = 1, parent = p) => el("ellipse", { cx, cy, rx, ry, fill, opacity }, parent);
      const noise = (count, colors, opacity = 0.2) => {
        for (let i = 0; i < count; i++) circle((i * 71.731 + 13) % 240, (i * i * 29.37 + 9) % 240, 0.25 + i % 3 * 0.2, colors[i % colors.length], opacity);
      };
      const glow = (key, color, opacity, cx, cy, rx, ry) => {
        gradient(defs, "radialGradient", `${id}-${key}`, {}, [[0, color, opacity], [0.6, color, opacity * 0.5], [1, color, 0]]);
        ellipse(cx, cy, rx, ry, `url(#${id}-${key})`);
      };
      if (name === "knit") {
        for (let x = 23; x < 220; x += 10) for (let y = 24; y < 198; y += 10) {
          path(`M${x - 3} ${y}L${x} ${y + 7} ${x + 3} ${y}`, "none", "#613c57", 3, 0.4);
          path(`M${x - 2} ${y}L${x} ${y + 6} ${x + 2} ${y}`, "none", "#ddb4c9", 1.3, 0.6);
        }
        for (const x of [49, 120, 191]) for (let y = 17; y < 202; y += 32) {
          path(`M${x - 9} ${y}C${x - 10} ${y + 14} ${x + 9} ${y + 17} ${x + 9} ${y + 32}M${x + 9} ${y}C${x + 10} ${y + 14} ${x - 9} ${y + 17} ${x - 9} ${y + 32}`, "none", "#6f4261", 9, 0.9);
          path(`M${x - 9} ${y}C${x - 10} ${y + 14} ${x + 9} ${y + 17} ${x + 9} ${y + 32}M${x + 9} ${y}C${x + 10} ${y + 14} ${x - 9} ${y + 17} ${x - 9} ${y + 32}`, "none", "#d6a5bf", 5, 0.9);
          path(`M${x - 10} ${y}C${x - 11} ${y + 14} ${x + 8} ${y + 17} ${x + 8} ${y + 32}`, "none", "#f0cddd", 1, 0.65);
        }
        rect(0, 199, 240, 41, "#9b6787", 0, 0.9);
        for (let x = 20; x < 222; x += 6) path(`M${x} 200v28`, "none", "#d7aac2", 2, 0.65);
        path("M20 199H220", "none", "#673d57", 2, 0.45);
      } else if (name === "kiwi") {
        glow("pulp", "#e7f4b3", 0.9, 115, 111, 105, 108);
        for (let i = 0; i < 130; i++) {
          const a = i * Math.PI / 65, t = (r) => `${120 + Math.cos(a) * r} ${120 + Math.sin(a) * r}`;
          path(`M${t(29 + i % 5)}L${t(103)}`, "none", i % 3 ? "#e3edaf" : "#739535", 0.6, 0.38);
        }
        ellipse(120, 120, 27, 36, "#f1edca", 0.95);
        for (let i = 0; i < 35; i++) {
          const a = i * Math.PI * 2 / 35, r = 67 + i % 4 * 3, x = 120 + Math.cos(a) * r, y = 120 + Math.sin(a) * (r + 4);
          el("ellipse", { cx: x, cy: y, rx: 1.5, ry: 3.1, fill: "#374c2a", transform: `rotate(${i * 360 / 35 - 90} ${x} ${y})` }, p);
          circle(x - 1, y - 1, 0.55, "#d3dfa2", 0.8);
        }
        noise(180, ["#e8efba", "#6e9239"], 0.18);
      } else if (name === "lemon") {
        const colors = ["#f8d254", "#f9df77", "#f1c544", "#ffe88c"];
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4 + 0.04, b = a + 0.67, point = (r, t) => `${120 + Math.cos(t) * r} ${120 + Math.sin(t) * r}`;
          path(`M${point(12, a + 0.05)}Q${point(57, a - 0.05)} ${point(102, a)}Q${point(118, (a + b) / 2)} ${point(102, b)}Q${point(58, b + 0.05)} ${point(12, b - 0.05)}Z`, colors[i % 4], "#fff0b5", 2, 0.97);
          for (let j = 0; j < 7; j++) {
            const t = a + 0.08 + j * 0.08, r = 76 + j % 3 * 6;
            path(`M${point(23 + j % 3 * 3, t)}Q${point(54, t + 0.015)} ${point(r, t)}`, "none", "#fff4c6", 0.65, 0.64);
          }
        }
        circle(120, 120, 9, "#fff2c5");
        for (const [x, y, a] of [[112, 59, 18], [166, 167, -35]]) el("ellipse", { cx: x, cy: y, rx: 2.6, ry: 5.3, fill: "#fff5cf", transform: `rotate(${a} ${x} ${y})` }, p);
      } else if (name === "cloud") {
        gradient(defs, "linearGradient", `${id}-cloudcap`, { x1: "0", y1: "0", x2: "0", y2: "1" }, [[0, "#fff", 1], [0.55, "#f6fcff", 1], [1, "#cbdfed", 0.95]]);
        path("M-5-5H245V60C227 76 209 74 197 62C184 87 154 81 148 65C129 88 107 82 101 67C80 91 52 82 49 66C28 80 7 72-5 62Z", `url(#${id}-cloudcap)`);
        glow("haze", "#e9f8ff", 0.37, 35, 204, 69, 23);
      } else if (name === "chevron") {
        for (let y = -30; y < 270; y += 24) for (let x = -30; x < 270; x += 60) {
          const row = Math.round((y + 30) / 24), c = row % 6 === 0 ? "#ac7865" : row % 3 === 0 ? "#c6a76c" : "#678e86";
          path(`M${x} ${y}l30 16v15l-30-16Z`, c, "none", 0, 0.9);
          path(`M${x + 30} ${y + 16}l30-16v15l-30 16Z`, row % 6 === 0 ? "#c4937c" : "#9db3a2", "none", 0, 0.9);
        }
        for (let y = 0; y < 240; y += 2.5) path(`M0 ${y}H240`, "none", "#f9eccd", 0.45, 0.18);
      }
      return p;
    }
    exports.secondPassTexture = secondPassTexture;
  });
  __define("src/skins/sports-materials.js", function(__require2, __import2, exports) {
    const SPORTS = /* @__PURE__ */ new Set(["basketball", "baseball"]);
    function sportsTexture(defs, id, kind, el, gradient) {
      if (!SPORTS.has(kind)) return null;
      const p = el("pattern", { id, width: 240, height: 240, patternUnits: "userSpaceOnUse" }, defs);
      const path = (d, stroke, width = 1, fill = "none", opacity = 1, parent = p) => el("path", { d, stroke, "stroke-width": width, fill, opacity, "stroke-linecap": "round", "stroke-linejoin": "round" }, parent);
      if (["basketball", "tennis", "baseball"].includes(kind)) {
        const grain = el("pattern", { id: `${id}-grain`, width: 8, height: 8, patternUnits: "userSpaceOnUse" }, defs);
        {
          el("circle", { cx: 2, cy: 2, r: kind === "basketball" ? 1.05 : 0.45, fill: kind === "basketball" ? "#7f3918" : "#9b8c73", opacity: 0.25 }, grain);
          el("circle", { cx: 6, cy: 6, r: 0.7, fill: "#fff7de", opacity: 0.25 }, grain);
        }
        el("rect", { width: 240, height: 240, fill: `url(#${id}-grain)` }, p);
      }
      if (kind === "basketball") {
        const seams = "M119 0C107 67 106 160 125 240M0 145C65 160 168 157 240 132M29 0C113 47 76 98 0 117M204 0C130 54 166 101 240 111";
        path(seams, "#ffca7a", 6, "none", 0.4);
        path(seams, "#562d21", 3.7);
        path(seams, "#271d1b", 1.2, "none", 0.55);
      } else if (kind === "baseball") {
        for (const side of [-1, 1]) {
          const xAt = (y) => 120 + side * (54 + 28 * Math.sin(Math.PI * (y - 20) / 200));
          let d = "";
          for (let y = 0; y <= 240; y += 4) d += `${y === 0 ? "M" : "L"}${xAt(y)} ${y}`;
          path(d, "#b9a995", 3, "none", 0.45);
          path(d, "#a64d48", 1.3);
          for (let y = 17; y < 232; y += 11) {
            const x = xAt(y);
            path(`M${x - 5} ${y - 3}L${x} ${y + 1}L${x + 5} ${y - 3}`, "#b63d44", 2.3);
            el("circle", { cx: x - 5, cy: y - 3, r: 1.2, fill: "#793b3c" }, p);
            el("circle", { cx: x + 5, cy: y - 3, r: 1.2, fill: "#793b3c" }, p);
          }
        }
      }
      return p;
    }
    exports.sportsTexture = sportsTexture;
  });
  __define("src/skins/glaze-variants.js", function(__require2, __import2, exports) {
    const variant = (source, label, english, colors, antenna, eyeColor) => ({
      source,
      label,
      english,
      antenna,
      palette: {
        baseColor: colors[0],
        bodyColor: colors[1],
        bodyEndColor: colors[2],
        secondaryColor: colors[3],
        reflectionColor: colors[3],
        edgeColor: colors[4],
        ...eyeColor ? { eyeColor } : {}
      }
    });
    const glazeVariants = {
      jadeglaze: variant(
        "blueglaze",
        "亮釉翡翠绿",
        "JADE GLAZE",
        ["#086953", "#40c49b", "#12856c", "#b0f1d6", "#ddfff0"],
        ["#effff6", "#50c99f", "#126b57"]
      ),
      berryglaze: variant(
        "blueglaze",
        "亮釉莓果粉",
        "BERRY GLAZE",
        ["#9e285f", "#ec77ac", "#c13b7b", "#ffc6e4", "#fff0f7"],
        ["#fff1f8", "#ed8cba", "#a53169"]
      ),
      amberglaze: variant(
        "blueglaze",
        "亮釉琥珀橙",
        "AMBER GLAZE",
        ["#ae531b", "#f4b053", "#db762b", "#ffe1af", "#fff3dc"],
        ["#fff7dc", "#f2b85e", "#ad5e27"]
      ),
      irisglaze: variant(
        "blueglaze",
        "亮釉鸢尾紫",
        "IRIS GLAZE",
        ["#5831a8", "#aa83ef", "#7846cf", "#ddceff", "#f4edff"],
        ["#f7efff", "#b18bed", "#6440ac"]
      ),
      mintice: variant(
        "iceglaze",
        "冰透薄荷绿",
        "MINT ICE",
        ["#8bbcae", "#d7f0e5", "#b3d8c9", "#e9fff5", "#f5fff9"],
        ["#ffffff", "#c4e6d7", "#7fae9c"]
      ),
      blushice: variant(
        "iceglaze",
        "冰透樱花粉",
        "BLUSH ICE",
        ["#c093ab", "#f5dfe9", "#e2bed0", "#fff0f7", "#fff8fc"],
        ["#ffffff", "#e8c9d9", "#b28b9f"]
      ),
      champagneice: variant(
        "iceglaze",
        "冰透香槟金",
        "CHAMPAGNE ICE",
        ["#c2ac81", "#f4e9d2", "#e0cda8", "#fff6df", "#fffaf0"],
        ["#ffffff", "#e7d8b9", "#b4a078"]
      ),
      lavenderice: variant(
        "iceglaze",
        "冰透薰衣紫",
        "LAVENDER ICE",
        ["#a89ac9", "#e8e1f6", "#cec1e8", "#f4efff", "#fbf8ff"],
        ["#ffffff", "#d8ceeb", "#9f91bd"],
        "#304c6e"
      ),
      blackglaze: variant(
        "blueglaze",
        "亮釉曜石黑",
        "OBSIDIAN GLAZE",
        ["#090d14", "#39434f", "#101923", "#94a5ba", "#dce5ee"],
        ["#d9e3ed", "#4a596a", "#101923"],
        "#ffffff"
      ),
      whiteice: { ...variant(
        "iceglaze",
        "冰透霜白",
        "FROST WHITE ICE",
        ["#c0cdd6", "#f6fbff", "#dce8ef", "#effaff", "#ffffff"],
        ["#ffffff", "#e7f2f7", "#abbfc9"],
        "#405765"
      ), number: 119 }
    };
    exports.glazeVariants = glazeVariants;
  });
  __define("src/skins/layered-texture.js", function(__require2, __import2, exports) {
    const { glazeVariants } = __require2("src/skins/glaze-variants.js");
    const arcLayers = ["main", "secondary", "reflection"];
    const defaults = { "baseColor": "#253bb9", "bodyColor": "#359ee5", "bodyEndColor": "#2451c9", "bodyGradientStrength": 50, "bodyGradientAngle": 90, "bodyGradientRange": 100, "bodyX": 129, "bodyY": 104, "bodyWidth": 190, "bodyHeight": 166, "bodyBlur": 12, "bodyOpacity": 100, "mainColor": "#ffffff", "mainInset": 10, "mainWidth": 8, "mainStart": 85, "mainLength": 12, "mainFadeRange": 35, "mainFadeStrength": 100, "mainBlur": 1, "mainOpacity": 95, "secondaryColor": "#dbf1ff", "secondaryInset": 5, "secondaryWidth": 4, "secondaryStart": 66, "secondaryLength": 17, "secondaryFadeRange": 35, "secondaryFadeStrength": 100, "secondaryBlur": 1.5, "secondaryOpacity": 30, "reflectionColor": "#a8c7ff", "reflectionInset": 7, "reflectionWidth": 16, "reflectionStart": 26, "reflectionLength": 20, "reflectionFadeRange": 35, "reflectionFadeStrength": 100, "reflectionBlur": 3, "reflectionOpacity": 60, "edgeColor": "#d5efff", "edgeWidth": 4, "edgeBlur": 1.5, "edgeOpacity": 55, "eyeColor": "#ffffff" };
    function matchingIceEyeColor(values) {
      const color = values.baseColor || values.bodyColor || "#94afd0";
      const [r, g, b] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
      const lightness = (max + min) / 2;
      let hue = 0;
      if (delta) hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      const saturation = delta < 0.025 ? 0.08 : Math.max(0.24, Math.min(0.55, delta / (1 - Math.abs(2 * lightness - 1))));
      const chroma = (1 - Math.abs(2 * 0.31 - 1)) * saturation;
      const x = chroma * (1 - Math.abs(hue % 2 - 1)), m = 0.31 - chroma / 2;
      const rgb = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][Math.floor(hue)];
      return "#" + rgb.map((value) => Math.round((value + m) * 255).toString(16).padStart(2, "0")).join("");
    }
    function layerDefaults(name) {
      var _a, _b;
      const values = { ...defaults };
      if ((((_a = glazeVariants[name]) == null ? void 0 : _a.source) || name) === "iceglaze") Object.assign(values, {
        baseColor: "#94afd0",
        bodyColor: "#d4e3f3",
        bodyEndColor: "#b4cbe3",
        bodyGradientStrength: 0,
        reflectionColor: "#edf7ff",
        edgeColor: "#f3f8ff"
      });
      Object.assign(values, (_b = glazeVariants[name]) == null ? void 0 : _b.palette);
      if (["iceglaze", "mintice", "blushice", "champagneice"].includes(name)) values.eyeColor = matchingIceEyeColor(values);
      return values;
    }
    function drawRibbon(layer, shape, values, key) {
      const doc = layer.ownerDocument;
      const ns = "http://www.w3.org/2000/svg";
      const fragment = doc.createDocumentFragment();
      const make = (tag, attrs, parent) => {
        const node = doc.createElementNS(ns, tag);
        for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
        parent.append(node);
        return node;
      };
      const span = values[`${key}Length`] / 100;
      const total = shape.getTotalLength();
      const start = values[`${key}Start`] / 100;
      const fadeRange = values[`${key}FadeRange`] / 100;
      const strength = values[`${key}FadeStrength`] / 100;
      const fade = (t) => {
        const distance = Math.min(t, 1 - t);
        const u = fadeRange > 0 ? Math.min(1, Math.max(0, distance / fadeRange)) : 1;
        return 1 - strength + strength * u * u * (3 - 2 * u);
      };
      const at = (length) => shape.getPointAtLength((length % total + total) % total);
      const point = (t) => at((start + t * span) * total);
      const pieces = Math.max(1, Math.ceil(span * 8));
      const defs = make("defs", {}, fragment);
      for (let i = 0; i < pieces; i++) {
        const a = i / pieces, b = (i + 1) / pieces;
        const first = point(a), last = point(b);
        const gradientId = `${layer.id}-fade-${i}`;
        const paint = make("linearGradient", { id: gradientId, gradientUnits: "userSpaceOnUse", x1: first.x, y1: first.y, x2: last.x, y2: last.y }, defs);
        for (let j = 0; j <= 8; j++) make("stop", { offset: j / 8, "stop-color": values[`${key}Color`], "stop-opacity": fade(a + (b - a) * j / 8) }, paint);
        const outer = [], inner = [];
        const steps = Math.max(8, Math.ceil(total * span / pieces / 3));
        for (let j = 0; j <= steps; j++) {
          const t = a + (b - a) * j / steps, distance = (start + t * span) * total;
          const center = point(t), before = at(distance - 0.4), after = at(distance + 0.4);
          const dx = after.x - before.x, dy = after.y - before.y;
          const magnitude = Math.hypot(dx, dy) || 1;
          const halfWidth = values[`${key}Width`] / 2 * (0.15 + 0.85 * Math.sqrt(fade(t)));
          outer.push(`${center.x + dy / magnitude * halfWidth} ${center.y - dx / magnitude * halfWidth}`);
          inner.push(`${center.x - dy / magnitude * halfWidth} ${center.y + dx / magnitude * halfWidth}`);
        }
        make("path", { d: `M${outer.join("L")}L${inner.reverse().join("L")}Z`, fill: `url(#${gradientId})` }, fragment);
      }
      layer.replaceChildren(fragment);
    }
    function setLayers(get, values, shape) {
      const body = get("body");
      const sx = values.bodyWidth / 200, sy = values.bodyHeight / 200;
      body.setAttribute("transform", `translate(${values.bodyX - 120 * sx} ${values.bodyY - 120 * sy}) scale(${sx} ${sy})`);
      const paint = get("body-paint");
      const angle = values.bodyGradientAngle * Math.PI / 180;
      const radius = values.bodyGradientRange / 200;
      paint.setAttribute("x1", 0.5 - Math.cos(angle) * radius);
      paint.setAttribute("y1", 0.5 - Math.sin(angle) * radius);
      paint.setAttribute("x2", 0.5 + Math.cos(angle) * radius);
      paint.setAttribute("y2", 0.5 + Math.sin(angle) * radius);
      const strength = values.bodyGradientStrength / 100;
      const endColor = "#" + [1, 3, 5].map((offset) => {
        const from = parseInt(values.bodyColor.slice(offset, offset + 2), 16);
        const to = parseInt(values.bodyEndColor.slice(offset, offset + 2), 16);
        return Math.round(from + (to - from) * strength).toString(16).padStart(2, "0");
      }).join("");
      paint.firstElementChild.setAttribute("stop-color", values.bodyColor);
      paint.lastElementChild.setAttribute("stop-color", endColor);
      body.setAttribute("opacity", values.bodyOpacity / 100);
      get("body-blur").firstElementChild.setAttribute("stdDeviation", values.bodyBlur);
      for (const key of arcLayers) {
        const layer = get(key);
        const scale = 1 - values[`${key}Inset`] / 100;
        const offset = 120 * (1 - scale);
        const length = values[`${key}Length`];
        layer.setAttribute("transform", `translate(${offset} ${offset}) scale(${scale})`);
        layer.setAttribute("opacity", length <= 0 ? 0 : values[`${key}Opacity`] / 100);
        drawRibbon(layer, shape, values, key);
        get(`${key}-blur`).firstElementChild.setAttribute("stdDeviation", values[`${key}Blur`]);
      }
      const edge = get("edge");
      edge.setAttribute("stroke", values.edgeColor);
      edge.setAttribute("stroke-width", values.edgeWidth);
      edge.setAttribute("opacity", values.edgeOpacity / 100);
      get("edge-blur").firstElementChild.setAttribute("stdDeviation", values.edgeBlur);
    }
    function createLayerTexture(defs, id, name, el, gradient) {
      const values = layerDefaults(name);
      const shape = defs.querySelector("#headShape");
      const p = el("pattern", { id, width: 240, height: 240, patternUnits: "userSpaceOnUse" }, defs);
      const nodes = /* @__PURE__ */ new Map();
      const add = (key, tag, attrs, parent) => {
        const node = el(tag, { id: `${id}-${key}`, ...attrs }, parent);
        nodes.set(key, node);
        return node;
      };
      const blur = (key) => {
        const filter = add(`${key}-blur`, "filter", { filterUnits: "userSpaceOnUse", x: -200, y: -200, width: 640, height: 640, "color-interpolation-filters": "sRGB" }, defs);
        el("feGaussianBlur", { stdDeviation: 0 }, filter);
        return `url(#${id}-${key}-blur)`;
      };
      const bodyPaint = gradient(defs, "linearGradient", `${id}-body-paint`, {}, [[0, values.bodyColor], [1, values.bodyEndColor]]);
      nodes.set("body-paint", bodyPaint);
      add("body", "use", { href: "#headShape", fill: `url(#${id}-body-paint)`, filter: blur("body") }, p);
      for (const key of arcLayers) {
        add(key, "g", { filter: blur(key) }, p);
      }
      add("edge", "use", { href: "#headShape", fill: "none", filter: blur("edge") }, p);
      setLayers((key) => nodes.get(key), values, shape);
      p._layerValues = values;
      let drawn = shape.getBBox(), drawnAt = performance.now(), pending = 0;
      const redraw = () => {
        pending = 0;
        if (!p.isConnected) return;
        for (const key of arcLayers) drawRibbon(nodes.get(key), shape, p._layerValues, key);
        drawn = shape.getBBox();
        drawnAt = performance.now();
      };
      const observer = new MutationObserver(() => {
        if (!p.isConnected) {
          observer.disconnect();
          return;
        }
        const box = shape.getBBox();
        const moved = Math.max(
          Math.abs(box.x - drawn.x),
          Math.abs(box.y - drawn.y),
          Math.abs(box.width - drawn.width),
          Math.abs(box.height - drawn.height)
        );
        if (moved > 1.5) redraw();
        else if (moved > 0.5 && !pending) pending = setTimeout(redraw, Math.max(0, 250 - (performance.now() - drawnAt)));
      });
      observer.observe(shape, { attributes: true, attributeFilter: ["d"] });
      return p;
    }
    exports.matchingIceEyeColor = matchingIceEyeColor;
    exports.layerDefaults = layerDefaults;
    exports.createLayerTexture = createLayerTexture;
  });
  __define("src/skins/metal-tint.js", function(__require2, __import2, exports) {
    function metalTint(color, family) {
      const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
      const lightness = (Math.max(...channels) + Math.min(...channels)) / 2;
      const hue = family === "gold" ? 44 / 60 : 22 / 60;
      const saturation = family === "gold" ? 0.58 : 0.48;
      const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
      const x = c * (1 - Math.abs(hue % 2 - 1)), m = lightness - c / 2;
      return "#" + [c, x, 0].map((value) => Math.round((value + m) * 255).toString(16).padStart(2, "0")).join("");
    }
    exports.metalTint = metalTint;
  });
  __define("src/skins/wood-materials.js", function(__require2, __import2, exports) {
    const grainStyles = {
      woodmaple: { seed: 17, dark: "#a17849", light: "#fff0cd", sway: 3.5, bend: 5, knotX: 64, knotY: 163, pores: 32 },
      woodoak: { seed: 29, dark: "#70451e", light: "#ffe3ad", sway: 5, bend: 22, knotX: 142, knotY: 93, pores: 112, cathedral: true },
      woodwalnut: { seed: 43, dark: "#2e1a11", light: "#d8ac79", sway: 9, bend: 29, knotX: 68, knotY: 165, pores: 78, knot: true },
      woodrose: { seed: 59, dark: "#481b13", light: "#edb487", sway: 6, bend: 13, knotX: 176, knotY: 66, pores: 65, slant: 0.09 },
      woodebony: { seed: 73, dark: "#090806", light: "#bb9360", sway: 2, bend: 3, knotX: 190, knotY: 135, pores: 48 }
    };
    function woodTexture(defs, id, kind, el, gradient) {
      const grain = grainStyles[kind];
      if (!grain) return null;
      const pattern = el("pattern", { id, width: 240, height: 240, patternUnits: "userSpaceOnUse" }, defs);
      let seed = grain.seed;
      const random = () => {
        seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
        return seed / 4294967296;
      };
      gradient(
        defs,
        "linearGradient",
        `${id}-wood-grain`,
        { x1: "0", y1: "0", x2: "1", y2: ".65" },
        [[0, grain.dark, 0.45], [0.45, grain.dark, 0.7], [1, grain.dark, 0.52]]
      );
      gradient(
        defs,
        "linearGradient",
        `${id}-wood-fiber`,
        { x1: ".1", y1: "0", x2: ".9", y2: "1" },
        [[0, grain.light, 0.3], [0.5, grain.light, 0.17], [1, grain.light, 0.26]]
      );
      const dark = `url(#${id}-wood-grain)`, light = `url(#${id}-wood-fiber)`;
      const warp = el("filter", { id: `${id}-wood-warp`, x: "-10%", y: "-10%", width: "120%", height: "120%" }, defs);
      el("feTurbulence", { type: "fractalNoise", baseFrequency: ".045 .018", numOctaves: 2, seed: grain.seed, result: "grain-noise" }, warp);
      el("feDisplacementMap", { in: "SourceGraphic", in2: "grain-noise", scale: 1.6, xChannelSelector: "R", yChannelSelector: "G" }, warp);
      const fibers = el("g", { filter: `url(#${id}-wood-warp)` }, pattern);
      const stroke = (d, paint, width, opacity, target = fibers) => el("path", {
        d,
        fill: "none",
        stroke: paint,
        "stroke-width": width,
        opacity,
        "stroke-linecap": "round",
        "stroke-linejoin": "round"
      }, target);
      const flow = (x, y, phase) => {
        const distance = x - grain.knotX;
        const aroundKnot = Math.sign(distance) * grain.bend * Math.exp(-Math.abs(distance) / 35) * Math.exp(-(((y - grain.knotY) / 48) ** 2));
        return x + Math.sin(y * 0.023 + phase) * grain.sway + Math.sin(y * 0.057 + phase * 0.7) * grain.sway * 0.22 + aroundKnot + (grain.slant || 0) * (y - 120);
      };
      for (let index = 0; index < 122; index++) {
        const x = -26 + index * 2.45 + random() * 1.4, phase = x * 0.024 + random() * 0.45;
        let d = "";
        for (let y = -24; y <= 264; y += 12) d += `${y === -24 ? "M" : "L"}${flow(x, y, phase).toFixed(2)} ${y}`;
        if (index % 9 === 0) stroke(d, dark, 2.2 + random() * 3.5, 0.08 + random() * 0.09);
        stroke(d, index % 5 === 0 ? light : dark, 0.3 + random() * 0.55, 0.18 + random() * 0.42);
      }
      if (grain.cathedral) {
        for (let index = 0; index < 15; index++) {
          const width = 8 + index * 3.8, top = 145 - index * 7.3, cx = grain.knotX + Math.sin(index * 0.8) * 2;
          stroke(
            `M${cx - width} 258 C${cx - width * 1.18} 201 ${cx - width * 0.72} ${top + 19} ${cx} ${top}
        C${cx + width * 0.7} ${top + 21} ${cx + width * 1.14} 202 ${cx + width} 258`,
            dark,
            index % 4 === 0 ? 1.2 : 0.55,
            0.21 + random() * 0.18
          );
        }
      }
      if (grain.knot) {
        for (let index = 0; index < 6; index++) {
          const rx = 2 + index * 2.3, ry = 5 + index * 5.4, cx = grain.knotX, cy = grain.knotY;
          stroke(`M${cx} ${cy - ry} C${cx + rx * 1.3} ${cy - ry * 0.5} ${cx + rx} ${cy + ry * 0.6} ${cx} ${cy + ry}
        C${cx - rx * 0.85} ${cy + ry * 0.55} ${cx - rx * 1.2} ${cy - ry * 0.6} ${cx} ${cy - ry}Z`, dark, 0.6, 0.46 - index * 0.045);
        }
      }
      for (let index = 0; index < grain.pores; index++) {
        const x = 20 + random() * 200, y = 28 + random() * 180, length = 1.2 + random() * 5.8;
        stroke(`M${x} ${y}q${(random() - 0.5) * 1.4} ${length / 2} ${(random() - 0.5) * 1.4} ${length}`, dark, 0.4 + random() * 0.45, 0.12 + random() * 0.3);
      }
      return pattern;
    }
    exports.woodTexture = woodTexture;
  });
  __define("src/skins/soft-materials.js", function(__require2, __import2, exports) {
    const { createLayerTexture } = __require2("src/skins/layered-texture.js");
    const { metalTint } = __require2("src/skins/metal-tint.js");
    const { woodTexture } = __require2("src/skins/wood-materials.js");
    const translucentShadowStrength = {
      clearwhite: 0.2,
      clearpale: 0.32,
      clearsilver: 0.46,
      clearweighted: 0.4,
      clearhard: 0.42,
      clearsmoke: 0.68,
      clearink: 1
    };
    const SOFT = /* @__PURE__ */ new Set(["blackglaze", "blueglaze", "jadeglaze", "berryglaze", "amberglaze", "irisglaze", "iceglaze", "mintice", "blushice", "champagneice", "lavenderice", "whiteice", "clearsilver", "clearweighted", "clearhard", "silverdrop", "woodmaple", "woodoak", "woodwalnut", "woodrose", "woodebony", "matcharib"]);
    const LAYERED = /* @__PURE__ */ new Set(["blackglaze", "blueglaze", "jadeglaze", "berryglaze", "amberglaze", "irisglaze", "iceglaze", "mintice", "blushice", "champagneice", "lavenderice", "whiteice"]);
    const WOOD = /* @__PURE__ */ new Set(["woodmaple", "woodoak", "woodwalnut", "woodrose", "woodebony"]);
    const METAL_FAMILY = { golddrop: "gold", copperdeep: "copper" };
    function softTexture(defs, id, kind, el, gradient) {
      if (!SOFT.has(kind)) return null;
      if (WOOD.has(kind)) return woodTexture(defs, id, kind, el, gradient);
      if (LAYERED.has(kind)) return createLayerTexture(defs, id, kind, el, gradient);
      const p = el("pattern", { id, width: 240, height: 240, patternUnits: "userSpaceOnUse" }, defs);
      const path = (d, stroke, width = 1, fill = "none", opacity = 1) => el("path", { d, stroke, "stroke-width": width, fill, opacity, "stroke-linecap": "round", "stroke-linejoin": "round" }, p);
      const metalFamily = METAL_FAMILY[id.replace(/^material-/, "").replace(/-texture$/, "")];
      const radial = (name, stops, attrs = {}) => {
        const palette = metalFamily ? stops.map(([offset, color, opacity = 1]) => [offset, metalTint(color, metalFamily), opacity]) : stops;
        gradient(defs, "radialGradient", `${id}-${name}`, { cx: ".35", cy: ".25", r: ".8", ...attrs }, palette);
        return `url(#${id}-${name})`;
      };
      const shine = (name, stops) => {
        gradient(defs, "linearGradient", `${id}-${name}`, { x1: "0", y1: "0", x2: ".3", y2: "1" }, stops);
        return `url(#${id}-${name})`;
      };
      if (kind === "matcharib") {
        const rib = el("pattern", { id: `${id}-ribs`, width: 9, height: 240, patternUnits: "userSpaceOnUse" }, defs);
        gradient(
          defs,
          "linearGradient",
          `${id}-rib-light`,
          { x1: "0", y1: "0", x2: "1", y2: "0" },
          [[0, "#244d1b", 0.32], [0.25, "#bfe47b", 0.1], [0.48, "#edffc4", 0.26], [0.72, "#5e912e", 0.06], [1, "#244d1b", 0.32]]
        );
        el("rect", { width: 9, height: 240, fill: `url(#${id}-rib-light)` }, rib);
        el("rect", { width: 240, height: 240, fill: `url(#${id}-ribs)` }, p);
        for (let i = 0; i < 240; i++) {
          const x = 22 + i * 31.17 % 196, y = 22 + i * i * 7.73 % 196;
          path(`M${x} ${y}l${i % 2 ? 1 : -1} -2`, i % 3 ? "#e5f9b6" : "#345c23", 0.6, "none", 0.2);
        }
        const glow = radial("nap", [[0, "#eaffb5", 0.3], [0.6, "#ceec95", 0.07], [1, "#eaffb5", 0]]);
        el("ellipse", { cx: 83, cy: 58, rx: 91, ry: 64, fill: glow }, p);
      } else if (["clearsilver", "clearweighted", "clearhard"].includes(kind)) {
        const softEdge = el("filter", { id: `${id}-soft-edge`, x: "-40%", y: "-40%", width: "180%", height: "180%" }, defs);
        el("feGaussianBlur", { stdDeviation: 5 }, softEdge);
        const innerShade = shine("inner-shade", [[0, "#4d6573", 0.08], [0.24, "#344f60", 0.52], [0.6, "#4b687b", 0.37], [1, "#829ca9", 0]]);
        const innerShadeShape = "M181 39C210 55 216 87 213 117C212 145 202 166 190 180L182 169C196 139 200 117 196 90C194 69 189 51 181 39Z";
        const curve = path(innerShadeShape, "none", 0, innerShade);
        curve.setAttribute("filter", `url(#${id}-soft-edge)`);
        const depth = radial("inner-depth", [[0, "#3c5869", 0.34], [0.4, "#658391", 0.18], [1, "#9cb1bd", 0]], { cx: ".5", cy: ".5", r: ".5" });
        el("ellipse", { cx: 126, cy: 209, rx: 88, ry: 23, fill: depth, transform: "rotate(-5 126 209)" }, p);
        if (kind === "clearweighted") {
          gradient(
            defs,
            "linearGradient",
            `${id}-weight`,
            { x1: "0", y1: "0", x2: "0", y2: "1" },
            [[0, "#567180", 0], [0.3, "#567180", 0.04], [0.6, "#3e5b6d", 0.24], [0.84, "#2e495c", 0.5], [1, "#253e50", 0.57]]
          );
          el("rect", { x: 0, y: 144, width: 240, height: 96, fill: `url(#${id}-weight)` }, p);
        }
        const transmitted = radial("transmitted", [[0, "#f6fdff", 0.75], [0.3, "#e8f7ff", 0.46], [0.68, "#cbe3ee", 0.15], [1, "#cbe3ee", 0]], { cx: ".5", cy: ".5", r: ".5" });
        el("ellipse", { cx: 194, cy: 157, rx: 25, ry: 57, fill: transmitted, transform: "rotate(17 194 157)" }, p);
        el("ellipse", { cx: 126, cy: 214, rx: 73, ry: 14, fill: transmitted, opacity: kind === "clearweighted" ? 0.55 : 1 }, p);
        if (kind === "clearhard") {
          const hard = radial("hard-light", [[0, "#ffffff", 1], [0.68, "#ffffff", 1], [0.86, "#ffffff", 0.94], [0.95, "#f4fbff", 0.55], [1, "#f4fbff", 0]], { cx: ".5", cy: ".5", r: ".5" });
          el("ellipse", { cx: 79, cy: 51, rx: 43, ry: 12, fill: hard, transform: "rotate(-18 79 51)" }, p);
        } else {
          const white = radial("softbox", [[0, "#ffffff", 0.96], [0.3, "#ffffff", 0.78], [0.63, "#f4fbff", 0.28], [1, "#e8f3ff", 0]], { cx: ".5", cy: ".5", r: ".5" });
          el("ellipse", { cx: 76, cy: 55, rx: 59, ry: 27, fill: white, transform: "rotate(-18 76 55)" }, p);
        }
        const warm = radial("warm-transmission", [[0, "#fff1da", 0.25], [1, "#fff1da", 0]], { cx: ".5", cy: ".5", r: ".5" });
        el("ellipse", { cx: 49, cy: 140, rx: 33, ry: 68, fill: warm }, p);
        {
          const bottomShade = gradient(
            defs,
            "linearGradient",
            `${id}-bottom-shade-v2`,
            { x1: ".5", y1: "0", x2: ".5", y2: "1" },
            [[0, "#476171", 0], [0.24, "#344e60", 0.34], [0.56, "#213b4d", 0.86], [0.8, "#294455", 0.84], [1, "#58717f", 0.22]]
          );
          const bottomSoft = el("filter", { id: `${id}-bottom-soft-v2`, x: "-30%", y: "-100%", width: "160%", height: "300%" }, defs);
          el("feGaussianBlur", { stdDeviation: 3.5 }, bottomSoft);
          const materialName = id.replace(/^material-/, "").replace(/-texture$/, "");
          const bottom = el("g", {
            id: `${id}-bottom-shadow`,
            opacity: translucentShadowStrength[materialName] ?? 1,
            "data-x": 0,
            "data-y": 0,
            "data-width": 100,
            "data-height": 100
          }, p);
          el("path", {
            d: "M39 172C55 186 80 189 120 189C159 189 184 185 201 172C197 188 181 199 158 202C137 205 103 205 81 202C58 199 43 189 39 172Z",
            fill: `url(#${bottomShade.id})`,
            filter: `url(#${id}-bottom-soft-v2)`
          }, bottom);
        }
      } else if (kind === "silverdrop") {
        const dark = radial("studio-dark", [[0, "#43545f", 0.64], [0.35, "#586b76", 0.43], [0.7, "#86969f", 0.14], [1, "#a6b3bb", 0]], { cx: ".5", cy: ".5", r: ".5" });
        el("ellipse", { cx: 222, cy: 105, rx: 65, ry: 115, fill: dark, transform: "rotate(-12 222 105)" }, p);
        const underside = radial("underside", [[0, "#4d5d67", 0.44], [0.45, "#63747e", 0.22], [1, "#94a4ac", 0]], { cx: ".5", cy: ".5", r: ".5" });
        el("ellipse", { cx: 126, cy: 237, rx: 128, ry: 70, fill: underside }, p);
        const white = radial("studio-white", [[0, "#ffffff", 0.94], [0.28, "#ffffff", 0.76], [0.6, "#f4faff", 0.26], [1, "#e5f3ff", 0]], { cx: ".5", cy: ".5", r: ".5" });
        el("ellipse", { cx: 78, cy: 57, rx: 67, ry: 35, fill: white, transform: "rotate(-18 78 57)" }, p);
        const rimLight = radial("rim-light", [[0, "#f6fbff", 0.72], [0.3, "#edf6ff", 0.4], [0.65, "#d8e8f2", 0.12], [1, "#d8e8f2", 0]], { cx: ".5", cy: ".5", r: ".5" });
        el("ellipse", { cx: 216, cy: 145, rx: 28, ry: 78, fill: rimLight, transform: "rotate(9 216 145)" }, p);
        const floorBounce = radial("floor-bounce", [[0, "#e2ebee", 0.36], [0.45, "#d8e3e8", 0.14], [1, "#d8e3e8", 0]], { cx: ".5", cy: ".5", r: ".5" });
        el("ellipse", { cx: 120, cy: 222, rx: 92, ry: 24, fill: floorBounce }, p);
        const warm = radial("warm-room", [[0, "#e8ceac", 0.22], [1, "#e8ceac", 0]], { cx: ".5", cy: ".5", r: ".5" });
        el("ellipse", { cx: 39, cy: 137, rx: 35, ry: 75, fill: warm }, p);
      }
      return p;
    }
    exports.softTexture = softTexture;
  });
  __define("src/skins/material-library.js", function(__require2, __import2, exports) {
    const { MATERIALS: skins } = __require2("src/skins/material-data.js");
    const { extraTexture } = __require2("src/skins/more-materials.js");
    const { collectionTexture } = __require2("src/skins/collection-materials.js");
    const { revisionTexture } = __require2("src/skins/revised-materials.js");
    const { secondPassTexture } = __require2("src/skins/second-pass-materials.js");
    const { sportsTexture } = __require2("src/skins/sports-materials.js");
    const { softTexture } = __require2("src/skins/soft-materials.js");
    const { layerDefaults } = __require2("src/skins/layered-texture.js");
    const NS = "http://www.w3.org/2000/svg";
    function svgElement(tag, attributes = {}, parent) {
      const element = document.createElementNS(NS, tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      parent == null ? void 0 : parent.append(element);
      return element;
    }
    function gradient(defs, tag, id, attributes, stops) {
      const element = svgElement(tag, { id, ...attributes }, defs);
      for (const [offset, color, opacity = 1] of stops) {
        svgElement("stop", { offset, "stop-color": color, "stop-opacity": opacity }, element);
      }
      return element;
    }
    function texture(defs, id, kind) {
      const extra = softTexture(defs, id, kind, svgElement, gradient) || sportsTexture(defs, id, kind, svgElement, gradient) || secondPassTexture(defs, id, kind, svgElement, gradient) || revisionTexture(defs, id, kind, svgElement, gradient) || collectionTexture(defs, id, kind, svgElement, gradient) || extraTexture(defs, id, kind, svgElement, gradient);
      if (extra) return extra;
      const tileSize = {
        brushed: 8,
        grain: 48,
        wood: 120,
        marble: 220,
        denim: 8,
        carbon: 240,
        galaxy: 220,
        lava: 120,
        terrazzo: 80,
        cow: 160,
        seeds: 52,
        honey: 48,
        blueprint: 80
      }[kind] || 32;
      const pattern = svgElement("pattern", {
        id,
        width: tileSize,
        height: tileSize,
        patternUnits: "userSpaceOnUse",
        ...kind === "stripes" ? { patternTransform: "rotate(-32)" } : {}
      }, defs);
      if (kind === "stripes") {
        svgElement("rect", { width: 14, height: 32, fill: "#fff4f6", opacity: 0.88 }, pattern);
        svgElement("rect", { x: 20, width: 3, height: 32, fill: "#fff4f6", opacity: 0.48 }, pattern);
      } else if (kind === "grain") {
        for (let i = 0; i < 64; i++) {
          svgElement("circle", {
            cx: i * 17.37 % 48,
            cy: i * i * 7.13 % 48,
            r: 0.35 + i % 3 * 0.18,
            fill: i % 2 ? "#fff4de" : "#6f3a27",
            opacity: 0.18
          }, pattern);
        }
      } else if (kind === "dots") {
        for (const [cx, cy] of [[8, 8], [24, 24]]) {
          svgElement("circle", { cx, cy, r: 4.6, fill: "#f6db7b" }, pattern);
        }
      } else if (kind === "denim") {
        svgElement("path", { d: "M-4 8L8-4M0 12L12 0", stroke: "#94daff", "stroke-width": 2.6, opacity: 0.35 }, pattern);
        svgElement("path", { d: "M0 1H8M0 5H8", stroke: "#0a2a49", "stroke-width": 0.2, opacity: 0.45 }, pattern);
      } else if (kind === "carbon") {
        gradient(
          defs,
          "linearGradient",
          `${id}-warp`,
          { x1: "0", y1: "0", x2: "1", y2: "0" },
          [[0, "#142024"], [0.22, "#37464a"], [0.48, "#526064"], [0.72, "#354347"], [1, "#18252a"]]
        );
        gradient(
          defs,
          "linearGradient",
          `${id}-weft`,
          { x1: "0", y1: "0", x2: "0", y2: "1" },
          [[0, "#0d191f"], [0.25, "#27353b"], [0.52, "#3c4c52"], [0.78, "#26363c"], [1, "#101c23"]]
        );
        const weave = svgElement("pattern", {
          id: `${id}-weave`,
          width: 32,
          height: 32,
          patternUnits: "userSpaceOnUse",
          patternTransform: "rotate(-18 120 120)"
        }, defs);
        svgElement("rect", { width: 32, height: 32, fill: "#101b20" }, weave);
        for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
          const x = col * 8, y = row * 8, vertical = (row - col + 4) % 4 < 2;
          svgElement("rect", {
            x: x + 0.35,
            y: y + 0.35,
            width: 7.3,
            height: 7.3,
            rx: 0.65,
            fill: `url(#${id}-${vertical ? "warp" : "weft"})`
          }, weave);
          for (const offset of [1.7, 3.3, 4.9, 6.5]) {
            svgElement("path", {
              d: vertical ? `M${x + offset} ${y + 0.7}v6.6` : `M${x + 0.7} ${y + offset}h6.6`,
              stroke: vertical ? "#bdc8c6" : "#91a6ab",
              "stroke-width": 0.36,
              opacity: vertical ? 0.24 : 0.18
            }, weave);
          }
        }
        svgElement("rect", { width: 240, height: 240, fill: `url(#${id}-weave)` }, pattern);
        gradient(
          defs,
          "linearGradient",
          `${id}-resin`,
          { x1: ".05", y1: ".1", x2: ".95", y2: ".8" },
          [
            [0, "#e3efec", 0],
            [0.24, "#e3efec", 0.02],
            [0.42, "#e3efec", 0.18],
            [0.55, "#e3efec", 0.05],
            [0.72, "#e3efec", 0],
            [1, "#031119", 0.12]
          ]
        );
        svgElement("rect", { width: 240, height: 240, fill: `url(#${id}-resin)` }, pattern);
      } else if (kind === "galaxy") {
        gradient(defs, "radialGradient", `${id}-cloud`, {}, [[0, "#d77cff", 0.83], [0.35, "#ad59ed", 0.56], [0.65, "#8452d9", 0.25], [1, "#8452d9", 0]]);
        svgElement("ellipse", { cx: 72, cy: 106, rx: 110, ry: 51, fill: `url(#${id}-cloud)`, transform: "rotate(-35 72 106)" }, pattern);
        gradient(defs, "radialGradient", `${id}-blue`, {}, [[0, "#70d4ff", 0.68], [0.4, "#4aabf0", 0.35], [1, "#4aabf0", 0]]);
        svgElement("ellipse", { cx: 150, cy: 64, rx: 72, ry: 65, fill: `url(#${id}-blue)` }, pattern);
        gradient(defs, "radialGradient", `${id}-starlight`, {}, [[0, "#eef8ff", 0.6], [0.25, "#d0e6ff", 0.2], [1, "#bdd9ff", 0]]);
        for (let i = 0; i < 84; i++) {
          const cx = i * 37.13 % 220, cy = i * i * 11.79 % 220, bright = i % 10 === 0;
          if (bright) svgElement("circle", { cx, cy, r: 5.5, fill: `url(#${id}-starlight)` }, pattern);
          svgElement("circle", {
            cx,
            cy,
            r: bright ? 1.85 : 0.75 + i % 3 * 0.22,
            fill: i % 4 ? "#fff5e5" : "#cdefff",
            opacity: 0.64 + i % 4 * 0.11
          }, pattern);
        }
        svgElement("path", { d: "M156 164h14m-7-7v14M44 40h11m-5.5-5.5v11M177 72h9m-4.5-4.5v9", stroke: "#fff2ce", "stroke-width": 1, opacity: 0.95 }, pattern);
      } else if (kind === "terrazzo") {
        const colors = ["#a47d73", "#789b91", "#d3a963", "#a9a1b8", "#e0b2a4"];
        for (let i = 0; i < 24; i++) {
          const x = i * 29.17 % 80, y = i * i * 13.31 % 80, s = 3 + i % 4 * 1.4;
          svgElement("path", { d: `M${x} ${y}l${s} ${s * 0.4} ${-s * 0.3} ${s} ${-s * 0.9} ${-s * 0.3}Z`, fill: colors[i % colors.length], opacity: 0.75 }, pattern);
        }
      } else if (kind === "seeds") {
        for (const [cx, cy, angle] of [[13, 13, -20], [39, 39, 25]]) svgElement("ellipse", { cx, cy, rx: 3.3, ry: 4.6, fill: "#75000c", opacity: 0.75, transform: `rotate(${angle} ${cx} ${cy})` }, pattern);
      } else if (kind === "blueprint") {
        for (let p = 0; p <= 80; p += 10) svgElement("path", { d: `M${p} 0v80M0 ${p}h80`, stroke: "#d0eeff", "stroke-width": p % 40 === 0 ? 0.7 : 0.35, opacity: p % 40 === 0 ? 0.37 : 0.18 }, pattern);
        svgElement("circle", { cx: 40, cy: 40, r: 21, fill: "none", stroke: "#dbf3ff", "stroke-width": 0.6, opacity: 0.36 }, pattern);
        svgElement("path", { d: "M10 10h12m-6-6v12M60 63h12m-6-6v12", stroke: "#dbf3ff", "stroke-width": 0.8, opacity: 0.55 }, pattern);
      }
      return pattern;
    }
    function applyMaterial(avatar, name) {
      const skin = skins[name];
      const root = avatar.shadowRoot;
      const defs = root.querySelector("svg defs");
      const head = root.getElementById("head");
      const originalDefs = new Set(defs.children);
      const originalFill = head.getAttribute("fill");
      const originalOpacity = head.getAttribute("fill-opacity");
      const properties = ["--material-eye", "--material-eye-right", "--material-eye-relief", "--material-separate-eye-relief", "--material-antenna", "--material-antenna-rim"];
      const originalProperties = properties.map((key) => [key, avatar.style.getPropertyValue(key)]);
      const id = `material-${name}`;
      const fill = (suffix) => `url(#${id}-${suffix})`;
      let eyeShadowOffset;
      if (skin.raisedEyes) {
        const eyeColor = skin.simpleLayers ? layerDefaults(name).eyeColor : "#ffffff";
        const tintEye = (original) => "#" + [1, 3, 5].map(
          (offset) => Math.round(parseInt(original.slice(offset, offset + 2), 16) * parseInt(eyeColor.slice(offset, offset + 2), 16) / 255).toString(16).padStart(2, "0")
        ).join("");
        gradient(
          defs,
          "radialGradient",
          `${id}-eye-porcelain`,
          { cx: ".32", cy: ".22", r: ".88" },
          [[0, tintEye("#ffffff")], [0.66, tintEye("#f2f3f8")], [0.88, tintEye("#e3e8f1")], [1, tintEye("#b5c4d9")]]
        );
        const relief = svgElement("filter", { id: `${id}-eye-relief`, x: "-60%", y: "-60%", width: "240%", height: "250%", "color-interpolation-filters": "sRGB" }, defs);
        svgElement("feGaussianBlur", { in: "SourceAlpha", stdDeviation: 4, result: "soft-shadow" }, relief);
        eyeShadowOffset = svgElement("feOffset", { in: "soft-shadow", dx: 5, dy: 8, result: "offset-shadow" }, relief);
        svgElement("feFlood", { "flood-color": skin.eyeShadow || (name === "blueglaze" ? "#102674" : "#53759f"), "flood-opacity": 0.34, result: "shadow-color" }, relief);
        svgElement("feComposite", { in: "shadow-color", in2: "offset-shadow", operator: "in", result: "shadow" }, relief);
        svgElement("feOffset", { in: "SourceAlpha", dx: 1, dy: 2, result: "raised-edge" }, relief);
        svgElement("feFlood", { "flood-color": tintEye("#a9bad1"), result: "edge-color" }, relief);
        svgElement("feComposite", { in: "edge-color", in2: "raised-edge", operator: "in", result: "edge" }, relief);
        const merge = svgElement("feMerge", {}, relief);
        for (const source of ["shadow", "edge", "SourceGraphic"]) svgElement("feMergeNode", { in: source }, merge);
      }
      const linear = name === "aurora" || skin.linear;
      const base = gradient(
        defs,
        linear ? "linearGradient" : "radialGradient",
        `${id}-base`,
        linear ? { x1: ".05", y1: ".05", x2: ".85", y2: ".98" } : { cx: ".32", cy: ".17", r: ".95" },
        skin.simpleLayers ? [[0, skin.darkColor], [1, skin.darkColor]] : skin.base.map((color, index) => [index / (skin.base.length - 1), color])
      );
      const specular = gradient(
        defs,
        "radialGradient",
        `${id}-shine`,
        { cx: ".30", cy: ".12", r: ".70" },
        [[0, "#fff", skin.shine], [0.23, "#fff", skin.shine * 0.3], [0.65, "#fff", 0.035], [1, "#fff", 0]]
      );
      const volume = gradient(
        defs,
        "radialGradient",
        `${id}-volume`,
        { cx: ".43", cy: ".30", r: ".76" },
        [[0, "#091126", 0], [0.58, "#091126", 0], [0.82, "#091126", skin.shade * 0.27], [1, "#091126", skin.shade]]
      );
      const rim = gradient(
        defs,
        "linearGradient",
        `${id}-rim`,
        { x1: "0", y1: "0", x2: "1", y2: "1" },
        [[0, "#fff", 0.95], [0.28, skin.rim, 0.6], [0.52, skin.rim, 0.06], [0.82, skin.rim, 0.13], [1, skin.rim, 0.65]]
      );
      const edge = gradient(
        defs,
        "radialGradient",
        `${id}-edge`,
        { cx: ".88", cy: ".83", r: ".55" },
        [[0, skin.rim, 0.25], [0.65, skin.rim, 0.035], [1, skin.rim, 0]]
      );
      const antenna = gradient(
        defs,
        "radialGradient",
        `${id}-antenna`,
        { cx: ".28", cy: ".20", r: ".85" },
        [[0, skin.antenna[0]], [0.43, skin.antenna[1]], [1, skin.antenna[2]]]
      );
      if (skin.pattern) texture(defs, `${id}-texture`, skin.pattern);
      const layers = svgElement("g", { "pointer-events": "none", "aria-hidden": "true" });
      head.after(layers);
      const shape = { href: "#headShape", transform: head.getAttribute("transform") };
      if (skin.pattern) svgElement("use", { ...shape, fill: fill("texture") }, layers);
      if (!skin.simpleLayers) {
        if (skin.translucent) {
          gradient(
            defs,
            "linearGradient",
            `${id}-glass`,
            { x1: "0", y1: "0", x2: ".6", y2: "1" },
            [[0, "#fff", 0.6], [0.14, "#fff", 0.03], [0.77, "#fff", 0.02], [1, skin.glassTint || "#c5fff2", 0.3]]
          );
          svgElement("use", { ...shape, fill: fill("glass"), stroke: skin.glassRim || "#d6fff5", "stroke-width": 5, "stroke-opacity": skin.glassEdgeOpacity ?? 0.25 }, layers);
        }
        svgElement("use", { ...shape, fill: fill("shine") }, layers);
        svgElement("use", { ...shape, fill: fill("volume") }, layers);
        svgElement("use", { ...shape, fill: fill("edge") }, layers);
        svgElement("use", { ...shape, fill: "none", stroke: fill("rim"), "stroke-width": 1.25, opacity: skin.rimOpacity ?? (skin.matte ? 0.3 : 1) }, layers);
      }
      if (skin.stitched) {
        const stitch = { color: "#ead09d", width: 3, dash: "6 6", inset: 0.85, opacity: 0.9, ...skin.stitch };
        svgElement("use", { href: "#headShape", transform: `translate(${120 * (1 - stitch.inset)} ${120 * (1 - stitch.inset)}) scale(${stitch.inset})`, fill: "none", stroke: stitch.color, "stroke-width": stitch.width, "stroke-dasharray": stitch.dash, "stroke-linecap": "round", opacity: stitch.opacity }, layers);
      }
      if (skin.edgeColor) svgElement("use", { ...shape, fill: "none", stroke: skin.edgeColor, "stroke-width": 7, opacity: 0.9 }, layers);
      const eyeParent = root.getElementById("leftEye").parentElement;
      const originalEyeOpacity = eyeParent.style.opacity;
      let mergedSurface;
      if (skin.raisedEyes) {
        const silhouette = svgElement("mask", {
          id: `${id}-joined-eyes`,
          maskUnits: "userSpaceOnUse",
          maskContentUnits: "userSpaceOnUse",
          x: 0,
          y: 0,
          width: 240,
          height: 240,
          "mask-type": "alpha"
        }, defs);
        for (const side of ["left", "right"]) svgElement("use", { href: `#${side}Eye` }, silhouette);
        mergedSurface = svgElement("g", {
          id: `${id}-joined-eye-surface`,
          "pointer-events": "none",
          "aria-hidden": "true",
          "clip-path": eyeParent.getAttribute("clip-path") || "none"
        });
        eyeParent.after(mergedSurface);
        const reliefSurface = svgElement("g", { style: "filter:var(--material-eye-relief,none)" }, mergedSurface);
        svgElement("rect", {
          x: 0,
          y: 0,
          width: 240,
          height: 240,
          fill: "var(--material-eye,#fff)",
          mask: `url(#${id}-joined-eyes)`
        }, reliefSurface);
      }
      let joinedNow = null;
      function mergeEyes(merged) {
        if (!mergedSurface) return;
        eyeParent.style.opacity = merged ? "0" : originalEyeOpacity;
        mergedSurface.style.display = merged ? "" : "none";
        if (merged) avatar.style.setProperty("--material-separate-eye-relief", "none");
        else avatar.style.removeProperty("--material-separate-eye-relief");
      }
      const onFaceState = (event) => {
        var _a;
        joinedNow = ((_a = event.detail) == null ? void 0 : _a.state) === "love";
        mergeEyes(joinedNow);
      };
      const onActionState = (event) => {
        var _a;
        if (((_a = event.detail) == null ? void 0 : _a.action) === "love" && event.detail.phase !== "start") {
          joinedNow = false;
          mergeEyes(false);
        }
      };
      if (mergedSurface) {
        avatar.addEventListener("face-state", onFaceState);
        avatar.addEventListener("action-state", onActionState);
        mergeEyes(Boolean(avatar._loveFx));
      }
      const style = document.createElement("style");
      style.textContent = `
    #leftBase,#rightBase,#leftInputBase,#rightInputBase{fill:var(--material-eye,#fff)}
    #rightBase,#rightInputBase{fill:var(--material-eye-right,var(--material-eye,#fff))}
    #antennaDot{fill:var(--material-antenna);stroke:var(--material-antenna-rim);stroke-width:.7px}
    ${skin.raisedEyes ? "#leftEye,#rightEye{filter:var(--material-separate-eye-relief,var(--material-eye-relief,none))}" : ""}
  `;
      root.append(style);
      const addedDefs = [...defs.children].filter((node) => !originalDefs.has(node));
      let disposed = false;
      const material = {
        dispose() {
          if (disposed) return;
          disposed = true;
          avatar.removeEventListener("face-state", onFaceState);
          avatar.removeEventListener("action-state", onActionState);
          eyeParent.style.opacity = originalEyeOpacity;
          mergedSurface == null ? void 0 : mergedSurface.remove();
          for (const node of addedDefs) node.remove();
          layers.remove();
          style.remove();
          if (originalFill === null) head.removeAttribute("fill");
          else head.setAttribute("fill", originalFill);
          if (originalOpacity === null) head.removeAttribute("fill-opacity");
          else head.setAttribute("fill-opacity", originalOpacity);
          for (const [key, value] of originalProperties) {
            if (value) avatar.style.setProperty(key, value);
            else avatar.style.removeProperty(key);
          }
        },
        // Called every frame: one surface while the eyes draw one shape.
        syncJoin() {
          if (!mergedSurface || !avatar._eyesAsOne) return;
          const on = avatar._eyesAsOne();
          if (on !== joinedNow) {
            joinedNow = on;
            mergeEyes(on);
          }
        },
        // Only these coordinates are driven by light(), not the saved material.
        lightKeys: [
          ...!linear ? ["base:cx", "base:cy"] : skin.linear ? ["base:x1", "base:x2"] : [],
          "shine:cx",
          "shine:cy",
          "volume:cx",
          "volume:cy",
          "edge:cx",
          "edge:cy",
          "rim:x1",
          "rim:x2",
          "antenna:cx",
          "antenna:cy"
        ],
        light(x, y) {
          if (eyeShadowOffset) {
            eyeShadowOffset.setAttribute("dx", -x * 8);
            eyeShadowOffset.setAttribute("dy", 5 - y * 6);
          }
          const cx = 0.5 + x * 0.3;
          const cy = 0.3 + y * 0.17;
          if (!linear) {
            base.setAttribute("cx", cx);
            base.setAttribute("cy", cy);
          } else if (skin.linear) {
            base.setAttribute("x1", 0.1 + x * 0.2);
            base.setAttribute("x2", 0.9 + x * 0.2);
          }
          specular.setAttribute("cx", cx);
          specular.setAttribute("cy", cy - 0.1);
          volume.setAttribute("cx", 0.5 + x * 0.12);
          volume.setAttribute("cy", 0.35 + y * 0.08);
          edge.setAttribute("cx", 0.5 - x * 0.42);
          edge.setAttribute("cy", 0.75 - y * 0.12);
          rim.setAttribute("x1", 0.5 + x * 0.5);
          rim.setAttribute("x2", 0.5 - x * 0.5);
          antenna.setAttribute("cx", cx);
          antenna.setAttribute("cy", Math.max(0.1, cy));
        }
      };
      head.setAttribute("fill", fill("base"));
      head.setAttribute("fill-opacity", skin.translucent ? skin.bodyOpacity ?? 0.58 : 1);
      avatar.style.setProperty("--material-eye", skin.raisedEyes ? fill("eye-porcelain") : skin.eye);
      avatar.style.setProperty("--material-eye-right", skin.raisedEyes ? fill("eye-porcelain") : skin.eyeRight || skin.eye);
      if (skin.raisedEyes) avatar.style.setProperty("--material-eye-relief", fill("eye-relief"));
      avatar.style.setProperty("--material-antenna", fill("antenna"));
      avatar.style.setProperty("--material-antenna-rim", skin.rim);
      material.light(-0.5, -0.5);
      return material;
    }
    exports.applyMaterial = applyMaterial;
    exports.skins = skins;
  });
  __define("src/boopface-skins.js", function(__require2, __import2, exports) {
    const __imp0 = __require2("src/boopface-extension-host.js");
    const BoopFace = __imp0.default;
    const { registerAvatarExtension } = __imp0;
    const { SKIN_CATALOG, SKIN_SERIES } = __require2("src/skins/catalog.js");
    const painters = {};
    const loading = {};
    function loadPainter(kind) {
      loading[kind] ?? (loading[kind] = Promise.all([
        __import2("src/skins/paints.js"),
        kind === "native" ? __import2("src/skins/native.js") : __import2("src/skins/material-library.js"),
        __import2("src/skins/eyelids.js")
      ]).then(([paints, painter, eyelids]) => {
        painters.paints = paints.SKIN_PAINTS;
        painters.maskEyelids = eyelids.maskEyelids;
        painters[kind] = painter;
      }));
      return loading[kind];
    }
    function loadSkins() {
      return Promise.all([loadPainter("native"), loadPainter("material")]).then(() => void 0);
    }
    const proto = BoopFace.prototype;
    const baseApplyColor = proto._applyColor;
    const SKIN_NAMES = Object.freeze(SKIN_SERIES.flatMap((series) => series.skins));
    const SKINS = Object.freeze(Object.fromEntries(Object.entries(SKIN_CATALOG).map(([id, skin]) => [
      id,
      Object.freeze({ series: skin.series, title: skin.zh, titleEn: skin.en, base: Object.freeze([...skin.base]), eyeColor: skin.eyeColor !== false })
    ])));
    const SERIES = Object.freeze(SKIN_SERIES.map((series) => Object.freeze({
      id: series.id,
      number: series.number,
      title: series.zh,
      titleEn: series.en,
      skins: Object.freeze([...series.skins])
    })));
    const REST_LIGHT = Object.freeze({ x: -0.5, y: -0.5 });
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    function normalizeSkin(value) {
      const text = String(value ?? "").trim().toLowerCase();
      if (!text || text === "none") return null;
      const name = /^\d+$/.test(text) ? String(Number(text)) : text;
      return Object.hasOwn(SKIN_CATALOG, name) ? name : void 0;
    }
    function findPainted(root, record) {
      let node = record.id ? root.getElementById(record.id) : root.querySelector(record.selector);
      for (const index of record.path || []) node = node == null ? void 0 : node.children[index];
      return node;
    }
    function paintAdjustments(instance, name) {
      var _a, _b;
      const records = ((_a = painters.paints[name]) == null ? void 0 : _a.paint) || [];
      const root = instance.shadowRoot;
      const undo = instance._skinUndo ?? (instance._skinUndo = []);
      for (const record of records) {
        const node = findPainted(root, record);
        if (!node) continue;
        for (const [attribute, value] of Object.entries(record.attributes)) {
          undo.push(() => {
            if (old === null) node.removeAttribute(attribute);
            else node.setAttribute(attribute, old);
          });
          const old = node.getAttribute(attribute);
          node.setAttribute(attribute, value);
        }
      }
      for (const [property, value] of Object.entries(((_b = painters.paints[name]) == null ? void 0 : _b.properties) || {})) {
        const old = instance.style.getPropertyValue(property);
        undo.push(() => old ? instance.style.setProperty(property, old) : instance.style.removeProperty(property));
        instance.style.setProperty(property, value);
      }
    }
    function undoAdjustments(instance) {
      const undo = instance._skinUndo;
      while (undo == null ? void 0 : undo.length) undo.pop()();
    }
    function adjustNative(instance, skin, name) {
      const { lightNative } = painters.native;
      const { x, y } = skin.light;
      lightNative(instance, REST_LIGHT.x, REST_LIGHT.y);
      const resting = Object.entries(skin.nodes).map(([key, node]) => {
        const attribute = key.slice(key.lastIndexOf(".") + 1);
        return { key, node, attribute, value: parseFloat(node.getAttribute(attribute)) };
      });
      paintAdjustments(instance, name);
      for (const { key, node, attribute, value } of resting) {
        const adjusted = parseFloat(node.getAttribute(attribute));
        if (Number.isFinite(adjusted) && Number.isFinite(value) && adjusted !== value) skin.offsets[key] = adjusted - value;
      }
      skin.shown = {};
      lightNative(instance, x, y);
    }
    function adjustMaterial(instance, material, name) {
      var _a;
      const records = ((_a = painters.paints[name]) == null ? void 0 : _a.paint) || [];
      const root = instance.shadowRoot;
      const key = SKIN_CATALOG[name].material;
      const offsets = [];
      for (const lightKey of material.lightKeys || []) {
        const [suffix, attribute] = lightKey.split(":");
        const record = records.find((r) => {
          var _a2;
          return r.id === `material-${key}-${suffix}` && !((_a2 = r.path) == null ? void 0 : _a2.length);
        });
        const node = record && findPainted(root, record);
        const value = record == null ? void 0 : record.attributes[attribute];
        if (node && value != null) offsets.push({ node, attribute, delta: parseFloat(value) - parseFloat(node.getAttribute(attribute)) });
      }
      paintAdjustments(instance, name);
      const light = material.light.bind(material);
      material.light = (x, y) => {
        light(x, y);
        for (const { node, attribute, delta } of offsets) node.setAttribute(attribute, parseFloat(node.getAttribute(attribute)) + delta);
      };
    }
    function render(instance) {
      var _a;
      const name = instance._skinName ?? null;
      if (instance._skinShown === name || !instance._head) return;
      const entry = name ? SKIN_CATALOG[name] : null;
      const kind = entry ? entry.native ? "native" : "material" : null;
      if (kind && !painters[kind]) {
        if (instance._skinPending !== name) {
          instance._skinPending = name;
          loadPainter(kind).then(() => {
            instance._skinPending = void 0;
            if ((instance._skinName ?? null) === name) render(instance);
          });
        }
        return;
      }
      const { showNative } = painters.native || {};
      undoAdjustments(instance);
      (_a = instance._material) == null ? void 0 : _a.dispose();
      instance._material = null;
      if (!(entry == null ? void 0 : entry.native)) showNative == null ? void 0 : showNative(instance, null);
      instance._skinShown = name;
      if (!entry) {
        baseApplyColor.call(instance, instance.getAttribute("color"));
        return;
      }
      if (entry.native) {
        if (!instance._skinLoveEnd) {
          instance._skinLoveEnd = (event) => {
            var _a2, _b;
            if (((_a2 = event.detail) == null ? void 0 : _a2.state) !== "love") (_b = painters.native) == null ? void 0 : _b.separateNativeEyes(instance);
          };
          instance.addEventListener("face-state", instance._skinLoveEnd);
        }
        const skin = showNative(instance, entry.native);
        if (skin) {
          const light = instance._skinLight;
          if (light) {
            skin.light.x = light.x;
            skin.light.y = light.y;
          }
          adjustNative(instance, skin, name);
        }
      } else {
        painters.maskEyelids(instance);
        const material = painters.material.applyMaterial(instance, entry.material);
        adjustMaterial(instance, material, name);
        instance._material = material;
        instance._materialLight = null;
      }
    }
    function updateLight(instance) {
      var _a, _b, _c;
      const name = instance._skinShown;
      if (!name) return;
      const pointer = instance._pointer;
      const reduced = (_a = instance._isReducedMotion) == null ? void 0 : _a.call(instance);
      const follows = instance._pointerFollowEnabled !== false && !reduced && (pointer == null ? void 0 : pointer.active) && pointer.lastMove > 0;
      const pull = follows ? Math.pow(clamp(pointer.influence || 0, 0, 1), 0.7) : 0;
      const fixed = instance._skinFixedLight;
      const tx = fixed ? fixed.x : REST_LIGHT.x + (clamp((pointer == null ? void 0 : pointer.x) / 48, -1, 1) - REST_LIGHT.x) * pull;
      const ty = fixed ? fixed.y : REST_LIGHT.y + (clamp((pointer == null ? void 0 : pointer.y) / 34, -1, 1) - REST_LIGHT.y) * pull;
      const light = instance._skinLight ?? (instance._skinLight = { ...REST_LIGHT });
      if (reduced) {
        light.x = tx;
        light.y = ty;
      } else {
        light.x += ((Number.isFinite(tx) ? tx : REST_LIGHT.x) - light.x) * 0.18;
        light.y += ((Number.isFinite(ty) ? ty : REST_LIGHT.y) - light.y) * 0.18;
      }
      if (SKIN_CATALOG[name].native) {
        painters.native.joinNativeEyes(instance);
        painters.native.lightNative(instance, light.x, light.y);
      } else if (instance._material) {
        (_c = (_b = instance._material).syncJoin) == null ? void 0 : _c.call(_b);
        const last = instance._materialLight;
        if (last && Math.abs(last.x - light.x) < 5e-4 && Math.abs(last.y - light.y) < 5e-4) return;
        instance._materialLight = { x: light.x, y: light.y };
        instance._material.light(light.x, light.y);
      }
    }
    proto._applySkinAttribute = function() {
      const value = this.getAttribute("skin");
      this._skinAttributeApplied = value;
      if (normalizeSkin(value) === void 0) {
        console.warn(`boopface: unknown skin "${value}". Use a skin number such as ${SKIN_NAMES[0]}, or none.`);
        this.setSkin(null);
      } else {
        this.setSkin(value);
      }
    };
    proto.setSkin = function(value = null) {
      var _a;
      const name = normalizeSkin(value);
      if (name === void 0) throw new Error(`Unknown BoopFace skin: ${value}`);
      this._skinName = name;
      render(this);
      (_a = this._resumeFrames) == null ? void 0 : _a.call(this);
      return this;
    };
    proto._skinKeepsEyes = function() {
      var _a;
      const name = this._skinName ?? normalizeSkin(this.getAttribute("skin"));
      return !!(name && ((_a = SKIN_CATALOG[name]) == null ? void 0 : _a.eyeColor) === false);
    };
    proto.getSkin = function() {
      return this._skinName ?? null;
    };
    proto._applyColor = function(value) {
      baseApplyColor.call(this, value);
      const entry = this._skinShown ? SKIN_CATALOG[this._skinShown] : null;
      if (!entry || !this._head) return;
      this._head.setAttribute("fill", entry.native ? "url(#skin-base)" : `url(#material-${entry.material}-base)`);
    };
    registerAvatarExtension({
      name: "skins",
      draw() {
        if ((this._skinName ?? null) !== (this._skinShown ?? null)) render(this);
        updateLight(this);
      }
    });
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.SKINS = SKINS;
    exports.SKIN_NAMES = SKIN_NAMES;
    exports.SKIN_SERIES = SERIES;
    exports.loadSkins = loadSkins;
  });
  __define("src/boopface-agent.js", function(__require2, __import2, exports) {
    const STATES = Object.freeze([
      "idle",
      "typing",
      "listening",
      "thinking",
      "tool",
      "replying",
      "speaking",
      "approval",
      "done",
      "error",
      "refused",
      "cancelled"
    ]);
    const BUSY = /* @__PURE__ */ new Set(["thinking", "tool", "replying", "speaking"]);
    const LOOPING = /* @__PURE__ */ new Set([...BUSY, "listening"]);
    const VOICE = /* @__PURE__ */ new Set(["listening", "speaking"]);
    const ENDINGS = /* @__PURE__ */ new Set(["done", "error", "refused", "cancelled"]);
    const DEFAULT_ACTIONS = Object.freeze({
      idle: "idle",
      typing: "input",
      listening: "listening",
      thinking: "waiting-spin",
      tool: "waiting-wave",
      replying: "idle",
      speaking: "speaking",
      approval: "wary",
      done: "success",
      error: "failure",
      refused: "refuse",
      cancelled: "idle"
    });
    const ACTION_NAMES = /* @__PURE__ */ new Set([
      "idle",
      "bored",
      "waiting",
      "waiting-spin",
      "waiting-wrap",
      "waiting-wave",
      "input",
      "affirm",
      "success",
      "failure",
      "wary",
      "inspect",
      "angry",
      "refuse",
      "surprise",
      "love",
      "random",
      "sleep",
      "wake",
      "waiting-bloom",
      "listening",
      "speaking"
    ]);
    const WORDS = Object.freeze({
      idle: "idle",
      typing: "typing",
      input: "typing",
      listening: "listening",
      listen: "listening",
      speaking: "speaking",
      speak: "speaking",
      talking: "speaking",
      thinking: "thinking",
      reasoning: "thinking",
      submitted: "thinking",
      waiting: "thinking",
      pending: "thinking",
      loading: "thinking",
      start: "thinking",
      started: "thinking",
      running: "thinking",
      "in-progress": "thinking",
      tool: "tool",
      "tool-call": "tool",
      "tool-calling": "tool",
      "tool-use": "tool",
      working: "tool",
      replying: "replying",
      streaming: "replying",
      writing: "replying",
      responding: "replying",
      approval: "approval",
      "needs-approval": "approval",
      confirm: "approval",
      "needs-confirmation": "approval",
      interrupt: "approval",
      "awaiting-approval": "approval",
      done: "done",
      success: "done",
      complete: "done",
      completed: "done",
      finish: "done",
      finished: "done",
      error: "error",
      failed: "error",
      failure: "error",
      fail: "error",
      refused: "refused",
      refusal: "refused",
      refuse: "refused",
      cancelled: "cancelled",
      canceled: "cancelled",
      cancel: "cancelled",
      abort: "cancelled",
      aborted: "cancelled",
      stopped: "cancelled"
    });
    const READY = "ready";
    const AG_UI = Object.freeze({
      run_started: "thinking",
      step_started: null,
      step_finished: null,
      thinking_start: "thinking",
      thinking_end: null,
      thinking_text_message_end: null,
      reasoning_end: null,
      reasoning_message_end: null,
      text_message_end: null,
      thinking_text_message_start: "thinking",
      thinking_text_message_content: "thinking",
      reasoning_start: "thinking",
      reasoning_message_start: "thinking",
      reasoning_message_content: "thinking",
      reasoning_message_chunk: "thinking",
      text_message_content: "replying",
      text_message_chunk: "replying",
      tool_call_start: "tool",
      tool_call_args: "tool",
      tool_call_chunk: "tool",
      tool_call_end: "tool",
      tool_call_result: "thinking"
    });
    const AI_SDK = Object.freeze({
      "start-step": "thinking",
      "reasoning-start": "thinking",
      "reasoning-delta": "thinking",
      reasoning: "thinking",
      "text-start": "replying",
      "text-delta": "replying",
      text: "replying",
      "tool-input-start": "tool",
      "tool-input-delta": "tool",
      "tool-input-available": "tool",
      "tool-call": "tool",
      "tool-call-streaming-start": "tool",
      "tool-call-delta": "tool",
      "tool-output-available": "thinking",
      "tool-output-error": "thinking",
      "tool-result": "thinking",
      "tool-error": "thinking",
      "tool-approval-request": "approval"
    });
    const TOOL_ITEM = /(?:^|_)(?:call|tool_use)$/;
    const LOOP_SEAM = Object.freeze({ spin: 1600, wave: 1100, wrap: 2400 });
    const WAITING_ACTION = /^waiting(?:-(spin|wrap|wave|bloom))?$/;
    function lower(value) {
      return typeof value === "string" ? value.trim().toLowerCase() : "";
    }
    function fromWord(word) {
      const key = lower(word).replace(/[\s_]+/g, "-");
      if (key === READY) return READY;
      return Object.hasOwn(WORDS, key) ? WORDS[key] : void 0;
    }
    function fromFinishReason(reason) {
      const value = lower(reason).replace(/_/g, "-");
      if (!value) return void 0;
      if (value === "tool-calls" || value === "function-call" || value === "tool-use") return "tool";
      if (value === "content-filter" || value === "refusal") return "refused";
      if (value === "error") return "error";
      if (value === "pause-turn") return "thinking";
      return "done";
    }
    function fromOpenAIItem(item) {
      const type = lower(item == null ? void 0 : item.type);
      if (type === "reasoning") return "thinking";
      if (type === "mcp_approval_request") return "approval";
      if (TOOL_ITEM.test(type) || type === "mcp_list_tools") return "tool";
      return null;
    }
    function fromOpenAIResponses(type, event) {
      var _a, _b, _c, _d, _e;
      if (type.startsWith("response.output_audio") || type.startsWith("response.audio")) return "speaking";
      if (type === "response.done") {
        const status = lower((_a = event.response) == null ? void 0 : _a.status);
        if (status === "failed") return "error";
        if (status === "cancelled") return "cancelled";
        const output = Array.isArray((_b = event.response) == null ? void 0 : _b.output) ? event.response.output : [];
        if (output.some((item) => lower(item == null ? void 0 : item.type) === "function_call")) return "tool";
        return "done";
      }
      if (type === "response.created" || type === "response.in_progress" || type === "response.queued") return "thinking";
      if (type.startsWith("response.reasoning")) return "thinking";
      if (type.startsWith("response.output_text.")) return "replying";
      if (type.startsWith("response.refusal.")) return "refused";
      if (/^response\.[a-z_]+_call(?:_[a-z]+)?\./.test(type) || type.startsWith("response.mcp_list_tools.")) return "tool";
      if (type === "response.output_item.added") return fromOpenAIItem(event.item);
      if (type === "response.failed") return "error";
      if (type === "response.incomplete") {
        return lower((_d = (_c = event.response) == null ? void 0 : _c.incomplete_details) == null ? void 0 : _d.reason) === "content_filter" ? "refused" : "error";
      }
      if (type === "response.completed") {
        const output = Array.isArray((_e = event.response) == null ? void 0 : _e.output) ? event.response.output : [];
        if (output.some((item) => lower(item == null ? void 0 : item.type) === "mcp_approval_request")) return "approval";
        if (output.some((item) => lower(item == null ? void 0 : item.type) === "function_call" || lower(item == null ? void 0 : item.type) === "custom_tool_call")) return "tool";
        if (output.some((item) => {
          var _a2, _b2;
          return (_b2 = (_a2 = item == null ? void 0 : item.content) == null ? void 0 : _a2.some) == null ? void 0 : _b2.call(_a2, (part) => lower(part == null ? void 0 : part.type) === "refusal");
        })) return "refused";
        return "done";
      }
      return null;
    }
    function fromChatCompletionChunk(event) {
      var _a, _b;
      const choice = (_a = event.choices) == null ? void 0 : _a[0];
      if (!choice) return null;
      const finish = fromFinishReason(choice.finish_reason);
      if (finish) return finish;
      const delta = choice.delta || {};
      if (delta.refusal) return "refused";
      if (((_b = delta.tool_calls) == null ? void 0 : _b.length) || delta.function_call) return "tool";
      if (delta.content) return "replying";
      if (delta.reasoning_content || delta.reasoning) return "thinking";
      return null;
    }
    function fromAnthropicBlock(type) {
      if (type === "thinking" || type === "redacted_thinking") return "thinking";
      if (type === "text") return "replying";
      if (type.endsWith("tool_result")) return "thinking";
      if (type.endsWith("tool_use")) return "tool";
      return null;
    }
    function fromAnthropic(type, event, memo) {
      var _a, _b, _c;
      switch (type) {
        case "message_start":
          memo.stopReason = "";
          return "thinking";
        case "content_block_start":
          return fromAnthropicBlock(lower((_a = event.content_block) == null ? void 0 : _a.type));
        case "content_block_delta": {
          const delta = lower((_b = event.delta) == null ? void 0 : _b.type);
          if (delta === "thinking_delta" || delta === "signature_delta") return "thinking";
          if (delta === "text_delta" || delta === "citations_delta") return "replying";
          if (delta === "input_json_delta") return "tool";
          return null;
        }
        case "message_delta": {
          memo.stopReason = lower((_c = event.delta) == null ? void 0 : _c.stop_reason);
          return memo.stopReason === "refusal" ? "refused" : null;
        }
        case "message_stop": {
          const reason = memo.stopReason;
          memo.stopReason = "";
          return fromFinishReason(reason) || "done";
        }
        default:
          return void 0;
      }
    }
    function fromAgUi(type, event) {
      var _a;
      if (type === "text_message_start") {
        const role = lower(event.role);
        return !role || role === "assistant" ? "replying" : null;
      }
      if (type === "run_error") {
        const code = lower(event.code);
        return code.includes("refus") || code.includes("content_filter") ? "refused" : "error";
      }
      if (type === "run_finished") {
        const outcome = lower(((_a = event.outcome) == null ? void 0 : _a.type) ?? event.outcome);
        return outcome === "interrupt" || event.interrupt ? "approval" : "done";
      }
      return Object.hasOwn(AG_UI, type) ? AG_UI[type] : void 0;
    }
    function fromAiSdk(type, event) {
      if (type === "start") return "thinking";
      if (type === "finish") return fromFinishReason(event.finishReason) || "done";
      if (type === "finish-step") return null;
      if (type === "abort") return "cancelled";
      return Object.hasOwn(AI_SDK, type) ? AI_SDK[type] : void 0;
    }
    function stateFromEvent(event, memo) {
      if (typeof event === "string") return fromWord(event);
      if (!event || typeof event !== "object") return void 0;
      const type = lower(event.type);
      if (type) {
        if (type === "error") return "error";
        if (type === "ping") return null;
        if (type.startsWith("response.")) return fromOpenAIResponses(type, event);
        if (type === "input_audio_buffer.speech_started") return "listening";
        if (type === "input_audio_buffer.speech_stopped" || type === "input_audio_buffer.committed") return "thinking";
        if (type === "output_audio_buffer.started") {
          memo.playback = true;
          return "speaking";
        }
        if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") return "listening";
        if (type.startsWith("input_audio_buffer.") || type.startsWith("output_audio_buffer.")) return null;
        const anthropic = fromAnthropic(type, event, memo);
        if (anthropic !== void 0) return anthropic;
        const agUi = fromAgUi(type, event);
        if (agUi !== void 0) return agUi;
        const aiSdk = fromAiSdk(type, event);
        if (aiSdk !== void 0) return aiSdk;
      }
      if (lower(event.object) === "chat.completion.chunk" || Array.isArray(event.choices)) return fromChatCompletionChunk(event);
      if (typeof event.state === "string") return fromWord(event.state);
      if (typeof event.mode === "string") return fromWord(event.mode);
      if (typeof event.status === "string") return fromWord(event.status);
      return type ? fromWord(type) : void 0;
    }
    function resolveAvatar(target) {
      const avatar = typeof target === "string" && typeof document !== "undefined" ? document.querySelector(target) : target;
      if (!avatar || typeof avatar.play !== "function" || typeof avatar.startWaiting !== "function") {
        throw new TypeError("connectAgent: pass a <boop-face> element or a selector that finds one.");
      }
      return avatar;
    }
    function resolveActions(custom = {}) {
      if (custom === null || typeof custom !== "object") throw new TypeError("connectAgent: options.actions must be an object.");
      const actions = { ...DEFAULT_ACTIONS };
      for (const [state, action] of Object.entries(custom)) {
        if (!STATES.includes(state)) {
          throw new TypeError(`connectAgent: unknown state "${state}". States: ${STATES.join(", ")}.`);
        }
        if (action !== null && action !== false && typeof action !== "function" && !ACTION_NAMES.has(action)) {
          throw new TypeError(`connectAgent: unknown action "${action}" for state "${state}".`);
        }
        actions[state] = action;
      }
      return actions;
    }
    function isAbort(error) {
      return (error == null ? void 0 : error.name) === "AbortError" || (error == null ? void 0 : error.code) === "ABORT_ERR";
    }
    async function* readItems(source) {
      var _a;
      if (typeof source === "string") throw new TypeError("track: pass a stream, not a string; use handle() for a state name.");
      if (source && typeof source[Symbol.asyncIterator] === "function") {
        yield* source;
        return;
      }
      if (source && typeof source.getReader === "function") {
        const reader = source.getReader();
        try {
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          (_a = reader.releaseLock) == null ? void 0 : _a.call(reader);
        }
      }
      if (source && typeof source[Symbol.iterator] === "function") {
        yield* source;
        return;
      }
      throw new TypeError("track: pass an async iterable, a ReadableStream or an iterable.");
    }
    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    function audioMeter(context, source) {
      let node;
      if (typeof MediaStream !== "undefined" && source instanceof MediaStream) {
        node = context.createMediaStreamSource(source);
      } else if (source && typeof source.play === "function") {
        node = context.createMediaElementSource(source);
        node.connect(context.destination);
      } else {
        throw new TypeError("connectAudio: pass a MediaStream or an <audio> / <video> element.");
      }
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      node.connect(analyser);
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      const split = Math.max(1, Math.round(700 / (context.sampleRate / analyser.fftSize)));
      const band = (from, to) => {
        let power = 0;
        for (let i = from; i < to; i++) power += 10 ** (spectrum[i] / 10);
        return clamp01((10 * Math.log10(power || 1e-12) + 60) / 38);
      };
      return {
        read() {
          analyser.getFloatFrequencyData(spectrum);
          return [band(1, split), band(split, spectrum.length)];
        },
        disconnect() {
          try {
            node.disconnect(analyser);
          } catch {
          }
        }
      };
    }
    function connectAgent(target, options = {}) {
      const avatar = resolveAvatar(target);
      const actions = resolveActions(options.actions);
      const onChange = typeof options.onChange === "function" ? options.onChange : null;
      const warned = /* @__PURE__ */ new Set();
      const memo = { stopReason: "", ended: false, voice: false, playback: false, pendingDone: false, outputMeter: false };
      let state = "idle";
      let looping = null;
      let timer = 0;
      const customThinking = Boolean(options.actions && Object.hasOwn(options.actions, "thinking"));
      const actionFor = (next) => next === "thinking" && memo.voice && !customThinking ? "waiting-bloom" : actions[next];
      function loopOf(next) {
        const action = actionFor(next);
        if (typeof action !== "string" || !LOOPING.has(next)) return null;
        const waiting = WAITING_ACTION.exec(action);
        if (waiting) return { key: `waiting:${waiting[1] || "spin"}`, start: () => avatar.startWaiting({ variant: waiting[1] || "spin" }) };
        const methods = { listening: "startListening", speaking: "startSpeaking" };
        if (methods[action] && typeof avatar[methods[action]] === "function") {
          return { key: `voice:${action}`, start: () => avatar[methods[action]]() };
        }
        return null;
      }
      function stillLooping(key) {
        var _a;
        if (key === "waiting:bloom") return ((_a = avatar._voiceFx) == null ? void 0 : _a.mode) === "thinking" || avatar._voiceRequested === "thinking";
        if (key.startsWith("waiting:")) return Boolean(avatar._waitingFx || avatar._waitingRequested);
        if (avatar._voiceFx && avatar._voiceFx.mode !== key.slice(6)) return false;
        return Boolean(avatar._voiceFx || avatar._voiceRequested);
      }
      function reduced() {
        var _a;
        const motion = String(((_a = avatar.getAttribute) == null ? void 0 : _a.call(avatar, "motion")) || "auto").toLowerCase();
        if (motion === "reduce") return true;
        if (motion === "full") return false;
        return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      }
      function untilSeam() {
        const fx = avatar._waitingFx;
        if (!(looping == null ? void 0 : looping.key.startsWith("waiting:")) || !fx || !fx.continuous || reduced()) return 0;
        const period = LOOP_SEAM[fx.variant === "default" ? "spin" : fx.variant];
        if (!period) return 0;
        const left = period - (performance.now() - fx.start) % period;
        return left < 50 ? 0 : left;
      }
      function apply(next) {
        const action = actionFor(next);
        const loop = loopOf(next);
        looping = loop;
        if (action === null || action === false) return;
        if (typeof action === "function") {
          action(avatar, next);
          return;
        }
        let result;
        if (loop) result = loop.start();
        else if (action === "idle") result = avatar.reset();
        else result = avatar.play(action);
        if (result && typeof result.catch === "function") result.catch(() => {
        });
      }
      function show(next) {
        clearTimeout(timer);
        timer = 0;
        const loop = loopOf(next);
        if (loop && loop.key === (looping == null ? void 0 : looping.key) && stillLooping(loop.key)) return;
        const wait = untilSeam();
        if (wait) timer = setTimeout(() => {
          timer = 0;
          apply(next);
        }, wait);
        else apply(next);
      }
      function set(next) {
        var _a;
        if (VOICE.has(next)) memo.voice = true;
        if (memo.voice) {
          if (next === "done" && state === "speaking") {
            memo.pendingDone = true;
            return state;
          }
          if (next === "done" || next === "cancelled") next = "listening";
        }
        if (next !== "speaking") memo.pendingDone = false;
        if (next === state) {
          if (BUSY.has(next)) (_a = avatar.noteActivity) == null ? void 0 : _a.call(avatar, false);
          return state;
        }
        if (next === "done" && (memo.ended || state === "approval")) return state;
        const previous = state;
        if (BUSY.has(next) && !BUSY.has(previous)) memo.ended = false;
        if (next === "error" || next === "refused" || next === "cancelled") memo.ended = true;
        if (next === "idle" || next === "typing" || next === "listening") memo.ended = false;
        state = next;
        if (previous === "typing" && next !== "typing" && actions.typing === "input" && typeof avatar.input === "function") {
          if (actionFor(next) === null || actionFor(next) === false) avatar.input(false);
        }
        show(next);
        onChange == null ? void 0 : onChange(next, previous);
        return state;
      }
      function handle(event) {
        var _a;
        let next = stateFromEvent(event, memo);
        if (next === READY) next = BUSY.has(state) ? "done" : null;
        if (next === void 0) {
          if (typeof event === "string" && !warned.has(event)) {
            warned.add(event);
            console.warn(`boopface: connectAgent does not know the state "${event}". States: ${STATES.join(", ")}.`);
          }
          return state;
        }
        if (next === null) {
          if (BUSY.has(state)) (_a = avatar.noteActivity) == null ? void 0 : _a.call(avatar, false);
          return state;
        }
        return set(next);
      }
      async function* track(source) {
        let finished = false;
        if (!BUSY.has(state)) set("thinking");
        try {
          for await (const item of readItems(source)) {
            handle(item);
            yield item;
          }
          finished = true;
        } catch (error) {
          finished = true;
          set(isAbort(error) ? "cancelled" : "error");
          throw error;
        } finally {
          if (!finished && BUSY.has(state)) set("cancelled");
          else if (finished && (state === "thinking" || state === "replying")) set("done");
        }
      }
      function connectAudio({ input, output } = {}) {
        var _a, _b, _c, _d, _e, _f;
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Context) throw new TypeError("connectAudio: this browser has no Web Audio.");
        const context = new Context();
        const meters = {};
        try {
          if (input) meters.input = audioMeter(context, input);
          if (output) meters.output = audioMeter(context, output);
        } catch (error) {
          for (const meter of Object.values(meters)) meter.disconnect();
          (_c = (_a = context.close) == null ? void 0 : (_b = _a.call(context)).catch) == null ? void 0 : _c.call(_b, () => {
          });
          throw error;
        }
        memo.outputMeter = Boolean(meters.output);
        (_f = (_d = context.resume) == null ? void 0 : (_e = _d.call(context)).catch) == null ? void 0 : _f.call(_e, () => {
        });
        let frame = 0;
        let quietSince = 0;
        const tick = (now) => {
          var _a2;
          frame = requestAnimationFrame(tick);
          const meter = state === "listening" ? meters.input : state === "speaking" ? meters.output : null;
          if (!meter) return;
          const pair = meter.read();
          (_a2 = avatar.setVoiceLevel) == null ? void 0 : _a2.call(avatar, pair);
          const level = Math.max(...pair);
          if (state !== "speaking" || !memo.pendingDone || meter !== meters.output) {
            quietSince = 0;
            return;
          }
          if (level > 0.04) quietSince = 0;
          else if (!quietSince) quietSince = now;
          else if (now - quietSince > 700) {
            quietSince = 0;
            set("listening");
          }
        };
        frame = requestAnimationFrame(tick);
        let connected = true;
        return function disconnectAudio() {
          var _a2, _b2, _c2;
          if (!connected) return;
          connected = false;
          cancelAnimationFrame(frame);
          for (const meter of Object.values(meters)) meter.disconnect();
          if (meters.output) memo.outputMeter = false;
          (_c2 = (_a2 = context.close) == null ? void 0 : (_b2 = _a2.call(context)).catch) == null ? void 0 : _c2.call(_b2, () => {
          });
        };
      }
      return {
        get state() {
          return state;
        },
        get avatar() {
          return avatar;
        },
        handle,
        track,
        connectAudio,
        reset() {
          memo.stopReason = "";
          memo.ended = false;
          memo.voice = false;
          memo.pendingDone = false;
          return set("idle");
        }
      };
    }
    exports.default = connectAgent;
    exports.connectAgent = connectAgent;
    exports._agentStateFromEvent = stateFromEvent;
    exports.AGENT_STATES = STATES;
    exports.AGENT_DEFAULT_ACTIONS = DEFAULT_ACTIONS;
  });
  __define("boopface.js", function(__require2, __import2, exports) {
    const BoopFace = __require2("src/boopface-extension-host.js").default;
    __require2("src/boopface-actions.js");
    __require2("src/boopface-antenna.js");
    __require2("src/boopface-waiting.js");
    __require2("src/boopface-voice.js");
    __require2("src/boopface-inspect.js");
    __require2("src/boopface-failure.js");
    __require2("src/boopface-love.js");
    __require2("src/boopface-random.js");
    __require2("src/boopface-head-roundness.js");
    __require2("src/boopface-gestures.js");
    const { SKIN_NAMES, SKINS, SKIN_SERIES, loadSkins } = __require2("src/boopface-skins.js");
    __require2("src/boopface-new-expressions.js");
    __require2("src/boopface-body-motion.js");
    __require2("src/boopface-petting.js");
    __require2("src/boopface-3d.js");
    __require2("src/boopface-runtime.js");
    __require2("src/boopface-eye-color.js");
    __require2("src/boopface-round-eyes.js");
    const { VERSION } = __require2("src/boopface-version.js");
    const { connectAgent } = __require2("src/boopface-agent.js");
    if (typeof document !== "undefined") {
      document.querySelectorAll("boop-face, agent-robot-avatar").forEach((avatar) => {
        var _a;
        return (_a = avatar._resumeFrames) == null ? void 0 : _a.call(avatar);
      });
    }
    if (typeof window !== "undefined") {
      window.BoopFaceVersion = window.AgentRobotAvatarVersion = VERSION;
    }
    exports.default = BoopFace;
    exports.BoopFace = BoopFace;
    exports.AgentRobotAvatar = BoopFace;
    exports.SKIN_NAMES = SKIN_NAMES;
    exports.SKINS = SKINS;
    exports.SKIN_SERIES = SKIN_SERIES;
    exports.VERSION = VERSION;
    exports.loadSkins = loadSkins;
    exports.connectAgent = connectAgent;
  });
  var __boopface = __require("boopface.js");
  if (typeof __boopface.loadSkins === "function") {
    __boopface.loadSkins();
  }
  (function initNightAvatarsBoopFace(global2, boop) {
    "use strict";
    if (!boop || !boop.BoopFace) {
      throw new Error("BoopFace adapter requires bundled BoopFace runtime.");
    }
    var SKIN_NAMES = boop.SKIN_NAMES || [];
    var SKINS = boop.SKINS || {};
    var VARIANTS = [
      { id: "classic-3d", label: "经典黑 · 立体 3D", thumb: "avatars/boop/materials.webp", tile: 0, side: 14 },
      { id: "classic-2d", label: "经典黑 · 平面 2D", thumb: "avatars/boop/materials.webp", tile: 1, side: 14 }
    ];
    for (var ki = 0; ki < SKIN_NAMES.length; ki++) {
      var skinId = SKIN_NAMES[ki];
      var info = SKINS[skinId];
      if (!info) continue;
      var title = info.title || skinId;
      VARIANTS.push({
        id: "skin-" + skinId,
        label: skinId + " · " + title,
        thumb: "avatars/boop/materials.webp",
        tile: VARIANTS.length,
        side: 14
      });
    }
    var EXPRESSIONS = [
      { id: "idle", label: "待机" },
      { id: "success", label: "开心笑眼" },
      { id: "love", label: "心动爱心" },
      { id: "wink", label: "俏皮眨眼" },
      { id: "smug", label: "小得意" },
      { id: "bounce", label: "欢快弹跳" },
      { id: "smug-bounce", label: "得意弹跳" },
      { id: "affirm", label: "点头确认" },
      { id: "bow", label: "礼貌鞠躬" },
      { id: "surprise", label: "惊讶瞪眼" },
      { id: "think", label: "抬头思考" },
      { id: "ponder", label: "低头沉思" },
      { id: "observe", label: "凑近观察" },
      { id: "inspect", label: "眯眼扫视" },
      { id: "wary", label: "侧头警惕" },
      { id: "bored", label: "无聊张望" },
      { id: "dizzy", label: "晕头转向" },
      { id: "shake", label: "转头否认" },
      { id: "refuse", label: "摇头拒绝" },
      { id: "failure", label: "低落失落" },
      { id: "angry", label: "生气瞪眼" },
      { id: "random", label: "老虎机眼" },
      { id: "input", label: "输入光标" },
      { id: "listening", label: "语音倾听" },
      { id: "speaking", label: "语音说话" },
      { id: "waiting-spin", label: "等待·绕圈" },
      { id: "waiting-wrap", label: "等待·穿梭" },
      { id: "waiting-wave", label: "等待·波浪" },
      { id: "waiting-bloom", label: "等待·花瓣" },
      { id: "waiting-cross", label: "等待·交叉" },
      { id: "shape-wait", label: "等待·变形" },
      { id: "sleep", label: "闭眼睡觉" },
      { id: "wake", label: "睁眼醒来" }
    ];
    var EXPRESSION_SET = /* @__PURE__ */ Object.create(null);
    for (var ei = 0; ei < EXPRESSIONS.length; ei++) {
      EXPRESSION_SET[EXPRESSIONS[ei].id] = true;
    }
    var ACTION_ALIAS = {
      // Upstream deprecated aliases
      wait: "waiting-spin",
      waiting: "waiting-spin",
      send: "affirm",
      failed: "failure",
      fail: "failure",
      warning: "wary",
      verify: "inspect",
      review: "inspect",
      blocked: "angry",
      "policy-blocked": "angry",
      error: "refuse",
      "system-error": "refuse",
      "connection-error": "refuse",
      slot: "random",
      // Common semantic mood/emotion names
      neutral: "idle",
      calm: "idle",
      relaxed: "idle",
      happy: "success",
      joy: "success",
      glad: "success",
      warm: "success",
      cheerful: "bounce",
      excited: "bounce",
      celebrate: "bounce",
      affection: "love",
      affectionate: "love",
      heart: "love",
      playful: "wink",
      tease: "wink",
      proud: "smug",
      confident: "smug",
      curious: "observe",
      interested: "observe",
      focused: "inspect",
      thinking: "think",
      thoughtful: "ponder",
      shy: "ponder",
      surprised: "surprise",
      shocked: "surprise",
      amazed: "surprise",
      cautious: "wary",
      suspicious: "wary",
      sad: "failure",
      down: "failure",
      sorry: "failure",
      apologetic: "bow",
      upset: "failure",
      annoyed: "angry",
      frustrated: "angry",
      mad: "angry",
      confused: "dizzy",
      dizzy: "dizzy",
      sleepy: "sleep",
      tired: "sleep",
      nod: "affirm",
      yes: "affirm",
      no: "refuse",
      typing: "input"
    };
    var PREVIEW_HOLD_MS = {
      input: 2600,
      sleep: 4e3,
      listening: 2900,
      speaking: 2900,
      "waiting-spin": 3300,
      "waiting-wrap": 2500,
      "waiting-wave": 3400,
      "waiting-bloom": 3900,
      "waiting-cross": 3900,
      "shape-wait": 2800
    };
    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    }
    function clamp01(v) {
      return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
    }
    function resolveAction(raw) {
      var key = String(raw || "").trim().toLowerCase();
      if (!key) return null;
      if (EXPRESSION_SET[key]) return key;
      if (Object.prototype.hasOwnProperty.call(ACTION_ALIAS, key)) return ACTION_ALIAS[key];
      return null;
    }
    function parseVariant(variantId) {
      var raw = String(variantId || "classic-3d").trim().toLowerCase();
      if (!raw || raw === "default" || raw === "classic-3d" || raw === "3d") {
        return { skin: null, view: "3d" };
      }
      if (raw === "classic" || raw === "classic-2d" || raw === "2d" || raw === "flat" || raw === "none") {
        return { skin: null, view: "2d" };
      }
      var m = /^(?:skin-)?(\d+)(?:-(2d|3d))?$/.exec(raw);
      if (m && Object.prototype.hasOwnProperty.call(SKINS, m[1])) {
        return { skin: m[1], view: m[2] || "3d" };
      }
      return { skin: null, view: "3d" };
    }
    function parseColorLuminance(color) {
      var s = String(color || "").trim();
      var r, g, b;
      var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
      if (hex) {
        var h = hex[1];
        if (h.length === 3) {
          r = parseInt(h[0] + h[0], 16);
          g = parseInt(h[1] + h[1], 16);
          b = parseInt(h[2] + h[2], 16);
        } else {
          r = parseInt(h.slice(0, 2), 16);
          g = parseInt(h.slice(2, 4), 16);
          b = parseInt(h.slice(4, 6), 16);
        }
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      }
      var rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
      if (rgb) {
        r = Number(rgb[1]);
        g = Number(rgb[2]);
        b = Number(rgb[3]);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      }
      return null;
    }
    function isValidCssColor(color) {
      if (typeof color !== "string") return false;
      var s = color.trim();
      if (!s || s.length > 48) return false;
      return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]{3,24})$/i.test(s);
    }
    function moodEnergyGain(mood) {
      var m = String(mood || "").trim().toLowerCase();
      if (m === "excited" || m === "happy" || m === "joy" || m === "cheerful" || m === "angry" || m === "surprised" || m === "playful") {
        return 1.18;
      }
      if (m === "calm" || m === "sad" || m === "down" || m === "sleepy" || m === "tired" || m === "shy" || m === "sorry") {
        return 0.74;
      }
      return 1;
    }
    function safePlay(avatar, action) {
      try {
        var res = avatar.play(action);
        if (res && typeof res.catch === "function") res.catch(function() {
        });
        return res;
      } catch (_) {
        return null;
      }
    }
    function safeCallPromise(fn) {
      try {
        var res = fn();
        if (res && typeof res.catch === "function") res.catch(function() {
        });
        return res;
      } catch (_) {
        return null;
      }
    }
    function mount(host, variantId) {
      if (!host || typeof host.appendChild !== "function") {
        throw new Error("BoopFace mount() requires a valid DOM host element.");
      }
      var config = parseVariant(variantId);
      var destroyed = false;
      var wrapper = document.createElement("div");
      wrapper.className = "boopface-night-host";
      wrapper.style.cssText = "position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:visible;box-sizing:border-box;padding-top:3%;";
      var avatar = document.createElement("boop-face");
      avatar.setAttribute("auto-sleep", "0");
      avatar.setAttribute("wake-on", "manual");
      avatar.setAttribute("view", config.view);
      if (config.skin) {
        avatar.setAttribute("skin", config.skin);
      }
      var lastSize = 0;
      function syncSize() {
        if (destroyed) return;
        var rect = host.getBoundingClientRect ? host.getBoundingClientRect() : null;
        var w = rect && rect.width > 0 ? rect.width : host.clientWidth || 160;
        var h = rect && rect.height > 0 ? rect.height : host.clientHeight || w;
        var edge = Math.min(w, h);
        var px = Math.max(32, Math.round(edge * 0.9));
        if (px !== lastSize) {
          lastSize = px;
          avatar.setAttribute("size", String(px));
        }
      }
      syncSize();
      wrapper.appendChild(avatar);
      host.appendChild(wrapper);
      if (config.skin && typeof avatar.setSkin === "function") {
        try {
          avatar.setSkin(config.skin);
        } catch (_) {
        }
      }
      var resizeObserver = null;
      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(function() {
          syncSize();
        });
        resizeObserver.observe(host);
      }
      var currentPhase = "idle";
      var currentThinkingStyle = "bloom";
      var currentReduced = null;
      var currentColor = null;
      var currentMood = "";
      var currentInputMode = false;
      var manualExpressUntil = 0;
      var manualExpressAction = null;
      var manualHoldTimer = 0;
      var errorHoldTimer = 0;
      var lastNativePointerAt = -Infinity;
      var gazeActive = false;
      var pokeCount = 0;
      var lastPokeAt = 0;
      var touchCycle = 0;
      function clearTimers() {
        if (manualHoldTimer) {
          clearTimeout(manualHoldTimer);
          manualHoldTimer = 0;
        }
        if (errorHoldTimer) {
          clearTimeout(errorHoldTimer);
          errorHoldTimer = 0;
        }
      }
      function cancelManualExpress() {
        if (manualHoldTimer) {
          clearTimeout(manualHoldTimer);
          manualHoldTimer = 0;
        }
        manualExpressUntil = 0;
        manualExpressAction = null;
      }
      function onNativePointer() {
        lastNativePointerAt = performance.now();
      }
      function onActionState(event) {
        if (destroyed) return;
        var detail = event && event.detail;
        if (!detail) return;
        if (manualExpressAction && (detail.phase === "end" || detail.phase === "cancel")) {
          if (detail.action === manualExpressAction) {
            cancelManualExpress();
          }
        }
      }
      avatar.addEventListener("pointerdown", onNativePointer, { passive: true });
      avatar.addEventListener("pointermove", onNativePointer, { passive: true });
      avatar.addEventListener("action-state", onActionState);
      function applyColor(color) {
        if (config.skin) return;
        var normalized = isValidCssColor(color) ? color.trim() : null;
        if (normalized === currentColor) return;
        currentColor = normalized;
        if (!normalized) {
          avatar.removeAttribute("color");
          avatar.removeAttribute("eye-color");
          return;
        }
        avatar.setAttribute("color", normalized);
        var lum = parseColorLuminance(normalized);
        if (lum !== null && lum > 0.72) {
          avatar.setAttribute("eye-color", "#08090b");
        } else {
          avatar.removeAttribute("eye-color");
        }
      }
      function applyReduced(reduced) {
        if (typeof reduced !== "boolean" || reduced === currentReduced) return;
        currentReduced = reduced;
        avatar.setAttribute("motion", reduced ? "reduce" : "full");
      }
      function applyGaze(gazeX, gazeY, now, reduced) {
        if (reduced) {
          if (gazeActive && avatar._pointer) {
            avatar._pointer.active = false;
            avatar._pointer.influence = 0;
            gazeActive = false;
          }
          return;
        }
        if (now - lastNativePointerAt < 1200) return;
        if (avatar._dragJelly && (avatar._dragJelly.active || avatar._dragJelly.returning)) return;
        if (avatar._gestureFx && avatar._gestureFx.held) return;
        var hasGaze = Number.isFinite(gazeX) && Number.isFinite(gazeY);
        if (!hasGaze) return;
        var gx = clamp(gazeX, -1, 1);
        var gy = clamp(gazeY, -1, 1);
        var mag = Math.hypot(gx, gy);
        if (mag > 0.02) {
          gazeActive = true;
          if (avatar._pointer) {
            avatar._pointer.x = gx * 48;
            avatar._pointer.y = gy * 34;
            avatar._pointer.active = true;
            avatar._pointer.influence = clamp(mag, 0.25, 1);
            avatar._pointer.lastMove = now;
          }
          if (typeof avatar._resumeFrames === "function") avatar._resumeFrames();
        } else if (gazeActive) {
          gazeActive = false;
          if (avatar._pointer) {
            avatar._pointer.active = false;
            avatar._pointer.influence = 0;
          }
        }
      }
      function enterPhase(nextPhase, frame) {
        var prevPhase = currentPhase;
        currentPhase = nextPhase;
        if (errorHoldTimer) {
          clearTimeout(errorHoldTimer);
          errorHoldTimer = 0;
        }
        if (nextPhase !== "idle" && currentInputMode) {
          currentInputMode = false;
          safeCallPromise(function() {
            return avatar.input(false);
          });
        }
        var reduced = Boolean(frame && frame.reduced);
        var mood = String(frame && frame.mood || "").trim().toLowerCase();
        var state = String(frame && frame.state || "").trim().toLowerCase();
        switch (nextPhase) {
          case "listening":
            safeCallPromise(function() {
              return avatar.startListening();
            });
            break;
          case "thinking": {
            var style = state === "tool" || mood === "inspect" ? "cross" : "bloom";
            currentThinkingStyle = style;
            safeCallPromise(function() {
              return avatar.startWaiting({ variant: style });
            });
            break;
          }
          case "speaking":
            safeCallPromise(function() {
              return avatar.startSpeaking();
            });
            break;
          case "connecting":
            safeCallPromise(function() {
              return avatar.startWaiting({ variant: "wave" });
            });
            break;
          case "muted":
            if (reduced) {
              avatar.reset();
              if (typeof avatar.setState === "function") {
                avatar.setState("sleep", { duration: 0, notify: true });
              }
            } else {
              safeCallPromise(function() {
                return avatar.sleep();
              });
            }
            break;
          case "error": {
            var errAction = "failure";
            var holdPose = "sad";
            if (mood === "angry" || state === "blocked" || state === "policy-blocked") {
              errAction = "angry";
              holdPose = "angry";
            } else if (state === "refused" || mood === "refuse") {
              errAction = "refuse";
              holdPose = "sad";
            }
            if (reduced) {
              avatar.reset();
              if (typeof avatar.setState === "function") {
                avatar.setState(holdPose, { duration: 0, notify: true });
              }
            } else {
              var p = safePlay(avatar, errAction);
              var onDone = function() {
                if (destroyed || currentPhase !== "error") return;
                if (typeof avatar.setState === "function") {
                  avatar.setState(holdPose, { duration: 240, notify: false });
                }
              };
              if (p && typeof p.then === "function") {
                p.then(onDone, function() {
                });
              } else {
                errorHoldTimer = setTimeout(onDone, 2200);
              }
            }
            break;
          }
          case "idle":
          default: {
            if (prevPhase === "muted") {
              if (reduced) {
                avatar.reset();
              } else {
                safeCallPromise(function() {
                  return avatar.wake();
                });
              }
            } else if (prevPhase === "speaking" && !reduced) {
              var closing = mood && mood !== "neutral" && mood !== "calm" ? resolveAction(mood) : null;
              if (closing && closing !== "idle" && closing !== "sleep" && closing !== "input" && closing !== "listening" && closing !== "speaking" && closing.indexOf("waiting") !== 0) {
                safePlay(avatar, closing);
              } else {
                avatar.reset();
              }
            } else if (prevPhase !== "idle" && state !== "typing" && state !== "input") {
              avatar.reset();
            }
            break;
          }
        }
      }
      function update(frame) {
        if (destroyed || !frame || typeof frame !== "object") return;
        syncSize();
        var now = performance.now();
        var frameTime = Number.isFinite(frame.time) ? frame.time : now;
        applyReduced(frame.reduced);
        applyColor(frame.color);
        var phase = String(frame.phase || "idle").trim().toLowerCase();
        if (phase !== "idle" && phase !== "connecting" && phase !== "listening" && phase !== "thinking" && phase !== "speaking" && phase !== "muted" && phase !== "error") {
          phase = "idle";
        }
        var urgentVoicePhase = phase === "listening" || phase === "thinking" || phase === "speaking" || phase === "error";
        if (manualExpressUntil > now) {
          if (urgentVoicePhase && phase !== currentPhase) {
            cancelManualExpress();
          } else if (phase === "idle" || phase === "muted" || phase === "connecting") {
            applyGaze(frame.gazeX, frame.gazeY, now, Boolean(frame.reduced));
            return;
          }
        } else if (manualExpressAction) {
          cancelManualExpress();
        }
        if (phase !== currentPhase) {
          enterPhase(phase, frame);
        } else if (phase === "thinking") {
          var moodNow = String(frame.mood || "").trim().toLowerCase();
          var stateNow = String(frame.state || "").trim().toLowerCase();
          var wantedStyle = stateNow === "tool" || moodNow === "inspect" ? "cross" : "bloom";
          if (wantedStyle !== currentThinkingStyle) {
            currentThinkingStyle = wantedStyle;
            safeCallPromise(function() {
              return avatar.startWaiting({ variant: wantedStyle });
            });
          }
        }
        if (phase === "listening") {
          var hasLocal = Number.isFinite(frame.localLevel);
          var hasLvl = Number.isFinite(frame.level);
          if (hasLocal || hasLvl) {
            var micLvl = clamp01(hasLocal ? frame.localLevel : frame.level);
            avatar.setVoiceLevel(micLvl);
          }
        } else if (phase === "speaking") {
          var hasRemote = Number.isFinite(frame.remoteLevel);
          var hasOverall = Number.isFinite(frame.level);
          if (hasRemote || hasOverall) {
            var rawAmp = clamp01(hasRemote ? frame.remoteLevel : frame.level);
            if (rawAmp <= 0.015) {
              avatar.setVoiceLevel([0, 0]);
            } else {
              var gain = moodEnergyGain(frame.mood);
              var scaled = clamp01(rawAmp * gain);
              var tSec = frameTime / 1e3;
              var tilt = frame.reduced ? 0 : 0.18 * Math.sin(tSec * 7.3) + 0.09 * Math.sin(tSec * 13.1);
              var low = clamp01(scaled * (1 + tilt));
              var high = clamp01(scaled * (1 - tilt));
              avatar.setVoiceLevel([low, high]);
            }
          }
        }
        if (phase === "idle") {
          var st = String(frame.state || "").trim().toLowerCase();
          var wantInput = st === "typing" || st === "input";
          if (wantInput !== currentInputMode) {
            currentInputMode = wantInput;
            safeCallPromise(function() {
              return avatar.input(wantInput);
            });
          }
          var mood = String(frame.mood || "").trim().toLowerCase();
          if (mood !== currentMood) {
            var prevMood = currentMood;
            currentMood = mood;
            if (!frame.reduced && !wantInput && mood && mood !== "neutral" && mood !== "calm" && prevMood !== mood) {
              var moodAction = resolveAction(mood);
              if (moodAction && moodAction !== "idle" && moodAction !== "listening" && moodAction !== "speaking" && moodAction !== "input" && moodAction.indexOf("waiting") !== 0) {
                safePlay(avatar, moodAction);
              }
            }
          }
        } else {
          currentMood = String(frame.mood || "").trim().toLowerCase();
        }
        applyGaze(frame.gazeX, frame.gazeY, now, Boolean(frame.reduced));
      }
      function express(id) {
        if (destroyed) return;
        var action = resolveAction(id);
        if (!action) return;
        cancelManualExpress();
        if (action === "idle") {
          currentInputMode = false;
          avatar.reset();
          return;
        }
        var now = performance.now();
        var holdMs = PREVIEW_HOLD_MS[action] || 3600;
        manualExpressAction = action;
        manualExpressUntil = now + holdMs;
        if (action === "wake") {
          if (!avatar._sleeping && avatar._state !== "sleep" && typeof avatar.setState === "function") {
            avatar.setState("sleep", { duration: 0, notify: false });
            avatar._sleeping = true;
          }
          safeCallPromise(function() {
            return avatar.wake();
          });
          return;
        }
        if (action === "input") {
          safeCallPromise(function() {
            return avatar.input(true);
          });
          manualHoldTimer = setTimeout(function() {
            manualHoldTimer = 0;
            if (destroyed || manualExpressAction !== "input") return;
            cancelManualExpress();
            if (currentPhase === "idle" && !currentInputMode) {
              safeCallPromise(function() {
                return avatar.input(false);
              });
            }
          }, holdMs);
          return;
        }
        if (action === "sleep") {
          safeCallPromise(function() {
            return avatar.sleep();
          });
          return;
        }
        safePlay(avatar, action);
      }
      function touch(x, y) {
        if (destroyed) return;
        var now = performance.now();
        var rect = host.getBoundingClientRect ? host.getBoundingClientRect() : { width: lastSize || 160, height: lastSize || 160 };
        var w = Math.max(1, rect.width || lastSize || 160);
        var h = Math.max(1, rect.height || lastSize || 160);
        var nx = 0.5;
        var ny = 0.5;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
            nx = x;
            ny = y;
          } else if (x >= -1 && x <= 1 && y >= -1 && y <= 1) {
            nx = (x + 1) * 0.5;
            ny = (y + 1) * 0.5;
          } else {
            nx = clamp(x / w, 0, 1);
            ny = clamp(y / h, 0, 1);
          }
        }
        if (!currentReduced && avatar._pointer) {
          avatar._pointer.x = clamp((nx - 0.5) * 2, -1, 1) * 48;
          avatar._pointer.y = clamp((ny - 0.5) * 2, -1, 1) * 34;
          avatar._pointer.active = true;
          avatar._pointer.influence = 0.9;
          avatar._pointer.lastMove = now;
          lastNativePointerAt = now;
        }
        if (now - lastPokeAt < 1800) {
          pokeCount += 1;
        } else {
          pokeCount = 1;
        }
        lastPokeAt = now;
        if (currentPhase === "muted") {
          express("wake");
          return;
        }
        if (pokeCount >= 4) {
          pokeCount = 0;
          express(touchCycle++ % 2 === 0 ? "dizzy" : "angry");
          return;
        }
        if (ny < 0.2 && Math.abs(nx - 0.5) < 0.26) {
          express(touchCycle++ % 2 === 0 ? "surprise" : "bounce");
        } else if (ny < 0.38) {
          express(touchCycle++ % 2 === 0 ? "love" : "success");
        } else if (ny > 0.74) {
          express(touchCycle++ % 2 === 0 ? "smug-bounce" : "bow");
        } else {
          var faceReactions = ["wink", "success", "affirm", "smug", "bounce"];
          express(faceReactions[touchCycle++ % faceReactions.length]);
        }
      }
      function destroy() {
        if (destroyed) return;
        destroyed = true;
        clearTimers();
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        avatar.removeEventListener("pointerdown", onNativePointer);
        avatar.removeEventListener("pointermove", onNativePointer);
        avatar.removeEventListener("action-state", onActionState);
        if (avatar._view3dState && avatar._view3dState.timer) {
          clearTimeout(avatar._view3dState.timer);
          avatar._view3dState.timer = 0;
        }
        try {
          if (typeof avatar.setView === "function") avatar.setView("2d");
          avatar.reset();
        } catch (_) {
        }
        if (wrapper.parentNode) {
          wrapper.parentNode.removeChild(wrapper);
        }
      }
      return {
        update,
        touch,
        express,
        destroy
      };
    }
    var descriptor = {
      id: "boop",
      title: "BoopFace",
      variants: VARIANTS,
      expressions: EXPRESSIONS,
      mount
    };
    if (global2.NightAvatars && typeof global2.NightAvatars.register === "function") {
      global2.NightAvatars.register(descriptor);
    } else {
      global2.__NightAvatarsBoopDescriptor = descriptor;
    }
  })(typeof window !== "undefined" ? window : globalThis, typeof __boopface !== "undefined" ? __boopface : null);
})(typeof window !== "undefined" ? window : globalThis);
