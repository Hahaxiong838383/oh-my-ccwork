// Offline regression for the sphere avatar. Run:
//   node tests/avatar.cjs [asset directory] [baseline asset directory]
// Use PLAYWRIGHT_MODULE and CHROMIUM_PATH to select an existing installation.
// BASELINE_ASSETS selects the pre-change build; default is ../build/assets.
//
// The reply is real PCM: several bundled Mandarin phrases are joined with
// silence and decoded by Web Audio into the same MediaStreamTrack the app
// meters. No level value is injected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const assets = path.resolve(process.argv[2] || path.join(__dirname, '../assets'));
const baseline = path.resolve(process.argv[3] || process.env.BASELINE_ASSETS || path.join(__dirname, '../build/assets'));
const origin = 'http://localhost:13092';
const FILLERS = path.resolve(__dirname, '../../assets/fillers');
const SAMPLE_RATE = 24000;

function readPcm(file) {
  const bytes = fs.readFileSync(file);
  let offset = 12, format = null, data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4), body = offset + 8;
    if (id === 'fmt ') format = { channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14) };
    if (id === 'data') data = bytes.subarray(body, body + size);
    offset = body + size + (size & 1);
  }
  if (!format || !data || format.channels !== 1 || format.bits !== 16 || format.rate !== SAMPLE_RATE) return null;
  return data;
}

function silence(ms) { return Buffer.alloc(Math.round(SAMPLE_RATE * 2 * ms / 1000)); }

// A deterministic fallback keeps the test runnable without the voice corpus.
function syntheticSpeech(seconds = 8.4) {
  const total = Math.round(SAMPLE_RATE * seconds), data = Buffer.alloc(total * 2);
  const pauses = [[2.30, 2.62], [4.62, 5.04], [6.92, 7.20]];
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    if (t < 0.28 || pauses.some(([a, b]) => t >= a && t < b)) continue;
    const syllable = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4.3 * t)), 1.7);
    const accent = t > 3.6 && t < 4.1 ? 0.18 : 0;
    const amp = (0.16 + 0.42 * syllable + accent) * 0.42;
    const f0 = 128 + 18 * Math.sin(2 * Math.PI * 0.7 * t);
    const sample = amp * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) + 0.25 * Math.sin(2 * Math.PI * 3 * f0 * t));
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * 2);
  }
  return data;
}

function wavBuffer(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Four real, separate utterances joined by natural pauses. A continuous reply
// with sentence rhythm, breath gaps and accented syllables is what the avatar
// must animate, not a steady oscillator.
function speechPcm() {
  const names = ['story_08.wav', 'ask_04.wav', 'emo_pos_03.wav', 'story_06.wav'];
  let clips = [];
  try {
    for (const name of names) {
      const pcm = readPcm(path.join(FILLERS, name));
      if (!pcm) return syntheticSpeech();
      clips.push(pcm);
    }
  } catch { return syntheticSpeech(); }
  return Buffer.concat([
    silence(260), clips[0], silence(430), clips[1], silence(700),
    clips[2], silence(380), clips[3], silence(320),
  ]);
}

function installRoomFixture(pcm) {
  window.__pcmBase64 = pcm;
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
      const local = tone(this.ctx, 320), localSink = this.ctx.createMediaStreamDestination();
      const remote = this.ctx.createMediaStreamDestination();
      const remoteGain = this.ctx.createGain();
      remoteGain.gain.value = 0;
      remoteGain.connect(remote);
      window.probe = { local: local.gain, remote: remoteGain.gain, ctx: this.ctx };
      this.remoteTrack = remote.stream.getAudioTracks()[0];
      this.peer = { identity: 'agent-fixture', sid: 'PA_fixture', audioTrackPublications: new Map(), isAgent: true, isSpeaking: false, audioLevel: 0, attributes: { 'lk.agent.name': 'personal-xiaoke' } };
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
      window.loadSpeech = async () => {
        const bytes = Uint8Array.from(atob(window.__pcmBase64), c => c.charCodeAt(0));
        window.speechBuffer = await this.ctx.decodeAudioData(bytes.buffer);
        window.speechDuration = window.speechBuffer.duration;
      };
      window.startSpeech = () => {
        if (!window.speechBuffer) throw new Error('speech not loaded');
        try { window.speechSource?.stop(); } catch {}
        const source = this.ctx.createBufferSource();
        source.buffer = window.speechBuffer;
        source.connect(remoteGain);
        source.start();
        window.speechSource = source;
        window.speechStart = performance.now();
      };
      window.emitTranscript = items => this.events.get('TranscriptionReceived')?.(
        items.map(([id, text, final]) => ({id, text, final, startTime: 0, endTime: 0, language: 'zh'})), this.peer);
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
    async startAudio() { await this.ctx.resume(); }
    async disconnect() { await this.ctx.close(); }
  }
  window.LivekitClient = { Room, RoomEvent: new Proxy({}, { get: (_, name) => name }), Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } } };
}

