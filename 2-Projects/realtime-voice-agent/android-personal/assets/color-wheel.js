(function (global) {
  'use strict';

  function channels(h, s, v) {
    const channel = n => {
      const k = (n + h / 60) % 6;
      return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4-k, 1))));
    };
    return '#' + [channel(5), channel(3), channel(1)].map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function attach({preview, commit, cancel}) {
    const get = id => document.getElementById(id);
    const panel = get('color-wheel-panel'), trigger = get('color-custom');
    const wheel = get('color-wheel'), marker = get('wheel-marker'), value = get('wheel-value');
    const sheet = get('color-popover'), back = get('wheel-back');
    let hue = 0, saturation = 0, brightness = 1, pointer = null, changingValue = false;
    const clamp = n => Math.max(0, Math.min(1, n));
    const hex = () => channels(hue, saturation, brightness);
    function draw() {
      const angle = hue * Math.PI / 180;
      marker.style.left = (50 + 50 * saturation * Math.sin(angle)) + '%';
      marker.style.top = (50 - 50 * saturation * Math.cos(angle)) + '%';
      marker.style.backgroundColor = hex();
      wheel.style.setProperty('--wheel-dim', String(1-brightness));
      value.value = String(Math.round(brightness*100));
      value.style.setProperty('--bright-end', channels(hue,saturation,1));
      wheel.setAttribute('aria-valuenow',String(Math.round(hue) % 360));
      wheel.setAttribute('aria-valuetext','色相 ' + Math.round(hue) + ' 度，饱和度 ' + Math.round(saturation*100) + '%');
    }
    function sync(color) {
      const [r,g,b] = color.slice(1).match(/../g).map(c => parseInt(c,16)/255);
      const max = Math.max(r,g,b), diff = max - Math.min(r,g,b);
      if (diff) hue = ((max===r ? (g-b)/diff : max===g ? (b-r)/diff+2 : (r-g)/diff+4)*60+360)%360;
      if (max) saturation = diff/max;
      brightness = max;
      draw();
    }
    function point(e) {
      const box = wheel.getBoundingClientRect();
      const dx = (e.clientX-box.left)*2/box.width-1, dy = (e.clientY-box.top)*2/box.height-1;
      saturation = clamp(Math.hypot(dx,dy));
      if (saturation > .001) hue = (Math.atan2(dx,-dy)*180/Math.PI+360)%360;
      draw(); preview(hex());
    }
    wheel.addEventListener('pointerdown', e => {
      if (e.button !== 0 || pointer !== null) return;
      pointer = e.pointerId; wheel.setPointerCapture(pointer); point(e);
    });
    wheel.addEventListener('pointermove', e => { if (e.pointerId === pointer) point(e); });
    wheel.addEventListener('pointerup', e => {
      if (e.pointerId !== pointer) return;
      point(e); pointer = null; commit(hex());
    });
    function abort() {
      if (pointer === null && !changingValue) return;
      pointer = null; changingValue = false; cancel();
    }
    wheel.addEventListener('lostpointercapture', abort);
    wheel.addEventListener('pointercancel', abort);
    wheel.addEventListener('keydown', e => {
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') hue = (hue-step+360)%360;
      else if (e.key === 'ArrowRight') hue = (hue+step)%360;
      else if (e.key === 'ArrowUp') saturation = clamp(saturation+step/100);
      else if (e.key === 'ArrowDown') saturation = clamp(saturation-step/100);
      else return;
      e.preventDefault(); draw(); commit(hex());
    });
    value.addEventListener('input', () => {
      changingValue = true; brightness = Number(value.value)/100; draw(); preview(hex());
    });
    value.addEventListener('change', () => {
      changingValue = false; brightness = Number(value.value)/100; draw(); commit(hex());
    });
    value.addEventListener('pointercancel', abort);
    function open(show) {
      if (!show) abort();
      sheet.classList.toggle('wheel-open',show);
      panel.hidden = !show; back.hidden = !show;
      trigger.setAttribute('aria-expanded',String(show));
    }
    back.addEventListener('click', () => { open(false); trigger.focus(); });
    trigger.addEventListener('click', () => open(panel.hidden));
    document.addEventListener('visibilitychange', () => { if (document.hidden) abort(); });
    return {sync, close:() => open(false), editing:() => pointer !== null || changingValue};
  }
  global.NightColorWheel = {attach};
})(window);
