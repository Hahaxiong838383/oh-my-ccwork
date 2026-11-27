(function (global) {
  'use strict';

  var STORAGE_KEY = 'xiaoke.night.accent.v1';
  var DEFAULT_COLOR = '#4F7DF3';
  var MAX_STATUS_LEN = 96;

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
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

  function readSavedColor() {
    try {
      var stored = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      return normalizeHex(stored);
    } catch (_) {
      return null;
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

  var savedColor = readSavedColor();
  var committedColor = savedColor || DEFAULT_COLOR;
  var explicitColor = Boolean(savedColor);
  var orb = canvasEl ? new global.NightSphere(canvasEl, committedColor) : null;
  var appearance = orb && global.NightAvatars ? global.NightAvatars.attach(orb) : null;
  var wheel = global.NightColorWheel.attach({
    preview: hex => paintColor(hex, true, true),
    commit: hex => selectColor(hex, true, true),
    cancel: () => { paintColor(committedColor, explicitColor, false); wheel.sync(committedColor); }
  });

  function paintColor(hex, explicit, dragging) {
    var rgb = hexToRgb(hex);
    document.documentElement.style.setProperty('--accent', hex);
    document.documentElement.style.setProperty('--accent-rgb', rgb.r + ', ' + rgb.g + ', ' + rgb.b);

    if (colorHexEl) {
      colorHexEl.textContent = hex;
    }
    for (var i = 0; i < swatchEls.length; i++) {
      var dot = swatchEls[i];
      var dotColor = (dot.getAttribute('data-color') || '').toUpperCase();
      dot.classList.toggle('is-active', dotColor === hex);
    }

    if (orb) {
      orb.customColor = explicit;
      orb.previewColor = dragging;
      orb.setColor(hex);
    }
  }

  function selectColor(hex, local, fromWheel) {
    // A remote echo of the initial accent must not replace a skin's own palette.
    explicitColor = local || explicitColor || hex !== DEFAULT_COLOR;
    committedColor = hex;
    if (explicitColor) saveColor(hex);
    if (!local && wheel.editing()) return;
    paintColor(hex, explicitColor, false);
    if (!fromWheel) wheel.sync(hex);
    if (local) callVoice('onAccentPick', hex);
  }

  function setPopoverOpen(open) {
    if (!colorPopoverEl || !btnPaletteEl) return;
    if (!open) wheel.close();
    if (appearance) appearance.setOpen(open);
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
      var facePhase = s.phase;
      if (s.phase === 'connecting' && /重连/.test(s.status)) facePhase = 'reconnecting';
      else if (s.phase === 'connecting' && /等待小可接听/.test(s.status)) facePhase = 'waiting';
      else if (/需要麦克风权限|请检查权限|设备凭据无效/.test(s.status)) facePhase = 'blocked';
      else if (isErrorState(s.phase, s.status)) facePhase = 'error';
      orb.setState(facePhase, s.active, s.muted);
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

  const closeAppearance = () => {
    if (!colorPopoverEl || colorPopoverEl.hidden) return false;
    setPopoverOpen(false);
    btnPaletteEl.focus({preventScroll: true});
    return true;
  };
  document.getElementById('appearance-done')?.addEventListener('click', closeAppearance);
  document.getElementById('pair-key')?.addEventListener('focus', closeAppearance);
  global.NightCloseAppearance = closeAppearance;
  // Wire UI Events
  if (btnPaletteEl) {
    btnPaletteEl.addEventListener('click', function (e) {
      e.stopPropagation();
      setPopoverOpen(colorPopoverEl ? colorPopoverEl.hidden : false);
    });
  }

  if (colorPopoverEl) {
    btnPaletteEl.addEventListener('click', function () {
      const service = document.getElementById('service-panel');
      if (!colorPopoverEl.hidden && service && !service.hidden) document.getElementById('service-close').click();
    });
    colorPopoverEl.addEventListener('click', function (e) {
      e.stopPropagation();
    });
  }

  for (var i = 0; i < swatchEls.length; i++) {
    swatchEls[i].addEventListener('click', function () {
      var hex = this.getAttribute('data-color');
      selectColor(hex, true, false);
    });
  }

  document.addEventListener('click', function () {
    setPopoverOpen(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeAppearance();
    }
  });

  if (avatarWrapEl) {
    avatarWrapEl.addEventListener('click', function () {
      setPopoverOpen(false);
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

  if (orb && global.NightOrbInput) global.NightOrbInput.bind(canvasEl, orb);

  // Initialize color, clean initial DOM, and animation loop
  paintColor(committedColor, explicitColor, false);
  wheel.sync(committedColor);
  applyStateToDom({ paired: false, active: false });
  if (orb && !document.hidden) {
    orb.start();
  }

  global.NightView = {
    render: render,
    level: level,
    accent: function () {
      return committedColor;
    },
    setAccent: function (rawHex, source) {
      var hex = normalizeHex(rawHex);
      if (!hex) return false;
      selectColor(hex, source === 'local', false);
      return true;
    },
    speech: function (patch) {
      if (orb && orb.setSpeech) orb.setSpeech(patch);
    },
    micLevel: function (value) {
      if (orb) orb.micTarget = clamp(Number(value) || 0, 0, 1);
    }
  };
})(window);