async function facePixels(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
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

const FAMILY = [0,0,1,2,3,5,1,4,0,5,0,1,0,3,4,0,0,1,5,0,0,2,3,4,1];

function summarize(frames, start) {
  const live = frames.filter(f => f.t >= start && (f.phase === 'speaking' || f.phase === 'streaming'));
  const groups = [], changes = [];
  let last = null;
  for (const frame of live) {
    const group = frame.group || 'family-' + FAMILY[frame.expression];
    if (frame.expression !== last) {
      groups.push(group);
      changes.push({expression: frame.expression, group, at: +(frame.t / 1000).toFixed(2),
        source: frame.source || 'state', cue: frame.cue || ''});
      last = frame.expression;
    }
  }
  const uniq = [...new Set(groups)];
  return {
    frames: live.length,
    expressions: [...new Set(changes.map(c => c.expression))],
    groups: uniq,
    changes: changes.length,
    timeline: changes.slice(0, 24),
  };
}

async function measure(assetDir, pcmBase64, wavDuration) {
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
      return route.fulfill({ contentType: types[name], path: path.join(assetDir, name) });
    });
    await page.addInitScript(installRoomFixture, pcmBase64);
    await page.goto(origin);
    // Read the motion output without touching production code.
    await page.evaluate(() => {
      window.__frames = [];
      const proto = window.NightSphere.prototype, original = proto.render;
      proto.render = function (dt) {
        if (!this.__tap) {
          const step = this.motion.step.bind(this.motion);
          this.motion.step = (seconds, input) => {
            const frame = step(seconds, input);
            window.__frames.push({ t: performance.now(), expression: frame.expression,
              group: frame.expressionGroup, source: frame.expressionSource,
              cue: frame.expressionCue, phase: frame.phase, energy: frame.energy });
            return frame;
          };
          this.__tap = true;
        }
        return original.call(this, dt);
      };
    });
    const phase = value => page.waitForFunction(v => document.querySelector('#app').dataset.phase === v, value, { timeout: 6000 });
    async function capture(ch, gain) {
      await page.evaluate(([name, value]) => { probe[name].value = value; }, [ch, gain]);
      await page.waitForTimeout(420);
      return page.locator('#orb-canvas').evaluate(facePixels);
    }
    await page.click('#btn-start'); await phase('listening');
    await page.evaluate(() => loadSpeech());
    const quiet = await capture('local', 0), listening = await capture('local', .18);
    await page.click('#btn-mute'); await phase('muted');
    const muted = await capture('local', .18);
    await page.evaluate(() => probe.local.value = 0);

    // Replay the worker protocol: each interim arrives as its sentence starts,
    // then final arrives when that sentence has been played.
    const timedSegments = (turn) => page.evaluate(turn => {
      const sentences = ['我先查一下。','这样可真好。','你要现在听吗？'];
      sentences.forEach((text, i) => {
        const id = 'SG_a'+turn+'_'+i;
        setTimeout(() => emitTranscript([[id,text,false]]), i * 3000);
        setTimeout(() => emitTranscript([[id,text,true]]), i * 3000 + 2400);
      });
    }, turn);
    await page.evaluate(() => { probe.remote.value = .42; startSpeech(); });
    await phase('speaking');
    await timedSegments(1);
    const samples = [];
    for (let i = 0; i < 3; i++) { await page.waitForTimeout(Math.max(600, wavDuration * 1000 / 4)); samples.push(await page.locator('#orb-canvas').evaluate(facePixels)); }
    await page.waitForTimeout(Math.max(300, wavDuration * 1000 * .28));
    const frames = await page.evaluate(() => window.__frames);
    const start = await page.evaluate(() => window.speechStart);
    const normal = summarize(frames, start);

    // Reduced motion must keep the semantic beats while removing bob/blink.
    await page.evaluate(() => { probe.remote.value = 0; });
    await page.waitForTimeout(500);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__frames = []; probe.remote.value = .42; startSpeech(); });
    await phase('speaking');
    await timedSegments(2);
    await page.waitForTimeout(Math.max(1200, wavDuration * 1000 * .9));
    const reducedFrames = await page.evaluate(() => window.__frames);
    const reducedStart = await page.evaluate(() => window.speechStart);
    const reduced = summarize(reducedFrames, reducedStart);
    const reducedSample = await page.locator('#orb-canvas').evaluate(facePixels);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => probe.remote.value = 0);
    await page.click('#btn-stop'); await phase('idle');
    return {
      normal, reduced,
      eyes: { quiet: quiet.islands.length, listening: listening.islands.length, muted: muted.islands.length,
        speaking: samples.map(s => s.islands.length), reduced: reducedSample.islands.length },
      digests: { listeningChanged: quiet.digest !== listening.digest,
        speakingChanged: samples[0]?.digest !== samples[2]?.digest },
    };
  } finally { await browser.close(); }
}

