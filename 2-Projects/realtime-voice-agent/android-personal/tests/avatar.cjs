// Offline regression. Run: node tests/avatar.cjs [asset directory extracted from an APK]
// Use PLAYWRIGHT_MODULE and CHROMIUM_PATH to select an existing local installation.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(process.argv[2] || path.join(__dirname, '../assets'));
const origin = 'http://localhost:13092';

// Replace signalling only. The app creates its usual Web Audio analysers and draws
// its normal canvas. Each side carries distinct PCM from an actual MediaStreamTrack.
function installRoomFixture() {
  window.NightHost = {
    paired: () => true, setCall() {}, event() {},
    micPermission: id => Voice.onPermission(id, true),
    ticket: id => Voice.onTicket(id, { url: 'wss://pa.hahaxiong.cc:8666', token: 'fixture' }),
  };
  function tone(ctx, frequency) {
    const sink = ctx.createMediaStreamDestination(), oscillator = ctx.createOscillator(), gain = ctx.createGain();
    gain.gain.value = 0;
    oscillator.frequency.value = frequency;
    oscillator.connect(gain).connect(sink);
    oscillator.start();
    return { gain: gain.gain, track: sink.stream.getAudioTracks()[0] };
  }
  class Room {
    constructor() {
      this.events = new Map();
      this.ctx = new AudioContext();
      const local = tone(this.ctx, 320), remote = tone(this.ctx, 180);
      window.probe = { local: local.gain, remote: remote.gain };
      this.remoteTrack = remote.track;
      this.peer = { identity: 'agent-fixture', sid: 'PA_fixture', isAgent: true, attributes: { 'lk.agent.name': 'personal-xiaoke' } };
      this.remoteParticipants = new Map([[this.peer.identity, this.peer]]);
      const pub = { isMuted: false, track: { mediaStreamTrack: local.track } };
      this.localParticipant = {
        getTrackPublication: () => pub,
        setMicrophoneEnabled: async enabled => { pub.isMuted = !enabled; local.track.enabled = enabled; return pub; },
        publishData: async data => {
          const { id, type } = JSON.parse(new TextDecoder().decode(data));
          if (type === 'hello') {
            const reply = new TextEncoder().encode(JSON.stringify({ type: 'ready', id, voice: true }));
            setTimeout(() => this.events.get('DataReceived')(reply, this.peer, null, 'personal.v1.output'), 0);
          }
        },
      };
    }
    on(name, cb) { this.events.set(name, cb); }
    async connect() {
      await this.ctx.resume();
      const audio = document.createElement('audio');
      audio.srcObject = new MediaStream([this.remoteTrack]);
      this.events.get('TrackSubscribed')({
        kind: 'audio', mediaStreamTrack: this.remoteTrack, attach: () => audio, detach: () => [audio],
      }, null, this.peer);
    }
    async startAudio() {}
    async disconnect() { await this.ctx.close(); }
  }
  window.LivekitClient = { Room, RoomEvent: new Proxy({}, { get: (_, name) => name }), Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } } };
}

async function facePixels(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  function feature(top, bottom) {
    let first = height, last = -1;
    for (let y = Math.ceil(height * top); y < height * bottom; y++) {
      let bright = 0;
      for (let x = Math.ceil(width * .32); x < width * .68; x++) {
        const i = (y * width + x) * 4;
        if (Math.min(data[i], data[i+1], data[i+2], data[i+3]) > 201) bright++;
      }
      if (bright >= 3) { first = Math.min(first, y); last = y; }
    }
    return { top: first / height, height: Math.max(0, last-first+1) / height };
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return { brow: feature(.25, .48), mouth: feature(.54, .69), digest: digest.join('-') };
}

async function run() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 412, height: 850 }, deviceScaleFactor: 2, isMobile: true });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      const types = { 'index.html': 'text/html', 'night.css': 'text/css', 'night.js': 'text/javascript', 'session.js': 'text/javascript' };
      const name = url.pathname.slice(1) || 'index.html';
      if (url.origin !== origin) return route.abort();
      if (name === 'livekit.js') return route.fulfill({ contentType: 'text/javascript', body: '' });
      if (!Object.hasOwn(types, name)) return route.abort();
      return route.fulfill({ contentType: types[name], path: path.join(assets, name) });
    });
    await page.addInitScript(installRoomFixture);
    await page.goto(origin);
    const phase = value => page.waitForFunction(v => document.querySelector('#app').dataset.phase === v, value, { timeout: 5000 });
    async function capture(ch, gain) {
      await page.evaluate(([name, value]) => { probe[name].value = value; }, [ch, gain]);
      await page.waitForTimeout(480);
      return page.locator('#orb-canvas').evaluate(facePixels);
    }
    await page.click('#btn-start'); await phase('listening');
    const quiet = await capture('local', 0), listening = await capture('local', .18);
    await page.click('#btn-mute'); await phase('muted');
    const muted = await capture('local', .18);
    // Keep the microphone muted during playback. Speaker state must come from these samples.
    const soft = await capture('remote', .04); await phase('speaking');
    const loud = await capture('remote', .20);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const stillLoud = await capture('remote', .20), stillSoft = await capture('remote', .06);
    await capture('remote', 0); await phase('muted');
    await page.click('#btn-stop'); await phase('idle');
    const checks = {
      'microphone raises the brows': quiet.brow.top - listening.brow.top > .035,
      'muting relaxes the listening face': muted.brow.top - listening.brow.top > .04,
      'speech has a visible mouth': soft.mouth.height > .022,
      'louder playback opens the mouth wider': loud.mouth.height - soft.mouth.height > .025,
      'reduced motion holds the speaking pose': stillLoud.digest === stillSoft.digest && stillSoft.mouth.height > .022,
    };
    for (const [name, pass] of Object.entries(checks)) console.log((pass ? 'PASS ' : 'FAIL ') + name);
    assert(Object.values(checks).every(Boolean), 'facial expression pixel regression');
  } finally { await browser.close(); }
}
run().catch(err => { console.error(err.message); process.exitCode = 1; });
