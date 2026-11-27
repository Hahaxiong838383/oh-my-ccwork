/**
 * NightAvatars adapter for open-bot-avatar.
 *
 * Locally maintainable bridge between the host frame/interaction protocol and
 * the upstream open-bot-avatar runtime (core, dom/mountAvatar, fluffy, glass).
 *
 * Contract:
 *   window.NightAvatars.register({
 *     id: "open",
 *     title: "open-bot-avatar",
 *     variants: [{ id, label, thumb }],
 *     expressions: [{ id, label }],
 *     mount(host, variantId) {
 *       return { update(frame), touch(x, y), express(id), destroy() };
 *     }
 *   });
 */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v) {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

function clampSigned(v) {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, -1, 1) : 0;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function perfNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

const VALID_UPSTREAM_STATES = new Set(['idle', 'thinking', 'working', 'waiting', 'blocked', 'done']);


/** All testable built-in expressions (6 upstream states + happy mood + voice/tone expressions). */
const EXPRESSIONS = [
  { id: 'idle', label: 'Idle' },
  { id: 'happy', label: 'Happy' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'working', label: 'Working' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
  { id: 'listening', label: 'Listening' },
  { id: 'speaking', label: 'Speaking' },
  { id: 'muted', label: 'Muted' },
  { id: 'curious', label: 'Curious' },
  { id: 'shy', label: 'Shy' },
];

const EXPRESSION_DURATION_MS = {
  idle: 3200,
  done: 4300,
  working: 4400,
  thinking: 3600,
  blocked: 3400,
  happy: 3400,
  waiting: 3600,
  listening: 3200,
  speaking: 3600,
  muted: 3200,
  curious: 3200,
  shy: 3200,
};

/**
 * Parse a host mood/tone string into upstream's base mood ('neutral' | 'happy')
 * plus a finer tone key for subtle posture & eye modulation.
 */
function parseTone(rawMood) {
  const m = typeof rawMood === 'string' ? rawMood.trim().toLowerCase() : '';
  if (!m || m === 'neutral' || m === 'default' || m === 'normal') {
    return { baseMood: 'neutral', tone: 'neutral' };
  }
  if (m === 'excited' || m === 'delighted' || m === 'ecstatic' || m === 'energetic') {
    return { baseMood: 'happy', tone: 'excited' };
  }
  if (m === 'happy' || m === 'joy' || m === 'cheerful' || m === 'playful' || m === 'warm' || m === 'love' || m === 'smile') {
    return { baseMood: 'happy', tone: 'happy' };
  }
  if (m === 'calm' || m === 'gentle' || m === 'relaxed' || m === 'sleepy' || m === 'tired' || m === 'bored') {
    return { baseMood: 'neutral', tone: 'calm' };
  }
  if (m === 'curious' || m === 'surprised' || m === 'amazed' || m === 'interested' || m === 'attentive') {
    return { baseMood: 'neutral', tone: 'curious' };
  }
  if (m === 'focused' || m === 'serious' || m === 'determined' || m === 'working' || m === 'concentrated') {
    return { baseMood: 'neutral', tone: 'focused' };
  }
  if (m === 'shy' || m === 'bashful' || m === 'embarrassed') {
    return { baseMood: 'neutral', tone: 'shy' };
  }
  if (m === 'sad' || m === 'sorry' || m === 'apologetic' || m === 'worried' || m === 'anxious') {
    return { baseMood: 'neutral', tone: 'sad' };
  }
  if (m === 'angry' || m === 'frustrated' || m === 'annoyed' || m === 'stern') {
    return { baseMood: 'neutral', tone: 'angry' };
  }
  return { baseMood: 'neutral', tone: 'neutral' };
}

/**
 * Apply subtle mood/tone posture & eye nuances on top of a body pose.
 * Respects reducedMotion (only static eye/tilt cues, no extra oscillation).
 */
function applyToneOverlay(pose, tone, ctx, strength) {
  if (!tone || tone === 'neutral' || strength <= 0) return pose;
  const k = clamp01(strength);
  const live = ctx.live;
  switch (tone) {
    case 'excited':
      pose.sy += 0.025 * k;
      pose.sx -= 0.015 * k;
      pose.lift -= 0.7 * k * live;
      pose.eyes = { arc: Math.max(pose.eyes.arc, 0.9 * k), slit: pose.eyes.slit * (1 - k) };
      break;
    case 'happy':
      pose.eyes = { arc: Math.max(pose.eyes.arc, 0.85 * k), slit: pose.eyes.slit * (1 - k) };
      break;
    case 'calm':
      pose.eyes = { arc: pose.eyes.arc, slit: Math.max(pose.eyes.slit, 0.42 * k * (1 - pose.eyes.arc)) };
      pose.roll += 1.5 * k;
      break;
    case 'curious':
      pose.roll += 7.5 * k;
      pose.pitch += 0.06 * k;
      pose.sy += 0.02 * k;
      pose.squintL *= 1 - 0.6 * k;
      pose.squintR *= 1 - 0.6 * k;
      break;
    case 'focused':
      pose.pitch -= 0.05 * k;
      pose.squintL = Math.max(pose.squintL, 0.24 * k);
      pose.squintR = Math.max(pose.squintR, 0.24 * k);
      break;
    case 'shy':
      pose.roll -= 6.5 * k;
      pose.pitch -= 0.08 * k;
      pose.yaw -= 0.14 * k;
      pose.gazeX = clamp(pose.gazeX - 0.35 * k, -1, 1);
      pose.gazeY = clamp(pose.gazeY + 0.28 * k, -1, 1);
      pose.eyes = { arc: Math.max(pose.eyes.arc, 0.35 * k), slit: Math.max(pose.eyes.slit, 0.3 * k) };
      break;
    case 'sad':
      pose.pitch -= 0.09 * k;
      pose.roll -= 4.5 * k;
      pose.sy -= 0.025 * k;
      pose.sx += 0.02 * k;
      pose.squintL = Math.max(pose.squintL, 0.22 * k);
      pose.squintR = Math.max(pose.squintR, 0.22 * k);
      pose.eyes = { arc: pose.eyes.arc * (1 - k), slit: Math.max(pose.eyes.slit, 0.35 * k) };
      break;
    case 'angry':
      pose.pitch -= 0.08 * k;
      pose.squintL = Math.max(pose.squintL, 0.46 * k);
      pose.squintR = Math.max(pose.squintR, 0.36 * k);
      pose.sy -= 0.015 * k;
      pose.sx += 0.02 * k;
      break;
    default:
      break;
  }
  return pose;
}

/**
 * Create the NightAvatars engine descriptor from bundled upstream modules.
 */
function createOpenBotAvatarEngine(deps) {
  const { core, colorMod, dom, fluffy, glass, gallery, colors, thumbBase = 'avatars/open/thumbs' } = deps;
  const { examples, stateDefinition, DEFAULT_COLOR, DEFAULT_EYE_COLOR } = core;
  const { parseHex, luminance, autoEyeColor, toHex } = colorMod;
  const { mountAvatar } = dom;

  // Build lookup map of all 23 upstream avatar definitions (7 starters + 16 gallery).
  const allDefinitions = [...examples, ...gallery];
  const byId = new Map();
  for (const def of allDefinitions) {
    byId.set(def.id, def);
  }

  const materialMap = {
    fluffy,
    glass,
    flat: 'flat',
  };

  function resolveVariant(variantId) {
    const raw = typeof variantId === 'string' ? variantId.trim().toLowerCase() : '';
    let avatarId = raw;
    let materialName = 'fluffy';
    const colon = raw.indexOf(':');
    if (colon !== -1) {
      avatarId = raw.slice(0, colon);
      const suffix = raw.slice(colon + 1);
      if (suffix === 'fluffy' || suffix === 'glass' || suffix === 'flat') {
        materialName = suffix;
      }
    }
    const definition = byId.get(avatarId) || allDefinitions[0];
    const defaultColor = (colors && colors[definition.id]) || DEFAULT_COLOR;
    return {
      id: `${definition.id}${materialName === 'fluffy' ? '' : ':' + materialName}`,
      definition,
      materialName,
      material: materialMap[materialName] || fluffy,
      defaultColor,
    };
  }

  // Build exposed variants list:
  // 1) All 23 upstream avatars in Studio default finish (fluffy, auto-fallback to flat if no WebGL2).
  // 2) Glass & Flat finishes for each shape so users can also select finishes directly in UI.
  const variants = [];
  for (const def of allDefinitions) {
    variants.push({
      id: def.id,
      label: def.name,
      thumb: 'avatars/open/fluffy.webp',
      tile: deps.atlasKeys.findIndex(key => key.slice(0, key.lastIndexOf('-')) === def.id),
      side: Math.ceil(Math.sqrt(deps.atlasKeys.length)),
    });
  }
  for (const id of byId.keys()) {
    const def = byId.get(id);
    if (!def) continue;
    variants.push({
      id: `${id}:glass`,
      label: `${def.name} · Glass`,
      thumb: `${thumbBase}/${id}-glass.svg`,
    });
  }
  for (const id of byId.keys()) {
    const def = byId.get(id);
    if (!def) continue;
    variants.push({
      id: `${id}:flat`,
      label: `${def.name} · Flat`,
      thumb: `${thumbBase}/${id}.svg`,
    });
  }

  function resolveEyeColor(bodyColor) {
    const rgb = parseHex(bodyColor);
    if (!rgb) return DEFAULT_EYE_COLOR;
    // Keep upstream's signature near-black ink except on very dark custom colors.
    return luminance(rgb) < 0.08 ? toHex(autoEyeColor(rgb)) : DEFAULT_EYE_COLOR;
  }

  function mount(host, variantId) {
    if (!host || typeof host.appendChild !== 'function') {
      throw new Error('open-bot-avatar: mount(host) requires a valid DOM element');
    }
    const resolved = resolveVariant(variantId);

    // Owned inner square stage so we never clobber host styles/attributes/siblings.
    const stage = host.ownerDocument.createElement('div');
    stage.className = 'oba-night-stage';
    stage.style.width = '100%';
    stage.style.height = '100%';
    stage.style.position = 'relative';
    stage.style.display = 'block';
    stage.style.pointerEvents = 'none';
    stage.style.userSelect = 'none';
    host.appendChild(stage);

    let destroyed = false;
    let exprSeq = 0;

    // Live reactive state read by custom AvatarStateDefinitions each render tick.
    const live = {
      phase: 'idle',
      explicitState: null,
      level: 0,
      localLevel: 0,
      remoteLevel: 0,
      smoothSpeak: 0,
      smoothListen: 0,
      cadence: 0,
      baseMood: 'neutral',
      tone: 'neutral',
      gazeX: 0,
      gazeY: 0,
      hasGaze: false,
      reduced: undefined, // undefined -> 'system', boolean -> explicit
      color: resolved.defaultColor,
      eyeColor: resolveEyeColor(resolved.defaultColor),
      lastFrameTime: null,
      // Temporary expression override triggered by express(id) (measured on perfNow() clock)
      exprId: null,
      exprUntil: 0,
      exprDef: null,
      // Touch / poke reaction (measured on perfNow() clock)
      touchUntil: 0,
      touchAt: 0,
      touchX: 0,
      touchY: 0,
      tapCombo: 0,
      lastTapAt: 0,
    };

    let exprTimer = null;
    let touchTimer = null;
    let pokeRaf = 0;

    function isReducedNow() {
      if (typeof live.reduced === 'boolean') return live.reduced;
      return dom.prefersReducedMotion ? dom.prefersReducedMotion() : false;
    }

    // ---- Custom voice & tone state definitions (reused by stable id for smooth 420ms blending) ----

    const idleTonedDef = {
      id: 'oba:idle-toned',
      pose(ctx) {
        const base = stateDefinition('idle').pose(ctx);
        const pose = { ...ctx.base, ...base, eyes: { ...ctx.base.eyes, ...(base.eyes || {}) } };
        return applyToneOverlay(pose, live.tone, ctx, 1);
      },
    };

    const connectingDef = {
      id: 'oba:connecting',
      pose(ctx) {
        const pose = ctx.rest(1.05);
        if (ctx.reducedMotion) {
          pose.roll = 4;
          pose.pitch += 0.03;
          return applyToneOverlay(pose, live.tone, ctx, 0.5);
        }
        pose.roll = 4.5 * ctx.wave(2.8);
        pose.yaw += 0.14 * ctx.sway * ctx.wave(3.4);
        pose.pitch += 0.04 + 0.03 * ctx.wave(2.2, 0.7);
        pose.lift = -0.8 * (0.5 + 0.5 * ctx.wave(1.9));
        pose.gazeX = 0.45 * ctx.wave(2.6);
        pose.gazeY = -0.15 + 0.12 * ctx.wave(1.8, 1.1);
        pose.ribbons = 0.38;
        pose.cage = 0;
        pose.sweep = ctx.t * 2.2;
        return applyToneOverlay(pose, live.tone, ctx, 0.5);
      },
    };

    const listeningDef = {
      id: 'oba:listening',
      pose(ctx) {
        const pose = ctx.rest(1.1);
        const amp = live.exprId === 'listening'
          ? (ctx.reducedMotion ? 0 : 0.28 + 0.22 * (0.5 + 0.5 * ctx.wave(1.3)))
          : live.smoothListen;
        if (ctx.reducedMotion) {
          pose.roll = 5;
          pose.pitch += 0.05;
          pose.sy = 1.015;
          return applyToneOverlay(pose, live.tone, ctx, 0.7);
        }
        // Attentive lean forward + reactive nod & ear-perk driven by user's microphone level
        const nod = Math.sin(ctx.t * 7.5) * amp;
        pose.roll = 5.5 + 2.2 * ctx.wave(3.8) + 3.2 * amp * ctx.wave(1.7);
        pose.pitch += 0.06 + 0.09 * amp + 0.035 * nod;
        pose.yaw += 0.06 * ctx.sway * ctx.wave(4.6);
        pose.lift -= 1.3 * amp;
        pose.sy = 1 + 0.045 * amp;
        pose.sx = 1 - 0.025 * amp;
        pose.squintL = Math.max(pose.squintL, 0.08 + 0.12 * amp);
        pose.squintR = Math.max(pose.squintR, 0.08 + 0.12 * amp);
        if (amp > 0.45 && live.baseMood === 'happy') {
          pose.eyes = { arc: Math.max(pose.eyes.arc, clamp01((amp - 0.35) * 1.1)), slit: 0 };
        }
        return applyToneOverlay(pose, live.tone, ctx, 0.75);
      },
    };

    const speakingDef = {
      id: 'oba:speaking',
      pose(ctx) {
        const pose = ctx.rest(0.95);
        const isDemo = live.exprId === 'speaking';
        const amp = isDemo
          ? (ctx.reducedMotion ? 0.25 : 0.22 + 0.52 * (0.5 + 0.5 * Math.sin(ctx.t * 8.4)) * (0.55 + 0.45 * Math.sin(ctx.t * 2.7)))
          : live.smoothSpeak;
        const energyBoost = live.tone === 'excited' ? 1.25 : live.tone === 'calm' || live.tone === 'sad' ? 0.72 : 1;
        const e = clamp01(amp * energyBoost);

        if (ctx.reducedMotion) {
          pose.pitch += 0.04;
          pose.sy = 1.02;
          pose.sx = 0.99;
          return applyToneOverlay(pose, live.tone, ctx, 0.85);
        }

        // Syllabic speech cadence & organic 3D squash/stretch + bounce + expressive nod
        const syll = Math.sin(live.cadence + ctx.t * 11.5);
        const phrase = ctx.wave(2.1);
        const pulse = e * (0.65 + 0.35 * (0.5 + 0.5 * syll));

        pose.lift = -0.35 - 2.9 * pulse;
        pose.sy = 1 + 0.105 * pulse - 0.015 * e * Math.cos(ctx.t * 11.5);
        pose.sx = 1 - 0.06 * pulse + 0.012 * e * Math.cos(ctx.t * 11.5);
        pose.pitch += 0.04 + 0.11 * e * (0.4 + 0.6 * syll);
        pose.roll = 2.6 * phrase + 5.2 * e * ctx.wave(1.45, 0.5);
        pose.yaw += (0.09 * ctx.sway * ctx.wave(3.1)) + 0.08 * e * ctx.wave(1.9, 1.2);

        // Suppress mid-syllable blinking while speaking loudly so eyes feel expressive
        if (e > 0.22) pose.blink *= clamp01(1 - e * 1.4);

        // Mood/tone-driven eyes during speech
        if (live.baseMood === 'happy') {
          pose.eyes = { arc: clamp01(0.45 + 0.55 * e), slit: 0 };
        } else if (live.tone === 'focused' || live.tone === 'angry') {
          pose.squintL = Math.max(pose.squintL, 0.15 + 0.18 * e);
          pose.squintR = Math.max(pose.squintR, 0.15 + 0.18 * e);
        } else {
          // Subtle lively cheek-squint on loud peaks
          pose.squintL = Math.max(pose.squintL, 0.14 * e);
          pose.squintR = Math.max(pose.squintR, 0.14 * e);
        }
        return applyToneOverlay(pose, live.tone, ctx, 0.85);
      },
    };

    const mutedDef = {
      id: 'oba:muted',
      pose(ctx) {
        const pose = ctx.rest(1.6);
        pose.pitch -= 0.07;
        pose.roll = -4 + 0.8 * ctx.wave(6.8);
        pose.sy = 0.985 + 0.01 * ctx.wave(4.8);
        pose.sx = 1.01 - 0.006 * ctx.wave(4.8);
        pose.gazeX *= 0.3;
        pose.gazeY = 0.25;
        pose.eyes = { arc: 0, slit: 0.86 };
        return pose;
      },
    };

    const curiousDef = {
      id: 'oba:curious',
      pose(ctx) {
        const pose = ctx.rest(0.95);
        pose.roll = 10 + 1.8 * ctx.wave(3.4);
        pose.pitch += 0.07;
        pose.yaw += 0.12 * ctx.sway;
        pose.sy = 1.03;
        pose.sx = 0.985;
        pose.gazeX = 0.35 * ctx.wave(3.6);
        pose.gazeY = -0.2;
        return pose;
      },
    };

    const shyDef = {
      id: 'oba:shy',
      pose(ctx) {
        const pose = ctx.rest(1.2);
        pose.roll = -8 + 1.2 * ctx.wave(4.4);
        pose.pitch -= 0.1;
        pose.yaw -= 0.18 * ctx.sway;
        pose.gazeX = -0.45;
        pose.gazeY = 0.32;
        pose.eyes = { arc: 0.45, slit: 0.25 };
        return pose;
      },
    };

    function makeFreshUpstreamExpr(upstreamName, startAge) {
      exprSeq += 1;
      const baseDef = stateDefinition(upstreamName);
      return {
        id: `oba:expr:${upstreamName}:${exprSeq}`,
        startAge,
        pose: (ctx) => baseDef.pose(ctx),
      };
    }

    // Compute current 3D poke recoil offset (yaw/pitch) from touch(x, y)
    function computeTouchView(now) {
      if (isReducedNow() || live.touchAt <= 0) return { yaw: 0, pitch: 0, active: false };
      const elapsed = (now - live.touchAt) / 1000;
      if (elapsed < 0 || elapsed > 0.85) return { yaw: 0, pitch: 0, active: false };
      const decay = Math.exp(-elapsed * 5.2);
      const spring = Math.sin(elapsed * 16.5) * decay;
      const push = Math.exp(-elapsed * 8.5) * 0.28;
      // Include a gentle nod even when tapped right near center (0, 0)
      const centerWeight = clamp01(1 - Math.hypot(live.touchX, live.touchY));
      const nod = centerWeight * (-0.16 * push + 0.09 * spring);
      const yaw = clamp(live.touchX * (push + 0.16 * spring), -0.55, 0.55);
      const pitch = clamp(-live.touchY * (push + 0.13 * spring) + nod, -0.42, 0.42);
      return { yaw, pitch, active: decay > 0.015 };
    }

    function resolveActiveLook(now) {
      // 1) Active temporary expression from express(id)
      if (live.exprId && now < live.exprUntil) {
        switch (live.exprId) {
          case 'idle':
            return { state: 'idle', mood: 'neutral' };
          case 'happy':
            return { state: 'idle', mood: 'happy' };
          case 'thinking':
            return { state: 'thinking', mood: 'neutral' };
          case 'working':
            return { state: live.exprDef || 'working', mood: live.baseMood };
          case 'waiting':
            return { state: 'waiting', mood: 'neutral' };
          case 'blocked':
            return { state: 'blocked', mood: 'neutral' };
          case 'done':
            return { state: live.exprDef || 'done', mood: 'happy' };
          case 'listening':
            return { state: listeningDef, mood: live.baseMood };
          case 'speaking':
            return { state: speakingDef, mood: live.baseMood };
          case 'muted':
            return { state: mutedDef, mood: 'neutral' };
          case 'curious':
            return { state: curiousDef, mood: 'neutral' };
          case 'shy':
            return { state: shyDef, mood: 'neutral' };
          default:
            break;
        }
      } else if (live.exprId && now >= live.exprUntil) {
        live.exprId = null;
        live.exprDef = null;
      }

      // 2) Active phase from update(frame)
      switch (live.phase) {
        case 'connecting':
          return { state: connectingDef, mood: live.baseMood };
        case 'listening':
          return { state: listeningDef, mood: live.baseMood };
        case 'thinking':
          return { state: 'thinking', mood: live.baseMood };
        case 'speaking':
          return { state: speakingDef, mood: live.baseMood };
        case 'muted':
          return { state: mutedDef, mood: 'neutral' };
        case 'error':
          return { state: 'blocked', mood: 'neutral' };
        case 'idle':
        default: {
          if (live.explicitState && VALID_UPSTREAM_STATES.has(live.explicitState)) {
            return { state: live.explicitState, mood: live.baseMood };
          }
          // When neutral/happy without custom tone nuance, pass plain 'idle' string
          // so upstream's calm-state 30fps power-saving optimization applies.
          if (live.tone === 'neutral' || live.tone === 'happy') {
            return { state: 'idle', mood: live.baseMood };
          }
          return { state: idleTonedDef, mood: live.baseMood };
        }
      }
    }

    function resolveLookAt(now) {
      if (now < live.touchUntil) {
        return { x: live.touchX, y: live.touchY };
      }
      if (live.hasGaze) {
        return { x: live.gazeX, y: live.gazeY };
      }
      return null;
    }

    // Track last committed structural options so reduced-motion / unchanged frames don't churn repaints.
    let lastSig = '';
    let renderedId = 'idle';

    const mounted = mountAvatar(stage, {
      definition: resolved.definition,
      color: live.color,
      eyeColor: live.eyeColor,
      material: resolved.material,
      state: 'idle',
      mood: 'neutral',
      followPointer: false,
      lookAt: null,
      view: { yaw: 0, pitch: 0 },
      reducedMotion: 'system',
      label: resolved.definition.name,
    });

    function syncMount(now, force) {
      if (destroyed) return;
      const look = resolveActiveLook(now);
      const lookAt = resolveLookAt(now);
      const touchView = computeTouchView(now);
      const reducedOpt = typeof live.reduced === 'boolean' ? live.reduced : 'system';
      const stateKey = typeof look.state === 'string' ? look.state : look.state.id;
      const lookAtKey = lookAt ? `${lookAt.x.toFixed(3)},${lookAt.y.toFixed(3)}` : 'null';
      const viewKey = `${touchView.yaw.toFixed(4)},${touchView.pitch.toFixed(4)}`;
      const sig = `${stateKey}|${look.mood}|${live.color}|${live.eyeColor}|${lookAtKey}|${viewKey}|${reducedOpt}`;

      if (!force && sig === lastSig) return;
      lastSig = sig;
      // The renderer's state can be a stock string or one of this adapter's pose definitions.
      const namedPose = stateKey.replace(/^oba:/, '');
      renderedId = live.exprId || (look.state === connectingDef ? 'waiting'
        : (look.state === idleTonedDef || stateKey === 'idle') ? (look.mood === 'happy' ? 'happy' : 'idle') : namedPose);
      mounted.update({
        state: look.state,
        mood: look.mood,
        color: live.color,
        eyeColor: live.eyeColor,
        lookAt,
        view: { yaw: touchView.yaw, pitch: touchView.pitch },
        reducedMotion: reducedOpt,
      });
    }

    function startPokeLoop() {
      if (pokeRaf || destroyed || isReducedNow()) return;
      if (typeof requestAnimationFrame !== 'function') return;
      const step = () => {
        pokeRaf = 0;
        if (destroyed) return;
        const now = perfNow();
        const tv = computeTouchView(now);
        syncMount(now, false);
        if (tv.active) {
          pokeRaf = requestAnimationFrame(step);
        }
      };
      pokeRaf = requestAnimationFrame(step);
    }

    function stopPokeLoop() {
      if (pokeRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pokeRaf);
      }
      pokeRaf = 0;
    }

    function scheduleExprReset(delayMs) {
      if (exprTimer !== null) clearTimeout(exprTimer);
      exprTimer = setTimeout(() => {
        exprTimer = null;
        if (destroyed) return;
        const now = perfNow();
        if (live.exprId && now >= live.exprUntil - 10) {
          live.exprId = null;
          live.exprDef = null;
          syncMount(now, false);
        }
      }, Math.max(0, delayMs));
    }

    function scheduleTouchReset(delayMs) {
      if (touchTimer !== null) clearTimeout(touchTimer);
      touchTimer = setTimeout(() => {
        touchTimer = null;
        if (destroyed) return;
        syncMount(perfNow(), false);
      }, Math.max(0, delayMs));
    }

    return {
      update(frame) {
        if (destroyed || !frame || typeof frame !== 'object') return;
        const now = perfNow();
        const frameClock = typeof frame.time === 'number' && Number.isFinite(frame.time) ? frame.time : now;
        const dt = live.lastFrameTime === null
          ? 1 / 60
          : clamp((frameClock - live.lastFrameTime) / 1000, 0.001, 0.2);
        live.lastFrameTime = frameClock;

        // Phase
        const nextPhase = typeof frame.phase === 'string' && frame.phase.trim()
          ? frame.phase.trim().toLowerCase()
          : 'idle';
        // If phase transitions to a new active phase, smoothly yield any manual test expression
        if (nextPhase !== live.phase && live.exprId && !live.voiceExpression && nextPhase !== 'idle') {
          live.exprId = null;
          live.exprDef = null;
          if (exprTimer !== null) {
            clearTimeout(exprTimer);
            exprTimer = null;
          }
        }
        live.phase = nextPhase;

        // Optional explicit upstream state passthrough
        if (typeof frame.state === 'string' && VALID_UPSTREAM_STATES.has(frame.state.trim().toLowerCase())) {
          live.explicitState = frame.state.trim().toLowerCase();
        } else {
          live.explicitState = null;
        }

        // Audio levels (0..1) with frame-rate-independent exponential smoothing
        live.level = clamp01(frame.level);
        live.localLevel = clamp01(frame.localLevel);
        live.remoteLevel = clamp01(frame.remoteLevel);

        const targetSpeak = live.remoteLevel > 0 ? live.remoteLevel : live.level;
        const targetListen = live.localLevel > 0 ? live.localLevel : live.level;
        const atk = 1 - Math.exp(-dt * 26);
        const rel = 1 - Math.exp(-dt * 11);
        live.smoothSpeak = lerp(live.smoothSpeak, targetSpeak, targetSpeak > live.smoothSpeak ? atk : rel);
        live.smoothListen = lerp(live.smoothListen, targetListen, targetListen > live.smoothListen ? atk : rel);
        live.cadence += dt * (2.5 + 9.5 * live.smoothSpeak);

        // Mood / tone
        const parsedTone = parseTone(frame.mood);
        live.baseMood = parsedTone.baseMood;
        live.tone = parsedTone.tone;

        // Gaze (-1..1). Near-zero returns null so upstream idle wander smoothly resumes.
        const gx = typeof frame.gazeX === 'number' && Number.isFinite(frame.gazeX) ? clampSigned(frame.gazeX) : 0;
        const gy = typeof frame.gazeY === 'number' && Number.isFinite(frame.gazeY) ? clampSigned(frame.gazeY) : 0;
        if (Math.abs(gx) > 0.015 || Math.abs(gy) > 0.015) {
          live.gazeX = gx;
          live.gazeY = gy;
          live.hasGaze = true;
        } else {
          live.gazeX = 0;
          live.gazeY = 0;
          live.hasGaze = false;
        }

        // Reduced motion
        if (typeof frame.reduced === 'boolean') {
          live.reduced = frame.reduced;
          if (frame.reduced) stopPokeLoop();
        }

        // Color override
        const nextColor = typeof frame.color === 'string' && frame.color.trim()
          ? frame.color.trim()
          : resolved.defaultColor;
        if (nextColor !== live.color) {
          live.color = nextColor;
          live.eyeColor = resolveEyeColor(nextColor);
        }

        syncMount(now, false);
      },

      touch(x, y) {
        if (destroyed) return;
        const now = perfNow();

        // Normalize coordinates: accept 0..1, -1..1, or host-relative pixel coordinates.
        let nx = 0;
        let ny = 0;
        if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
          if (Math.abs(x) > 1 || Math.abs(y) > 1) {
            const w = host.clientWidth || stage.clientWidth || 100;
            const h = host.clientHeight || stage.clientHeight || 100;
            nx = clamp((x / w) * 2 - 1, -1, 1);
            ny = clamp((y / h) * 2 - 1, -1, 1);
          } else if (x >= 0 && y >= 0) {
            nx = clamp(x * 2 - 1, -1, 1);
            ny = clamp(y * 2 - 1, -1, 1);
          } else {
            nx = clamp(x, -1, 1);
            ny = clamp(y, -1, 1);
          }
        }

        live.touchX = nx;
        live.touchY = ny;
        live.touchAt = now;
        live.touchUntil = now + 1150;

        // Track rapid taps: 3 taps within 1.4s triggers a playful happy hop (unless reduced motion)
        if (now - live.lastTapAt < 1400) {
          live.tapCombo += 1;
        } else {
          live.tapCombo = 1;
        }
        live.lastTapAt = now;

        if (live.tapCombo >= 3 && !isReducedNow() && live.phase === 'idle') {
          live.tapCombo = 0;
          live.exprId = 'happy';
          live.exprUntil = now + 2200;
          live.exprDef = null;
          scheduleExprReset(2250);
        }

        syncMount(now, true);
        startPokeLoop();
        scheduleTouchReset(1200);
      },

      currentExpression() { return renderedId; },
      endVoiceExpression() { if (live.voiceExpression) this.express('reset'); },

      express(id, voice = false) {
        if (destroyed) return;
        const now = perfNow();
        const key = typeof id === 'string' ? id.trim().toLowerCase() : '';

        live.voiceExpression = voice;
        if (!key || key === 'reset' || key === 'clear' || (key === 'idle' && !voice)) {
          live.exprId = null;
          live.exprDef = null;
          if (exprTimer !== null) {
            clearTimeout(exprTimer);
            exprTimer = null;
          }
          syncMount(now, true);
          return;
        }

        // Known expressions (including aliases like 'error' -> 'blocked', 'celebrate' -> 'done')
        const canonical = key === 'error' ? 'blocked'
          : key === 'celebrate' ? 'done'
          : key;

        if (!Object.prototype.hasOwnProperty.call(EXPRESSION_DURATION_MS, canonical)) {
          return;
        }

        const duration = EXPRESSION_DURATION_MS[canonical];
        live.exprId = canonical;
        live.exprUntil = now + duration;

        // Fresh state wrapper for 'done' (startAge: 0 -> immediate celebration) and
        // 'working' (startAge: 1.1 -> quick ribbon sweep) so repeat clicks always replay.
        if (canonical === 'done') {
          live.exprDef = makeFreshUpstreamExpr('done', 0);
        } else if (canonical === 'working') {
          live.exprDef = makeFreshUpstreamExpr('working', 1.1);
        } else {
          live.exprDef = null;
        }

        syncMount(now, true);
        scheduleExprReset(duration + 40);
      },

      destroy() {
        if (destroyed) return;
        destroyed = true;
        stopPokeLoop();
        if (exprTimer !== null) {
          clearTimeout(exprTimer);
          exprTimer = null;
        }
        if (touchTimer !== null) {
          clearTimeout(touchTimer);
          touchTimer = null;
        }
        mounted.destroy();
        if (stage.parentNode === host) {
          host.removeChild(stage);
        }
      },
    };
  }

  return {
    id: 'open',
    title: 'open-bot-avatar',
    variants,
    expressions: EXPRESSIONS.map((e) => ({ id: e.id, label: e.label })),
    mount,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createOpenBotAvatarEngine, EXPRESSIONS };
}