(async () => {
  const pcm = speechPcm();
  const wav = wavBuffer(pcm);
  const base64 = wav.toString('base64');
  const duration = pcm.length / 2 / SAMPLE_RATE;
  // After a build the default ../build/assets contains the same code. Keep the
  // current-code assertions useful and only run the comparison when a distinct
  // pre-change snapshot is supplied.
  const sameAsCurrent = fs.existsSync(path.join(baseline, 'orb-motion.js')) &&
    fs.readFileSync(path.join(baseline, 'orb-motion.js'), 'utf8') === fs.readFileSync(path.join(assets, 'orb-motion.js'), 'utf8');
  const before = sameAsCurrent ? null : await measure(baseline, base64, duration);
  const after = await measure(assets, base64, duration);
  console.log(JSON.stringify({
    pcm: { seconds: +duration.toFixed(2), sampleRate: SAMPLE_RATE, source: fs.existsSync(path.join(FILLERS, 'story_08.wav')) ? 'bundled-mandarin-wav' : 'synthetic' },
    baseline: sameAsCurrent ? 'current-assets' : 'pre-change',
    before: before && { groups: before.normal.groups, changes: before.normal.changes, reducedGroups: before.reduced.groups, timeline: before.normal.timeline },
    after: { groups: after.normal.groups, changes: after.normal.changes, reducedGroups: after.reduced.groups, timeline: after.normal.timeline },
  }, null, 2));
  const twoEyes = after.eyes.quiet === 2 && after.eyes.listening === 2 && after.eyes.muted === 2 &&
    after.eyes.speaking.every(n => n === 2) && after.eyes.reduced === 2;
  const checks = {
    'continuous PCM reply keeps two eye silhouettes': twoEyes,
    'microphone activity changes the listening frame': after.digests.listeningChanged,
    'one continuous reply shows at least three expression families': after.normal.groups.length >= 3,
    ...(before ? {
      'the reply has more distinguishable families than before': after.normal.groups.length > before.normal.groups.length,
      'the pre-change build stayed within two families': before.normal.groups.length <= 2,
      'the pre-change reduced pose was frozen': before.reduced.groups.length <= 1,
    } : {}),
    'a question sentence reaches the ask expression': after.normal.timeline.some(c => c.cue === 'question' && c.group === 'ask'),
    'reduced motion still switches between expression families': after.reduced.groups.length >= 2,
  };
  for (const [name, pass] of Object.entries(checks)) console.log((pass ? 'PASS ' : 'FAIL ') + name);
  assert(Object.values(checks).every(Boolean), 'facial expression pixel regression');
})().catch(err => { console.error(err.message); process.exitCode = 1; });
