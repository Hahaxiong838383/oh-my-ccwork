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

    function respond(x, y, onOrb) {
      var point = orb.localPoint(x, y);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      if (onOrb) {
        clearLook();
        orb.touch(point.x, point.y);
        return;
      }
      // Normalise the vector as a whole: a tall screen corner is more up than left.
      var length = Math.max(1, Math.hypot(point.x, point.y));
      // A tap turns the face toward the target while keeping the nearer eye on the visible hemisphere.
      orb.lookAt(.54 * point.x / length, .54 * point.y / length);
      win.clearTimeout(lookTimer);
      lookTimer = win.setTimeout(clearLook, 1200);
    }

    function start(id, x, y, target) {
      press = { id: id, x: x, y: y, at: performance.now(), onOrb: target === canvas && orb.hitTest(x, y) };
    }
    function move(id, x, y) {
      if (press && press.id === id && Math.hypot(x - press.x, y - press.y) > 10) press = null;
    }
    function finish(id, x, y, target) {
      move(id, x, y);
      var tap = press;
      press = null;
      if (!tap || tap.id !== id || performance.now() - tap.at > 600) return;
      respond(x, y, tap.onOrb && target === canvas && orb.hitTest(x, y));
    }

    if (win.PointerEvent) {
      doc.addEventListener('pointerdown', function (e) {
        if (!e.isPrimary || e.button !== 0) { press = null; return; }
        start(e.pointerId, e.clientX, e.clientY, e.target);
      }, options);
      doc.addEventListener('pointermove', function (e) { move(e.pointerId, e.clientX, e.clientY); }, options);
      doc.addEventListener('pointerup', function (e) {
        if (e.isPrimary && e.button === 0) finish(e.pointerId, e.clientX, e.clientY, e.target);
      }, options);
      doc.addEventListener('pointercancel', function () { press = null; }, options);
    } else {
      // Some older system WebViews only expose Touch Events plus a compatibility click.
      doc.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { press = null; return; }
        var t = e.touches[0];
        start(t.identifier, t.clientX, t.clientY, e.target);
      }, options);
      doc.addEventListener('touchmove', function (e) {
        if (e.touches.length !== 1) { press = null; return; }
        var t = e.touches[0];
        move(t.identifier, t.clientX, t.clientY);
      }, options);
      doc.addEventListener('touchend', function (e) {
        lastTouchEnd = performance.now();
        if (e.touches.length || !e.changedTouches.length) { press = null; return; }
        var t = e.changedTouches[0];
        finish(t.identifier, t.clientX, t.clientY, e.target);
      }, options);
      doc.addEventListener('touchcancel', function () {
        lastTouchEnd = performance.now(); press = null;
      }, options);
      function realMouse(e) {
        return performance.now() - lastTouchEnd > 700 && !(e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents);
      }
      doc.addEventListener('mousedown', function (e) {
        if (e.button === 0 && realMouse(e)) start('mouse', e.clientX, e.clientY, e.target);
      }, options);
      doc.addEventListener('mousemove', function (e) {
        if (realMouse(e)) move('mouse', e.clientX, e.clientY);
      }, options);
      doc.addEventListener('mouseup', function (e) {
        if (e.button === 0 && realMouse(e)) finish('mouse', e.clientX, e.clientY, e.target);
      }, options);
    }

    doc.addEventListener('click', function (e) {
      if (e.detail === 0) {
        // Keyboard or accessibility activation has no screen coordinate.
        if (e.target === canvas) { clearLook(); orb.touch(); return; }
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
    doc.addEventListener('contextmenu', function () { press = null; }, options);
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
