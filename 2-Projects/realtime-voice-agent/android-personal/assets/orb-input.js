(function (global) {
  'use strict';

  function bind(canvas, orb) {
    var doc = canvas.ownerDocument;
    var win = doc.defaultView;
    var options = { capture: true, passive: true };
    var press = null;
    var lookTimer = 0;
    var lastTouchEnd = -Infinity;
    var spaceHeld = false;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('aria-label', '触摸小可');

    function clearLook() {
      win.clearTimeout(lookTimer);
      lookTimer = 0;
      orb.clearLook();
    }

    function reset() {
      press = null;
      spaceHeld = false;
      clearLook();
    }

    function follow(x, y) {
      const point = orb.localPoint(x, y);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      orb.lookAt(Math.tanh(point.x * .82), Math.tanh(point.y * .69));
    }

    function release(delay) {
      win.clearTimeout(lookTimer);
      lookTimer = win.setTimeout(clearLook, delay);
    }

    const head = doc.getElementById('avatar-engine');
    const app = doc.getElementById('app');

    function skinHit(family,x,y) {
      if (family === 'boop') {
        const face = head.querySelector('boop-face')?.shadowRoot;
        if (!face) return false;
        // 3D projects its outer wall into this SVG path on each turn.
        const wall = face.querySelector('.view-3d')?.shadowRoot?.querySelector('.wall > path');
        const outline = wall || face.querySelector('#headShape');
        const matrix = (wall || face.querySelector('#head'))?.getScreenCTM();
        if (!outline || !matrix) return false;
        return outline.isPointInFill(new DOMPoint(x,y).matrixTransform(matrix.inverse()));
      }
      const layer = head.querySelector('canvas');
      if (!layer || !layer.clientWidth || !layer.clientHeight) return false;
      // Undo the skin's animated CSS scale/roll, then test the painted pixel.
      const box = layer.getBoundingClientRect(), transform = win.getComputedStyle(layer).transform;
      const matrix = new DOMMatrix(transform==='none' ? undefined : transform);
      const d = new DOMPoint(x-box.left-box.width/2,y-box.top-box.height/2,0,0).matrixTransform(matrix.inverse());
      const px=Math.floor((.5+d.x/layer.clientWidth)*layer.width), py=Math.floor((.5+d.y/layer.clientHeight)*layer.height);
      if (px<0 || py<0 || px>=layer.width || py>=layer.height) return false;
      const a = layer.getContext('2d')?.getImageData(px,py,1,1).data[3] || 0;
      // The glass shell is visibly translucent, including its face between the eyes.
      return a >= (family === 'open' && head.dataset.variant?.endsWith(':glass') ? 24 : 128);
    }

    function onHead(target,x,y) {
      if (target !== canvas && !head.contains(target)) return false;
      const family = app.dataset.avatar;
      if (family === 'classic') return orb.hitTest(x,y);
      // A skin may be between mounts, or WebView may have lost its drawing context.
      try { return skinHit(family,x,y); } catch (_) { return false; }
    }

    function respond(x, y, onOrb) {
      if (onOrb) {
        const point = orb.localPoint(x, y);
        clearLook();
        // BoopFace already reacts to the original pointer in its shadow DOM.
        if (app.dataset.avatar !== 'boop') orb.touch(point.x, point.y);
        win.Voice?.pet?.(app.dataset.avatar);
      } else {
        follow(x, y);
        release(750);
      }
    }

    function start(id, x, y, target, at) {
      const surface = !target.closest('button, input, label, #service-panel, #color-popover, .subtitles, .bottom-bar');
      press = { id, x, y, at, target, surface, dragged:false, family:app.dataset.avatar };
      if (surface) {
        win.clearTimeout(lookTimer);
        follow(x, y);
      }
    }
    function move(id, x, y) {
      if (!press || press.id !== id) return;
      if (Math.hypot(x - press.x, y - press.y) > 7) press.dragged = true;
      if (press.surface) follow(x, y);
    }
    function finish(id, x, y, target, at) {
      const tap = press;
      if (!tap || tap.id !== id) return;
      move(id, x, y);
      press = null;
      if (tap.dragged || at - tap.at > 600) {
        if (tap.surface) release(250);
        return;
      }
      const hit = tap.surface && tap.family === app.dataset.avatar && onHead(target,x,y) &&
        (tap.target===target && x===tap.x && y===tap.y || onHead(tap.target,tap.x,tap.y));
      respond(x, y, hit);
    }

    if (win.PointerEvent) {
      doc.addEventListener('pointerdown', function (e) {
        if (!e.isPrimary || e.button !== 0) { reset(); return; }
        start(e.pointerId, e.clientX, e.clientY, e.target, e.timeStamp);
      }, options);
      doc.addEventListener('pointermove', function (e) { move(e.pointerId, e.clientX, e.clientY); }, options);
      doc.addEventListener('pointerup', function (e) {
        if (e.isPrimary && e.button === 0) finish(e.pointerId, e.clientX, e.clientY, e.target, e.timeStamp);
      }, options);
      doc.addEventListener('pointercancel', reset, options);
    } else {
      // Some older system WebViews only expose Touch Events plus a compatibility click.
      doc.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { reset(); return; }
        var t = e.touches[0];
        start(t.identifier, t.clientX, t.clientY, e.target, e.timeStamp);
      }, options);
      doc.addEventListener('touchmove', function (e) {
        if (e.touches.length !== 1) { reset(); return; }
        var t = e.touches[0];
        move(t.identifier, t.clientX, t.clientY);
      }, options);
      doc.addEventListener('touchend', function (e) {
        lastTouchEnd = performance.now();
        if (e.touches.length || !e.changedTouches.length) { reset(); return; }
        var t = e.changedTouches[0];
        finish(t.identifier, t.clientX, t.clientY, e.target, e.timeStamp);
      }, options);
      doc.addEventListener('touchcancel', function () {
        lastTouchEnd = performance.now(); reset();
      }, options);
      function realMouse(e) {
        return performance.now() - lastTouchEnd > 700 && !(e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents);
      }
      doc.addEventListener('mousedown', function (e) {
        if (e.button === 0 && realMouse(e)) start('mouse', e.clientX, e.clientY, e.target, e.timeStamp);
      }, options);
      doc.addEventListener('mousemove', function (e) {
        if (realMouse(e)) move('mouse', e.clientX, e.clientY);
      }, options);
      doc.addEventListener('mouseup', function (e) {
        if (e.button === 0 && realMouse(e)) finish('mouse', e.clientX, e.clientY, e.target, e.timeStamp);
      }, options);
    }

    doc.addEventListener('click', function (e) {
      if (e.detail === 0) {
        // Keyboard or accessibility activation has no screen coordinate.
        if (e.target === canvas) { clearLook(); orb.touch(0,0); win.Voice?.pet?.(app.dataset.avatar); return; }
        if (typeof e.target.getBoundingClientRect !== 'function') return;
        var rect = e.target.getBoundingClientRect();
        if (rect.width && rect.height) respond(rect.left + rect.width / 2, rect.top + rect.height / 2, false);
      }
    }, options);

    canvas.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (e.repeat) return;
      if (e.key === ' ') spaceHeld = true;
      else canvas.click();
    });
    canvas.addEventListener('keyup', function (e) {
      if (e.key === ' ' && spaceHeld) {
        e.preventDefault();
        spaceHeld = false;
        canvas.click();
      }
    });
    canvas.addEventListener('blur', function () { spaceHeld = false; });
    doc.addEventListener('scroll', reset, options);
    doc.addEventListener('contextmenu', function (e) {
      if (press && press.surface) e.preventDefault();
    }, {capture: true});
    doc.addEventListener('visibilitychange', function () { if (doc.hidden) reset(); });
    win.addEventListener('resize', reset, options);
    // Canvas/input blur is dispatched after pointerup when a tap changes focus.
    // Only the window actually losing focus should dismiss its newly acquired gaze.
    win.addEventListener('blur', function (e) { if (e.target === win) reset(); });
    win.addEventListener('pagehide', reset, options);
    if (win.visualViewport) {
      win.visualViewport.addEventListener('resize', reset, options);
      win.visualViewport.addEventListener('scroll', reset, options);
    }
  }

  global.NightOrbInput = { bind: bind };
})(window);
