/**
 * NightAvatars adapter for BoopFace (v0.9.0).
 *
 * This file is the locally maintainable source for the NightAvatars <-> BoopFace
 * bridge. `outside-delivery/build.mjs` embeds it directly after the bundled
 * upstream BoopFace runtime inside `engine.js`.
 */
(function initNightAvatarsBoopFace(global, boop) {
  'use strict';

  if (!boop || !boop.BoopFace) {
    throw new Error('BoopFace adapter requires bundled BoopFace runtime.');
  }

  var SKIN_NAMES = boop.SKIN_NAMES || [];
  var SKINS = boop.SKINS || {};
  // Build complete variant catalog:
  // 1. Classic 3D & Classic 2D (no skin; dynamically follows frame.color)
  // 2. All 188 built-in numbered skins in upstream SKIN_SERIES display order
  var VARIANTS = [
    { id: 'classic-3d', label: '经典黑 · 立体 3D', thumb:'avatars/boop/materials.webp', tile:0, side:14 },
    { id: 'classic-2d', label: '经典黑 · 平面 2D', thumb:'avatars/boop/materials.webp', tile:1, side:14 },
  ];

  for (var ki = 0; ki < SKIN_NAMES.length; ki++) {
    var skinId = SKIN_NAMES[ki];
    var info = SKINS[skinId];
    if (!info) continue;
    var title = info.title || skinId;
    VARIANTS.push({
      id: 'skin-' + skinId,
      label: skinId + ' · ' + title,
      thumb:'avatars/boop/materials.webp', tile:VARIANTS.length, side:14,
    });
  }

  // Complete catalog of all 33 canonical BoopFace 0.9 built-in expressions/actions.
  var EXPRESSIONS = [
    { id: 'idle', label: '待机' },
    { id: 'success', label: '开心笑眼' },
    { id: 'love', label: '心动爱心' },
    { id: 'wink', label: '俏皮眨眼' },
    { id: 'smug', label: '小得意' },
    { id: 'bounce', label: '欢快弹跳' },
    { id: 'smug-bounce', label: '得意弹跳' },
    { id: 'affirm', label: '点头确认' },
    { id: 'bow', label: '礼貌鞠躬' },
    { id: 'surprise', label: '惊讶瞪眼' },
    { id: 'think', label: '抬头思考' },
    { id: 'ponder', label: '低头沉思' },
    { id: 'observe', label: '凑近观察' },
    { id: 'inspect', label: '眯眼扫视' },
    { id: 'wary', label: '侧头警惕' },
    { id: 'bored', label: '无聊张望' },
    { id: 'dizzy', label: '晕头转向' },
    { id: 'shake', label: '转头否认' },
    { id: 'refuse', label: '摇头拒绝' },
    { id: 'failure', label: '低落失落' },
    { id: 'angry', label: '生气瞪眼' },
    { id: 'random', label: '老虎机眼' },
    { id: 'input', label: '输入光标' },
    { id: 'listening', label: '语音倾听' },
    { id: 'speaking', label: '语音说话' },
    { id: 'waiting-spin', label: '等待·绕圈' },
    { id: 'waiting-wrap', label: '等待·穿梭' },
    { id: 'waiting-wave', label: '等待·波浪' },
    { id: 'waiting-bloom', label: '等待·花瓣' },
    { id: 'waiting-cross', label: '等待·交叉' },
    { id: 'shape-wait', label: '等待·变形' },
    { id: 'sleep', label: '闭眼睡觉' },
    { id: 'wake', label: '睁眼醒来' },
  ];

  var EXPRESSION_SET = Object.create(null);
  for (var ei = 0; ei < EXPRESSIONS.length; ei++) {
    EXPRESSION_SET[EXPRESSIONS[ei].id] = true;
  }

  // Semantic mood & upstream deprecated aliases -> canonical BoopFace action.
  var ACTION_ALIAS = {
    // Upstream deprecated aliases
    wait: 'waiting-spin',
    waiting: 'waiting-spin',
    send: 'affirm',
    failed: 'failure',
    fail: 'failure',
    warning: 'wary',
    verify: 'inspect',
    review: 'inspect',
    blocked: 'angry',
    'policy-blocked': 'angry',
    error: 'refuse',
    'system-error': 'refuse',
    'connection-error': 'refuse',
    slot: 'random',
    // Common semantic mood/emotion names
    neutral: 'idle',
    calm: 'idle',
    relaxed: 'idle',
    happy: 'success',
    joy: 'success',
    glad: 'success',
    warm: 'success',
    cheerful: 'bounce',
    excited: 'bounce',
    celebrate: 'bounce',
    affection: 'love',
    affectionate: 'love',
    heart: 'love',
    playful: 'wink',
    tease: 'wink',
    proud: 'smug',
    confident: 'smug',
    curious: 'observe',
    interested: 'observe',
    focused: 'inspect',
    thinking: 'think',
    thoughtful: 'ponder',
    shy: 'ponder',
    surprised: 'surprise',
    shocked: 'surprise',
    amazed: 'surprise',
    cautious: 'wary',
    suspicious: 'wary',
    sad: 'failure',
    down: 'failure',
    sorry: 'failure',
    apologetic: 'bow',
    upset: 'failure',
    annoyed: 'angry',
    frustrated: 'angry',
    mad: 'angry',
    confused: 'dizzy',
    dizzy: 'dizzy',
    sleepy: 'sleep',
    tired: 'sleep',
    nod: 'affirm',
    yes: 'affirm',
    no: 'refuse',
    typing: 'input',
  };

  // Approximate hold duration (ms) for previewing continuous or finite actions via express().
  var PREVIEW_HOLD_MS = {
    input: 2600,
    sleep: 4000,
    listening: 2900,
    speaking: 2900,
    'waiting-spin': 3300,
    'waiting-wrap': 2500,
    'waiting-wave': 3400,
    'waiting-bloom': 3900,
    'waiting-cross': 3900,
    'shape-wait': 2800,
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function clamp01(v) {
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
  }

  function resolveAction(raw) {
    var key = String(raw || '').trim().toLowerCase();
    if (!key) return null;
    if (EXPRESSION_SET[key]) return key;
    if (Object.prototype.hasOwnProperty.call(ACTION_ALIAS, key)) return ACTION_ALIAS[key];
    return null;
  }

  function parseVariant(variantId) {
    var raw = String(variantId || 'classic-3d').trim().toLowerCase();
    if (!raw || raw === 'default' || raw === 'classic-3d' || raw === '3d') {
      return { skin: null, view: '3d' };
    }
    if (raw === 'classic' || raw === 'classic-2d' || raw === '2d' || raw === 'flat' || raw === 'none') {
      return { skin: null, view: '2d' };
    }
    var m = /^(?:skin-)?(\d+)(?:-(2d|3d))?$/.exec(raw);
    if (m && Object.prototype.hasOwnProperty.call(SKINS, m[1])) {
      return { skin: m[1], view: m[2] || '3d' };
    }
    return { skin: null, view: '3d' };
  }

  function parseColorLuminance(color) {
    var s = String(color || '').trim();
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
    if (typeof color !== 'string') return false;
    var s = color.trim();
    if (!s || s.length > 48) return false;
    return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]{3,24})$/i.test(s);
  }

  function moodEnergyGain(mood) {
    var m = String(mood || '').trim().toLowerCase();
    if (m === 'excited' || m === 'happy' || m === 'joy' || m === 'cheerful' || m === 'angry' || m === 'surprised' || m === 'playful') {
      return 1.18;
    }
    if (m === 'calm' || m === 'sad' || m === 'down' || m === 'sleepy' || m === 'tired' || m === 'shy' || m === 'sorry') {
      return 0.74;
    }
    return 1.0;
  }

  function safePlay(avatar, action) {
    try {
      var res = avatar.play(action);
      if (res && typeof res.catch === 'function') res.catch(function () {});
      return res;
    } catch (_) {
      return null;
    }
  }

  function safeCallPromise(fn) {
    try {
      var res = fn();
      if (res && typeof res.catch === 'function') res.catch(function () {});
      return res;
    } catch (_) {
      return null;
    }
  }

  function mount(host, variantId) {
    if (!host || typeof host.appendChild !== 'function') {
      throw new Error('BoopFace mount() requires a valid DOM host element.');
    }

    var config = parseVariant(variantId);
    var destroyed = false;

    // Container keeps square aspect centered with headroom for BoopFace's antenna dot.
    var wrapper = document.createElement('div');
    wrapper.className = 'boopface-night-host';
    wrapper.style.cssText =
      'position:relative;width:100%;height:100%;display:flex;align-items:center;' +
      'justify-content:center;overflow:visible;box-sizing:border-box;padding-top:3%;';

    var avatar = document.createElement('boop-face');
    avatar.setAttribute('auto-sleep', '0');
    avatar.setAttribute('wake-on', 'manual');
    avatar.setAttribute('view', config.view);
    if (config.skin) {
      avatar.setAttribute('skin', config.skin);
    }

    var lastSize = 0;
    function syncSize() {
      if (destroyed) return;
      var rect = host.getBoundingClientRect ? host.getBoundingClientRect() : null;
      var w = rect && rect.width > 0 ? rect.width : (host.clientWidth || 160);
      var h = rect && rect.height > 0 ? rect.height : (host.clientHeight || w);
      var edge = Math.min(w, h);
      // 90% leaves headroom so the antenna (cy=12, r=15) and subtle bounce never clip.
      var px = Math.max(32, Math.round(edge * 0.90));
      if (px !== lastSize) {
        lastSize = px;
        avatar.setAttribute('size', String(px));
      }
    }

    syncSize();
    wrapper.appendChild(avatar);
    host.appendChild(wrapper);

    // Ensure skin is applied synchronously if painters are already warm.
    if (config.skin && typeof avatar.setSkin === 'function') {
      try { avatar.setSkin(config.skin); } catch (_) {}
    }

    var resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(function () {
        syncSize();
      });
      resizeObserver.observe(host);
    }

    // State tracking
    var currentPhase = 'idle';
    var currentThinkingStyle = 'bloom';
    var currentReduced = null;
    var currentColor = null;
    var currentMood = '';
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
      if (manualExpressAction && (detail.phase === 'end' || detail.phase === 'cancel')) {
        if (detail.action === manualExpressAction) {
          cancelManualExpress();
        }
      }
    }

    avatar.addEventListener('pointerdown', onNativePointer, { passive: true });
    avatar.addEventListener('pointermove', onNativePointer, { passive: true });
    avatar.addEventListener('action-state', onActionState);

    function applyColor(color) {
      // Numbered skins own their head surface; only classic (skin=null) takes frame.color.
      if (config.skin) return;
      var normalized = isValidCssColor(color) ? color.trim() : null;
      if (normalized === currentColor) return;
      currentColor = normalized;
      if (!normalized) {
        avatar.removeAttribute('color');
        avatar.removeAttribute('eye-color');
        return;
      }
      avatar.setAttribute('color', normalized);
      var lum = parseColorLuminance(normalized);
      if (lum !== null && lum > 0.72) {
        avatar.setAttribute('eye-color', '#08090b');
      } else {
        avatar.removeAttribute('eye-color');
      }
    }

    function applyReduced(reduced) {
      if (typeof reduced !== 'boolean' || reduced === currentReduced) return;
      currentReduced = reduced;
      avatar.setAttribute('motion', reduced ? 'reduce' : 'full');
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
      // Yield to direct user pointer drag/petting for 1.2s so tactile gestures never fight gaze.
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
        if (typeof avatar._resumeFrames === 'function') avatar._resumeFrames();
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

      if (nextPhase !== 'idle' && currentInputMode) {
        currentInputMode = false;
        safeCallPromise(function () { return avatar.input(false); });
      }

      var reduced = Boolean(frame && frame.reduced);
      var mood = String((frame && frame.mood) || '').trim().toLowerCase();
      var state = String((frame && frame.state) || '').trim().toLowerCase();

      switch (nextPhase) {
        case 'listening':
          safeCallPromise(function () { return avatar.startListening(); });
          break;

        case 'thinking': {
          var style = (state === 'tool' || mood === 'inspect') ? 'cross' : 'bloom';
          currentThinkingStyle = style;
          safeCallPromise(function () { return avatar.startWaiting({ variant: style }); });
          break;
        }

        case 'speaking':
          safeCallPromise(function () { return avatar.startSpeaking(); });
          break;

        case 'connecting':
          safeCallPromise(function () { return avatar.startWaiting({ variant: 'wave' }); });
          break;

        case 'muted':
          if (reduced) {
            avatar.reset();
            if (typeof avatar.setState === 'function') {
              avatar.setState('sleep', { duration: 0, notify: true });
            }
          } else {
            safeCallPromise(function () { return avatar.sleep(); });
          }
          break;

        case 'error': {
          var errAction = 'failure';
          var holdPose = 'sad';
          if (mood === 'angry' || state === 'blocked' || state === 'policy-blocked') {
            errAction = 'angry';
            holdPose = 'angry';
          } else if (state === 'refused' || mood === 'refuse') {
            errAction = 'refuse';
            holdPose = 'sad';
          }
          if (reduced) {
            avatar.reset();
            if (typeof avatar.setState === 'function') {
              avatar.setState(holdPose, { duration: 0, notify: true });
            }
          } else {
            var p = safePlay(avatar, errAction);
            var onDone = function () {
              if (destroyed || currentPhase !== 'error') return;
              if (typeof avatar.setState === 'function') {
                avatar.setState(holdPose, { duration: 240, notify: false });
              }
            };
            if (p && typeof p.then === 'function') {
              p.then(onDone, function () {});
            } else {
              errorHoldTimer = setTimeout(onDone, 2200);
            }
          }
          break;
        }

        case 'idle':
        default: {
          if (prevPhase === 'muted') {
            if (reduced) {
              avatar.reset();
            } else {
              safeCallPromise(function () { return avatar.wake(); });
            }
          } else if (prevPhase === 'speaking' && !reduced) {
            // Optional natural closing reaction matching the utterance's mood.
            var closing = mood && mood !== 'neutral' && mood !== 'calm' ? resolveAction(mood) : null;
            if (closing && closing !== 'idle' && closing !== 'sleep' && closing !== 'input' &&
                closing !== 'listening' && closing !== 'speaking' && closing.indexOf('waiting') !== 0) {
              safePlay(avatar, closing);
            } else {
              avatar.reset();
            }
          } else if (prevPhase !== 'idle' && state !== 'typing' && state !== 'input') {
            avatar.reset();
          }
          break;
        }
      }
    }

    function update(frame) {
      if (destroyed || !frame || typeof frame !== 'object') return;

      syncSize();

      var now = performance.now();
      var frameTime = Number.isFinite(frame.time) ? frame.time : now;

      applyReduced(frame.reduced);
      applyColor(frame.color);

      var phase = String(frame.phase || 'idle').trim().toLowerCase();
      if (
        phase !== 'idle' &&
        phase !== 'connecting' &&
        phase !== 'listening' &&
        phase !== 'thinking' &&
        phase !== 'speaking' &&
        phase !== 'muted' &&
        phase !== 'error'
      ) {
        phase = 'idle';
      }

      var urgentVoicePhase = (
        phase === 'listening' ||
        phase === 'thinking' ||
        phase === 'speaking' ||
        phase === 'error'
      );

      // Urgent conversation phases preempt manual expression previews.
      if (manualExpressUntil > now) {
        if (urgentVoicePhase && phase !== currentPhase) {
          cancelManualExpress();
        } else if (phase === 'idle' || phase === 'muted' || phase === 'connecting') {
          applyGaze(frame.gazeX, frame.gazeY, now, Boolean(frame.reduced));
          return;
        }
      } else if (manualExpressAction) {
        cancelManualExpress();
      }

      // Phase transition
      if (phase !== currentPhase) {
        enterPhase(phase, frame);
      } else if (phase === 'thinking') {
        var moodNow = String(frame.mood || '').trim().toLowerCase();
        var stateNow = String(frame.state || '').trim().toLowerCase();
        var wantedStyle = (stateNow === 'tool' || moodNow === 'inspect') ? 'cross' : 'bloom';
        if (wantedStyle !== currentThinkingStyle) {
          currentThinkingStyle = wantedStyle;
          safeCallPromise(function () { return avatar.startWaiting({ variant: wantedStyle }); });
        }
      }

      // Audio-reactive amplitude driving for listening & speaking
      if (phase === 'listening') {
        var hasLocal = Number.isFinite(frame.localLevel);
        var hasLvl = Number.isFinite(frame.level);
        if (hasLocal || hasLvl) {
          var micLvl = clamp01(hasLocal ? frame.localLevel : frame.level);
          avatar.setVoiceLevel(micLvl);
        }
      } else if (phase === 'speaking') {
        var hasRemote = Number.isFinite(frame.remoteLevel);
        var hasOverall = Number.isFinite(frame.level);
        if (hasRemote || hasOverall) {
          var rawAmp = clamp01(hasRemote ? frame.remoteLevel : frame.level);
          if (rawAmp <= 0.015) {
            avatar.setVoiceLevel([0, 0]);
          } else {
            var gain = moodEnergyGain(frame.mood);
            var scaled = clamp01(rawAmp * gain);
            var tSec = frameTime / 1000;
            var tilt = frame.reduced
              ? 0
              : 0.18 * Math.sin(tSec * 7.3) + 0.09 * Math.sin(tSec * 13.1);
            var low = clamp01(scaled * (1 + tilt));
            var high = clamp01(scaled * (1 - tilt));
            avatar.setVoiceLevel([low, high]);
          }
        }
      }

      // Idle state extras: typing cursor & edge-triggered mood shifts
      if (phase === 'idle') {
        var st = String(frame.state || '').trim().toLowerCase();
        var wantInput = (st === 'typing' || st === 'input');
        if (wantInput !== currentInputMode) {
          currentInputMode = wantInput;
          safeCallPromise(function () { return avatar.input(wantInput); });
        }

        var mood = String(frame.mood || '').trim().toLowerCase();
        if (mood !== currentMood) {
          var prevMood = currentMood;
          currentMood = mood;
          if (!frame.reduced && !wantInput && mood && mood !== 'neutral' && mood !== 'calm' && prevMood !== mood) {
            var moodAction = resolveAction(mood);
            if (moodAction && moodAction !== 'idle' && moodAction !== 'listening' &&
                moodAction !== 'speaking' && moodAction !== 'input' &&
                moodAction.indexOf('waiting') !== 0) {
              safePlay(avatar, moodAction);
            }
          }
        }
      } else {
        currentMood = String(frame.mood || '').trim().toLowerCase();
      }

      // Gaze tracking (drives eyes, 2D head-follow, 3D head yaw/pitch, and skin lighting)
      applyGaze(frame.gazeX, frame.gazeY, now, Boolean(frame.reduced));
    }

    function express(id) {
      if (destroyed) return;
      var action = resolveAction(id);
      if (!action) return;

      cancelManualExpress();

      if (action === 'idle') {
        currentInputMode = false;
        avatar.reset();
        return;
      }

      var now = performance.now();
      var holdMs = PREVIEW_HOLD_MS[action] || 3600;
      manualExpressAction = action;
      manualExpressUntil = now + holdMs;

      if (action === 'wake') {
        // Wake is a no-op if not sleeping; briefly close eyes so the wake animation is visible.
        if (!avatar._sleeping && avatar._state !== 'sleep' && typeof avatar.setState === 'function') {
          avatar.setState('sleep', { duration: 0, notify: false });
          avatar._sleeping = true;
        }
        safeCallPromise(function () { return avatar.wake(); });
        return;
      }

      if (action === 'input') {
        safeCallPromise(function () { return avatar.input(true); });
        manualHoldTimer = setTimeout(function () {
          manualHoldTimer = 0;
          if (destroyed || manualExpressAction !== 'input') return;
          cancelManualExpress();
          if (currentPhase === 'idle' && !currentInputMode) {
            safeCallPromise(function () { return avatar.input(false); });
          }
        }, holdMs);
        return;
      }

      if (action === 'sleep') {
        safeCallPromise(function () { return avatar.sleep(); });
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

      // Look briefly toward the touch point (unless reduced motion).
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

      // Wake up gently if tapped while sleeping/muted (only visual if idle; keep muted intact).
      if (currentPhase === 'muted') {
        express('wake');
        return;
      }

      // Rapid multi-tap easter egg
      if (pokeCount >= 4) {
        pokeCount = 0;
        express(touchCycle++ % 2 === 0 ? 'dizzy' : 'angry');
        return;
      }

      // Zone-aware tactile reactions matching BoopFace's anatomy:
      // - Top antenna zone -> surprise / bounce
      // - Forehead zone -> love / success (head pat)
      // - Lower cheek / chin -> smug-bounce / bow
      // - Center face -> wink / bounce / affirm / smug
      if (ny < 0.20 && Math.abs(nx - 0.5) < 0.26) {
        express(touchCycle++ % 2 === 0 ? 'surprise' : 'bounce');
      } else if (ny < 0.38) {
        express(touchCycle++ % 2 === 0 ? 'love' : 'success');
      } else if (ny > 0.74) {
        express(touchCycle++ % 2 === 0 ? 'smug-bounce' : 'bow');
      } else {
        var faceReactions = ['wink', 'success', 'affirm', 'smug', 'bounce'];
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
      avatar.removeEventListener('pointerdown', onNativePointer);
      avatar.removeEventListener('pointermove', onNativePointer);
      avatar.removeEventListener('action-state', onActionState);

      // Clear any pending 3D rebuild timer before disconnecting.
      if (avatar._view3dState && avatar._view3dState.timer) {
        clearTimeout(avatar._view3dState.timer);
        avatar._view3dState.timer = 0;
      }
      try {
        if (typeof avatar.setView === 'function') avatar.setView('2d');
        avatar.reset();
      } catch (_) {}

      if (wrapper.parentNode) {
        wrapper.parentNode.removeChild(wrapper);
      }
    }

    return {
      update: update,
      touch: touch,
      express: express,
      destroy: destroy,
    };
  }

  var descriptor = {
    id: 'boop',
    title: 'BoopFace',
    variants: VARIANTS,
    expressions: EXPRESSIONS,
    mount: mount,
  };

  if (global.NightAvatars && typeof global.NightAvatars.register === 'function') {
    global.NightAvatars.register(descriptor);
  } else {
    global.__NightAvatarsBoopDescriptor = descriptor;
  }
})(typeof window !== 'undefined' ? window : globalThis, typeof __boopface !== 'undefined' ? __boopface : null);
