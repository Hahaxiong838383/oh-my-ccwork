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
      this.peer = { identity: 'agent-fixture', sid: 'PA_fixture', audioTrackPublications: new Map(), isAgent: true, attributes: { 'lk.agent.name': 'personal-xiaoke' } };
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
      const track = {kind:'audio', mediaStreamTrack:this.remoteTrack, attach:() => audio, detach:() => [audio]};
      const publication = {track};
      this.peer.audioTrackPublications.set('TR_fixture', publication);
      this.events.get('TrackSubscribed')(track, publication, this.peer);
    }
    async startAudio() {}
    async disconnect() { await this.ctx.close(); }
  }
  window.LivekitClient = { Room, RoomEvent: new Proxy({}, { get: (_, name) => name }), Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } } };
}

async function facePixels(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  // Locate opaque, near-white eye islands in the sphere's central area.
  const mask = new Uint8Array(width * height), seen = new Uint8Array(mask.length);
  for (let y = Math.floor(height * .14); y < height * .77; y++)
    for (let x = Math.floor(width * .19); x < width * .81; x++) {
      const pos = y * width + x, i = pos * 4;
      const lo = Math.min(data[i], data[i+1], data[i+2]), hi = Math.max(data[i], data[i+1], data[i+2]);
      if (lo >= 192 && hi-lo < 48 && data[i+3] > 205) mask[pos] = 1;
    }
  const islands = [];
  for (let pos=0; pos<mask.length; pos++) {
    if (!mask[pos] || seen[pos]) continue;
    const queue = [pos]; seen[pos]=1;
    let sumX=0, sumY=0, low=height, high=0;
    for(let n=0;n<queue.length;n++){
      const at=queue[n], x=at%width, y=Math.floor(at/width);
      sumX+=x; sumY+=y; low=Math.min(low,y); high=Math.max(high,y);
      for(const next of [at-1,at+1,at-width,at+width]) if(mask[next]&&!seen[next]){
        seen[next]=1;queue.push(next);
      }
    }
    if(queue.length>width*height*.00032) islands.push({x:sumX/queue.length/width,y:sumY/queue.length/height,area:queue.length,height:(high-low+1)/height});
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return {islands, digest: digest.join('-')};
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
      if (['orb-reference','orb-motion','orb-surface','orb-input'].some(script => name === script+'.js')) types[name]='text/javascript';
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
    const twoEyes = sample => sample.islands.length === 2;
    const checks = {
      'listening uses two eye silhouettes': twoEyes(quiet) && twoEyes(listening),
      'microphone activity changes the listening frame': quiet.digest !== listening.digest,
      'mute remains an eye-only pose': twoEyes(muted),
      'reply is animated without a mouth or brows': twoEyes(soft) && twoEyes(loud) && soft.digest !== loud.digest,
      'reduced motion holds the speaking pose': twoEyes(stillSoft) && stillLoud.digest === stillSoft.digest,
    };
    if(process.env.AVATAR_PIXEL_DETAILS) console.log({quiet,listening,muted,soft,loud,stillSoft});
    for (const [name, pass] of Object.entries(checks)) console.log((pass ? 'PASS ' : 'FAIL ') + name);
    assert(Object.values(checks).every(Boolean), 'facial expression pixel regression');
  } finally { await browser.close(); }
}
run().catch(err => { console.error(err.message); process.exitCode = 1; });
