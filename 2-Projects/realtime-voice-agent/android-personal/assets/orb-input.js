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

    function respond(x, y, onOrb) {
      if (onOrb) {
        const point = orb.localPoint(x, y);
        clearLook();
        orb.touch(point.x, point.y);
      } else {
        follow(x, y);
        release(750);
      }
    }

    function start(id, x, y, target) {
      const surface = !target.closest('button, input, label, #service-panel, #color-popover, .subtitles, .bottom-bar');
      press = { id, x, y, at: performance.now(), surface, dragged: false,
        onOrb: target === canvas && orb.hitTest(x, y) };
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
    function finish(id, x, y, target) {
      const tap = press;
      if (!tap || tap.id !== id) return;
      move(id, x, y);
      press = null;
      if (tap.dragged || performance.now() - tap.at > 600) {
        if (tap.surface) release(250);
        return;
      }
      respond(x, y, tap.onOrb && target === canvas && orb.hitTest(x, y));
    }

    if (win.PointerEvent) {
      doc.addEventListener('pointerdown', function (e) {
        if (!e.isPrimary || e.button !== 0) { reset(); return; }
        start(e.pointerId, e.clientX, e.clientY, e.target);
      }, options);
      doc.addEventListener('pointermove', function (e) { move(e.pointerId, e.clientX, e.clientY); }, options);
      doc.addEventListener('pointerup', function (e) {
        if (e.isPrimary && e.button === 0) finish(e.pointerId, e.clientX, e.clientY, e.target);
      }, options);
      doc.addEventListener('pointercancel', reset, options);
    } else {
      // Some older system WebViews only expose Touch Events plus a compatibility click.
      doc.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { reset(); return; }
        var t = e.touches[0];
        start(t.identifier, t.clientX, t.clientY, e.target);
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
        finish(t.identifier, t.clientX, t.clientY, e.target);
      }, options);
      doc.addEventListener('touchcancel', function () {
        lastTouchEnd = performance.now(); reset();
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
