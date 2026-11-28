(function (global) {
  'use strict';
  // Each note is [onset, length, starting Hz, ending Hz, peak, harmonic].
  const notes = {
    classic: [[0,.27,420,408,.10,0], [.016,.25,845,815,.040,0]],
    open:    [[0,.095,660,765,.10,.12], [.068,.15,925,1100,.075,.08]],
    boop:    [[0,.15,245,650,.14,.10], [.10,.105,445,315,.060,.06]],
    robot:   [[0,.075,565,565,.09,.30], [.092,.10,760,760,.075,.30]]
  };
  const tau = Math.PI * 2;
  let playing = null, lastTap = -Infinity;

  function render(ctx, score, inCall) {
    const rate = ctx.sampleRate;
    const end = Math.max(...score.map(note => note[0]+note[1]));
    const buffer = ctx.createBuffer(1, Math.ceil(end*rate), rate);
    const pcm = buffer.getChannelData(0);
    for (const [delay,duration,from,to,peak,harmonic] of score) {
      const offset = Math.round(delay*rate);
      const samples = Math.min(pcm.length-offset, Math.round(duration*rate));
      for (let i=0; i<samples; i++) {
        const t=i/rate, p=t/duration;
        const phase=tau*t*(from+.5*(to-from)*p);
        const env=Math.min(1,t/.008,(duration-t)/.018)*Math.exp(-2.7*p);
        pcm[offset+i] += (inCall ? .55 : 1)*peak*env*(Math.sin(phase)+harmonic*Math.sin(3*phase));
      }
    }
    return buffer;
  }

  function stop() {
    const sound = playing;
    if (!sound) return;
    playing = null;
    clearTimeout(sound.timeout);
    if (sound.source) {
      sound.source.onended = null;
      try { sound.source.stop(); } catch (_) {}
      sound.source.disconnect();
    }
    // The room owns its shared context and all microphone connections.
    if (sound.ownsContext && sound.ctx.state !== 'closed') sound.ctx.close().catch(() => {});
  }

  async function play(family, roomContext) {
    const now = performance.now();
    if (!Object.prototype.hasOwnProperty.call(notes,family) || document.hidden || now-lastTap<360) return;
    lastTap=now;
    stop();
    let sound;
    try {
      const ctx = roomContext || new global.AudioContext();
      sound = playing = {ctx, ownsContext:!roomContext};
      sound.timeout = setTimeout(() => { if (playing===sound) stop(); }, 650);
      if (ctx.state !== 'running') await ctx.resume();
      if (playing!==sound || document.hidden || ctx.state!=='running') return;
      const source = sound.source = ctx.createBufferSource();
      source.buffer = render(ctx,notes[family],Boolean(roomContext));
      source.connect(ctx.destination);
      source.onended = () => { if (playing===sound) stop(); };
      source.start();
    } catch (_) {
      if (sound && playing===sound) stop();
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  global.addEventListener('pagehide',stop);
  global.NightTouchSound = {play,stop};
})(window);
