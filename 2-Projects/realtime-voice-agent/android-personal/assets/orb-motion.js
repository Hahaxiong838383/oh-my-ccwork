/* The face pools and cadences come from the bundled BSD-3-Clause grokbot-web
 * stateData. These small poses and the audio choreography are written for this
 * app; no clip data from the Electron analysis project is embedded. */
(function (global) {
  'use strict';

  // Each cue combines an authored body gesture with a named reference face.
  // Amplitudes are in orb-radius units, independent of the canvas resolution.
  const sequences = {
    idle: [
      ['rest', 'idle', 5.2, 'float', 0.65], ['glance-around', 'curious', 3.0, 'glance', 0.55],
      ['drift', 'humming', 4.5, 'lean', -0.35], ['settle', 'idle', 3.9, 'settle', 0.6]
    ],
    connecting: [
      ['orient', 'spawning', 1.25, 'rise', 0.85], ['look-out', 'searching', 2.4, 'scan', 0.9],
      ['handshake', 'working', 1.9, 'incline', 0.7], ['wait-link', 'loading', 2.6, 'float', 0.45]
    ],
    reconnecting: [
      ['look-back', 'alerting', 1.4, 'recoil', 0.8], ['rescan', 'radar', 2.3, 'scan', -1],
      ['listen-link', 'receiving', 2.5, 'lean', 0.65]
    ],
    listening: [
      ['attend', 'listening', 2.3, 'lean', 0.75], ['turn-ear', 'receiving', 2.9, 'incline', -0.85],
      ['follow', 'curious', 2.5, 'glance', 0.65], ['acknowledge', 'listening', 2.2, 'nod', 0.6]
    ],
    thinking: [
      ['look-up', 'thinking', 2.0, 'ponder', 0.95], ['consider', 'working', 2.4, 'weigh', -0.75],
      ['trace', 'writing', 2.7, 'scan', 0.65], ['refocus', 'thinking', 1.8, 'settle', 0.75]
    ],
    searching: [
      ['seek', 'searching', 1.9, 'scan', 1], ['inspect', 'curious', 1.7, 'lean', -0.75],
      ['cross-check', 'working', 2.1, 'weigh', 0.8], ['collect', 'receiving', 1.9, 'settle', 0.7]
    ],
    speaking: [
      ['phrase-start', 'sending', 1.7, 'rise', 0.55], ['explain', 'dictating', 2.7, 'incline', 0.65],
      ['emphasize', 'happy', 1.8, 'nod', 0.65], ['phrase-end', 'humming', 2.15, 'settle', 0.6]
    ],
    streaming: [
      ['deliver', 'dictating', 1.8, 'lean', 0.55], ['carry-phrase', 'sending', 2.4, 'incline', -0.75],
      ['stress', 'excited', 1.6, 'nod', 0.65], ['release', 'humming', 2.05, 'settle', 0.75]
    ],
    reading: [
      ['find-line', 'writing', 1.55, 'glance', -0.7], ['read-line', 'working', 2.2, 'read', 1],
      ['next-line', 'thinking', 1.5, 'read', 0.8]
    ],
    waiting: [
      ['look-outward', 'receiving', 1.8, 'glance', 0.9], ['wait-still', 'idle', 2.8, 'float', 0.4],
      ['check-again', 'listening', 1.7, 'incline', -0.55]
    ],
    blocked: [
      ['pause', 'suspicious', 1.45, 'recoil', 0.55], ['tilt-question', 'confused', 2.25, 'weigh', -1],
      ['hold', 'sad', 3.2, 'still', 0.6]
    ],
    muted: [
      ['quiet', 'sleeping', 4.0, 'settle', 0.45], ['lower-lids', 'drowsy', 3.8, 'still', 0.5],
      ['resting', 'sleeping', 4.5, 'float', 0.2]
    ],
    error: [
      ['startle', 'alerting', 1.1, 'recoil', 1], ['question', 'confused', 2.8, 'weigh', 0.85],
      ['recover', 'sad', 3.0, 'settle', 0.7]
    ]
  };

  const touches = [
    ['tap-recoil', 'surprised', 'recoil'], ['tap-lean', 'playful', 'lean'],
    ['tap-nod', 'happy', 'nod'], ['tap-shy', 'shy', 'incline']
  ];
  // Speech expression groups authored for this app. Each group only borrows a
  // bundled reference pool for eye contours; the group name, the caption kind
  // and every switch below are local estimates, never provider labels.
  const speechGroups = {
    steady:  {reference: 'dictating', faces: [10, 1, 19]},
    warm:    {reference: 'happy',     faces: [2, 11, 17, 19]},
    bright:  {reference: 'excited',   faces: [2, 17, 21, 3, 11]},
    ask:     {reference: 'curious',   faces: [3, 21, 0, 15]},
    concern: {reference: 'confused',  faces: [14, 5, 8]},
    hush:    {reference: 'bored',     faces: [4, 22, 0]},
    lively:  {reference: 'laughing',  faces: [2, 11, 17]}
  };
  // Visual families for the 25 drawn eye pairs: neutral, smile, wide, squint,
  // sad, asymmetric. The director avoids staying inside one family.
  const faceFamily = [0,0,1,2,3,5,1,4,0,5,0,1,0,3,4,0,0,1,5,0,0,2,3,4,1];
  const speechCycle = ['steady', 'warm', 'bright', 'steady', 'ask', 'lively', 'warm'];
  const captionGroup = {
    explain: 'steady', warm: 'warm', emphasis: 'bright',
    question: 'ask', concern: 'concern', hush: 'hush'
  };
  const aliases = {
    connected: 'listening', ready: 'idle', disconnected: 'idle', ended: 'idle',
    failed: 'error', processing: 'thinking', working: 'thinking',
    talking: 'speaking', muted: 'muted'
  };
  const rest = {gazeX: 0, gazeY: 0, roll: 0, scaleX: 1, scaleY: 1, lift: 0,
    eyeOpenL: 1, eyeOpenR: 1, eyeAimX: 0, eyeAimY: 0, accent: 0, breath: 0};
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const finite = value => Number.isFinite(value) ? value : 0;
  const unit = v => clamp(finite(v), 0, 1);
  const approach = (a, b, dt, rate) => a + (b-a) * (1-Math.exp(-rate*dt));
  const ease = v => v*v*(3-2*v);

  function seeded(seed) {
    let state = 2166136261;
    const text = String(seed == null ? 'xiaoke' : seed);
    for (let i = 0; i < text.length; i++) state = Math.imul(state ^ text.charCodeAt(i), 16777619);
    return () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function phaseFor(input) {
    const name = input.phase || 'idle';
    const phase = aliases[name] || name;
    if (input.muted && ['listening','idle'].includes(phase) && input.active !== false) return 'muted';
    return Object.prototype.hasOwnProperty.call(sequences, phase) ? phase : 'idle';
  }

  // A motion phrase has a soft attack, a small overshoot in the middle and a
  // release. Mixing the pose below also bridges unplanned state changes mid-clip.
  function gesture(pose, name, strength, progress) {
    const u = unit(progress);
    const arc = Math.sin(Math.PI * u);
    const swing = Math.sin(2 * Math.PI * u);
    const a = Math.abs(strength);
    const g = strength * arc;
    switch (name) {
      case 'float': pose.lift -= a*arc*0.027; break;
      case 'glance':
        pose.gazeX += 0.58*g; pose.gazeY -= 0.18*a*arc; pose.roll += 0.055*g; break;
      case 'scan':
        pose.gazeX += 0.62*strength*swing; pose.gazeY -= 0.22*arc*a;
        pose.roll += 0.085*strength*swing; pose.lift -= 0.025*a*arc; break;
      case 'read': {
        // Sweep across one line, drop the gaze, then return to the left margin.
        const line = u < 0.75 ? ease(u/0.75) : 1-ease((u-0.75)/0.25);
        pose.gazeX += a*(0.93*line-0.43)*arc;
        pose.gazeY += a*(0.14+0.22*ease(u))*arc;
        pose.roll += a*(line-0.5)*arc*0.08;
        break;
      }
      case 'rise':
        pose.lift -= 0.073*a*arc; pose.gazeY -= 0.26*a*arc;
        pose.scaleY += 0.038*a*arc; pose.scaleX -= 0.022*a*arc; break;
      case 'incline':
        pose.roll += 0.225*g; pose.gazeX += 0.28*g; pose.lift -= 0.018*a*arc; break;
      case 'lean':
        pose.gazeX += 0.3*g; pose.gazeY += 0.12*a*arc;
        pose.scaleX += 0.035*a*arc; pose.scaleY += 0.024*a*arc; pose.roll += 0.11*g; break;
      case 'nod':
        pose.lift += a*(0.065*arc-0.024*swing); pose.gazeY += a*(0.39*arc-0.12*swing);
        pose.scaleY -= a*0.028*arc; break;
      case 'ponder':
        pose.gazeX += 0.54*g; pose.gazeY -= 0.48*a*arc; pose.roll -= 0.105*g;
        pose.eyeOpenR -= 0.21*a*arc; break;
      case 'weigh':
        pose.roll += 0.13*strength*swing; pose.gazeX += 0.4*strength*swing;
        pose.eyeOpenL -= 0.19*a*arc; pose.eyeOpenR += 0.04*a*arc; break;
      case 'recoil':
        pose.lift -= 0.09*a*arc; pose.scaleX -= 0.052*a*arc; pose.scaleY += 0.06*a*arc;
        pose.accent = Math.max(pose.accent, 0.67*a*arc); break;
      case 'settle':
        pose.lift += 0.042*a*arc; pose.scaleY -= 0.032*a*arc;
        pose.eyeOpenL -= 0.065*a*arc; pose.eyeOpenR -= 0.065*a*arc; break;
    }
  }

  function create(seed) {
    const random = seeded(seed);
    const clockOffset = random() * Math.PI * 2;
    const faceTables = global.GrokReference && global.GrokReference.stateData;
    if (!faceTables || !faceTables.idle) throw new Error('orb-reference stateData must be loaded before orb-motion');
    const pose = Object.assign({}, rest);
    const visits = new Map();
    let phase, cueIndex = 0, cueAge = 0, now = 0, age = 0;
    let reference = '', expression = 0, fromExpression = 0, morphAge = 1;
    let expressionAt = Infinity, blinkAt = Infinity, blinkAge = 1, secondBlink = false;
    let energy = 0, previousEnergy = 0, attack = 0, speechPause = 0;
    let slowEnergy = 0, speechStress = 0, syllableRate = 0, syllableHits = 0, syllableClock = 0, onsetAge = Infinity;
    let speechSeq = -1, speechCue = '', speechGroup = '', speechHold = 0, speechCycleAt = 0, inHush = false, pendingCue = false;
    let gazeSide = 1, beatAge = Infinity, speechBlinkAt = Infinity, onsetArmed = true;
    let expressionSource = 'state', expressionEstimated = false;
    let listeningFor=0, pauseFor=0, nodAge=Infinity, nextNod=0;
    let touchAge = Infinity, touchIndex = -1, touchX = 0, touchY = 0;

    const interval = range => range ? (range.min + random() * (range.max-range.min))/1000 : Infinity;
    function setExpression(id) {
      if (id === expression) return;
      fromExpression = morphAge < 0.11 ? fromExpression : expression;
      expression = id;
      morphAge = 0;
    }
    function selectFace(name, reduced) {
      const table = faceTables[name] || faceTables.idle;
      if (reference !== name) {
        reference = name;
        const visit = visits.get(name) || 0;
        visits.set(name, (visit + 1) % table.expressions.length);
        setExpression(table.expressions[reduced ? 0 : visit]);
        expressionAt = now + interval(table.expressionCadence);
        blinkAt = table.blinkCadence
          ? Math.min(blinkAt, now + interval(table.blinkCadence)) : Infinity;
      }
      if (reduced) { setExpression(table.expressions[0]); blinkAge = 1; return; }
      if (now >= expressionAt) {
        const pool = table.expressions.filter(id => id !== expression);
        if (pool.length) setExpression(pool[Math.floor(random()*pool.length)]);
        expressionAt = now + interval(table.expressionCadence);
      }
      if (now >= blinkAt) {
        blinkAge = 0;
        secondBlink = !secondBlink && random()<.16;
        blinkAt = now + (secondBlink ? .48 : interval(table.blinkCadence));
      }
    }
    function tap(x, y) {
      touchIndex = (touchIndex+1) % touches.length; touchAge = 0;
      touchX = clamp(finite(x), -1, 1); touchY = clamp(finite(y), -1, 1);
    }
    function nextCycle() {
      speechCycleAt = (speechCycleAt + 1) % speechCycle.length;
      return speechCycle[speechCycleAt];
    }
    // Choose a face outside the family already on screen. That is what makes
    // consecutive beats readable instead of four near-identical round eyes.
    function chooseSpeech(name) {
      const group = speechGroups[name] || speechGroups.steady;
      const family = expression >= 0 ? faceFamily[expression] : -1;
      const fresh = group.faces.filter(id => faceFamily[id] !== family);
      const pool = fresh.length ? fresh : group.faces.filter(id => id !== expression);
      if (!pool.length) return;
      const id = pool[Math.floor(random() * pool.length)];
      reference = group.reference;
      speechGroup = speechGroups[name] ? name : 'steady';
      setExpression(id);
      speechHold = 0;
      gazeSide *= -1;
    }
    // Audio rhythm leads; a revealed caption only selects the base group. The
    // local caption kind is a lexical estimate and is reported as such.
    function directSpeech(dt, speech, reduced) {
      speechHold += dt;
      const kind = speech && typeof speech.kind === 'string' ? speech.kind : '';
      const seq = speech && Number.isFinite(speech.seq) ? speech.seq : -1;
      if (seq !== speechSeq) {
        speechSeq = seq;
        speechCue = captionGroup[kind] ? kind : '';
        if (speechCue) {
          speechCycleAt = 0;
          inHush = false;
          // A new sentence never flashes a face for less than half a second.
          if (speechHold >= 0.50) chooseSpeech(captionGroup[speechCue]);
          else pendingCue = true;
          return;
        }
      }
      if (energy <= 0.055) {
        if (speechPause > 0.55 && !inHush && speechHold > (reduced ? 0.42 : 0.30)) {
          inHush = true; chooseSpeech('hush');
        }
        return;
      }
      if (inHush) {
        if (speechPause < 0.04 && speechHold > (reduced ? 0.36 : 0.18) && (!pendingCue || speechHold >= 0.50)) {
          inHush = false;
          pendingCue = false;
          chooseSpeech(speechCue ? captionGroup[speechCue] : nextCycle());
        }
        return;
      }
      if (pendingCue && speechHold >= 0.50) {
        pendingCue = false;
        chooseSpeech(captionGroup[speechCue] || 'steady');
        return;
      }
      // A clear accent beat gets wide eyes, but only after the previous shape
      // has been readable for a while.
      if (attack > 0.12 && energy > 0.34 && speechGroup !== 'bright' &&
          speechHold > (reduced ? 2.2 : 0.62)) {
        chooseSpeech('bright');
        return;
      }
      const hold = reduced ? 2.3 : clamp(1.40 - syllableRate * 0.10, 0.94, 1.40);
      if (speechHold < hold) return;
      if (speechCue) {
        const base = captionGroup[speechCue];
        // Long steady or warm sentences alternate with a contrasting group so
        // one sentence still carries several visible beats.
        chooseSpeech((base === speechGroup && (base === 'steady' || base === 'warm')) ? nextCycle() : base);
      } else {
        chooseSpeech(nextCycle());
      }
    }
    function step(seconds, input) {
      input = input || {};
      const dt = clamp(finite(seconds), 0, 0.12);
      const nextPhase = phaseFor(input);
      const reduced = Boolean(input.reduced);
      const sameSpeech = (phase === 'speaking' || phase === 'streaming') &&
        (nextPhase === 'speaking' || nextPhase === 'streaming');
      if (phase !== nextPhase) {
        phase = nextPhase; age = 0; cueAge = 0; cueIndex = 0;
        // speaking <-> streaming is one reply. Keep the audio envelope and the
        // expression cycle so short pauses do not restart at the same face.
        if (!sameSpeech) {
          beatAge = Infinity; onsetArmed = true;
          speechBlinkAt = now + 2.8 + random()*1.7;
          speechPause = 0;
          energy = 0; previousEnergy = 0; attack = 0; slowEnergy = 0; speechStress = 0;
          syllableRate = 0; syllableHits = 0; syllableClock = 0; onsetAge = Infinity;
          speechSeq = -1; speechCue = ''; speechGroup = ''; speechHold = 0; speechCycleAt = 0;
          inHush = false; pendingCue = false; expressionSource = 'state'; expressionEstimated = false;
          listeningFor=0; pauseFor=0; nodAge=Infinity;
        }
      }
      now += dt; age += dt; cueAge += dt; touchAge += dt; morphAge += dt; blinkAge += dt;
      const sequence = sequences[phase];
      if (!reduced && cueAge >= sequence[cueIndex][2]) {
        cueAge -= sequence[cueIndex][2]; cueIndex = (cueIndex+1)%sequence.length;
      }
      if (reduced) { cueIndex = 0; cueAge = 0; }
      const cue = sequence[cueIndex];
      const touching = touchAge < 0.86;
      const touch = touches[Math.max(0,touchIndex)];
      const speaking = phase === 'speaking' || phase === 'streaming';
      const busy = input.active !== false && (speaking || phase === 'listening');
      const inputLevel = speaking ? unit(input.playback)
        : phase === 'listening' && !input.muted ? unit(input.mic) : 0;
      energy = busy ? approach(energy, inputLevel, dt, inputLevel>energy ? 26 : 10) : 0;
      if (energy < 0.0005) energy = 0;
      // Measure the slope per second. Count one onset per syllable, regardless
      // of how many 60/120 Hz frames occur while the envelope is rising.
      const slope = dt > 0 ? (energy - previousEnergy) / dt : 0;
      attack = Math.max(attack*Math.exp(-dt*7), clamp(slope*.040, 0, .60));
      onsetAge += dt;
      beatAge += dt;
      if (slope <= 0.1) onsetArmed = true;
      if (onsetArmed && energy > .075 && slope > .78 && onsetAge > .115) {
        onsetAge = 0; syllableHits++; onsetArmed = false;
        if (speaking && beatAge > .67 && energy - slowEnergy > .065) beatAge = 0;
      }
      syllableClock += dt;
      if (syllableClock >= .75 - 1e-8) {
        syllableRate = approach(syllableRate, syllableHits / syllableClock, syllableClock, 1.5);
        syllableClock = 0; syllableHits = 0;
      }
      slowEnergy = approach(slowEnergy, energy, dt, 1.1);
      speechStress = clamp((energy - slowEnergy) * 2.6, 0, 1);
      previousEnergy = energy;
      speechPause = energy < 0.055 ? speechPause+dt : 0;
      const declared = input.referenceState;
      const face = typeof declared === 'string' && Object.prototype.hasOwnProperty.call(faceTables, declared)
        ? declared : cue[1];
      if (speaking && !speechGroup) {
        speechGroup = 'steady';
        reference = speechGroups.steady.reference;
        chooseSpeech('steady');
      }
      expressionEstimated = false;
      if (touching) {
        selectFace(touch[1], reduced);
        expressionSource = 'touch';
      } else if (declared && face === declared) {
        selectFace(face, reduced);
        expressionSource = 'requested';
      } else if (speaking) {
        // Captions may arrive before their audio. Only the revealed sentence
        // supplies a cue; the audio rhythm carries everything in between.
        directSpeech(dt, input.speech, reduced);
        if (!reduced && now >= speechBlinkAt && (attack < .1 || now > speechBlinkAt+.4)) {
          blinkAge = 0;
          speechBlinkAt = now + 2.8 + random()*1.7;
        }
        expressionSource = speechCue ? 'caption' : 'audio';
        expressionEstimated = true;
      } else {
        selectFace(face, reduced);
        expressionSource = 'state';
      }
      // The upstream pools omit ring 6. Its small rounded eyes make a gentle
      // second beat after the wide-eyed reaction, before returning to the call.
      if (!reduced && touching && touchIndex === 0 && touchAge >= 0.43) setExpression(6);
      const goal = Object.assign({}, rest);
      // Static silhouettes stay distinct in reduced-motion and when the phone is quiet.
      switch (phase) {
        case 'muted':
          goal.gazeY = 0.18; goal.eyeOpenL = 0.64; goal.eyeOpenR = 0.64; goal.lift = 0.018; break;
        case 'thinking': case 'searching':
          goal.gazeY = -0.27; goal.roll = -0.045; goal.eyeOpenR = 0.88; break;
        case 'reading':
          goal.gazeY = 0.23; goal.gazeX = -0.10; goal.roll = 0.032; break;
        case 'waiting':
          goal.gazeX = 0.14; goal.gazeY = -0.08; goal.roll = -0.025; break;
        case 'blocked':
          goal.eyeOpenR = 0.72; goal.gazeX = -0.24; goal.roll = -0.095; break;
        case 'streaming':
          goal.gazeY = -0.025; goal.lift = -0.02; goal.roll = 0.032; break;
        case 'listening':
          goal.gazeY = 0.045; goal.roll = -0.042; break;
        case 'speaking':
          goal.gazeY = -0.035; goal.lift = -0.009; break;
        case 'connecting': case 'reconnecting':
          goal.gazeY = -0.14; goal.lift = -0.018; break;
        case 'error':
          goal.roll = 0.095; goal.eyeOpenL = 0.80; goal.gazeX = -0.18; break;
      }
      let articulation = 'quiet';
      if (!reduced) {
        goal.breath = .8*Math.sin(2*Math.PI*now/5.8+clockOffset)+.2*Math.sin(2*Math.PI*now/13.3);
        const swell = phase === 'muted' ? 0.004 : 0.011;
        goal.scaleX += goal.breath*swell; goal.scaleY += goal.breath*swell*0.65;
        goal.lift -= goal.breath*swell*0.8;
        gesture(goal, cue[3], cue[4], cueAge/cue[2]);
        if (speaking) {
          articulation = speechPause > 0.18 ? 'pause' : attack > 0.12 ? 'attack'
            : speechStress > 0.18 ? 'stress' : syllableRate > 0.62 ? 'lively' : 'flow';
          // Let a phrase hold its silhouette while faster syllables accent it.
          // The eyes seek first, then settle back toward the listener as the head turns.
          const side = gazeSide;
          const seek = Math.exp(-speechHold*3.3);
          const voice = 1 - Math.min(1, speechPause/.48);
          let turn = .24*side, tilt = .06*side, pitch = -.12;
          switch (speechGroup) {
            case 'ask':
              turn = .48*side; tilt = -.225*side; pitch = -.16;
              goal.eyeOpenR -= .22; break;
            case 'warm': case 'lively':
              turn = .22*side; tilt = .16*side; pitch = .025;
              goal.lift -= .022; break;
            case 'bright':
              turn = .07*side; tilt = .035*side; pitch = -.29;
              goal.lift -= .032; break;
            case 'concern':
              turn = -.32*side; tilt = -.12*side; pitch = .16;
              goal.eyeOpenL -= .16; break;
            case 'hush':
              turn = -.29*side; tilt = .095*side; pitch = .11;
              goal.eyeOpenL -= .10; goal.eyeOpenR -= .10; break;
          }
          goal.gazeX += turn*voice;
          goal.gazeY += pitch*voice;
          goal.roll += tilt*voice;
          goal.eyeAimX = turn*(1.05*seek-.40)*voice;
          goal.eyeAimY = -.15*seek*voice;
          const nod = beatAge < .38 ? Math.sin(Math.PI*(beatAge-.06)/.32) : 0;
          goal.lift += .038*nod - .037*energy;
          goal.gazeY += .16*nod;
          goal.scaleX += .018*energy; goal.scaleY += .018*energy;
        } else if (phase === 'listening') {
          articulation = energy > 0.045 ? 'attend' : 'quiet';
          nodAge += dt;
          if (energy>.08) { listeningFor+=dt; pauseFor=0; }
          else {
            pauseFor+=dt;
            if (pauseFor>.12 && listeningFor>1.4 && now>=nextNod) {
              nodAge=0; nextNod=now+2.8; listeningFor=0;
            }
            if (pauseFor>.5) listeningFor=0;
          }
          if (nodAge<.39) goal.gazeY += .27*Math.sin(Math.PI*nodAge/.39);
          goal.gazeY += 0.26*energy; goal.roll -= 0.13*energy;
          goal.scaleY += 0.055*energy; goal.lift += 0.03*energy;
        }
        if (touching) {
          const t = touchAge/0.86;
          const reach = Math.sin(Math.PI*t);
          gesture(goal, touch[2], 1, t);
          goal.gazeX += 0.68*touchX*reach; goal.gazeY += 0.58*touchY*reach;
          goal.accent = Math.max(goal.accent, reach);
        }
        // Fast close, tiny hold, slower open. Eyelids stay paired across an interrupted blink.
        if (blinkAge < .25 && !touching) {
          const open = blinkAge < .07 ? 1-ease(blinkAge/.07)
            : blinkAge < .10 ? .03 : .03+.97*ease(unit((blinkAge-.10)/.15));
          goal.eyeOpenL *= open; goal.eyeOpenR *= open;
        }
      }
      const size=(goal.scaleX+goal.scaleY)/2;
      const squash=clamp((goal.scaleX-goal.scaleY)*.5,-.009,.009);
      goal.scaleX=size+squash; goal.scaleY=size-squash;
      for (const key of Object.keys(rest)) {
        const speed = key.startsWith('eyeAim') ? 32 : key === 'eyeOpenL' || key === 'eyeOpenR' ? 65 : key === 'accent' ? 20 : 11;
        pose[key] = reduced ? goal[key] : approach(pose[key], goal[key], dt, speed);
      }
      // referenceState names the eye-contour pool only. During speech,
      // expressionGroup/Source/Estimated describe this app's local estimate.
      return Object.assign({}, pose, {
        phase, clip: touching ? touch[0] : cue[0], referenceState: reference,
        articulation, expression, fromExpression, expressionMix: reduced ? 1 : ease(unit(morphAge/0.22)),
        expressionGroup: touching ? 'touch' : speaking ? speechGroup : '',
        expressionSource, expressionEstimated, expressionCue: speaking ? speechCue : '',
        speechPause, speechStress, syllableRate,
        eyeOpenL: clamp(pose.eyeOpenL,0.02,1), eyeOpenR: clamp(pose.eyeOpenR,0.02,1),
        gazeX: clamp(pose.gazeX,-1,1), gazeY: clamp(pose.gazeY,-1,1), energy
      });
    }
    return {step, tap};
  }
  global.NightOrbMotion = Object.freeze({create});
})(typeof window === 'object' ? window : globalThis);
